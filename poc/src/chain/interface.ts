import type { Role, SendResult, TransferKind } from "../common/interface.js";

export type SendInput = {
  transferId: string;
  cycleId: number | null;
  kind: TransferKind;
  toRole: Role;
  toAddress: string;
  amount: bigint;
};

export type Wallet = {
  role: Role;
  address: string;
  balance(): Promise<bigint>;
  send(input: SendInput): Promise<SendResult>;
  received(txId: string, fromAddress: string): Promise<bigint | null>;
};

export type ChainSettings = {
  blockfrostUrl: string;
  blockfrostProjectId: string;
};
