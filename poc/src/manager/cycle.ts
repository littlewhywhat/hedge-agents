import { EQUAL, fallbackTrends } from "../ai/fallback.js";
import type { Brain } from "../ai/interface.js";
import { ada, showAda } from "../common/ada.js";
import type { Config } from "../common/config.js";
import { ASSETS, type AgentReply, type AgentReport, type AgentRequest, type Asset, type Cycle } from "../common/interface.js";
import { errorText, log, sleep } from "../common/time.js";
import type { Wallet } from "../chain/interface.js";
import type { ManagerStore } from "../db/interface.js";
import type { Peer } from "../link/interface.js";
import { capWeights, planMoves } from "./allocate.js";

const STOP_TIMEOUT_MS = 30 * 60_000;
const TRANSFER_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 60_000;
const RETRY_MS = 15_000;
const HALT_ATTEMPTS = 6;
const MIN_TRANSFER = ada(2);

export type AgentPeers = Record<Asset, Peer<AgentRequest, AgentReply, never>>;

export type Manager = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { looping: boolean; halting: boolean };
};

export const createManager = (deps: {
  config: Config;
  store: ManagerStore;
  wallet: Wallet;
  brain: Brain;
  agents: AgentPeers;
}): Manager => {
  const { config, store, wallet, brain, agents } = deps;
  let abort: AbortController | null = null;
  let loop: Promise<void> | null = null;
  let halting: Promise<void> | null = null;

  const stopAll = async (cycleId: number): Promise<AgentReport[]> => {
    return Promise.all(
      ASSETS.map(async (asset) => {
        const reply = await agents[asset].request({ type: "stop", cycleId }, STOP_TIMEOUT_MS);
        if (reply.type !== "report") throw new Error(`${asset} answered stop with ${reply.type}`);
        await store.saveReport(cycleId, reply.report);
        return reply.report;
      }),
    );
  };

  const step = async (cycle: Cycle, signal: AbortSignal): Promise<Cycle> => {
    switch (cycle.phase) {
      case "stopping": {
        log("manager", `cycle ${cycle.id}: stopping agents`);
        await stopAll(cycle.id);
        return store.updateCycle(cycle.id, { phase: "trends", error: null });
      }
      case "trends": {
        log("manager", `cycle ${cycle.id}: reading trends`);
        const trends = await brain.trends();
        return store.updateCycle(cycle.id, { phase: "deciding", trends, error: null });
      }
      case "deciding": {
        const reports = await store.reports(cycle.id);
        const decision = await brain.allocate({ weights: cycle.weightsBefore, reports, trends: cycle.trends ?? fallbackTrends() });
        const weights = capWeights(cycle.weightsBefore, decision.weights);
        const cash = config.fund + (await store.netRebalanced());
        const wallets = Object.fromEntries(ASSETS.map((asset) => [asset, reports.find((report) => report.role === asset)?.wallet ?? 0n])) as Record<Asset, bigint>;
        const moves = planMoves({ weights, cash, wallets, reserve: config.walletReserve, minTransfer: MIN_TRANSFER });
        log("manager", `cycle ${cycle.id}: ${decision.source} weights ${JSON.stringify(weights)}, ${moves.length} moves, cash ${showAda(cash)}`);
        return store.updateCycle(cycle.id, {
          phase: "collecting",
          weightsAfter: weights,
          strategies: decision.strategies,
          rationale: decision.rationale,
          source: decision.source,
          moves,
          error: null,
        });
      }
      case "collecting": {
        const collects = (cycle.moves ?? []).filter((move) => move.direction === "collect");
        await Promise.all(
          collects.map(async (move) => {
            const reply = await agents[move.asset].request(
              { type: "transfer", transferId: `c${cycle.id}-collect-${move.asset}`, cycleId: cycle.id, amount: move.amount },
              TRANSFER_TIMEOUT_MS,
            );
            if (reply.type !== "sent" || reply.result.status !== "confirmed") {
              throw new Error(`${move.asset} -> manager not confirmed: ${reply.type === "sent" ? reply.result.detail : reply.type}`);
            }
          }),
        );
        return store.updateCycle(cycle.id, { phase: "funding", error: null });
      }
      case "funding": {
        for (const move of (cycle.moves ?? []).filter((item) => item.direction === "fund")) {
          const result = await wallet.send({
            transferId: `c${cycle.id}-fund-${move.asset}`,
            cycleId: cycle.id,
            kind: "rebalance",
            toRole: move.asset,
            toAddress: config.addresses[move.asset],
            amount: move.amount,
          });
          if (result.status !== "confirmed") throw new Error(`manager -> ${move.asset} not confirmed: ${result.detail ?? result.status}`);
          log("manager", `funded ${move.asset} ${showAda(move.amount)}`);
        }
        return store.updateCycle(cycle.id, { phase: "starting", error: null });
      }
      case "starting": {
        await Promise.all(
          ASSETS.map(async (asset) => {
            const strategy = cycle.strategies?.[asset];
            if (!strategy) throw new Error(`no strategy for ${asset}`);
            await agents[asset].request({ type: "start", cycleId: cycle.id, strategy }, START_TIMEOUT_MS);
          }),
        );
        const nextAt = new Date(Date.now() + config.cycleMs).toISOString();
        await store.setState({ nextAt });
        log("manager", `cycle ${cycle.id}: agents trading until ${nextAt}`);
        return store.updateCycle(cycle.id, { phase: "running", error: null });
      }
      case "running": {
        const { nextAt } = await store.state();
        const wait = nextAt ? new Date(nextAt).getTime() - Date.now() : 0;
        if (wait > 0) await sleep(wait, signal);
        if (signal.aborted) return cycle;
        await store.updateCycle(cycle.id, { phase: "done", finishedAt: new Date().toISOString() });
        const next = await store.openCycle(cycle.weightsAfter ?? cycle.weightsBefore);
        await store.setState({ cycleId: next.id, nextAt: null });
        return next;
      }
      default:
        return cycle;
    }
  };

  const current = async (): Promise<Cycle> => {
    const last = await store.lastCycle();
    if (last && last.phase !== "done" && last.phase !== "halted") return last;
    const next = await store.openCycle(last?.weightsAfter ?? last?.weightsBefore ?? EQUAL);
    await store.setState({ cycleId: next.id, nextAt: null });
    return next;
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    let cycle = await current();
    while (!signal.aborted) {
      try {
        cycle = await step(cycle, signal);
      } catch (error) {
        log("manager", `cycle ${cycle.id} ${cycle.phase} failed, retrying: ${errorText(error)}`);
        cycle = await store.updateCycle(cycle.id, { error: errorText(error) });
        await sleep(RETRY_MS, signal);
      }
    }
  };

  const halt = async (): Promise<void> => {
    const last = await store.lastCycle();
    if (!last) return;
    if (last.phase !== "done" && last.phase !== "halted") {
      await store.updateCycle(last.id, { phase: "halted", finishedAt: new Date().toISOString() });
    }
    await store.setState({ nextAt: null });
    for (let attempt = 1; attempt <= HALT_ATTEMPTS; attempt++) {
      try {
        await stopAll(last.id);
        log("manager", "all agents stopped and withdrawn");
        return;
      } catch (error) {
        log("manager", `stop attempt ${attempt} failed: ${errorText(error)}`);
        await sleep(RETRY_MS);
      }
    }
  };

  const begin = (): void => {
    abort = new AbortController();
    loop = run(abort.signal).finally(() => {
      loop = null;
    });
  };

  return {
    start: async () => {
      if (loop) throw new Error("manager is already running");
      if (halting) throw new Error("manager is still stopping agents");
      await store.setState({ running: true });
      begin();
    },
    stop: async () => {
      await store.setState({ running: false });
      abort?.abort();
      if (halting) return;
      halting = (async () => {
        await loop;
        await halt();
      })().finally(() => {
        halting = null;
      });
    },
    status: () => ({ looping: loop !== null, halting: halting !== null }),
  };
};
