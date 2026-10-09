import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

let pool: Pool | null = null;

export function envFile(): Record<string, string> {
  const file = path.resolve(process.cwd(), "../.env");
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

export function db(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://hedge:hedge@127.0.0.1:5432/hedge",
    });
  }
  return pool;
}
