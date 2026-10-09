import { createHash, timingSafeEqual } from "node:crypto";

export class Rejected extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function authenticate(identity: string | undefined, authorization: string | undefined, hashes: Record<string, string>): string {
  const expected = identity ? hashes[identity] : undefined;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const digest = createHash("sha256").update(supplied).digest();
  if (!identity || !expected || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, "hex"), digest)) {
    throw new Rejected("Scoped service authorization required", 403);
  }
  return identity;
}

export function checkCapitalWallet(wallet: { agent_id: string; role: string; chain: string; signer: string; environment: string }, caller: string, environment: string) {
  if (wallet.agent_id !== caller || wallet.role !== "capital" || wallet.chain !== "cardano" || wallet.signer !== "facilitator" || wallet.environment !== environment) {
    throw new Rejected("Caller does not own this facilitator capital wallet", 403);
  }
}

export function checkControls(controls: { kill_switch: boolean; armed: boolean } | undefined, existingObligation: boolean, qualified: boolean) {
  if (!controls) throw new Rejected("Controls unavailable; refusing signature", 503);
  if (!existingObligation && (controls.kill_switch || !controls.armed || !qualified)) throw new Rejected("New capital operations are not armed and qualified", 423);
}

export const units: Record<string, string> = {
  preprod: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d",
  mainnet: "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378",
};

export type Qualification = { state: string; round_id: string; agent_id: string; environment: string; expires_at: string; budget_raw: string };

export function qualificationScope(qualification: Qualification | undefined, environment: string, caller: string, parentId: string, roundState: string | undefined, legs: { id: string; amount_raw: string }[], intent?: { buyer_id: string; request_id: string; amount_raw: string }): boolean {
  if (!qualification || qualification.state !== "authorized" || qualification.environment !== environment || qualification.agent_id !== caller || !(Date.parse(qualification.expires_at) > Date.now()) || !["planned", "executing", "partial"].includes(roundState || "")) return false;
  if (!/^[0-9]+$/.test(qualification.budget_raw) || BigInt(qualification.budget_raw) > 5000000n || BigInt(qualification.budget_raw) <= 0n) return false;
  if (qualification.round_id === parentId) return true;
  return Boolean(intent && intent.buyer_id === caller && BigInt(intent.amount_raw) <= BigInt(qualification.budget_raw) && legs.some((leg) => leg.id === intent.request_id && leg.amount_raw === String(intent.amount_raw)));
}

export function capitalRequirements(environment: string, destination: string, raw: string) {
  if (!units[environment] || !/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) throw new Rejected("Invalid capital amount or network", 422);
  const unit = units[environment];
  return { scheme: "exact", network: `cardano:${environment}` as `${string}:${string}`, asset: `${unit.slice(0, 56)}.${unit.slice(56)}`, amount: raw, payTo: destination, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "default", confirmationPolicy: { l1Confirmations: 1 } } };
}