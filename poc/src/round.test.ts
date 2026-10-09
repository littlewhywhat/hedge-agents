import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./memory.js";
import { budgetTotal, localReport, runRound } from "./round.js";
import type { SendResult, Transfer } from "./types.js";

function sendUnconfigured(): Promise<SendResult> {
  return Promise.resolve({ status: "pending", txId: null, detail: "facilitator_unconfigured" });
}

async function seedBudget(store: MemoryStore): Promise<void> {
  const manager = await store.agentByRole("manager");
  await store.insertTransfer({
    roundId: null,
    fromAgentId: null,
    toAgentId: manager.id,
    amount: 100_000_000n,
    status: "confirmed",
    txId: "demo-deposit",
    detail: "deposit",
  });
  const start = Date.parse("2026-09-21T00:00:00.000Z");
  for (const role of ["crypto", "stocks"] as const) {
    const agent = await store.agentByRole(role);
    for (let day = 0; day < 15; day += 1) {
      const growth = role === "crypto" ? 1.01 ** day : 0.99 ** day;
      await store.insertSnapshot({
        agentId: agent.id,
        sampledAt: new Date(start + day * 86_400_000).toISOString(),
        cardanoStablecoin: BigInt(Math.round(40_000_000 * growth)),
        solanaUsdc: 0n,
        tokenUsd: 0n,
      });
    }
  }
}

test("round 0 writes pending sends once and a retry does not send again", async () => {
  const store = new MemoryStore();
  await seedBudget(store);
  let calls = 0;
  const send = async (transfer: Transfer): Promise<SendResult> => {
    calls += 1;
    if (transfer.txId) return { status: "pending", txId: transfer.txId, detail: "already_broadcast" };
    return { status: "pending", txId: `tx-${transfer.id}`, detail: null };
  };
  const first = await runRound(store, "2026-09-28", {
    send,
    report: (role, week) => localReport(store, role, week).then((performance) => ({
      performance,
      fee: 0n,
      blockchainIdentifier: null,
      resultHash: null,
    })),
  });
  assert.equal(first.weightsAfter.crypto, 0.4);
  assert.equal(first.transfers.length, 2);
  assert.equal(calls, 2);
  const second = await runRound(store, "2026-09-28", {
    send,
    report: (role, week) => localReport(store, role, week).then((performance) => ({
      performance,
      fee: 0n,
      blockchainIdentifier: null,
      resultHash: null,
    })),
  });
  assert.equal(second.transfers.length, 2);
  assert.equal(calls, 4);
  assert.ok(second.transfers.every((transfer) => transfer.txId?.startsWith("tx-")));
  const sentAgain = second.transfers.filter((transfer) => transfer.detail === "already_broadcast");
  assert.equal(sentAgain.length, 2);
});

test("the next week waits until the previous sends confirm", async () => {
  const store = new MemoryStore();
  await seedBudget(store);
  const report = (role: "crypto" | "stocks", week: string) =>
    localReport(store, role, week).then((performance) => ({
      performance,
      fee: 0n,
      blockchainIdentifier: null,
      resultHash: null,
    }));
  await runRound(store, "2026-09-28", { send: sendUnconfigured, report });
  await assert.rejects(() => runRound(store, "2026-10-05", { send: sendUnconfigured, report }), /unconfirmed/);
});

test("a confirmed first split lets the next week pay crypto from stocks", async () => {
  const store = new MemoryStore();
  await seedBudget(store);
  const report = (role: "crypto" | "stocks", week: string) =>
    localReport(store, role, week).then((performance) => ({
      performance,
      fee: 0n,
      blockchainIdentifier: null,
      resultHash: null,
    }));
  const confirm = async (transfer: Transfer): Promise<SendResult> => {
    return { status: "confirmed", txId: `ok-${transfer.id}`, detail: null };
  };
  await runRound(store, "2026-09-28", { send: confirm, report });
  const next = await runRound(store, "2026-10-05", { send: confirm, report });
  assert.equal(next.weightsAfter.crypto, 0.5);
  assert.equal(next.weightsAfter.stocks, 0.3);
  assert.equal(next.transfers.length, 1);
  assert.equal(next.transfers[0].amount, 10_000_000n);
  const from = (await store.listAgents()).find((agent) => agent.id === next.transfers[0].fromAgentId);
  const to = (await store.listAgents()).find((agent) => agent.id === next.transfers[0].toAgentId);
  assert.equal(from?.role, "stocks");
  assert.equal(to?.role, "crypto");
  assert.equal(await budgetTotal(store), 100_000_000n);
});
