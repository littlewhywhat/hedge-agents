import { createHash, randomBytes } from "node:crypto";

export function purchaserId(): string {
  return randomBytes(10).toString("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function inputHash(identifier: string, input: unknown): string {
  return createHash("sha256").update(`${identifier};${canonicalJson(input)}`).digest("hex");
}

export function outputHash(identifier: string, output: string): string {
  return createHash("sha256").update(`${identifier};${JSON.stringify(output)}`).digest("hex");
}
