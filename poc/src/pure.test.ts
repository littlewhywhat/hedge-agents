import assert from "node:assert/strict";
import test from "node:test";
import { inputHash, outputHash } from "./hash.js";
import { allocate, performance, transfersFor } from "./pure.js";
import type { Weights } from "./types.js";

const flat: Weights = { crypto: 0.4, stocks: 0.4, reserve: 0.2 };

test("round 0 assigns equal market shares and leaves reserve", () => {
  const decision = allocate({ round0: true, before: { crypto: 0, stocks: 0, reserve: 1 }, performance: null, cooled: [] });
  assert.deepEqual(decision.weights, flat);
});

test("a losing market gives share back and the winner is capped at one step", () => {
  const decision = allocate({
    round0: false,
    before: flat,
    performance: {
      crypto: { decayedReturn: 0.08, volatility: 0.01 },
      stocks: { decayedReturn: -0.04, volatility: 0.02 },
    },
    cooled: [],
  });
  assert.equal(decision.weights.crypto, 0.5);
  assert.equal(decision.weights.stocks, 0.3);
  assert.equal(decision.weights.reserve, 0.2);
});

test("moves under 5 points stay put", () => {
  const before: Weights = { crypto: 0.5, stocks: 0.48, reserve: 0.02 };
  const decision = allocate({
    round0: false,
    before,
    performance: {
      crypto: { decayedReturn: 0.051, volatility: 0.01 },
      stocks: { decayedReturn: 0.049, volatility: 0.01 },
    },
    cooled: [],
  });
  assert.deepEqual(decision.weights, before);
});

test("near-zero scores leave the weights unchanged", () => {
  const decision = allocate({
    round0: false,
    before: flat,
    performance: {
      crypto: { decayedReturn: 0, volatility: 0 },
      stocks: { decayedReturn: 0, volatility: 0 },
    },
    cooled: [],
  });
  assert.deepEqual(decision.weights, flat);
});

test("an agent that sent last week cannot send", () => {
  const decision = allocate({
    round0: false,
    before: flat,
    performance: {
      crypto: { decayedReturn: -0.05, volatility: 0.01 },
      stocks: { decayedReturn: 0.05, volatility: 0.01 },
    },
    cooled: ["crypto"],
  });
  assert.ok(decision.weights.crypto >= flat.crypto);
});

test("the first split pays both markets from the manager", () => {
  const legs = transfersFor({ crypto: 0, stocks: 0, reserve: 1 }, flat, 100_000_000n);
  const crypto = legs.find((leg) => leg.to === "crypto");
  const stocks = legs.find((leg) => leg.to === "stocks");
  assert.equal(crypto?.from, "manager");
  assert.equal(crypto?.amount, 40_000_000n);
  assert.equal(stocks?.amount, 40_000_000n);
  assert.equal(legs.reduce((sum, leg) => sum + leg.amount, 0n), 80_000_000n);
});

test("a later week moves budget from stocks to crypto", () => {
  const legs = transfersFor(flat, { crypto: 0.5, stocks: 0.3, reserve: 0.2 }, 100_000_000n);
  assert.deepEqual(legs, [{ from: "stocks", to: "crypto", amount: 10_000_000n }]);
});

test("daily snapshots decay toward the newest return", () => {
  const rising = [100, 101, 102, 104].map((value, index) => ({ at: index, value }));
  const point = performance(rising);
  assert.ok(point.decayedReturn > 0);
  assert.ok(point.volatility > 0);
  assert.deepEqual(performance([{ at: 0, value: 100 }]), { decayedReturn: 0, volatility: 0 });
});

test("report hashes cover the purchaser id and the body", () => {
  const identifier = "ab".repeat(8);
  const input = inputHash(identifier, { week: "2026-10-05" });
  const output = outputHash(identifier, "{\"ok\":true}");
  assert.equal(input.length, 64);
  assert.notEqual(input, output);
  assert.equal(inputHash(identifier, { week: "2026-10-05" }), input);
});
