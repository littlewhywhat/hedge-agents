export const PREPROD_UNIT =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export const ROLES = ["manager", "crypto", "stocks"] as const;
export type Role = (typeof ROLES)[number];
export type MarketRole = "crypto" | "stocks";

export type Weights = {
  crypto: number;
  stocks: number;
  reserve: number;
};

export type Performance = {
  decayedReturn: number;
  volatility: number;
};

export type Fund = {
  id: string;
  depositAddress: string;
  environment: "preprod";
  unit: string;
};

export type Agent = {
  id: string;
  role: Role;
  cardanoAddress: string;
  agentIdentifier: string;
  market: string | null;
  solanaAddress: string | null;
};

export type Snapshot = {
  agentId: string;
  sampledAt: string;
  cardanoStablecoin: bigint;
  solanaUsdc: bigint;
  tokenUsd: bigint;
};

export type Round = {
  id: number;
  week: string;
  weightsBefore: Weights;
  weightsAfter: Weights;
  scores: { crypto: number; stocks: number };
  openedAt: string | null;
  settledAt: string | null;
};

export type Report = {
  roundId: number;
  agentId: string;
  blockchainIdentifier: string | null;
  fee: bigint;
  decayedReturn: number;
  volatility: number;
  resultHash: string | null;
};

export type TransferStatus = "pending" | "confirmed" | "failed";

export type Transfer = {
  id: number;
  roundId: number | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  amount: bigint;
  status: TransferStatus;
  txId: string | null;
  detail: string | null;
};

export type SendResult = {
  status: TransferStatus;
  txId: string | null;
  detail: string | null;
};

export function dottedUnit(unit: string): string {
  if (!/^[0-9a-f]+$/i.test(unit) || unit.length <= 56) {
    throw new Error(`budget unit must be a policy id plus asset name, got ${unit.length} hex chars`);
  }
  return `${unit.slice(0, 56)}.${unit.slice(56)}`;
}

export function snapshotValue(snapshot: Snapshot): bigint {
  return snapshot.cardanoStablecoin + snapshot.solanaUsdc + snapshot.tokenUsd;
}
