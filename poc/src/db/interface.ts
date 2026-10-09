import type {
  AgentReport,
  AgentState,
  Asset,
  BrokerAccount,
  Cycle,
  Fill,
  ManagerState,
  Role,
  Tick,
  Transfer,
  TransferStatus,
  ValueSnapshot,
  Weights,
} from "../common/interface.js";

export type Ledger = {
  find(id: string): Promise<Transfer | null>;
  begin(transfer: Omit<Transfer, "status" | "txId" | "detail">): Promise<void>;
  update(id: string, patch: { status: TransferStatus; txId: string | null; detail: string | null }): Promise<void>;
};

export type ManagerStore = {
  state(): Promise<ManagerState>;
  setState(patch: Partial<ManagerState>): Promise<void>;
  saveWallets(addresses: Partial<Record<Role, string>>): Promise<void>;
  openCycle(weightsBefore: Weights): Promise<Cycle>;
  cycle(id: number): Promise<Cycle | null>;
  lastCycle(): Promise<Cycle | null>;
  updateCycle(id: number, patch: Partial<Omit<Cycle, "id" | "startedAt">>): Promise<Cycle>;
  saveReport(cycleId: number, report: AgentReport): Promise<void>;
  reports(cycleId: number): Promise<AgentReport[]>;
  netRebalanced(): Promise<bigint>;
};

export type AgentStore = {
  load(role: Asset): Promise<AgentState | null>;
  save(state: AgentState): Promise<void>;
  fills(role: Asset, cycleId: number): Promise<Fill[]>;
  snapshot(row: ValueSnapshot): Promise<void>;
};

export type BrokerStore = {
  accounts(): Promise<BrokerAccount[]>;
  credit(input: { txId: string; role: Asset; amount: bigint }): Promise<BrokerAccount>;
  applyFill(account: BrokerAccount, fill: Fill): Promise<void>;
  reserveWithdraw(input: {
    account: BrokerAccount;
    transfer: Omit<Transfer, "status" | "txId" | "detail">;
  }): Promise<void>;
  savePrices(ticks: Tick[]): Promise<void>;
  lastPrices(): Promise<Partial<Record<Asset, number>>>;
};

export type DeskCycle = {
  id: number;
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  weightsBefore: Weights;
  weightsAfter: Weights | null;
  trends: Record<string, string> | null;
  rationale: string | null;
  source: string | null;
  error: string | null;
  reports: { role: Asset; wallet: string; deposited: string; withdrawn: string; pnl: string; trades: number; experience: string }[];
};

export type DeskAgent = {
  role: Asset;
  phase: string;
  cycleId: number | null;
  stance: string | null;
  notes: string | null;
  experience: string;
  cash: string;
  qty: number;
  value: string;
  updatedAt: string | null;
};

export type DeskTransfer = {
  id: string;
  cycleId: number | null;
  kind: string;
  from: string;
  to: string;
  amount: string;
  status: string;
  txId: string | null;
  detail: string | null;
  at: string;
};

export type DeskState = {
  manager: { running: boolean; cycleId: number | null; nextAt: string | null };
  agents: DeskAgent[];
  cycles: DeskCycle[];
  transfers: DeskTransfer[];
  prices: Record<string, { at: string; price: number }[]>;
  values: Record<string, { at: string; value: string }[]>;
  wallets: { role: string; address: string }[];
};

export type DeskStore = {
  state(): Promise<DeskState>;
};
