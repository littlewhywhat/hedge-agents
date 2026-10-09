import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { authenticate, capitalRequirements, checkCapitalWallet, checkControls, qualificationScope } from "../src/security.js";

test("service credentials are bound to the caller identity", () => {
  const hashes = { btc: createHash("sha256").update("test-secret").digest("hex") };
  assert.equal(authenticate("btc", "Bearer test-secret", hashes), "btc");
  assert.throws(() => authenticate("gateway", "Bearer test-secret", hashes));
  assert.throws(() => authenticate("btc", "Bearer wrong", hashes));
});

test("only exclusively owned capital wallets may sign", () => {
  const wallet = { agent_id: "btc", role: "capital", chain: "cardano", signer: "facilitator", environment: "preprod" };
  checkCapitalWallet(wallet, "btc", "preprod");
  assert.throws(() => checkCapitalWallet({ ...wallet, role: "purchasing" }, "btc", "preprod"));
  assert.throws(() => checkCapitalWallet(wallet, "eth", "preprod"));
  assert.throws(() => checkCapitalWallet(wallet, "btc", "mainnet"));
});

test("capital never selects Masumi escrow or the default asset table", () => {
  const requirement = capitalRequirements("mainnet", "registered-address", "25000000");
  assert.equal(requirement.extra.assetTransferMethod, "default");
  assert.equal(requirement.scheme, "exact");
  assert.equal(requirement.asset, "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e34.5553444378");
  assert.throws(() => capitalRequirements("mainnet", "address", "0.1"));
});

test("kill switch preserves only existing funded obligations", () => {
  assert.throws(() => checkControls({ kill_switch: true, armed: false }, false, false));
  assert.throws(() => checkControls(undefined, true, true));
  checkControls({ kill_switch: true, armed: false }, true, false);
});

test("qualification is bounded to its agent, parent operation, and expiry", () => {
  const qualification = { state: "authorized", round_id: "round", agent_id: "btc", environment: "preprod", expires_at: new Date(Date.now() + 60000).toISOString(), budget_raw: "5000000" };
  assert.equal(qualificationScope(qualification, "preprod", "btc", "round", "planned", []), true);
  assert.equal(qualificationScope(qualification, "preprod", "eth", "round", "planned", []), false);
  assert.equal(qualificationScope(qualification, "preprod", "btc", "other", "planned", []), false);
  assert.equal(qualificationScope({ ...qualification, budget_raw: "5000001" }, "preprod", "btc", "round", "planned", []), false);
  assert.equal(qualificationScope({ ...qualification, expires_at: "2020-01-01" }, "preprod", "btc", "round", "planned", []), false);
});