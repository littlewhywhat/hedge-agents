import { ada } from "./ada.js";
import { ASSETS, type Asset, ROLES, type Role } from "./interface.js";

export type ProcessName = "manager" | "agent" | "broker";

export const PORTS: Record<Role, number> = {
  manager: 8080,
  btc: 8081,
  eth: 8082,
  spx: 8083,
  gold: 8084,
  broker: 8090,
};

export type Config = {
  processName: ProcessName;
  asset: Asset;
  port: number;
  databaseUrl: string;
  operatorToken: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  mnemonics: Record<Role, string>;
  addresses: Record<Role, string>;
  agentUrls: Record<Asset, string>;
  brokerUrl: string;
  fund: bigint;
  walletReserve: bigint;
  brokerHouse: bigint;
  cycleMs: number;
  decideMs: number;
};

export const env = (name: string): string => {
  return process.env[name]?.trim() ?? "";
};

const number = (name: string, fallback: number): number => {
  const value = Number(env(name) || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

const byRole = (prefix: string): Record<Role, string> => {
  return Object.fromEntries(ROLES.map((role) => [role, env(`${prefix}_${role.toUpperCase()}`)])) as Record<Role, string>;
};

export const loadConfig = (): Config => {
  const processName = env("PROCESS") || "manager";
  if (processName !== "manager" && processName !== "agent" && processName !== "broker") {
    throw new Error(`PROCESS must be manager, agent, or broker, got ${processName}`);
  }
  const asset = (env("ASSET") || "btc") as Asset;
  if (!ASSETS.includes(asset)) throw new Error(`ASSET must be one of ${ASSETS.join(", ")}, got ${asset}`);
  const databaseUrl = env("DATABASE_URL") || "postgresql://hedge:hedge@127.0.0.1:5432/hedge";
  const role: Role = processName === "agent" ? asset : processName;
  return {
    processName,
    asset,
    port: Number(env("PORT") || PORTS[role]),
    databaseUrl,
    operatorToken: env("OPERATOR_TOKEN"),
    blockfrostProjectId: env("BLOCKFROST_PROJECT_ID"),
    blockfrostUrl: (env("BLOCKFROST_URL") || "https://cardano-preprod.blockfrost.io/api/v0").replace(/\/$/, ""),
    geminiApiKey: env("GEMINI_API_KEY"),
    geminiModel: env("GEMINI_MODEL") || "gemini-2.5-flash",
    mnemonics: byRole("MNEMONIC"),
    addresses: byRole("CARDANO_ADDRESS"),
    agentUrls: Object.fromEntries(
      ASSETS.map((item) => [item, env(`AGENT_URL_${item.toUpperCase()}`) || `ws://127.0.0.1:${PORTS[item]}`]),
    ) as Record<Asset, string>,
    brokerUrl: env("BROKER_URL") || `ws://127.0.0.1:${PORTS.broker}`,
    fund: ada(number("FUND_ADA", 200)),
    walletReserve: ada(number("WALLET_RESERVE_ADA", 5)),
    brokerHouse: ada(number("BROKER_HOUSE_ADA", 100)),
    cycleMs: number("CYCLE_MINUTES", 10) * 60_000,
    decideMs: number("DECIDE_SECONDS", 20) * 1000,
  };
};

export const roleOf = (config: Config): Role => {
  return config.processName === "agent" ? config.asset : config.processName;
};
