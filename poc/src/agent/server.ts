import { BALANCED } from "../ai/fallback.js";
import { openBrain } from "../ai/gemini.js";
import { showAda } from "../common/ada.js";
import type { Config } from "../common/config.js";
import type {
  AgentReply,
  AgentReport,
  AgentRequest,
  AgentState,
  BrokerAccount,
  BrokerPush,
  BrokerReply,
  BrokerRequest,
  Strategy,
  TradeIdea,
} from "../common/interface.js";
import { errorText, log, sleep } from "../common/time.js";
import { openWallet } from "../chain/cardano.js";
import { openAgentStore, openLedger } from "../db/pg.js";
import { valueOf } from "../broker/market.js";
import { connect, serve } from "../link/ws.js";

const WINDOW = 120;
const MIN_OUTPUT = 1_000_000n;
const RETRY_MS = 15_000;
const WITHDRAW_TIMEOUT_MS = 20 * 60_000;

export const startAgent = async (config: Config): Promise<void> => {
  const role = config.asset;
  const store = openAgentStore(config.databaseUrl);
  const ledger = openLedger(config.databaseUrl);
  const wallet = openWallet({
    role,
    mnemonic: config.mnemonics[role],
    ledger,
    settings: { blockfrostUrl: config.blockfrostUrl, blockfrostProjectId: config.blockfrostProjectId },
  });
  const brain = openBrain({ apiKey: config.geminiApiKey, model: config.geminiModel, role });
  const broker = connect<BrokerRequest, BrokerReply, BrokerPush>(config.brokerUrl);
  const prices: number[] = [];
  broker.onPush((message) => {
    const tick = message.ticks.find((item) => item.asset === role);
    if (!tick) return;
    prices.push(tick.price);
    if (prices.length > WINDOW) prices.shift();
  });

  let state: AgentState = (await store.load(role)) ?? {
    role,
    phase: "idle",
    cycleId: null,
    strategy: null,
    deposited: 0n,
    withdrawn: 0n,
    experience: "",
  };
  const save = async (patch: Partial<AgentState>): Promise<void> => {
    state = { ...state, ...patch };
    await store.save(state);
  };

  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };

  const account = async (): Promise<{ account: BrokerAccount; price: number }> => {
    const reply = await broker.request({ type: "account", role });
    if (reply.type !== "account") throw new Error("broker answered with the wrong message");
    return { account: reply.account, price: reply.price };
  };

  let trading: { stop: () => Promise<void> } | null = null;
  let depositing: Promise<void> | null = null;
  let stopRequested = false;

  const decideOnce = async (): Promise<void> => {
    const { account: current, price } = await account();
    await store.snapshot({ role, cash: current.cash, qty: current.qty, price, value: valueOf(current, price) });
    const think = (idea: TradeIdea): Promise<void> => {
      const at = Date.now();
      return store.think(role, { ...idea, price, at: new Date(at).toISOString(), nextAt: new Date(at + config.decideMs).toISOString() });
    };
    if (prices.length < 10) {
      await think({ side: "hold", fraction: 0, reason: "Watching the first prices before acting." });
      return;
    }
    const idea = await brain.trade({
      asset: role,
      strategy: state.strategy ?? BALANCED,
      prices: [...prices],
      cash: current.cash,
      qty: current.qty,
      entryValue: state.deposited,
    });
    await think(idea);
    if (idea.side === "hold" || idea.fraction <= 0) return;
    const reply = await broker.request({
      type: "order",
      role,
      cycleId: state.cycleId,
      side: idea.side,
      fraction: idea.fraction,
      reason: idea.reason,
    });
    if (reply.type === "filled" && reply.fill) {
      log(role, `${reply.fill.side} ${reply.fill.qty.toFixed(8)} at ${reply.fill.price.toFixed(2)}: ${idea.reason}`);
    }
  };

  const beginTrading = (): void => {
    if (trading) return;
    const abort = new AbortController();
    let running = true;
    const loop = (async () => {
      while (running && state.phase === "trading") {
        try {
          await decideOnce();
        } catch (error) {
          log(role, `trade step failed: ${errorText(error)}`);
        }
        await sleep(config.decideMs, abort.signal);
      }
    })();
    trading = {
      stop: async () => {
        running = false;
        abort.abort();
        await loop;
      },
    };
    log(role, `trading with ${state.strategy?.stance ?? "balanced"} strategy`);
  };

  const deposit = async (): Promise<void> => {
    const cycleId = state.cycleId ?? 0;
    const transferId = `c${cycleId}-deposit-${role}`;
    while (state.phase === "depositing") {
      try {
        const row = await ledger.find(transferId);
        if (!row) {
          if (stopRequested) {
            await save({ phase: "idle" });
            return;
          }
          const amount = (await wallet.balance()) - config.walletReserve;
          if (amount < MIN_OUTPUT) {
            const { account: current, price } = await account();
            await save({ phase: "trading", deposited: valueOf(current, price) });
            break;
          }
          log(role, `depositing ${showAda(amount)} to broker`);
        }
        const result = await wallet.send({
          transferId,
          cycleId,
          kind: "deposit",
          toRole: "broker",
          toAddress: config.addresses.broker,
          amount: row?.amount ?? (await wallet.balance()) - config.walletReserve,
        });
        if (result.status !== "confirmed" || !result.txId) throw new Error(result.detail ?? `deposit ${result.status}`);
        const reply = await broker.request({ type: "deposit", role, txId: result.txId }, 60_000);
        if (reply.type !== "account") throw new Error("broker answered with the wrong message");
        await save({ phase: "trading", deposited: valueOf(reply.account, reply.price) });
      } catch (error) {
        log(role, `deposit retry: ${errorText(error)}`);
        await sleep(RETRY_MS);
      }
    }
    if (state.phase === "trading" && !stopRequested) beginTrading();
  };

  const withdraw = async (): Promise<void> => {
    const cycleId = state.cycleId ?? 0;
    const transferId = `c${cycleId}-withdraw-${role}`;
    const reply = await broker.request({ type: "withdraw", role, cycleId, transferId }, WITHDRAW_TIMEOUT_MS);
    if (reply.type !== "withdrawn") throw new Error("broker answered with the wrong message");
    if (reply.result.status !== "confirmed") throw new Error(`withdraw ${reply.result.status}: ${reply.result.detail ?? ""}`);
    const { account: left, price } = await account();
    const withdrawn = reply.amount + valueOf(left, price);
    const fills = await store.fills(role, cycleId);
    const experience = await brain.experience({ asset: role, fills, pnl: withdrawn - state.deposited, deposited: state.deposited });
    await save({ phase: "idle", withdrawn, experience });
    log(role, `withdrew ${showAda(reply.amount)}, result ${showAda(withdrawn - state.deposited)}`);
  };

  const report = async (): Promise<AgentReport> => {
    const cycleId = state.cycleId;
    const fills = cycleId == null ? [] : await store.fills(role, cycleId);
    let withdrawn = state.withdrawn;
    if (state.phase === "trading") {
      const { account: current, price } = await account();
      withdrawn = valueOf(current, price);
    }
    return {
      role,
      phase: state.phase,
      cycleId,
      wallet: await wallet.balance(),
      deposited: state.deposited,
      withdrawn,
      pnl: state.deposited > 0n ? withdrawn - state.deposited : 0n,
      trades: fills.length,
      experience: state.experience,
    };
  };

  const stop = async (): Promise<AgentReport> => {
    stopRequested = true;
    if (depositing) await depositing;
    if (state.phase === "trading") {
      await trading?.stop();
      trading = null;
      await save({ phase: "withdrawing" });
    }
    if (state.phase === "withdrawing") await withdraw();
    return report();
  };

  const start = async (cycleId: number, strategy: Strategy): Promise<AgentReply> => {
    if (state.phase !== "idle") {
      if (state.cycleId === cycleId) return { type: "started" };
      throw new Error(`${role} is ${state.phase} in cycle ${state.cycleId}, stop it first`);
    }
    stopRequested = false;
    await save({ phase: "depositing", cycleId, strategy, deposited: 0n, withdrawn: 0n });
    depositing = deposit().finally(() => {
      depositing = null;
    });
    return { type: "started" };
  };

  const handle = async (request: AgentRequest): Promise<AgentReply> => {
    if (request.type === "report") return { type: "report", report: await report() };
    if (request.type === "stop") return serial(async () => ({ type: "report", report: await stop() }));
    if (request.type === "start") return serial(() => start(request.cycleId, request.strategy));
    return serial(async () => {
      if (state.phase !== "idle") throw new Error(`${role} cannot send while ${state.phase}`);
      const result = await wallet.send({
        transferId: request.transferId,
        cycleId: request.cycleId,
        kind: "rebalance",
        toRole: "manager",
        toAddress: config.addresses.manager,
        amount: request.amount,
      });
      log(role, `sent ${showAda(request.amount)} to manager: ${result.status}`);
      return { type: "sent", result };
    });
  };

  serve<AgentRequest, AgentReply, never>(config.port, handle);
  log(role, `listening on ${config.port}, wallet ${wallet.address}, phase ${state.phase}`);

  if (state.phase === "depositing") {
    depositing = deposit().finally(() => {
      depositing = null;
    });
  }
  if (state.phase === "trading") beginTrading();
};
