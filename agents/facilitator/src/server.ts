import { createHash, randomUUID } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler, Request } from "express";
import { Pool, type PoolClient } from "pg";
import { canonicalize } from "./stable.js";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { decodeCardanoTransaction, toClientCardanoSigner, toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as ClientScheme } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as FacilitatorScheme } from "@x402/cardano/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { authenticate, capitalRequirements, checkCapitalWallet, checkControls, qualificationScope, Rejected, type Qualification } from "./security.js";

const environment = process.env.ENVIRONMENT || "preprod";
const expectedCluster = environment === "preprod" ? "devnet" : "mainnet";
if (!["preprod", "mainnet"].includes(environment) || process.env.CARDANO_NETWORK !== environment || process.env.SOLANA_CLUSTER !== expectedCluster) throw new Error("Facilitator network configuration is inconsistent");
if (!process.env.DATABASE_URL) throw new Error("A signer-scoped Postgres URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace("postgresql+psycopg://", "postgresql://"), max: 8 });
const hashes = JSON.parse(process.env.SERVICE_TOKEN_HASHES_JSON || "{}") as Record<string, string>;
const blockfrostKey = process.env.BLOCKFROST_PROJECT_ID || "";
const provider = { blockfrost: { baseUrl: `https://cardano-${environment}.blockfrost.io/api/v0`, projectId: blockfrostKey } };
const scheme = new FacilitatorScheme(toFacilitatorCardanoSigner({ network: `cardano:${environment}`, provider, awaitConfirmation: false }), { confirmationTimeoutMs: 75000, confirmationPollMs: 5000 });
const input = z.object({ parent_id: z.string().min(1).max(128), leg: z.string().min(1).max(128) }).strict();
type Attempt = { id: string; wallet_id: string; parent_id: string; leg: string; state: string; tx_id: string; signed_bytes: Buffer; reserved_inputs: string[]; created_at: Date; validity: { requirements: PaymentRequirements; nonce: string; ttl_slot: string; output_index: number }; confirmation: Record<string, unknown> | null };
type WalletRow = { id: string; agent_id: string; role: string; chain: string; signer: string; environment: string; address: string };
type Leg = { id: string; state: string; kind: string; agent: string; sender: string; receiver: string; amount_raw: string; attempt_id?: string };

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function event(client: PoolClient, kind: string, payload: Record<string, unknown>) {
  const head = (await client.query("SELECT * FROM audit_heads WHERE id = 1 FOR UPDATE")).rows[0];
  if (!head) throw new Rejected("Audit head unavailable", 503);
  const row = { id: head.sequence + 1, time: new Date().toISOString(), kind, payload, prev_hash: head.hash };
  const hash = createHash("sha256").update(canonicalize(row)).digest("hex");
  await client.query("INSERT INTO events (id, time, kind, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6)", [row.id, row.time, kind, JSON.stringify(payload), head.hash, hash]);
}

function publicAttempt(attempt: Attempt) {
  return { id: attempt.id, wallet_id: attempt.wallet_id, parent_id: attempt.parent_id, leg: attempt.leg, state: attempt.state, tx_id: attempt.tx_id, chain: "cardano", locator: String(attempt.validity.output_index), confirmation: attempt.confirmation };
}

async function gatePassed(client: PoolClient, bounded = false): Promise<boolean> {
  const required = bounded && environment === "preprod" ? ["offline_acceptance"] : ["offline_acceptance", "preprod_registry", "preprod_escrow", "preprod_x402", "devnet_transfer", "adapter_recovery", ...(environment === "mainnet" && !bounded ? ["mainnet_qualification"] : [])];
  const rows = await client.query("SELECT id FROM gate_evidence WHERE passed = true AND id = ANY($1::text[])", [required]);
  return rows.rowCount === required.length;
}

async function qualificationAllowed(client: PoolClient, controls: { state?: { qualification?: Qualification } } | undefined, caller: string, parentId: string): Promise<boolean> {
  const qualification = controls?.state?.qualification;
  if (!qualification?.round_id) return false;
  const round = (await client.query("SELECT state,legs FROM allocation_rounds WHERE id=$1", [qualification.round_id])).rows[0];
  const intent = (await client.query("SELECT buyer_id,request_id,amount_raw FROM transfer_intents WHERE id=$1", [parentId])).rows[0];
  return qualificationScope(qualification, environment, caller, parentId, round?.state, round?.legs || [], intent);
}

async function registeredWallet(client: PoolClient, agent: string): Promise<WalletRow> {
  const wallet = (await client.query("SELECT * FROM wallets WHERE agent_id=$1 AND chain='cardano' AND role='capital' AND environment=$2 FOR UPDATE", [agent, environment])).rows[0];
  if (!wallet) throw new Rejected("Capital wallet is not registered", 422);
  return wallet;
}

async function prepare(caller: string, parentId: string, legId: string): Promise<Attempt> {
  return transaction(async (client) => {
    const controls = (await client.query("SELECT * FROM controls WHERE id=1 FOR UPDATE")).rows[0];
    const wallet = await registeredWallet(client, caller);
    checkCapitalWallet(wallet, caller, environment);
    const existing = (await client.query("SELECT * FROM chain_attempts WHERE wallet_id=$1 AND parent_id=$2 AND leg=$3 ORDER BY number DESC LIMIT 1", [wallet.id, parentId, legId])).rows[0] as Attempt | undefined;
    if (existing) return existing;
    const unresolved = await client.query("SELECT id FROM chain_attempts WHERE wallet_id=$1 AND state IN ('prepared','submitted','unknown')", [wallet.id]);
    if (unresolved.rowCount) throw new Rejected("Wallet has an unresolved transaction");
    let destination = "", amount = "", existingObligation = false;
    const intent = (await client.query("SELECT * FROM transfer_intents WHERE id=$1 FOR UPDATE", [parentId])).rows[0];
    if (intent) {
      if (intent.environment !== environment) throw new Rejected("Intent belongs to a different environment", 403);
      if (legId === "source") {
        if (intent.buyer_id !== caller || intent.terms.source_wallet !== wallet.id || intent.direction !== "deposit_to_solana" || intent.state !== "awaiting_inbound" || intent.fee_state !== "FundsLocked" || new Date(intent.expires_at).getTime() <= Date.now()) throw new Rejected("Source principal is not admitted");
        destination = intent.terms.gateway_source_address;
      } else {
        if (caller !== "gateway" || !intent.receipt_id || !intent.protected) throw new Rejected("Payout or refund requires exclusively claimed inbound principal", 403);
        existingObligation = true;
        if (legId === "payout") {
          if (intent.direction !== "withdraw_to_cardano" || intent.state !== "inbound_confirmed" || !intent.reserved || intent.payout_attempt_id || intent.refund_attempt_id) throw new Rejected("No authorized Cardano payout");
          const quota = (await client.query("SELECT * FROM gateway_quota WHERE id=1 FOR UPDATE")).rows[0];
          const today = new Date().toISOString().slice(0, 10);
          const settled = quota.day === today ? BigInt(quota.settled_raw) : 0n;
          if (settled + BigInt(quota.active_raw) > BigInt(process.env.GATEWAY_DAILY_USD || "1000") * 1000000n) throw new Rejected("Current-day gateway quota blocks payout");
          destination = intent.terms.destination_address;
        } else if (legId === "refund") {
          if (intent.direction !== "deposit_to_solana" || !["refund_pending", "inbound_confirmed", "manual_review"].includes(intent.state)) throw new Rejected("No authorized Cardano refund");
          if (intent.payout_attempt_id) {
            const payout = (await client.query("SELECT state FROM chain_attempts WHERE id=$1", [intent.payout_attempt_id])).rows[0];
            if (payout?.state !== "failed") throw new Rejected("Original payout may still land; refund prohibited");
          }
          destination = intent.terms.refund_address;
        } else throw new Rejected("Unsupported intent leg", 422);
      }
      amount = String(intent.amount_raw);
    } else {
      const round = (await client.query("SELECT * FROM allocation_rounds WHERE id=$1 FOR UPDATE", [parentId])).rows[0];
      if (!round || !["planned", "executing", "partial"].includes(round.state)) throw new Rejected("No executable durable allocation round", 404);
      const legs = round.legs as Leg[];
      const index = legs.findIndex((leg) => leg.id === legId);
      const leg = legs[index];
      if (!leg || !["x402", "cashout"].includes(leg.kind) || (leg.sender || leg.agent) !== caller || leg.state === "settled" || legs.slice(0, index).some((previous) => previous.state !== "settled")) throw new Rejected("Allocation leg is not currently executable", 403);
      const policy = (await client.query("SELECT * FROM policies WHERE version=$1 AND status='active'", [round.policy_version])).rows[0];
      if (!policy || (leg.kind === "x402" && controls.state?.stops?.[leg.receiver]?.stopped)) throw new Rejected("Policy activation or daily stop blocks the receiving sleeve");
      const books = (await client.query("SELECT agent_id, body FROM books ORDER BY agent_id FOR UPDATE")).rows;
      const equities = new Map<string, Decimal>(books.map((book) => [book.agent_id, Object.values(book.body.assets).reduce<Decimal>((sum, value) => sum.add(String(value)), new Decimal(0)).sub(book.body.payable)]));
      const total = [...equities.values()].reduce((sum, value) => sum.add(value), new Decimal(0));
      const usd = new Decimal(leg.amount_raw).div(1000000);
      if (leg.kind === "cashout") {
        const senderBook = books.find((book) => book.agent_id === caller);
        const operator = (await client.query("SELECT address FROM wallets WHERE agent_id='operator' AND chain='cardano' AND role='distribution' AND environment=$1", [environment])).rows[0];
        if (round.reason !== "operator_cashout" || !operator || !senderBook || new Decimal(senderBook.body.assets.capital).lt(usd)) throw new Rejected("Cash-out exceeds available principal or lacks a registered operator destination");
        destination = operator.address;
      } else {
        const receiverEquity = equities.get(leg.receiver);
        if (!receiverEquity || total.lte(0) || receiverEquity.add(usd).div(total).gt(policy.body.agents[leg.receiver].cap)) throw new Rejected("Actual post-leg equity would breach a hard cap");
        const receiver = await registeredWallet(client, leg.receiver);
        destination = receiver.address;
      }
      const latest = (await client.query("SELECT * FROM value_snapshots WHERE agent_id=$1 ORDER BY sampled_at DESC LIMIT 1", [caller])).rows[0];
      if (!latest?.valid || Date.now() - new Date(latest.sampled_at).getTime() > 120000) throw new Rejected("Fresh reconciled valuation required");
      amount = leg.amount_raw;
    }
    const bounded = await qualificationAllowed(client, controls, caller, parentId);
    checkControls(controls ? { ...controls, armed: controls.armed || bounded } : undefined, existingObligation, existingObligation || await gatePassed(client, bounded));
    if (!blockfrostKey.startsWith(environment)) throw new Rejected("Network-matched Blockfrost key is missing", 503);
    const mnemonic = process.env[`${caller.toUpperCase()}_CAPITAL_MNEMONIC`];
    if (!mnemonic || mnemonic.trim().split(/\s+/).length !== 24) throw new Rejected("A distinct 24-word capital mnemonic is required", 503);
    const signer = toClientCardanoSigner({ mnemonic, network: `cardano:${environment}`, provider });
    if (signer.getAddress() !== wallet.address) throw new Rejected("Capital signer does not match the registered wallet", 403);
    const requirements = capitalRequirements(environment, destination, amount);
    const created = await new ClientScheme(signer).createPaymentPayload(2, requirements);
    const payloadBody = z.object({ transaction: z.string(), nonce: z.string() }).parse(created.payload);
    const decoded = decodeCardanoTransaction(payloadBody.transaction);
    if (!decoded.ttlSlot || !decoded.signaturesValid || !decoded.isValid || decoded.balanceChangingOperations.length) throw new Rejected("Signed transaction violates capital transfer constraints", 422);
    const outputIndex = decoded.outputs.findIndex((output) => output.address === destination && output.assets[requirements.asset] === BigInt(amount));
    if (outputIndex < 0) throw new Rejected("Signed output does not match the immutable payout", 422);
    const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: payloadBody };
    const verified = await scheme.verify(payload, requirements);
    if (!verified.isValid) throw new Rejected("x402 phase-one verification rejected the transaction", 422);
    const latestControls = (await client.query("SELECT * FROM controls WHERE id=1")).rows[0];
    checkControls(latestControls ? { ...latestControls, armed: latestControls.armed || bounded } : undefined, existingObligation, true);
    const id = randomUUID();
    const validity = { requirements, nonce: payloadBody.nonce, ttl_slot: String(decoded.ttlSlot), output_index: outputIndex };
    const attempt = (await client.query("INSERT INTO chain_attempts (id,wallet_id,parent_id,leg,number,state,chain,tx_id,signed_bytes,validity,reserved_inputs,created_at) VALUES ($1,$2,$3,$4,1,'prepared','cardano',$5,$6,$7,$8,NOW()) RETURNING *", [id, wallet.id, parentId, legId, decoded.txHash, Buffer.from(payloadBody.transaction, "base64"), JSON.stringify(validity), JSON.stringify(decoded.inputs)])).rows[0] as Attempt;
    if (intent) {
      if (legId === "source") await client.query("UPDATE transfer_intents SET source_attempt_id=$2 WHERE id=$1", [parentId, id]);
      if (legId === "payout") await client.query("UPDATE transfer_intents SET payout_attempt_id=$2,state='payout_pending' WHERE id=$1", [parentId, id]);
      if (legId === "refund") await client.query("UPDATE transfer_intents SET refund_attempt_id=$2,state='refund_pending' WHERE id=$1", [parentId, id]);
    }
    await event(client, "attempt_prepared", { attempt_id: id, parent_id: parentId, wallet: wallet.id, chain: "cardano", tx_id: decoded.txHash, leg: legId });
    return attempt;
  });
}

