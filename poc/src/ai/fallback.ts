import { toAda } from "../common/ada.js";
import { ASSETS, type AgentReport, type Asset, type Decision, type Fill, type Strategy, type TradeIdea, type Trends, type Weights } from "../common/interface.js";
import type { TradeInput } from "./interface.js";

export const NAMES: Record<Asset, string> = {
  btc: "Bitcoin",
  eth: "Ether",
  spx: "S&P 500",
  gold: "Gold",
};

export const EQUAL: Weights = { btc: 0.2, eth: 0.2, spx: 0.2, gold: 0.2, reserve: 0.2 };

export const BALANCED: Strategy = {
  stance: "balanced",
  maxPositionPct: 60,
  stopLossPct: 5,
  notes: "Follow short momentum, keep some cash.",
};

export const fallbackTrends = (): Trends => {
  return Object.fromEntries(ASSETS.map((asset) => [asset, "No live trend data."])) as Trends;
};

const returnOf = (report: AgentReport | undefined): number => {
  if (!report || report.deposited <= 0n) return 0;
  return Number(report.pnl) / Number(report.deposited);
};

export const fallbackDecision = (input: { weights: Weights; reports: AgentReport[] }): Decision => {
  const byRole = new Map(input.reports.map((report) => [report.role, report]));
  const weights = { ...input.weights };
  const strategies = {} as Record<Asset, Strategy>;
  for (const asset of ASSETS) {
    const result = returnOf(byRole.get(asset));
    weights[asset] = input.weights[asset] + Math.max(-0.05, Math.min(0.05, result));
    strategies[asset] = {
      ...BALANCED,
      stance: result > 0.01 ? "aggressive" : result < -0.01 ? "defensive" : "balanced",
    };
  }
  return {
    weights,
    strategies,
    rationale: "Rule fallback: tilt a little toward agents that made money last cycle.",
    source: "fallback",
  };
};

const STANCE: Record<Strategy["stance"], { threshold: number; size: number }> = {
  aggressive: { threshold: 0.0005, size: 0.5 },
  balanced: { threshold: 0.001, size: 0.3 },
  defensive: { threshold: 0.002, size: 0.15 },
};

export const fallbackTrade = (input: TradeInput): TradeIdea => {
  const prices = input.prices;
  if (prices.length < 5) return { side: "hold", fraction: 0, reason: "Not enough prices yet." };
  const last = prices[prices.length - 1];
  const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const move = (last - average) / average;
  const rule = STANCE[input.strategy.stance];
  const positionValue = input.qty * last * 1_000_000;
  const total = Number(input.cash) + positionValue;
  const exposure = total > 0 ? (positionValue / total) * 100 : 0;
  if (input.entryValue > 0n && total < Number(input.entryValue) * (1 - input.strategy.stopLossPct / 100) && input.qty > 0) {
    return { side: "sell", fraction: 1, reason: `Stop loss at ${input.strategy.stopLossPct}%.` };
  }
  if (move > rule.threshold && exposure < input.strategy.maxPositionPct && input.cash > 0n) {
    return { side: "buy", fraction: rule.size, reason: `Price ${(move * 100).toFixed(2)}% above its short average.` };
  }
  if (move < -rule.threshold && input.qty > 0) {
    return { side: "sell", fraction: rule.size, reason: `Price ${(move * 100).toFixed(2)}% below its short average.` };
  }
  return { side: "hold", fraction: 0, reason: "No clear move." };
};

export const fallbackExperience = (input: { asset: Asset; fills: Fill[]; pnl: bigint; deposited: bigint }): string => {
  const buys = input.fills.filter((fill) => fill.side === "buy").length;
  const sells = input.fills.length - buys;
  const sign = input.pnl >= 0n ? "+" : "";
  return `${NAMES[input.asset]}: ${buys} buys, ${sells} sells, result ${sign}${toAda(input.pnl).toFixed(2)} tADA on ${toAda(input.deposited).toFixed(2)} deposited.`;
};
