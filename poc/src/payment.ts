import { inputHash, outputHash, purchaserId } from "./hash.js";

type PaymentRecord = Record<string, unknown>;

function unwrap(body: PaymentRecord): PaymentRecord {
  const data = body.data;
  if (data && typeof data === "object") return data as PaymentRecord;
  return body;
}

async function masumi(url: string, apiKey: string, path: string, body: unknown): Promise<PaymentRecord> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", token: apiKey },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`payment service ${path} ${response.status}: ${text}`);
  return JSON.parse(text) as PaymentRecord;
}

export function deadlines(now = Date.now()): {
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
} {
  const minute = 60_000;
  return {
    payByTime: new Date(now + 5 * minute).toISOString(),
    submitResultTime: new Date(now + 20 * minute).toISOString(),
    unlockTime: new Date(now + 35 * minute).toISOString(),
    externalDisputeUnlockTime: new Date(now + 50 * minute).toISOString(),
  };
}

export async function createReportPayment(input: {
  url: string;
  apiKey: string;
  agentIdentifier: string;
  unit: string;
  fee: bigint;
  week: string;
  identifier?: string;
}): Promise<PaymentRecord> {
  const identifier = input.identifier ?? purchaserId();
  const times = deadlines();
  const body = await masumi(input.url, input.apiKey, "/api/v1/payment/", {
    inputHash: inputHash(identifier, { week: input.week }),
    network: "Preprod",
    agentIdentifier: input.agentIdentifier,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: 0,
    RequestedFunds: [{ amount: input.fee.toString(), unit: input.unit }],
    identifierFromPurchaser: identifier,
    ...times,
  });
  return { ...unwrap(body), identifierFromPurchaser: identifier, inputHash: inputHash(identifier, { week: input.week }) };
}

export async function createReportPurchase(input: {
  url: string;
  apiKey: string;
  payment: PaymentRecord;
  sellerVkey: string;
  agentIdentifier: string;
  unit: string;
  fee: bigint;
}): Promise<PaymentRecord> {
  return unwrap(
    await masumi(input.url, input.apiKey, "/api/v1/purchase/", {
      blockchainIdentifier: input.payment.blockchainIdentifier,
      network: "Preprod",
      paymentSourceType: "Web3CardanoV2",
      supportedPaymentSourceIndex: input.payment.supportedPaymentSourceIndex ?? 0,
      inputHash: input.payment.inputHash,
      sellerVkey: input.sellerVkey,
      agentIdentifier: input.agentIdentifier,
      Amounts: [{ amount: input.fee.toString(), unit: input.unit }],
      payByTime: input.payment.payByTime,
      submitResultTime: input.payment.submitResultTime,
      unlockTime: input.payment.unlockTime,
      externalDisputeUnlockTime: input.payment.externalDisputeUnlockTime,
      identifierFromPurchaser: input.payment.identifierFromPurchaser,
    }),
  );
}

export async function paymentState(url: string, apiKey: string, blockchainIdentifier: string): Promise<string> {
  const body = unwrap(
    await masumi(url, apiKey, "/api/v1/payment/resolve-blockchain-identifier", {
      network: "Preprod",
      blockchainIdentifier,
    }),
  );
  return String(body.onChainState ?? body.NextAction?.toString() ?? "");
}

export async function submitReportResult(input: {
  url: string;
  apiKey: string;
  blockchainIdentifier: string;
  identifier: string;
  result: string;
}): Promise<void> {
  await masumi(input.url, input.apiKey, "/api/v1/payment/submit-result", {
    network: "Preprod",
    blockchainIdentifier: input.blockchainIdentifier,
    submitResultHash: outputHash(input.identifier, input.result),
  });
}

export function reportOutputHash(identifier: string, result: string): string {
  return outputHash(identifier, result);
}
