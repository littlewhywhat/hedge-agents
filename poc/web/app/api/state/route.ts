import { NextResponse } from "next/server";
import { deskDb } from "@/lib/db";
import { managerState } from "@/lib/manager";

export const dynamic = "force-dynamic";

export const GET = async () => {
  const [desk, live] = await Promise.all([deskDb().state(), managerState()]);
  return NextResponse.json({ ...desk, live });
};
