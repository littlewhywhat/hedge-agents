import express, { type NextFunction, type Request, type Response } from "express";
import pg from "pg";
import type { Config } from "./config.js";
import { ensureFund, PgStore } from "./pgstore.js";
import { confirmPending, seedDemo } from "./seed.js";
import { budgetTotal, runRound } from "./round.js";
import { createReportPurchase } from "./payment.js";
import { getJob, startReportJob } from "./jobs.js";
import type { Role, SendResult, Transfer } from "./types.js";
import { PREPROD_UNIT } from "./types.js";

const { Pool } = pg;

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(JSON.parse(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value))));
}

export async function startAgent(config: Config): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  await ensureFund(pool, {
    depositAddress: config.addresses.manager,
    unit: config.unit || PREPROD_UNIT,
    agents: (["manager", "crypto", "stocks"] as const).map((role) => ({
      role,
      cardanoAddress: config.addresses[role],
      agentIdentifier: config.agentIdentifiers[role],
      market: role === "manager" ? null : role,
      solanaAddress: role === "manager" ? null : "",
    })),
  });
  const store = new PgStore(pool);
  const app = express();
  app.use(express.json());

  function requireOperator(req: Request, res: Response, next: NextFunction): void {
    if (!config.operatorToken || req.header("authorization") !== `Bearer ${config.operatorToken}`) {
      res.status(401).json({ error: "operator token required" });
      return;
    }
    next();
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, role: config.role, masumiMode: config.masumiMode });
  });

  app.get("/availability", (_req, res) => {
    res.json({ status: config.role === "manager" ? "unavailable" : "available" });
  });

  app.get("/input_schema", (_req, res) => {
    res.json({ input_data: [{ id: "week", type: "string", name: "Week" }] });
  });

  app.post("/start_job", async (req, res) => {
    try {
      if (config.role === "manager") {
        sendJson(res, 400, { error: "the manager buys reports, it does not sell one" });
        return;
      }
      const week = String(req.body?.input_data?.week ?? "");
      const job = await startReportJob(store, config, week, req.body?.identifier_from_purchaser);
      sendJson(res, 200, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "start_job failed" });
    }
  });

  app.get("/status", (req, res) => {
    const job = getJob(String(req.query.job_id ?? req.query.jobId ?? ""));
    if (!job) {
      res.status(404).json({ error: "unknown job" });
      return;
    }
    sendJson(res, 200, job);
  });

  if (config.role !== "manager") {
    app.listen(config.port, () => console.log(`${config.role} listening on ${config.port}`));
    return;
  }

  app.get("/fund", async (_req, res) => {
    const fund = await store.getFund();
    const agents = await store.listAgents();
    sendJson(res, 200, { ...fund, budget: await budgetTotal(store), agents });
  });

  app.get("/rounds", async (_req, res) => {
    const rounds = await pool.query("select week, settled_at from rounds order by week");
    res.json({ rounds: rounds.rows });
  });

  app.post("/rounds", requireOperator, async (req, res) => {
    try {
      const week = String(req.body?.week ?? "");
      const body = await runRound(store, week, {
        send: (transfer, fromRole, toRole) => sendTransfer(config, store, transfer, fromRole, toRole),
        report: (role, roundWeek) => buyReport(config, role, roundWeek),
      });
      sendJson(res, 200, body);
    } catch (error) {
      sendJson(res, 409, { error: error instanceof Error ? error.message : "round failed" });
    }
  });

  app.post("/deposits", requireOperator, async (req, res) => {
    const amount = BigInt(req.body?.amount ?? "0");
    const txId = req.body?.txId ? String(req.body.txId) : null;
    if (amount <= 0n) {
      res.status(400).json({ error: "amount must be a positive integer of the budget token" });
      return;
    }
    const manager = await store.agentByRole("manager");
    const transfer = await store.insertTransfer({
      roundId: null,
      fromAgentId: null,
      toAgentId: manager.id,
      amount,
      status: txId ? "confirmed" : "pending",
      txId,
      detail: "deposit",
    });
    sendJson(res, 201, transfer);
  });

  app.post("/snapshots", requireOperator, async (req, res) => {
    const role = String(req.body?.role ?? "");
    if (role !== "crypto" && role !== "stocks" && role !== "manager") {
      res.status(400).json({ error: "role must be manager, crypto, or stocks" });
      return;
    }
    const agent = await store.agentByRole(role);
    await store.insertSnapshot({
      agentId: agent.id,
      sampledAt: String(req.body?.sampledAt),
      cardanoStablecoin: BigInt(req.body?.cardanoStablecoin ?? "0"),
      solanaUsdc: BigInt(req.body?.solanaUsdc ?? "0"),
      tokenUsd: BigInt(req.body?.tokenUsd ?? "0"),
    });
    res.status(201).json({ ok: true });
  });

  app.post("/demo/seed", requireOperator, async (_req, res) => {
    if (!config.demoSeed) {
      res.status(404).json({ error: "DEMO_SEED is not enabled" });
      return;
    }
    sendJson(res, 200, await seedDemo(store));
  });

  app.post("/demo/confirm-transfers", requireOperator, async (_req, res) => {
    if (!config.demoSeed) {
      res.status(404).json({ error: "DEMO_SEED is not enabled" });
      return;
    }
    const confirmed = await confirmPending(store);
    res.json({ confirmed, detail: "demo-confirm does not submit a Cardano transaction" });
  });

  app.listen(config.port, () => console.log(`manager listening on ${config.port}`));
}

