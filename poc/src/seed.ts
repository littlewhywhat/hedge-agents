import type { Store } from "./store.js";

export async function seedDemo(store: Store): Promise<{ seeded: boolean }> {
  const existing = await store.budgetTransfers();
  if (existing.length > 0) return { seeded: false };
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
  return { seeded: true };
}

export async function confirmPending(store: Store): Promise<number> {
  const rows = await store.allTransfers();
  let confirmed = 0;
  for (const row of rows) {
    if (row.roundId == null || row.status !== "pending") continue;
    await store.updateTransfer(row.id, {
      status: "confirmed",
      txId: row.txId ?? `demo-${row.id}`,
      detail: "demo-confirm",
    });
    confirmed += 1;
  }
  return confirmed;
}
