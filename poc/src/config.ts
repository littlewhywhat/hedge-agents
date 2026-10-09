import type { Role } from "./types.js";
import { PREPROD_UNIT } from "./types.js";

export type Config = {
  processName: "agent" | "facilitator" | "gateway";
  role: Role;
  port: number;
  databaseUrl: string;
  masumiMode: "local" | "live";
  demoSeed: boolean;
  operatorToken: string;
  paymentServiceUrl: string;
  paymentApiKey: string;
  facilitatorUrl: string;
  gatewayUrl: string;
  peerUrl: Record<"crypto" | "stocks", string>;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  mnemonics: Record<Role, string>;
  addresses: Record<Role, string>;
  agentIdentifiers: Record<Role, string>;
  sellerVkeys: Record<Role, string>;
  reportFee: bigint;
  unit: string;
};

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function loadConfig(): Config {
  const role = env("ROLE") || "manager";
  if (role !== "manager" && role !== "crypto" && role !== "stocks") {
    throw new Error(`ROLE must be manager, crypto, or stocks, got ${role}`);
  }
  const processName = env("PROCESS") || "agent";
  if (processName !== "agent" && processName !== "facilitator" && processName !== "gateway") {
    throw new Error(`PROCESS must be agent, facilitator, or gateway, got ${processName}`);
  }
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const mode = env("MASUMI_MODE") || "local";
  if (mode !== "local" && mode !== "live") throw new Error("MASUMI_MODE must be local or live");
  return {
    processName,
    role,
    port: Number(env("PORT") || "8080"),
    databaseUrl,
    masumiMode: mode,
    demoSeed: env("DEMO_SEED") === "true",
    operatorToken: env("OPERATOR_TOKEN"),
    paymentServiceUrl: env("PAYMENT_SERVICE_URL").replace(/\/$/, ""),
    paymentApiKey: env("PAYMENT_API_KEY"),
    facilitatorUrl: env("FACILITATOR_URL").replace(/\/$/, ""),
    gatewayUrl: env("GATEWAY_URL").replace(/\/$/, ""),
    peerUrl: {
      crypto: env("CRYPTO_URL").replace(/\/$/, "") || "http://crypto:8081",
      stocks: env("STOCKS_URL").replace(/\/$/, "") || "http://stocks:8082",
    },
    blockfrostProjectId: env("BLOCKFROST_PROJECT_ID"),
    blockfrostUrl: env("BLOCKFROST_URL") || "https://cardano-preprod.blockfrost.io/api/v0",
    mnemonics: {
      manager: env("MNEMONIC_MANAGER"),
      crypto: env("MNEMONIC_CRYPTO"),
      stocks: env("MNEMONIC_STOCKS"),
    },
    addresses: {
      manager: env("CARDANO_ADDRESS_MANAGER"),
      crypto: env("CARDANO_ADDRESS_CRYPTO"),
      stocks: env("CARDANO_ADDRESS_STOCKS"),
    },
    agentIdentifiers: {
      manager: env("AGENT_IDENTIFIER_MANAGER"),
      crypto: env("AGENT_IDENTIFIER_CRYPTO"),
      stocks: env("AGENT_IDENTIFIER_STOCKS"),
    },
    sellerVkeys: {
      manager: env("SELLER_VKEY_MANAGER"),
      crypto: env("SELLER_VKEY_CRYPTO"),
      stocks: env("SELLER_VKEY_STOCKS"),
    },
    reportFee: BigInt(env("REPORT_FEE") || "1000000"),
    unit: env("BUDGET_UNIT") || PREPROD_UNIT,
  };
}
