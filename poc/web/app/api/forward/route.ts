import { NextResponse } from "next/server";
import { db, envFile } from "@/lib/db";

function nextMonday(week: string): string {
  const day = new Date(`${week}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 7);
  return day.toISOString().slice(0, 10);
}

export async function POST() {
  const pool = db();
  const env = envFile();
  const token = env.OPERATOR_TOKEN || "change-me";
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  await pool.query(
    `update transfers
     set status = 'confirmed',
         tx_id = coalesce(tx_id, 'demo-' || id),
         detail = 'demo-confirm'
     where round_id is not null and status = 'pending'`,
  );
  await pool.query(
    `update rounds r
     set settled_at = now()
     where settled_at is null
       and not exists (
         select 1 from transfers t where t.round_id = r.id and t.status <> 'confirmed'
       )`,
  );

  const latest = await pool.query<{ week: string }>("select week::text as week from rounds order by week desc limit 1");
  if (!latest.rowCount) return NextResponse.json({ error: "нет раундов" }, { status: 400 });
  const week = nextMonday(latest.rows[0].week.slice(0, 10));

  const agents = await pool.query<{ id: string; role: string; sampled_at: Date; cardano_stablecoin: string }>(
    `select distinct on (a.id) a.id, a.role, s.sampled_at, s.cardano_stablecoin::text
     from agents a
     join snapshots s on s.agent_id = a.id
     where a.role in ('crypto', 'stocks')
     order by a.id, s.sampled_at desc`,
  );

  for (const agent of agents.rows) {
    let value = BigInt(agent.cardano_stablecoin);
    let cursor = new Date(agent.sampled_at);
    const end = new Date(`${week}T00:00:00.000Z`);
    const factor = agent.role === "crypto" ? 0.97 : 1.03;
    while (true) {
      cursor = new Date(cursor.getTime() + 86_400_000);
      if (cursor >= end) break;
      value = BigInt(Math.round(Number(value) * factor));
      await pool.query(
        `insert into snapshots (agent_id, sampled_at, cardano_stablecoin, solana_usdc, token_usd)
         values ($1, $2, $3, 0, 0)`,
        [agent.id, cursor.toISOString(), value.toString()],
      );
    }
  }

  const round = await fetch("http://127.0.0.1:8080/rounds", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ week }),
  });
  const payload = await round.json();
  if (!round.ok) return NextResponse.json(payload, { status: round.status });
  return NextResponse.json({ week, round: payload });
}