async function observe(attempt: Attempt): Promise<Attempt> {
  if (["confirmed", "failed"].includes(attempt.state)) return attempt;
  let observation: Record<string, unknown> = { state: "unknown", tx_id: attempt.tx_id };
  try {
    const response = await fetch(`${provider.blockfrost.baseUrl}/txs/${attempt.tx_id}`, { headers: { project_id: blockfrostKey }, signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      const body = await response.json() as { block: string; valid_contract: boolean; fees: string; block_height: number; block_time: number };
      const blockResponse = await fetch(`${provider.blockfrost.baseUrl}/blocks/${body.block}`, { headers: { project_id: blockfrostKey }, signal: AbortSignal.timeout(15000) });
      if (blockResponse.ok) {
        const block = await blockResponse.json() as { confirmations: number };
        if (block.confirmations >= 1 && body.valid_contract !== false) observation = { state: "confirmed", tx_id: attempt.tx_id, success: true, confirmed: true, block: body.block, block_time: body.block_time, fee_lovelace: body.fees, confirmations: block.confirmations };
      }
    } else if (response.status === 404 && attempt.validity.ttl_slot && attempt.reserved_inputs.length) {
      const wallet = (await pool.query("SELECT address FROM wallets WHERE id=$1", [attempt.wallet_id])).rows[0];
      const get = async (path: string) => {
        const result = await fetch(provider.blockfrost.baseUrl + path, { headers: { project_id: blockfrostKey }, signal: AbortSignal.timeout(15000) });
        if (!result.ok) throw new Rejected("Complete chain history unavailable", 503);
        return result.json();
      };
      const tip = await get("/blocks/latest") as { slot: number; hash: string };
      if (wallet && BigInt(tip.slot) > BigInt(attempt.validity.ttl_slot) + 180n) {
        const utxos = await get(`/addresses/${wallet.address}/utxos?count=100`) as { tx_hash: string; output_index: number }[];
        const history = await get(`/addresses/${wallet.address}/transactions?count=100&order=desc`) as { tx_hash: string; block_time: number }[];
        const completeHistory = history.length < 100 || history[history.length - 1].block_time < new Date(attempt.created_at).getTime() / 1000;
        const available = new Set(utxos.map((row) => `${row.tx_hash}#${row.output_index}`));
        if (completeHistory && !history.some((row) => row.tx_hash === attempt.tx_id) && attempt.reserved_inputs.every((reference) => available.has(reference))) {
          observation = { tx_id: attempt.tx_id, state: "failed", expired: true, history_checked: true, inputs_unspent: true, finality_reached: true, tip: tip.hash };
        }
      }
    }
  } catch { observation = { ...observation, error: "Provider unavailable; original transaction remains reserved" }; }
  return transaction(async (client) => {
    const current = (await client.query("SELECT * FROM chain_attempts WHERE id=$1 FOR UPDATE", [attempt.id])).rows[0] as Attempt;
    if (["confirmed", "failed"].includes(current.state)) return current;
    const updated = (await client.query("UPDATE chain_attempts SET state=$2,confirmation=$3 WHERE id=$1 RETURNING *", [attempt.id, observation.state, JSON.stringify(observation)])).rows[0] as Attempt;
    await event(client, "attempt_reconciled", { attempt_id: attempt.id, state: observation.state, chain: "cardano", tx_id: attempt.tx_id });
    return updated;
  });
}

async function broadcast(attempt: Attempt): Promise<Attempt> {
  const admitted = await transaction(async (client) => {
    const controls = (await client.query("SELECT * FROM controls WHERE id=1 FOR UPDATE")).rows[0];
    const intent = (await client.query("SELECT * FROM transfer_intents WHERE id=$1", [attempt.parent_id])).rows[0];
    const obligation = ["payout", "refund"].includes(attempt.leg) && Boolean(intent?.protected && intent?.receipt_id);
    const wallet = (await client.query("SELECT agent_id FROM wallets WHERE id=$1", [attempt.wallet_id])).rows[0];
    const bounded = await qualificationAllowed(client, controls, wallet?.agent_id || "", attempt.parent_id);
    checkControls(controls ? { ...controls, armed: controls.armed || bounded } : undefined, obligation, obligation || await gatePassed(client, bounded));
    if (attempt.leg === "source" && (!intent || intent.state !== "awaiting_inbound" || new Date(intent.expires_at).getTime() <= Date.now())) throw new Rejected("Source admission expired before broadcast");
    const updated = (await client.query("UPDATE chain_attempts SET state='submitted' WHERE id=$1 AND state='prepared' RETURNING *", [attempt.id])).rows[0] as Attempt | undefined;
    if (updated) await event(client, "attempt_submission_started", { attempt_id: attempt.id, tx_id: attempt.tx_id, chain: "cardano" });
    return updated;
  });
  if (!admitted) return observe(attempt);
  const payload: PaymentPayload = { x402Version: 2, accepted: admitted.validity.requirements, payload: { transaction: admitted.signed_bytes.toString("base64"), nonce: admitted.validity.nonce } };
  try { await scheme.settle(payload, admitted.validity.requirements); } catch { return observe(admitted); }
  return observe(admitted);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
const caller = (request: Request) => authenticate(request.header("X-Agent-Id"), request.header("Authorization"), hashes);
app.get("/health", async (_request, response) => {
  await pool.query("SELECT 1");
  response.json({ status: "ok", environment, rail: "cardano x402 exact/default", capital_signers_configured: ["btc", "eth", "gold", "stocks", "gateway"].filter((name) => Boolean(process.env[`${name.toUpperCase()}_CAPITAL_MNEMONIC`])).length });
});
app.post("/transfers", async (request, response) => {
  const identity = caller(request);
  const body = input.parse(request.body);
  const attempt = await prepare(identity, body.parent_id, body.leg);
  const result = attempt.state === "prepared" ? await broadcast(attempt) : await observe(attempt);
  response.status(result.state === "confirmed" ? 200 : 202).json(publicAttempt(result));
});
app.post("/attempts/:id/reconcile", async (request, response) => {
  const identity = caller(request);
  const row = (await pool.query("SELECT attempts.* FROM chain_attempts attempts JOIN wallets ON wallets.id=attempts.wallet_id WHERE attempts.id=$1 AND wallets.agent_id=$2 AND attempts.chain='cardano'", [request.params.id, identity])).rows[0] as Attempt | undefined;
  if (!row) throw new Rejected("Caller-owned attempt not found", 404);
  response.json(publicAttempt(await observe(row)));
});
const errors: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof Rejected) response.status(error.status).json({ detail: error.message });
  else if (error instanceof z.ZodError) response.status(422).json({ detail: "Invalid operation identity" });
  else response.status(503).json({ detail: "Facilitator operation unavailable; reconcile the original intent before retrying" });
};
app.use(errors);
const server = app.listen(Number(process.env.PORT || 8084), process.env.HOST || "127.0.0.1", () => console.log(`Cardano facilitator listening; ${environment}; no secret material is logged`));
let recovering = false;
const recovery = setInterval(async () => {
  if (recovering || !blockfrostKey) return;
  recovering = true;
  try {
    const rows = (await pool.query("SELECT * FROM chain_attempts WHERE chain='cardano' AND state IN ('prepared','submitted','unknown') ORDER BY created_at LIMIT 20")).rows as Attempt[];
    for (const attempt of rows) {
      try {
        if (attempt.state === "prepared") await broadcast(attempt);
        else await observe(attempt);
      } catch {
        console.error(`Recovery remains pending for ${attempt.id}; other obligations continue`);
      }
    }
  } catch { console.error("Cardano recovery unavailable; reservations remain held"); }
  finally { recovering = false; }
}, 20000);
process.on("SIGTERM", () => { clearInterval(recovery); server.close(() => void pool.end()); });