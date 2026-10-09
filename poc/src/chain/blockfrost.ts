import type { ChainSettings } from "./interface.js";

type Amount = { unit: string; quantity: string };
type TxUtxos = {
  inputs: { address: string }[];
  outputs: { address: string; amount: Amount[] }[];
};

const lovelaceOf = (amounts: Amount[]): bigint => {
  return BigInt(amounts.find((item) => item.unit === "lovelace")?.quantity ?? "0");
};

export const blockfrost = (settings: ChainSettings) => {
  const get = async <T>(path: string): Promise<T | null> => {
    const response = await fetch(`${settings.blockfrostUrl}${path}`, {
      headers: { project_id: settings.blockfrostProjectId },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`blockfrost ${path} ${response.status}`);
    return (await response.json()) as T;
  };

  return {
    balance: async (address: string): Promise<bigint> => {
      const row = await get<{ amount: Amount[] }>(`/addresses/${address}`);
      return row ? lovelaceOf(row.amount) : 0n;
    },
    included: async (txId: string): Promise<boolean> => {
      return (await get(`/txs/${txId}`)) !== null;
    },
    indexed: async (address: string, txId: string): Promise<boolean> => {
      const utxos = await get<{ tx_hash: string }[]>(`/addresses/${address}/utxos?order=desc&count=100`);
      return (utxos ?? []).some((utxo) => utxo.tx_hash === txId);
    },
    paid: async (txId: string, fromAddress: string, toAddress: string): Promise<bigint | null> => {
      const utxos = await get<TxUtxos>(`/txs/${txId}/utxos`);
      if (!utxos) return null;
      if (!utxos.inputs.some((input) => input.address === fromAddress)) return 0n;
      return utxos.outputs
        .filter((output) => output.address === toAddress)
        .reduce((sum, output) => sum + lovelaceOf(output.amount), 0n);
    },
  };
};
