import { allocate, cooledSenders, performance, transfersFor } from "./pure.js";
import { assertMonday, weekEnd, type Store } from "./store.js";
import type { MarketRole, Performance, Role, Round, SendResult, Transfer, Weights } from "./types.js";
import { snapshotValue } from "./types.js";

const EMPTY: Weights = { crypto: 0, stocks: 0, reserve: 1 };

export type RoundBody = Round & {
  transfers: Transfer[];
  reports: { role: MarketRole; decayedReturn: number; volatility: number }[];
};

async function roleOf(store: Store, agentId: string | null): Promise<Role | null> {
  if (!agentId) return null;
  const agents = await store.listAgents();
  return agents.find((agent) => agent.id === agentId)?.role ?? null;
}

export async function budgetTotal(store: Store): Promise<bigint> {
  const transfers = await store.budgetTransfers();
  let total = 0n;
  for (const transfer of transfers) {
    if (transfer.status !== "confirmed") continue;
    if (!transfer.fromAgentId) total += transfer.amount;
    if (!transfer.toAgentId) total -= transfer.amount;
  }
  return total;
}

export async function runRound(
  store: Store,
  week: string,
  deps: {
    now?: () => string;
    send: (transfer: Transfer, fromRole: Role, toRole: Role) => Promise<SendResult>;
    report: (role: MarketRole, week: string) => Promise<{
      performance: Performance;
      fee: bigint;
      blockchainIdentifier: string | null;
      resultHash: string | null;
    }>;
  },
): Promise<RoundBody> {
  assertMonday(week);
  const now = deps.now ?? (() => new Date().toISOString());
  const existing = await store.findRound(week);
  if (existing?.settledAt) return present(store, existing);

  const previous = await store.latestRoundBefore(week);
  if (previous) {
    const open = (await store.listTransfers(previous.id)).filter((transfer) => transfer.status !== "confirmed");
    if (!previous.settledAt || open.length > 0) {
      throw new Error(`week ${previous.week} still has ${Math.max(open.length, 1)} unconfirmed transfer(s)`);
    }
  }

  const round =
    existing ??
    (await store.insertRound({
      week,
      weightsBefore: previous?.weightsAfter ?? EMPTY,
      weightsAfter: previous?.weightsAfter ?? EMPTY,
      scores: { crypto: 0, stocks: 0 },
      openedAt: now(),
    }));

  if ((await store.reportsFor(round.id)).length === 0) {
    for (const role of ["crypto", "stocks"] as const) {
      const agent = await store.agentByRole(role);
      const collected = await deps.report(role, week);
      await store.insertReport({
        roundId: round.id,
        agentId: agent.id,
        blockchainIdentifier: collected.blockchainIdentifier,
        fee: collected.fee,
        decayedReturn: collected.performance.decayedReturn,
        volatility: collected.performance.volatility,
        resultHash: collected.resultHash,
      });
    }
  }

  const reports = await store.reportsFor(round.id);
  const agents = await store.listAgents();
  const byRole = Object.fromEntries(
    await Promise.all(
      reports.map(async (report) => {
        const role = agents.find((agent) => agent.id === report.agentId)?.role;
        return [
          role,
          { decayedReturn: report.decayedReturn, volatility: report.volatility },
        ] as const;
      }),
    ),
  ) as Record<MarketRole, Performance>;

  const previousTransfers = previous ? await store.listTransfers(previous.id) : [];
  const cooled = cooledSenders(
    await Promise.all(
      previousTransfers.map(async (transfer) => ({
        fromRole: await roleOf(store, transfer.fromAgentId),
        status: transfer.status,
      })),
    ),
  );
  const decision = allocate({
    round0: !previous,
    before: round.weightsBefore,
    performance: byRole,
    cooled,
  });
  round.weightsAfter = decision.weights;
  round.scores = decision.scores;
  await store.saveDecision(round.id, decision.weights, decision.scores);

  const total = await budgetTotal(store);
  const planned = transfersFor(round.weightsBefore, round.weightsAfter, total);
  let rows = await store.listTransfers(round.id);
  for (const leg of planned) {
    const from = await store.agentByRole(leg.from);
    const to = await store.agentByRole(leg.to);
    const already = rows.find((row) => row.fromAgentId === from.id && row.toAgentId === to.id);
    if (already) continue;
    rows.push(
      await store.insertTransfer({
        roundId: round.id,
        fromAgentId: from.id,
        toAgentId: to.id,
        amount: leg.amount,
        status: "pending",
        txId: null,
        detail: null,
      }),
    );
  }

  for (const row of rows) {
    if (row.status === "confirmed") continue;
    const fromRole = await roleOf(store, row.fromAgentId);
    const toRole = await roleOf(store, row.toAgentId);
    if (!fromRole || !toRole) continue;
    const result = await deps.send(row, fromRole, toRole);
    await store.updateTransfer(row.id, result);
  }

  rows = await store.listTransfers(round.id);
  if (rows.every((row) => row.status === "confirmed")) {
    await store.markSettled(round.id, now());
    round.settledAt = now();
  }
  return present(store, round);
}

async function present(store: Store, round: Round): Promise<RoundBody> {
  const agents = await store.listAgents();
  const reports = await store.reportsFor(round.id);
  return {
    ...round,
    transfers: await store.listTransfers(round.id),
    reports: reports.map((report) => ({
      role: agents.find((agent) => agent.id === report.agentId)?.role as MarketRole,
      decayedReturn: report.decayedReturn,
      volatility: report.volatility,
    })),
  };
}

export async function localReport(store: Store, role: MarketRole, week: string): Promise<Performance> {
  const agent = await store.agentByRole(role);
  const snapshots = await store.snapshotsBefore(agent.id, weekEnd(week));
  return performance(snapshots.map((snapshot) => ({ at: Date.parse(snapshot.sampledAt), value: Number(snapshotValue(snapshot)) })));
}
