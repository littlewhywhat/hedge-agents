import { NextRequest, NextResponse } from "next/server";

const routes = new Set(["health", "fund", "agents", "snapshots", "events", "rounds", "inventory", "policy", "readiness", "decisions", "transfers", "chat", "kill-switch", "arm", "policy/confirm", "inventory/refresh", "audit/verify", "operator/session", "operations/deploy", "operations/cashout", "qualification/deploy", "qualification/cashout", "replay/frames", "replay/trades", "replay/headlines"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!routes.has(path)) return NextResponse.json({ detail: "Unknown monitor route" }, { status: 404 });
  try {
    const target = new URL(path, (process.env.MONITOR_URL || "http://127.0.0.1:8000") + "/");
    target.search = request.nextUrl.search;
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && Buffer.byteLength(body) > 65536) return NextResponse.json({ detail: "Request too large" }, { status: 413 });
    const response = await fetch(target, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...(request.headers.get("authorization") ? { Authorization: request.headers.get("authorization")! } : {}) },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return new NextResponse(text, { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ detail: "Monitor unavailable. No operation was confirmed." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };