import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ada, maxBig, showAda } from "../src/common/ada.js";
import { loadConfig } from "../src/common/config.js";
import { ROLES, type Role } from "../src/common/interface.js";
import { openWallet } from "../src/chain/cardano.js";
import { addressOf, newMnemonic } from "../src/chain/keys.js";
import { memoryLedger } from "../src/db/memory.js";

const ENV = fileURLToPath(new URL("../.env", import.meta.url));
const fundOnly = process.argv.includes("--check") === false;

const parse = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim();
  }
  return out;
};

const setKey = (text: string, key: string, value: string): string => {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  return pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
};

let text = readFileSync(ENV, "utf8");
const values = parse(text);
for (const role of ROLES) {
  const key = role.toUpperCase();
  let mnemonic = values[`MNEMONIC_${key}`];
  if (!mnemonic) {
    mnemonic = newMnemonic();
    text = setKey(text, `MNEMONIC_${key}`, mnemonic);
    console.log(`${role}: generated a new mnemonic`);
  }
  const address = addressOf(mnemonic);
  if (values[`CARDANO_ADDRESS_${key}`] && values[`CARDANO_ADDRESS_${key}`] !== address) {
    console.log(`${role}: CARDANO_ADDRESS_${key} did not match the mnemonic, replaced`);
  }
  text = setKey(text, `CARDANO_ADDRESS_${key}`, address);
}
writeFileSync(ENV, text);
Object.assign(process.env, parse(text));

const config = loadConfig();
const settings = { blockfrostUrl: config.blockfrostUrl, blockfrostProjectId: config.blockfrostProjectId };
const ledger = memoryLedger();
const manager = openWallet({ role: "manager", mnemonic: config.mnemonics.manager, ledger, settings });

const target = (role: Role): bigint => {
  if (role === "manager") return 0n;
  if (role === "broker") return config.brokerHouse + config.walletReserve;
  return config.walletReserve;
};

const balances = async (): Promise<Record<Role, bigint>> => {
  const out = {} as Record<Role, bigint>;
  for (const role of ROLES) {
    const wallet = openWallet({ role, mnemonic: config.mnemonics[role], ledger, settings });
    out[role] = await wallet.balance();
    console.log(`${role.padEnd(8)} ${wallet.address} ${showAda(out[role])}`);
  }
  return out;
};

const before = await balances();
if (fundOnly) {
  const need = ROLES.map((role) => ({ role, amount: maxBig(0n, target(role) - before[role]) })).filter(
    (row) => row.amount >= ada(1),
  );
  const total = need.reduce((sum, row) => sum + row.amount, 0n);
  if (total > 0n && before.manager < total + config.walletReserve) {
    throw new Error(`manager has ${showAda(before.manager)}, needs ${showAda(total + config.walletReserve)}`);
  }
  for (const row of need) {
    console.log(`sending ${showAda(row.amount)} manager -> ${row.role} ...`);
    const result = await manager.send({
      transferId: `setup-${row.role}-${Date.now()}`,
      cycleId: null,
      kind: "setup",
      toRole: row.role,
      toAddress: config.addresses[row.role],
      amount: row.amount,
    });
    console.log(`  ${result.status} ${result.txId ?? ""} ${result.detail ?? ""}`);
    if (result.status !== "confirmed") process.exit(1);
  }
  if (need.length) {
    console.log("after:");
    await balances();
  }
}
