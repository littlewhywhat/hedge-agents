import { createRequire } from "node:module";

const canonical = createRequire(import.meta.url)("canonicalize") as (value: unknown) => string | undefined;

export function canonicalize(value: unknown): string {
  const output = canonical(value);
  if (output === undefined) throw new Error("Audit payload is not canonicalizable");
  return output;
}