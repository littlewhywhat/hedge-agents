import type { Agent, Fund, Report, Role, Round, Snapshot, Transfer, Weights } from "./types.js";

export type NewTransfer = {
  roundId: number | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  amount: bigint;
  status: Transfer["status"];
  txId: string | null;
  detail: string | null;
};

export interface Store {
  getFund(): Promise<Fund>;
  listAgents(): Promise<Agent[]>;
  agentByRole(role: Role): Promise<Agent>;
  insertSnapshot(snapshot: Snapshot): Promise<void>;
  snapshotsBefore(agentId: string, beforeExclusive: string): Promise<Snapshot[]>;
  findRound(week: string): Promise<Round | null>;
  latestRoundBefore(week: string): Promise<Round | null>;
  insertRound(input: {
    week: string;
    weightsBefore: Weights;
    weightsAfter: Weights;
    scores: { crypto: number; stocks: number };
    openedAt: string;
  }): Promise<Round>;
  saveDecision(roundId: number, weightsAfter: Weights, scores: { crypto: number; stocks: number }): Promise<void>;
  markSettled(roundId: number, settledAt: string): Promise<void>;
  insertReport(report: Report): Promise<void>;
  reportsFor(roundId: number): Promise<Report[]>;
  listTransfers(roundId: number): Promise<Transfer[]>;
  insertTransfer(transfer: NewTransfer): Promise<Transfer>;
  updateTransfer(id: number, patch: Pick<Transfer, "status" | "txId" | "detail">): Promise<Transfer>;
  allTransfers(): Promise<Transfer[]>;
  budgetTransfers(): Promise<Transfer[]>;
}

export function weekEnd(week: string): string {
  const monday = new Date(`${week}T00:00:00.000Z`);
  if (Number.isNaN(monday.getTime())) throw new Error(`week must be YYYY-MM-DD, got ${week}`);
  monday.setUTCDate(monday.getUTCDate() + 7);
  return monday.toISOString();
}

export function assertMonday(week: string): void {
  const day = new Date(`${week}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.getUTCDay() !== 1) {
    throw new Error(`week must be a Monday, got ${week}`);
  }
}
