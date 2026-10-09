import { envFile } from "./db";

const base = (): string => process.env.MANAGER_URL ?? "http://127.0.0.1:8080";

export const managerState = async (): Promise<unknown> => {
  try {
    const response = await fetch(`${base()}/state`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

export const managerCommand = async (command: "start" | "stop"): Promise<{ status: number; body: unknown }> => {
  const token = envFile().OPERATOR_TOKEN ?? "";
  try {
    const response = await fetch(`${base()}/${command}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: 503, body: { error: "manager is not reachable" } };
  }
};
