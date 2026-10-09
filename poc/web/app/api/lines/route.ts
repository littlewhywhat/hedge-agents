import { NextResponse } from "next/server";
import { scriptFor, type ScriptInput } from "@/lib/gemini";

export async function POST(request: Request) {
  const body = (await request.json()) as ScriptInput;
  const script = await scriptFor(body);
  return NextResponse.json(script);
}
