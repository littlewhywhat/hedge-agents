import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { poolFor } from "./pg.js";

const SCHEMA = fileURLToPath(new URL("../../db/init.sql", import.meta.url));

export const migrate = async (databaseUrl: string): Promise<void> => {
  const pool = poolFor(databaseUrl);
  await pool.query("select pg_advisory_lock(4242)");
  try {
    await pool.query(await readFile(SCHEMA, "utf8"));
  } finally {
    await pool.query("select pg_advisory_unlock(4242)");
  }
};
