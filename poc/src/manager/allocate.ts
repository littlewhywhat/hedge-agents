import { maxBig } from "../common/ada.js";
import { ASSETS, type Asset, type Move, type Weights } from "../common/interface.js";

export const MIN_AGENT = 0.1;
export const MAX_AGENT = 0.5;
export const MIN_RESERVE = 0.05;
export const MAX_RESERVE = 0.2;
export const MAX_STEP = 0.3;

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

export const capWeights = (previous: Weights, proposed: Weights): Weights => {
  const total = ASSETS.reduce((sum, asset) => sum + Math.max(0, proposed[asset]), Math.max(0, proposed.reserve));
  const share = (value: number): number => (total > 0 ? Math.max(0, value) / total : 0);
  const next = {} as Record<Asset, number>;
  for (const asset of ASSETS) {
    const stepped = Math.min(previous[asset] + MAX_STEP, Math.max(previous[asset] - MAX_STEP, share(proposed[asset])));
    next[asset] = Math.min(MAX_AGENT, Math.max(MIN_AGENT, stepped));
  }
  const invested = ASSETS.reduce((sum, asset) => sum + next[asset], 0);
  const floor = MIN_AGENT * ASSETS.length;
  if (invested > 1 - MIN_RESERVE) {
    const shrink = (1 - MIN_RESERVE - floor) / (invested - floor);
    for (const asset of ASSETS) next[asset] = MIN_AGENT + (next[asset] - MIN_AGENT) * shrink;
  } else if (invested < 1 - MAX_RESERVE) {
    const missing = 1 - MAX_RESERVE - invested;
    const room = MAX_AGENT * ASSETS.length - invested;
    for (const asset of ASSETS) next[asset] += ((MAX_AGENT - next[asset]) * missing) / room;
  }
  const weights = { reserve: 0 } as Weights;
  for (const asset of ASSETS) weights[asset] = round(next[asset]);
  weights.reserve = round(1 - ASSETS.reduce((sum, asset) => sum + weights[asset], 0));
  return weights;
};

export const planMoves = (input: {
  weights: Weights;
  cash: bigint;
  wallets: Record<Asset, bigint>;
  reserve: bigint;
  minTransfer: bigint;
}): Move[] => {
  const tradable = {} as Record<Asset, bigint>;
  const shortfall = {} as Record<Asset, bigint>;
  for (const asset of ASSETS) {
    tradable[asset] = maxBig(0n, input.wallets[asset] - input.reserve);
    shortfall[asset] = maxBig(0n, input.reserve - input.wallets[asset]);
  }
  const total = ASSETS.reduce((sum, asset) => sum + tradable[asset], maxBig(0n, input.cash));
  const collects: Move[] = [];
  const funds: Move[] = [];
  for (const asset of ASSETS) {
    const target = BigInt(Math.floor(Number(total) * input.weights[asset]));
    const diff = target - tradable[asset];
    if (diff > input.minTransfer) funds.push({ asset, direction: "fund", amount: diff + shortfall[asset] });
    else if (-diff > input.minTransfer) collects.push({ asset, direction: "collect", amount: -diff });
    else if (shortfall[asset] >= input.minTransfer) funds.push({ asset, direction: "fund", amount: shortfall[asset] });
  }
  let available = maxBig(0n, input.cash) + collects.reduce((sum, move) => sum + move.amount, 0n);
  const paid: Move[] = [];
  for (const move of funds) {
    const amount = move.amount > available ? available : move.amount;
    if (amount < input.minTransfer) continue;
    paid.push({ ...move, amount });
    available -= amount;
  }
  return [...collects, ...paid];
};
