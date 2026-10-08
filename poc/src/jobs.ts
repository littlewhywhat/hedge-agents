import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { localReport } from "./round.js";
import { outputHash, purchaserId } from "./hash.js";
import { createReportPayment, paymentState, submitReportResult } from "./payment.js";
import type { Config } from "./config.js";
import type { MarketRole, Performance } from "./types.js";

export type Job = {
  id: string;
  status: "completed" | "awaiting_payment" | "running" | "failed";
  result: string | null;
  resultHash: string | null;
  performance: Performance | null;
  fee: bigint;
  error: string | null;
  blockchainIdentifier: string | null;
  identifierFromPurchaser: string;
  inputHash: string | null;
  payByTime: unknown;
  submitResultTime: unknown;
  unlockTime: unknown;
  externalDisputeUnlockTime: unknown;
};

const jobs = new Map<string, Job>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export async function startReportJob(store: Store, config: Config, week: string, identifier?: string): Promise<Job> {
  const role = config.role;
  if (role !== "crypto" && role !== "stocks") throw new Error("the manager does not sell a report");
  const purchaser = identifier && /^[0-9a-f]{14,26}$/i.test(identifier) ? identifier : purchaserId();
  const id = randomUUID();
  const point = await localReport(store, role, week);
  const result = JSON.stringify({ role, week, decayedReturn: point.decayedReturn, volatility: point.volatility });
  if (config.masumiMode === "local") {
    const job: Job = {
      id,
      status: "completed",
      result,
      resultHash: outputHash(purchaser, result),
      performance: point,
      fee: 0n,
      error: null,
      blockchainIdentifier: null,
      identifierFromPurchaser: purchaser,
      inputHash: null,
      payByTime: null,
      submitResultTime: null,
      unlockTime: null,
      externalDisputeUnlockTime: null,
    };
    jobs.set(id, job);
    return job;
  }

  const agentIdentifier = config.agentIdentifiers[role];
  if (agentIdentifier.length < 57) throw new Error(`AGENT_IDENTIFIER_${role.toUpperCase()} must be the registry id`);
  if (!config.paymentServiceUrl || !config.paymentApiKey) {
    throw new Error("PAYMENT_SERVICE_URL and PAYMENT_API_KEY are required when MASUMI_MODE=live");
  }
  const payment = await createReportPayment({
    url: config.paymentServiceUrl,
    apiKey: config.paymentApiKey,
    agentIdentifier,
    unit: config.unit,
    fee: config.reportFee,
    week,
    identifier: purchaser,
  });
  const job: Job = {
    id,
    status: "awaiting_payment",
    result: null,
    resultHash: null,
    performance: null,
    fee: config.reportFee,
    error: null,
    blockchainIdentifier: String(payment.blockchainIdentifier ?? ""),
    identifierFromPurchaser: purchaser,
    inputHash: String(payment.inputHash ?? ""),
    payByTime: payment.payByTime,
    submitResultTime: payment.submitResultTime,
    unlockTime: payment.unlockTime,
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
  };
  jobs.set(id, job);
  void watchPayment(config, job, role, week, result, point);
  return job;
}

async function watchPayment(
  config: Config,
  job: Job,
  role: MarketRole,
  week: string,
  result: string,
  point: Performance,
): Promise<void> {
  if (!job.blockchainIdentifier) return;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    try {
      const state = await paymentState(config.paymentServiceUrl, config.paymentApiKey, job.blockchainIdentifier);
      if (state === "FundsLocked" || state === "ResultSubmitted") {
        job.status = "running";
        const hash = outputHash(job.identifierFromPurchaser, result);
        await submitReportResult({
          url: config.paymentServiceUrl,
          apiKey: config.paymentApiKey,
          blockchainIdentifier: job.blockchainIdentifier,
          identifier: job.identifierFromPurchaser,
          result,
        });
        job.result = result;
        job.resultHash = hash;
        job.performance = point;
        job.status = "completed";
        return;
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : "payment_poll_failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  job.status = "failed";
  job.error = job.error ?? `payment for ${role} ${week} did not lock within 180s`;
}
