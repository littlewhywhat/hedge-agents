import { minBig, showAda } from "../common/ada.js";
import type { Config } from "../common/config.js";
import type { Asset, BrokerAccount, BrokerPush, BrokerReply, BrokerRequest, Tick } from "../common/interface.js";
import { log } from "../common/time.js";
import { openWallet } from "../chain/cardano.js";
import { openBrokerStore, openLedger } from "../db/pg.js";
import { serve } from "../link/ws.js";
import { createMarket, execute } from "./market.js";

const TICK_MS = 1000;
const SAVE_EVERY = 1;
const FEE_BUFFER = 1_000_000n;
const MIN_OUTPUT = 1_000_000n;

export const startBroker = async (config: Config): Promise<void> => {
  const store = openBrokerStore(config.databaseUrl);
  const ledger = openLedger(config.databaseUrl);
  const wallet = openWallet({
    role: "broker",
    mnemonic: config.mnemonics.broker,
    ledger,
    settings: { blockfrostUrl: config.blockfrostUrl, blockfrostProjectId: config.blockfrostProjectId },
  });
  const market = createMarket(await store.lastPrices());
  const accounts = new Map<Asset, BrokerAccount>((await store.accounts()).map((account) => [account.role, account]));
  const account = (role: Asset): BrokerAccount => accounts.get(role) ?? { role, cash: 0n, qty: 0 };
  let outstanding = 0n;
  let locks: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const next = locks.then(job, job);
    locks = next.catch(() => undefined);
    return next;
  };

  const handle = async (request: BrokerRequest): Promise<BrokerReply> => {
    if (request.type === "account") {
      return { type: "account", account: account(request.role), price: market.price(request.role) };
    }

    if (request.type === "deposit") {
      const from = config.addresses[request.role];
      const amount = await wallet.received(request.txId, from);
      if (amount === null) throw new Error(`deposit ${request.txId} is not on chain yet`);
      if (amount === 0n) throw new Error(`deposit ${request.txId} does not pay the broker from ${request.role}`);
      const next = await store.credit({ txId: request.txId, role: request.role, amount });
      accounts.set(request.role, next);
      log("broker", `${request.role} deposit ${showAda(amount)}, cash ${showAda(next.cash)}`);
      return { type: "account", account: next, price: market.price(request.role) };
    }

    if (request.type === "order") {
      return exclusive(async () => {
        const result = execute({
          account: account(request.role),
          price: market.price(request.role),
          side: request.side,
          fraction: request.fraction,
          reason: request.reason,
          cycleId: request.cycleId,
        });
        if (!result) return { type: "filled", fill: null, account: account(request.role) };
        await store.applyFill(result.account, result.fill);
        accounts.set(request.role, result.account);
        return { type: "filled", fill: result.fill, account: result.account };
      });
    }

    const existing = await ledger.find(request.transferId);
    if (!existing) {
      await exclusive(async () => {
        let current = account(request.role);
        const closed = execute({
          account: current,
          price: market.price(request.role),
          side: "sell",
          fraction: 1,
          reason: "Close position for withdrawal.",
          cycleId: request.cycleId,
        });
        if (closed) {
          await store.applyFill(closed.account, closed.fill);
          current = closed.account;
        }
        const onChain = await wallet.balance();
        const available = onChain - outstanding - config.walletReserve - FEE_BUFFER;
        const capped = minBig(current.cash, available > 0n ? available : 0n);
        const amount = capped >= MIN_OUTPUT ? capped : 0n;
        const next = { ...current, cash: current.cash - amount };
        outstanding += amount;
        await store.reserveWithdraw({
          account: next,
          transfer: {
            id: request.transferId,
            cycleId: request.cycleId,
            kind: "withdraw",
            fromRole: "broker",
            toRole: request.role,
            toAddress: config.addresses[request.role],
            amount,
          },
        });
        accounts.set(request.role, next);
        if (next.cash > 0n) log("broker", `${request.role} withdraw short by ${showAda(next.cash)}, kept as cash`);
      });
    }
    const row = await ledger.find(request.transferId);
    const amount = row?.amount ?? 0n;
    if (amount === 0n) {
      await ledger.update(request.transferId, { status: "confirmed", txId: null, detail: "nothing_to_send" });
      return { type: "withdrawn", amount: 0n, result: { status: "confirmed", txId: null, detail: "nothing_to_send" } };
    }
    if (existing) outstanding += amount;
    const result = await wallet
      .send({
        transferId: request.transferId,
        cycleId: request.cycleId,
        kind: "withdraw",
        toRole: request.role,
        toAddress: config.addresses[request.role],
        amount,
      })
      .finally(() => {
        outstanding -= amount;
      });
    log("broker", `${request.role} withdraw ${showAda(amount)} ${result.status} ${result.txId ?? result.detail ?? ""}`);
    return { type: "withdrawn", amount, result };
  };

  const server = serve<BrokerRequest, BrokerReply, BrokerPush>(config.port, handle);
  let count = 0;
  setInterval(() => {
    const ticks: Tick[] = market.step();
    server.broadcast({ type: "tick", ticks });
    if (++count % SAVE_EVERY === 0) void store.savePrices(ticks).catch(() => undefined);
  }, TICK_MS);
  log("broker", `listening on ${config.port}, wallet ${wallet.address}`);
};
