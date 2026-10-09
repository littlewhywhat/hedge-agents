export const ASSETS = ["btc", "eth", "spx", "gold"] as const;
export type Asset = (typeof ASSETS)[number];

export const ROLES = ["manager", ...ASSETS, "broker"] as const;
export type Role = (typeof ROLES)[number];

export type Weights = Record<Asset | "reserve", number>;

export type Stance = "aggressive" | "balanced" | "defensive";

export type Strategy = {
  stance: Stance;
  maxPositionPct: number;
  stopLossPct: number;
  notes: string;
};

export type Trends = Record<Asset, string>;

export type Decision = {
  weights: Weights;
  strategies: Record<Asset, Strategy>;
  rationale: string;
  source: "gemini" | "fallback";
};

export type Side = "buy" | "sell";

export type TradeIdea = {
  side: Side | "hold";
  fraction: number;
  reason: string;
};

export type CyclePhase =
  | "stopping"
  | "trends"
  | "deciding"
  | "collecting"
  | "funding"
  | "starting"
  | "running"
  | "done"
  | "halted";

export type AgentPhase = "idle" | "depositing" | "trading" | "withdrawing";

export type TransferKind = "rebalance" | "deposit" | "withdraw" | "setup";
export type TransferStatus = "signing" | "pending" | "confirmed" | "failed";

export type Transfer = {
  id: string;
  cycleId: number | null;
  kind: TransferKind;
  fromRole: Role;
  toRole: Role;
  toAddress: string;
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

export type Move = {
  asset: Asset;
  direction: "collect" | "fund";
  amount: bigint;
};

export type Cycle = {
  id: number;
  phase: CyclePhase;
  startedAt: string;
  finishedAt: string | null;
  weightsBefore: Weights;
  weightsAfter: Weights | null;
  strategies: Record<Asset, Strategy> | null;
  trends: Trends | null;
  rationale: string | null;
  source: string | null;
  moves: Move[] | null;
  error: string | null;
};

export type ManagerState = {
  running: boolean;
  cycleId: number | null;
  nextAt: string | null;
};

export type BrokerAccount = {
  role: Asset;
  cash: bigint;
  qty: number;
};

export type Fill = {
  role: Asset;
  cycleId: number | null;
  side: Side;
  qty: number;
  price: number;
  cash: bigint;
  fee: bigint;
  reason: string;
};

export type Tick = {
  asset: Asset;
  price: number;
  at: string;
};

export type AgentState = {
  role: Asset;
  phase: AgentPhase;
  cycleId: number | null;
  strategy: Strategy | null;
  deposited: bigint;
  withdrawn: bigint;
  experience: string;
};

export type AgentReport = {
  role: Asset;
  phase: AgentPhase;
  cycleId: number | null;
  wallet: bigint;
  deposited: bigint;
  withdrawn: bigint;
  pnl: bigint;
  trades: number;
  experience: string;
};

export type ValueSnapshot = {
  role: Asset;
  cash: bigint;
  qty: number;
  price: number;
  value: bigint;
};

export type AgentRequest =
  | { type: "stop"; cycleId: number | null }
  | { type: "report" }
  | { type: "transfer"; transferId: string; cycleId: number; amount: bigint }
  | { type: "start"; cycleId: number; strategy: Strategy };

export type AgentReply =
  | { type: "report"; report: AgentReport }
  | { type: "sent"; result: SendResult }
  | { type: "started" };

export type BrokerRequest =
  | { type: "account"; role: Asset }
  | { type: "deposit"; role: Asset; txId: string }
  | { type: "order"; role: Asset; cycleId: number | null; side: Side; fraction: number; reason: string }
  | { type: "withdraw"; role: Asset; cycleId: number; transferId: string };

export type BrokerReply =
  | { type: "account"; account: BrokerAccount; price: number }
  | { type: "filled"; fill: Fill | null; account: BrokerAccount }
  | { type: "withdrawn"; amount: bigint; result: SendResult };

export type BrokerPush = { type: "tick"; ticks: Tick[] };
