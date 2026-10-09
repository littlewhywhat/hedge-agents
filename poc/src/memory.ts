import type { Agent, Fund, Report, Role, Round, Snapshot, Transfer, Weights } from "./types.js";
import { PREPROD_UNIT } from "./types.js";
import type { NewTransfer, Store } from "./store.js";

export function demoFund(): { fund: Fund; agents: Agent[] } {
  const fund: Fund = {
    id: "demo",
    depositAddress: "",
    environment: "preprod",
    unit: PREPROD_UNIT,
  };
  const agents: Agent[] = (["manager", "crypto", "stocks"] as const).map((role) => ({
    id: role,
    role,
    cardanoAddress: "",
    agentIdentifier: "",
    market: role === "manager" ? null : role,
    solanaAddress: null,
  }));
  return { fund, agents };
}

export class MemoryStore implements Store {
  roundSeq = 1;
  transferSeq = 1;
  rounds: Round[] = [];
  reports: Report[] = [];
  transfers: Transfer[] = [];
  snapshots: Snapshot[] = [];

  constructor(
    private fund: Fund = demoFund().fund,
    private agents: Agent[] = demoFund().agents,
  ) {}

  async getFund(): Promise<Fund> {
    return this.fund;
  }

  async listAgents(): Promise<Agent[]> {
    return this.agents;
  }

  async agentByRole(role: Role): Promise<Agent> {
    const agent = this.agents.find((item) => item.role === role);
    if (!agent) throw new Error(`no ${role} agent`);
    return agent;
  }

  async insertSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshots.push(snapshot);
  }

  async snapshotsBefore(agentId: string, beforeExclusive: string): Promise<Snapshot[]> {
    const end = Date.parse(beforeExclusive);
    return this.snapshots
      .filter((snapshot) => snapshot.agentId === agentId && Date.parse(snapshot.sampledAt) < end)
      .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  }

  async findRound(week: string): Promise<Round | null> {
    return this.rounds.find((round) => round.week === week) ?? null;
  }

  async latestRoundBefore(week: string): Promise<Round | null> {
    return this.rounds.filter((round) => round.week < week).sort((a, b) => (a.week < b.week ? 1 : -1))[0] ?? null;
  }

  async insertRound(input: {
    week: string;
    weightsBefore: Weights;
    weightsAfter: Weights;
    scores: { crypto: number; stocks: number };
    openedAt: string;
  }): Promise<Round> {
    const round: Round = { id: this.roundSeq, settledAt: null, ...input };
    this.roundSeq += 1;
    this.rounds.push(round);
    return round;
  }

  async saveDecision(roundId: number, weightsAfter: Weights, scores: { crypto: number; stocks: number }): Promise<void> {
    const round = this.rounds.find((item) => item.id === roundId);
    if (!round) throw new Error(`no round ${roundId}`);
    round.weightsAfter = weightsAfter;
    round.scores = scores;
  }

  async markSettled(roundId: number, settledAt: string): Promise<void> {
    const round = this.rounds.find((item) => item.id === roundId);
    if (!round) throw new Error(`no round ${roundId}`);
    round.settledAt = settledAt;
  }

  async insertReport(report: Report): Promise<void> {
    this.reports.push(report);
  }

  async reportsFor(roundId: number): Promise<Report[]> {
    return this.reports.filter((report) => report.roundId === roundId);
  }

  async listTransfers(roundId: number): Promise<Transfer[]> {
    return this.transfers.filter((transfer) => transfer.roundId === roundId);
  }

  async insertTransfer(transfer: NewTransfer): Promise<Transfer> {
    const row: Transfer = { id: this.transferSeq, ...transfer };
    this.transferSeq += 1;
    this.transfers.push(row);
    return row;
  }

  async updateTransfer(id: number, patch: Pick<Transfer, "status" | "txId" | "detail">): Promise<Transfer> {
    const transfer = this.transfers.find((item) => item.id === id);
    if (!transfer) throw new Error(`no transfer ${id}`);
    Object.assign(transfer, patch);
    return transfer;
  }

  async allTransfers(): Promise<Transfer[]> {
    return this.transfers;
  }

  async budgetTransfers(): Promise<Transfer[]> {
    return this.transfers;
  }
}
