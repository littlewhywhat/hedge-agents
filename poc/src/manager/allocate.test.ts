import assert from "node:assert/strict";
import { test } from "node:test";
import { EQUAL } from "../ai/fallback.js";
import { ada } from "../common/ada.js";
import { ASSETS } from "../common/interface.js";
import { capWeights, MAX_AGENT, MAX_RESERVE, MAX_STEP, MIN_AGENT, MIN_RESERVE, planMoves } from "./allocate.js";

const sum = (weights: Record<string, number>): number => Object.values(weights).reduce((total, value) => total + value, 0);

test("capWeights keeps every agent under the cap and the reserve above the floor", () => {
  const weights = capWeights({ btc: 0.35, eth: 0.3, spx: 0.2, gold: 0.15, reserve: 0 }, { btc: 0.9, eth: 0.9, spx: 0.9, gold: 0.9, reserve: 0 });
  for (const asset of ASSETS) assert.ok(weights[asset] <= MAX_AGENT + 1e-9, `${asset} ${weights[asset]}`);
  assert.ok(weights.reserve >= MIN_RESERVE - 1e-4);
  assert.ok(Math.abs(sum(weights) - 1) < 1e-3);
});

test("capWeights limits how far one cycle can move a share", () => {
  const weights = capWeights(EQUAL, { btc: 1, eth: 0, spx: 0, gold: 0, reserve: 0 });
  assert.ok(weights.btc <= EQUAL.btc + MAX_STEP + 1e-9);
  assert.ok(weights.eth >= EQUAL.eth - MAX_STEP - 1e-9);
});

test("capWeights gives every agent at least the floor, even from zero", () => {
  const weights = capWeights({ btc: 0, eth: 0, spx: 0.1, gold: 0.4, reserve: 0.5 }, { btc: 0, eth: 0, spx: 0, gold: 1, reserve: 0 });
  for (const asset of ASSETS) assert.ok(weights[asset] >= MIN_AGENT - 1e-4, `${asset} ${weights[asset]}`);
  assert.ok(Math.abs(sum(weights) - 1) < 1e-3);
});

test("capWeights deploys the fund when the proposal hoards reserve", () => {
  const weights = capWeights(EQUAL, { btc: 0.1, eth: 0.1, spx: 0.1, gold: 0.1, reserve: 0.6 });
  assert.ok(weights.reserve <= MAX_RESERVE + 1e-4, `reserve ${weights.reserve}`);
  for (const asset of ASSETS) assert.ok(weights[asset] <= MAX_AGENT + 1e-9);
  assert.ok(Math.abs(sum(weights) - 1) < 1e-3);
});

test("capWeights normalizes shares that do not sum to one", () => {
  const weights = capWeights(EQUAL, { btc: 2, eth: 2, spx: 2, gold: 2, reserve: 2 });
  for (const asset of ASSETS) assert.equal(weights[asset], 0.2);
  assert.equal(weights.reserve, 0.2);
});

test("planMoves funds empty agents from manager cash on the first cycle", () => {
  const moves = planMoves({
    weights: EQUAL,
    cash: ada(200),
    wallets: { btc: ada(10), eth: ada(10), spx: ada(10), gold: ada(10) },
    reserve: ada(10),
    minTransfer: ada(2),
  });
  assert.equal(moves.length, 4);
  for (const move of moves) {
    assert.equal(move.direction, "fund");
    assert.equal(move.amount, ada(40));
  }
});

test("planMoves collects from over-target agents and tops up a drained fee reserve", () => {
  const moves = planMoves({
    weights: { btc: 0.1, eth: 0.3, spx: 0.2, gold: 0.2, reserve: 0.2 },
    cash: ada(40),
    wallets: { btc: ada(50), eth: ada(30), spx: ada(50), gold: ada(9) },
    reserve: ada(10),
    minTransfer: ada(2),
  });
  const btc = moves.find((move) => move.asset === "btc");
  const gold = moves.find((move) => move.asset === "gold");
  assert.equal(btc?.direction, "collect");
  assert.equal(btc?.amount, ada(26));
  assert.equal(gold?.direction, "fund");
  assert.equal(gold?.amount, ada(29));
});

test("planMoves never pays out more than it has", () => {
  const moves = planMoves({
    weights: { btc: 0.4, eth: 0.4, spx: 0, gold: 0, reserve: 0.2 },
    cash: ada(10),
    wallets: { btc: ada(10), eth: ada(10), spx: ada(10), gold: ada(10) },
    reserve: ada(10),
    minTransfer: ada(2),
  });
  const paid = moves.filter((move) => move.direction === "fund").reduce((total, move) => total + move.amount, 0n);
  assert.ok(paid <= ada(10));
});
