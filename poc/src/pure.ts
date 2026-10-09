import type { MarketRole, Performance, Role, Weights } from "./types.js";

export const FLOOR = 0.1;
export const CAP = 0.5;
export const MIN_MOVE = 0.05;
export const MAX_STEP = 0.1;
export const VOL_FLOOR = 0.01;
const ROUND0: Weights = { crypto: 0.4, stocks: 0.4, reserve: 0.2 };

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function clip(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function performance(points: { at: number; value: number }[]): Performance {
  const sorted = [...points].filter((point) => point.value > 0).sort((a, b) => a.at - b.at);
  if (sorted.length < 2) return { decayedReturn: 0, volatility: 0 };

  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    returns.push(sorted[i].value / sorted[i - 1].value - 1);
  }

  let weightSum = 0;
  let returnSum = 0;
  returns.forEach((value, index) => {
    const weight = 0.5 ** (returns.length - 1 - index);
    weightSum += weight;
    returnSum += weight * value;
  });

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return { decayedReturn: returnSum / weightSum, volatility: Math.sqrt(variance) };
}

function score(point: Performance): number {
  return Math.max(point.decayedReturn, 0) / Math.max(point.volatility, VOL_FLOOR);
}

function stepToward(current: number, target: number): number {
  const delta = target - current;
  if (Math.abs(delta) < MIN_MOVE) return current;
  const capped = Math.sign(delta) * Math.min(Math.abs(delta), MAX_STEP);
  return clip(current + capped, FLOOR, CAP);
}

export function allocate(input: {
  round0: boolean;
  before: Weights;
  performance: Record<MarketRole, Performance> | null;
  cooled: Role[];
}): { weights: Weights; scores: Record<MarketRole, number> } {
  if (input.round0) {
    return { weights: { ...ROUND0 }, scores: { crypto: 0, stocks: 0 } };
  }

  const points = input.performance ?? {
    crypto: { decayedReturn: 0, volatility: 0 },
    stocks: { decayedReturn: 0, volatility: 0 },
  };
  const scores = { crypto: score(points.crypto), stocks: score(points.stocks) };
  if (scores.crypto < 1e-8 && scores.stocks < 1e-8) {
    return { weights: input.before, scores };
  }

  let crypto = scores.crypto > 0 ? scores.crypto : 0;
  let stocks = scores.stocks > 0 ? scores.stocks : 0;
  if (crypto + stocks === 0) {
    crypto = FLOOR;
    stocks = FLOOR;
  } else {
    const sum = crypto + stocks;
    crypto /= sum;
    stocks /= sum;
  }
  if (scores.crypto <= 0) crypto = FLOOR;
  if (scores.stocks <= 0) stocks = FLOOR;
  crypto = clip(crypto, FLOOR, CAP);
  stocks = clip(stocks, FLOOR, CAP);
  if (crypto + stocks > 1) {
    const overflow = crypto + stocks - 1;
    if (crypto >= stocks) crypto -= overflow;
    else stocks -= overflow;
  }

  crypto = stepToward(input.before.crypto, crypto);
  stocks = stepToward(input.before.stocks, stocks);
  if (input.cooled.includes("crypto")) crypto = Math.max(crypto, input.before.crypto);
  if (input.cooled.includes("stocks")) stocks = Math.max(stocks, input.before.stocks);
  crypto = clip(crypto, FLOOR, CAP);
  stocks = clip(stocks, FLOOR, CAP);

  if (input.cooled.includes("manager") && crypto + stocks > input.before.crypto + input.before.stocks) {
    crypto = input.before.crypto;
    stocks = input.before.stocks;
  }

  crypto = round4(crypto);
  stocks = round4(stocks);
  return {
    weights: { crypto, stocks, reserve: round4(1 - crypto - stocks) },
    scores: { crypto: round4(scores.crypto), stocks: round4(scores.stocks) },
  };
}

export type Leg = { from: Role; to: Role; amount: bigint };

function share(total: bigint, weight: number): bigint {
  return (total * BigInt(Math.round(weight * 10000))) / 10000n;
}

function holdings(weights: Weights, total: bigint): Record<Role, bigint> {
  const crypto = share(total, weights.crypto);
  const stocks = share(total, weights.stocks);
  return { crypto, stocks, manager: total - crypto - stocks };
}

export function transfersFor(before: Weights, after: Weights, total: bigint): Leg[] {
  if (total <= 0n) return [];
  const current = holdings(before, total);
  const target = holdings(after, total);
  const surplus: { role: Role; amount: bigint }[] = [];
  const deficit: { role: Role; amount: bigint }[] = [];
  for (const role of ["manager", "crypto", "stocks"] as const) {
    const delta = target[role] - current[role];
    if (delta > 0n) deficit.push({ role, amount: delta });
    if (delta < 0n) surplus.push({ role, amount: -delta });
  }

  const legs: Leg[] = [];
  for (const source of surplus) {
    for (const sink of deficit) {
      if (source.amount === 0n) break;
      const amount = source.amount < sink.amount ? source.amount : sink.amount;
      if (amount === 0n) continue;
      legs.push({ from: source.role, to: sink.role, amount });
      source.amount -= amount;
      sink.amount -= amount;
    }
  }
  return legs;
}

export function cooledSenders(transfers: { fromRole: Role | null; status: string }[]): Role[] {
  const cooled = new Set<Role>();
  for (const transfer of transfers) {
    if (transfer.status === "confirmed" && transfer.fromRole) cooled.add(transfer.fromRole);
  }
  return [...cooled];
}
