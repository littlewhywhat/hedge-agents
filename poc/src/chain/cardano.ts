import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { toClientCardanoSigner, toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as CardanoClient } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as CardanoFacilitator } from "@x402/cardano/exact/facilitator";
import type { Role, SendResult } from "../common/interface.js";
import { errorText, sleep } from "../common/time.js";
import type { Ledger } from "../db/interface.js";
import { blockfrost } from "./blockfrost.js";
import type { ChainSettings, SendInput, Wallet } from "./interface.js";
import { addressOf } from "./keys.js";

const NETWORK = "cardano:preprod";
const POLL_MS = 5000;
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
const INDEX_TIMEOUT_MS = 90_000;
const STALE_RETRIES = 4;
const STALE_WAIT_MS = 10_000;
const STALE_UTXO = /nonce_not_on_chain|BadInputsUTxO|input.*spent/i;

const queue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
};

const fromSettle = (settled: SettleResponse): SendResult => {
  const txId = settled.transaction || null;
  if (settled.success) return { status: "pending", txId, detail: null };
  if (settled.errorReason === "settlement_pending" && txId) return { status: "pending", txId, detail: null };
  return { status: "failed", txId, detail: settled.errorReason ?? settled.errorMessage ?? "settlement_failed" };
};

export const openWallet = (input: { role: Role; mnemonic: string; ledger: Ledger; settings: ChainSettings }): Wallet => {
  const { role, mnemonic, ledger, settings } = input;
  if (!mnemonic) throw new Error(`MNEMONIC_${role.toUpperCase()} is required`);
  if (!settings.blockfrostProjectId) throw new Error("BLOCKFROST_PROJECT_ID is required");
  const address = addressOf(mnemonic);
  const api = blockfrost(settings);
  const provider = { blockfrost: { baseUrl: settings.blockfrostUrl, projectId: settings.blockfrostProjectId } };
  const client = new CardanoClient(toClientCardanoSigner({ mnemonic, network: NETWORK, provider }));
  const facilitator = new CardanoFacilitator(toFacilitatorCardanoSigner({ network: NETWORK, provider, awaitConfirmation: false }));
  const serial = queue();

  const settleIndex = async (txId: string): Promise<void> => {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await api.indexed(address, txId).catch(() => false)) return;
      await sleep(POLL_MS);
    }
  };

  const confirm = async (transferId: string, txId: string): Promise<SendResult> => {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await api.included(txId).catch(() => false)) {
        await settleIndex(txId);
        await ledger.update(transferId, { status: "confirmed", txId, detail: null });
        return { status: "confirmed", txId, detail: null };
      }
      await sleep(POLL_MS);
    }
    await ledger.update(transferId, { status: "pending", txId, detail: "confirmation_timeout" });
    return { status: "pending", txId, detail: "confirmation_timeout" };
  };

  const submit = async (send: SendInput): Promise<SendResult> => {
    const existing = await ledger.find(send.transferId);
    if (existing?.status === "confirmed") return { status: "confirmed", txId: existing.txId, detail: existing.detail };
    if (existing?.txId && existing.status !== "failed") return confirm(send.transferId, existing.txId);
    const amount = existing?.amount ?? send.amount;
    if (!existing) {
      await ledger.begin({ id: send.transferId, cycleId: send.cycleId, kind: send.kind, fromRole: role, toRole: send.toRole, toAddress: send.toAddress, amount });
    }
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      asset: "lovelace",
      amount: amount.toString(),
      payTo: existing?.toAddress ?? send.toAddress,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "default" },
    };
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(requirements);
      if (result.status === "failed" && STALE_UTXO.test(result.detail ?? "") && attempt < STALE_RETRIES) {
        await sleep(STALE_WAIT_MS);
        continue;
      }
      await ledger.update(send.transferId, result);
      if (result.status === "failed" || !result.txId) return result;
      return confirm(send.transferId, result.txId);
    }
  };

  const attemptOnce = async (requirements: PaymentRequirements): Promise<SendResult> => {
    try {
      const created = await client.createPaymentPayload(2, requirements);
      const payload = { x402Version: created.x402Version, accepted: requirements, payload: created.payload };
      return fromSettle(await facilitator.settle(payload, requirements));
    } catch (error) {
      return { status: "failed", txId: null, detail: errorText(error) };
    }
  };

  return {
    role,
    address,
    balance: () => api.balance(address),
    send: (send) => serial(() => submit(send)),
    received: (txId, fromAddress) => api.paid(txId, fromAddress, address),
  };
};
