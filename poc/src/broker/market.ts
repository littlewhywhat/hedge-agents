import { ASSETS, type Asset, type BrokerAccount, type Fill, type Side, type Tick } from "../common/interface.js";

export const START_PRICES: Record<Asset, number> = {
  btc: 120_000,
  eth: 4_500,
  spx: 6_700,
  gold: 2_650,
};

const VOLATILITY: Record<Asset, number> = {
  btc: 0.0015,
  eth: 0.002,
  spx: 0.0005,
  gold: 0.0003,
};

const REGIME_MIN_S = 60;
const REGIME_MAX_S = 240;
const DRIFT_SHARE = 0.15;

export const FEE_BPS = 10n;

export type Random = () => number;

const normal = (random: Random): number => {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export const seeded = (seed: number): Random => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type Market = {
  step(now?: Date): Tick[];
  price(asset: Asset): number;
};

export const createMarket = (start: Partial<Record<Asset, number>>, random: Random = Math.random): Market => {
  const prices = { ...START_PRICES, ...start };
  const drift = {} as Record<Asset, number>;
  const regimeLeft = {} as Record<Asset, number>;

  const newRegime = (asset: Asset): void => {
    drift[asset] = (random() * 2 - 1) * VOLATILITY[asset] * DRIFT_SHARE;
    regimeLeft[asset] = REGIME_MIN_S + Math.floor(random() * (REGIME_MAX_S - REGIME_MIN_S));
  };
  for (const asset of ASSETS) newRegime(asset);

  return {
    step: (now = new Date()) => {
      const at = now.toISOString();
      return ASSETS.map((asset) => {
        if (--regimeLeft[asset] <= 0) newRegime(asset);
        const change = drift[asset] + VOLATILITY[asset] * normal(random);
        prices[asset] = Math.max(prices[asset] * Math.exp(change), 0.01);
        return { asset, price: prices[asset], at };
      });
    },
    price: (asset) => prices[asset],
  };
};

export const valueOf = (account: BrokerAccount, price: number): bigint => {
  return account.cash + BigInt(Math.floor(account.qty * price * 1_000_000));
};

export const execute = (input: {
  account: BrokerAccount;
  price: number;
  side: Side;
  fraction: number;
  reason: string;
  cycleId: number | null;
}): { account: BrokerAccount; fill: Fill } | null => {
  const { account, price, side, cycleId, reason } = input;
  const fraction = Math.max(0, Math.min(1, input.fraction));
  if (fraction === 0) return null;
  if (side === "buy") {
    const spend = BigInt(Math.floor(Number(account.cash) * fraction));
    if (spend <= 0n) return null;
    const fee = (spend * FEE_BPS) / 10_000n;
    const qty = Number(spend - fee) / 1_000_000 / price;
    return {
      account: { ...account, cash: account.cash - spend, qty: account.qty + qty },
      fill: { role: account.role, cycleId, side, qty, price, cash: -spend, fee, reason },
    };
  }
  const qty = fraction === 1 ? account.qty : account.qty * fraction;
  if (qty <= 0) return null;
  const gross = BigInt(Math.floor(qty * price * 1_000_000));
  const fee = (gross * FEE_BPS) / 10_000n;
  return {
    account: { ...account, cash: account.cash + gross - fee, qty: fraction === 1 ? 0 : account.qty - qty },
    fill: { role: account.role, cycleId, side, qty, price, cash: gross - fee, fee, reason },
  };
};
