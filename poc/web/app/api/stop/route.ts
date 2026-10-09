import { NextResponse } from "next/server";
import { managerCommand } from "@/lib/manager";

export const POST = async () => {
  const { status, body } = await managerCommand("stop");
  return NextResponse.json(body, { status });
};
