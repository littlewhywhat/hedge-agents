import { readFileSync } from "node:fs";
import path from "node:path";
import type { DeskStore } from "../../src/db/interface.js";
import { openDeskStore } from "../../src/db/pg.js";

let desk: DeskStore | null = null;

export const deskDb = (): DeskStore => {
  if (!desk) desk = openDeskStore(process.env.DATABASE_URL ?? "postgresql://hedge:hedge@127.0.0.1:5432/hedge");
  return desk;
};

export const envFile = (): Record<string, string> => {
  const file = path.resolve(process.cwd(), "../.env");
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
};