async function buyReport(config: Config, role: "crypto" | "stocks", week: string) {
  const started = await fetch(`${config.peerUrl[role]}/start_job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier_from_purchaser: undefined, input_data: { week } }),
  });
  const job = (await started.json()) as {
    id?: string;
    status?: string;
    error?: string;
    performance?: { decayedReturn: number; volatility: number };
    resultHash?: string | null;
    blockchainIdentifier?: string | null;
    fee?: string;
    identifierFromPurchaser?: string;
    inputHash?: string | null;
    payByTime?: unknown;
    submitResultTime?: unknown;
    unlockTime?: unknown;
    externalDisputeUnlockTime?: unknown;
  };
  if (!started.ok || !job.id) throw new Error(job.error ?? `${role} start_job failed`);
  if (config.masumiMode === "live") {
    await createReportPurchase({
      url: config.paymentServiceUrl,
      apiKey: config.paymentApiKey,
      payment: job as unknown as Record<string, unknown>,
      sellerVkey: config.sellerVkeys[role],
      agentIdentifier: config.agentIdentifiers[role],
      unit: config.unit,
      fee: BigInt(job.fee ?? config.reportFee.toString()),
    });
  }
  const deadline = Date.now() + (config.masumiMode === "live" ? 180_000 : 5_000);
  while (Date.now() < deadline) {
    const status = await fetch(`${config.peerUrl[role]}/status?job_id=${job.id}`);
    const body = (await status.json()) as typeof job & { error: string | null };
    if (body.status === "completed" && body.performance) {
      return {
        performance: body.performance,
        fee: BigInt(body.fee ?? "0"),
        blockchainIdentifier: body.blockchainIdentifier ?? null,
        resultHash: body.resultHash ?? null,
      };
    }
    if (body.status === "failed") throw new Error(body.error ?? `${role} report failed`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${role} report was not ready`);
}

async function sendTransfer(
  config: Config,
  store: PgStore,
  transfer: Transfer,
  fromRole: Role,
  toRole: Role,
): Promise<SendResult> {
  const to = await store.agentByRole(toRole);
  if (!to.cardanoAddress) return { status: "pending", txId: transfer.txId, detail: "missing_address" };
  if (fromRole !== "manager") {
    const from = await store.agentByRole(fromRole);
    const snapshots = await store.snapshotsBefore(from.id, new Date(Date.now() + 1000).toISOString());
    const latest = snapshots.at(-1);
    if (latest && latest.cardanoStablecoin < transfer.amount) {
      const freed = await fetch(`${config.gatewayUrl}/free`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: fromRole, amount: transfer.amount.toString() }),
      });
      if (!freed.ok) return { status: "pending", txId: transfer.txId, detail: "needs_free" };
    }
  }
  let response: globalThis.Response;
  try {
    response = await fetch(`${config.facilitatorUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transferId: String(transfer.id),
        fromRole,
        toAddress: to.cardanoAddress,
        amount: transfer.amount.toString(),
      }),
    });
  } catch (error) {
    return { status: "pending", txId: transfer.txId, detail: error instanceof Error ? error.message : "facilitator_unreachable" };
  }
  const body = (await response.json()) as SendResult;
  return {
    status: body.status ?? "pending",
    txId: body.txId ?? null,
    detail: body.detail ?? null,
  };
}
