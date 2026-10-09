import type { AgentReport, Asset, Decision, Fill, Strategy, TradeIdea, Trends, Weights } from "../common/interface.js";

export type TradeInput = {
  asset: Asset;
  strategy: Strategy;
  prices: number[];
  cash: bigint;
  qty: number;
  entryValue: bigint;
};

export type Brain = {
  trends(): Promise<Trends>;
  allocate(input: { weights: Weights; reports: AgentReport[]; trends: Trends }): Promise<Decision>;
  trade(input: TradeInput): Promise<TradeIdea>;
  experience(input: { asset: Asset; fills: Fill[]; pnl: bigint; deposited: bigint }): Promise<string>;
};
