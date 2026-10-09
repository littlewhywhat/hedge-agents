import type { Transfer } from "../common/interface.js";
import type { Ledger } from "./interface.js";

export const memoryLedger = (): Ledger => {
  const rows = new Map<string, Transfer>();
  return {
    find: async (id) => rows.get(id) ?? null,
    begin: async (transfer) => {
      if (!rows.has(transfer.id)) rows.set(transfer.id, { ...transfer, status: "signing", txId: null, detail: null });
    },
    update: async (id, patch) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch, txId: patch.txId ?? row.txId });
    },
  };
};
