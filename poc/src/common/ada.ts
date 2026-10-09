export const LOVELACE_PER_ADA = 1_000_000n;

export const ada = (value: number): bigint => {
  return BigInt(Math.round(value * 1_000_000));
};

export const toAda = (lovelace: bigint): number => {
  return Number(lovelace) / 1_000_000;
};

export const showAda = (lovelace: bigint): string => {
  return `${toAda(lovelace).toFixed(2)} tADA`;
};

export const maxBig = (a: bigint, b: bigint): bigint => {
  return a > b ? a : b;
};

export const minBig = (a: bigint, b: bigint): bigint => {
  return a < b ? a : b;
};
