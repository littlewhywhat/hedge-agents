import express from "express";
import pg from "pg";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactCardanoScheme as CardanoClient } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as CardanoFacilitator } from "@x402/cardano/exact/facilitator";
import { toClientCardanoSigner, toFacilitatorCardanoSigner } from "@x402/cardano";
import type { Config } from "./config.js";
import { dottedUnit } from "./types.js";
import type { SendResult } from "./types.js";

const { Pool } = pg;
const NETWORK = "cardano:preprod";

type Claim = {
  transfer_id: string;
  payload: { paymentPayload: PaymentPayload; requirements: PaymentRequirements } | null;
  tx_id: string | null;
  status: string;
  detail: string | null;
};

function missing(config: Config, fromRole: string): string[] {
  const gaps: string[] = [];
  if (!config.blockfrostProjectId) gaps.push("BLOCKFROST_PROJECT_ID");
  const mnemonic = config.mnemonics[fromRole as keyof Config["mnemonics"]];
  if (!mnemonic) gaps.push(`MNEMONIC_${fromRole.toUpperCase()}`);
  return gaps;
}

async function observe(config: Config, txId: string): Promise<SendResult> {
  if (!config.blockfrostProjectId) {
    return { status: "pending", txId, detail: "blockfrost_unconfigured" };
  }
  const response = await fetch(`${config.blockfrostUrl}/txs/${txId}`, {
    headers: { project_id: config.blockfrostProjectId },
  });
  if (response.status === 200) return { status: "confirmed", txId, detail: null };
  if (response.status === 404) return { status: "pending", txId, detail: "settlement_pending" };
  return { status: "pending", txId, detail: `blockfrost_${response.status}` };
}

function fromSettle(settled: SettleResponse): SendResult {
  const txId = settled.transaction || null;
  if (settled.success) return { status: "confirmed", txId, detail: null };
  if (settled.errorReason === "settlement_pending" && txId) {
    return { status: "pending", txId, detail: "settlement_pending" };
  }
  return {
    status: "failed",
    txId,
    detail: settled.errorReason ?? settled.errorMessage ?? "settlement_failed",
  };
}

export function startFacilitator(config: Config): void {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, chain: Boolean(config.blockfrostProjectId) });
  });

  app.post("/send", async (req, res) => {
    const transferId = String(req.body.transferId ?? "");
    const fromRole = String(req.body.fromRole ?? "");
    const toAddress = String(req.body.toAddress ?? "");
    const amount = String(req.body.amount ?? "");
    if (!transferId || !fromRole || !toAddress || !amount) {
      res.status(400).json({ status: "failed", txId: null, detail: "transferId, fromRole, toAddress, and amount are required" });
      return;
    }

    const existing = await pool.query<Claim>("select * from facilitator_claims where transfer_id = $1", [transferId]);
    const claim = existing.rows[0];
    if (claim?.tx_id) {
      const observed = await observe(config, claim.tx_id);
      await pool.query("update facilitator_claims set status = $2, detail = $3 where transfer_id = $1", [
        transferId,
        observed.status,
        observed.detail,
      ]);
      res.json(observed);
      return;
    }

    const gaps = missing(config, fromRole);
    if (gaps.length > 0 && !claim?.payload) {
      res.status(503).json({ status: "pending", txId: null, detail: `facilitator_unconfigured:${gaps.join(",")}` });
      return;
    }

    try {
      const provider = { blockfrost: { baseUrl: config.blockfrostUrl, projectId: config.blockfrostProjectId } };
      const facilitator = new CardanoFacilitator(
        toFacilitatorCardanoSigner({ network: NETWORK, provider, awaitConfirmation: false }),
      );
      let paymentPayload = claim?.payload?.paymentPayload;
      let requirements = claim?.payload?.requirements;
      if (!paymentPayload || !requirements) {
        requirements = {
          scheme: "exact",
          network: NETWORK,
          asset: dottedUnit(config.unit),
          amount,
          payTo: toAddress,
          maxTimeoutSeconds: 300,
          extra: { assetTransferMethod: "default" },
        };
        const client = new CardanoClient(
          toClientCardanoSigner({ mnemonic: config.mnemonics[fromRole as keyof Config["mnemonics"]], network: NETWORK, provider }),
        );
        const created = await client.createPaymentPayload(2, requirements);
        paymentPayload = { x402Version: created.x402Version, accepted: requirements, payload: created.payload };
        await pool.query(
          `insert into facilitator_claims (transfer_id, from_role, to_address, amount, payload, status)
           values ($1, $2, $3, $4, $5, 'signing')
           on conflict (transfer_id) do update set payload = excluded.payload`,
          [transferId, fromRole, toAddress, amount, { paymentPayload, requirements }],
        );
      }
      const settled = await facilitator.settle(paymentPayload, requirements);
      const result = fromSettle(settled);
      await pool.query("update facilitator_claims set tx_id = $2, status = $3, detail = $4 where transfer_id = $1", [
        transferId,
        result.txId,
        result.status,
        result.detail,
      ]);
      res.status(result.status === "failed" ? 422 : 200).json(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "send_failed";
      await pool.query(
        `insert into facilitator_claims (transfer_id, from_role, to_address, amount, status, detail)
         values ($1, $2, $3, $4, 'failed', $5)
         on conflict (transfer_id) do update set status = 'failed', detail = excluded.detail`,
        [transferId, fromRole, toAddress, amount, detail],
      );
      res.status(422).json({ status: "failed", txId: null, detail });
    }
  });

  app.listen(config.port, () => {
    console.log(`facilitator listening on ${config.port}`);
  });
}
