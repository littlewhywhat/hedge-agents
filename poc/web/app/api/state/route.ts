import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type Weights = { crypto: number; stocks: number; reserve: number };

export async function GET() {
  const pool = db();
  const rounds = await pool.query<{
    id: string;
    week: string;
    weights_before: Weights;
    weights_after: Weights;
    settled_at: Date | null;
  }>("select id, week::text as week, weights_before, weights_after, settled_at from rounds order by week");

  const reports = await pool.query<{ round_id: string; role: "crypto" | "stocks"; decayed_return: number }>(
    `select r.round_id, a.role, r.decayed_return
     from reports r join agents a on a.id = r.agent_id
     order by r.round_id`,
  );

  const transfers = await pool.query<{
    id: string;
    round_id: string | null;
    from_role: string | null;
    to_role: string | null;
    amount: string;
    status: string;
    tx_id: string | null;
    detail: string | null;
  }>(
    `select t.id, t.round_id, fa.role as from_role, ta.role as to_role, t.amount::text, t.status, t.tx_id, t.detail
     from transfers t
     left join agents fa on fa.id = t.from_agent_id
     left join agents ta on ta.id = t.to_agent_id
     order by t.id`,
  );

  const byRound = new Map<string, { role: "crypto" | "stocks"; decayedReturn: number }[]>();
  for (const report of reports.rows) {
    const list = byRound.get(report.round_id) ?? [];
    list.push({ role: report.role, decayedReturn: Number(report.decayed_return) });
    byRound.set(report.round_id, list);
  }

  return NextResponse.json({
    rounds: rounds.rows.map((round) => ({
      id: Number(round.id),
      week: round.week.slice(0, 10),
      weightsBefore: round.weights_before,
      weightsAfter: round.weights_after,
      settledAt: round.settled_at?.toISOString() ?? null,
      reports: byRound.get(round.id) ?? [],
    })),
    transfers: transfers.rows.map((row) => ({
      id: Number(row.id),
      roundId: row.round_id == null ? null : Number(row.round_id),
      from: row.from_role,
      to: row.to_role,
      amount: row.amount,
      status: row.status,
      txId: row.tx_id,
      detail: row.detail,
    })),
  });
}
