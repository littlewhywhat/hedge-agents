import assert from "node:assert/strict";
import { test } from "node:test";
import { ada } from "../common/ada.js";
import { createMarket, execute, seeded, START_PRICES, valueOf } from "./market.js";

test("the same seed gives the same price path", () => {
  const a = createMarket({}, seeded(7));
  const b = createMarket({}, seeded(7));
  const at = new Date("2026-10-09T00:00:00Z");
  for (let i = 0; i < 50; i++) assert.deepEqual(a.step(at), b.step(at));
});

test("prices move but stay positive over a long run", () => {
  const market = createMarket({}, seeded(1));
  for (let i = 0; i < 5000; i++) market.step();
  assert.notEqual(market.price("btc"), START_PRICES.btc);
  assert.ok(market.price("gold") > 0);
});

test("a market restarts from saved prices", () => {
  const market = createMarket({ eth: 1234 }, seeded(3));
  assert.equal(market.price("eth"), 1234);
});

test("buy then sell at the same price loses only the fees", () => {
  const account = { role: "btc" as const, cash: ada(100), qty: 0 };
  const bought = execute({ account, price: 50, side: "buy", fraction: 1, reason: "", cycleId: 1 });
  assert.ok(bought);
  assert.equal(bought.account.cash, 0n);
  const sold = execute({ account: bought.account, price: 50, side: "sell", fraction: 1, reason: "", cycleId: 1 });
  assert.ok(sold);
  assert.equal(sold.account.qty, 0);
  const lost = ada(100) - sold.account.cash;
  assert.ok(lost > 0n && lost <= ada(0.21), `lost ${lost}`);
});

test("orders with nothing to trade are skipped", () => {
  const empty = { role: "eth" as const, cash: 0n, qty: 0 };
  assert.equal(execute({ account: empty, price: 10, side: "buy", fraction: 0.5, reason: "", cycleId: null }), null);
  assert.equal(execute({ account: empty, price: 10, side: "sell", fraction: 0.5, reason: "", cycleId: null }), null);
});

test("value marks the position at the current price", () => {
  assert.equal(valueOf({ role: "spx", cash: ada(10), qty: 2 }, 3), ada(16));
});
