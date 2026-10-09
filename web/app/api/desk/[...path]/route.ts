import { NextRequest, NextResponse } from "next/server";

const routes: Record<string, "GET" | "POST"> = { desk: "GET", start: "POST", stop: "POST" };

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (routes[path] !== request.method) return NextResponse.json({ detail: "Unknown desk route" }, { status: 404 });
  try {
    const response = await fetch(new URL(path, (process.env.MANAGER_URL || "http://127.0.0.1:8080") + "/"), {
      method: request.method,
      headers: request.method === "POST" ? { Authorization: `Bearer ${process.env.MANAGER_TOKEN || ""}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    return NextResponse.json(response.ok ? result : { detail: result.error || "Manager rejected the request." }, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ detail: "Manager unavailable. No command was sent." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
