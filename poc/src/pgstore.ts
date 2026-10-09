import pg from "pg";
import type { Agent, Fund, Report, Role, Round, Snapshot, Transfer, Weights } from "./types.js";
import type { NewTransfer, Store } from "./store.js";

const { Pool } = pg;

pg.types.setTypeParser(1082, (value: string) => value);

function big(value: string | number | bigint): bigint {
  return BigInt(value);
}

function weights(value: unknown): Weights {
  const row = value as Weights;
  return { crypto: Number(row.crypto), stocks: Number(row.stocks), reserve: Number(row.reserve) };
}

function roundRow(row: {
  id: string;
  week: Date | string;
  weights_before: unknown;
  weights_after: unknown;
  scores: { crypto: number; stocks: number };
  opened_at: Date | null;
  settled_at: Date | null;
}): Round {
  const week = row.week instanceof Date ? row.week.toISOString().slice(0, 10) : String(row.week).slice(0, 10);
  return {
    id: Number(row.id),
    week,
    weightsBefore: weights(row.weights_before),
    weightsAfter: weights(row.weights_after),
    scores: { crypto: Number(row.scores.crypto), stocks: Number(row.scores.stocks) },
    openedAt: row.opened_at?.toISOString() ?? null,
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

function transferRow(row: {
  id: string;
  round_id: string | null;
  from_agent_id: string | null;
  to_agent_id: string | null;
  amount: string;
  status: Transfer["status"];
  tx_id: string | null;
  detail: string | null;
}): Transfer {
  return {
    id: Number(row.id),
    roundId: row.round_id == null ? null : Number(row.round_id),
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    amount: big(row.amount),
    status: row.status,
    txId: row.tx_id,
    detail: row.detail,
  };
}

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  static connect(databaseUrl: string): PgStore {
    return new PgStore(new Pool({ connectionString: databaseUrl }));
  }

  async getFund(): Promise<Fund> {
    const result = await this.pool.query<{
      id: string;
      deposit_address: string;
      environment: "preprod";
      unit: string;
    }>("select id, deposit_address, environment, unit from funds limit 1");
    const row = result.rows[0];
    if (!row) throw new Error("no fund row; start the manager against an initialized database");
    return { id: row.id, depositAddress: row.deposit_address, environment: row.environment, unit: row.unit };
  }

  async listAgents(): Promise<Agent[]> {
    const result = await this.pool.query<{
      id: string;
      role: Role;
      cardano_address: string;
      agent_identifier: string;
      market: string | null;
      solana_address: string | null;
    }>("select id, role, cardano_address, agent_identifier, market, solana_address from agents order by role");
    return result.rows.map((row) => ({
      id: row.id,
      role: row.role,
      cardanoAddress: row.cardano_address,
      agentIdentifier: row.agent_identifier,
      market: row.market,
      solanaAddress: row.solana_address,
    }));
  }

  async agentByRole(role: Role): Promise<Agent> {
    const agent = (await this.listAgents()).find((item) => item.role === role);
    if (!agent) throw new Error(`no ${role} agent`);
    return agent;
  }

  async insertSnapshot(snapshot: Snapshot): Promise<void> {
    await this.pool.query(
      `insert into snapshots (agent_id, sampled_at, cardano_stablecoin, solana_usdc, token_usd)
       values ($1, $2, $3, $4, $5)`,
      [snapshot.agentId, snapshot.sampledAt, snapshot.cardanoStablecoin.toString(), snapshot.solanaUsdc.toString(), snapshot.tokenUsd.toString()],
    );
  }

  async snapshotsBefore(agentId: string, beforeExclusive: string): Promise<Snapshot[]> {
    const result = await this.pool.query<{
      agent_id: string;
      sampled_at: Date;
      cardano_stablecoin: string;
      solana_usdc: string;
      token_usd: string;
    }>(
      `select agent_id, sampled_at, cardano_stablecoin, solana_usdc, token_usd
       from snapshots where agent_id = $1 and sampled_at < $2 order by sampled_at`,
      [agentId, beforeExclusive],
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      sampledAt: row.sampled_at.toISOString(),
      cardanoStablecoin: big(row.cardano_stablecoin),
      solanaUsdc: big(row.solana_usdc),
      tokenUsd: big(row.token_usd),
    }));
  }

  async findRound(week: string): Promise<Round | null> {
    const result = await this.pool.query("select * from rounds where week = $1", [week]);
    return result.rows[0] ? roundRow(result.rows[0]) : null;
  }

  async latestRoundBefore(week: string): Promise<Round | null> {
    const result = await this.pool.query("select * from rounds where week < $1 order by week desc limit 1", [week]);
    return result.rows[0] ? roundRow(result.rows[0]) : null;
  }

  async insertRound(input: {
    week: string;
    weightsBefore: Weights;
    weightsAfter: Weights;
    scores: { crypto: number; stocks: number };
    openedAt: string;
  }): Promise<Round> {
    const fund = await this.getFund();
    const result = await this.pool.query(
      `insert into rounds (fund_id, week, weights_before, weights_after, scores, opened_at)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [fund.id, input.week, input.weightsBefore, input.weightsAfter, input.scores, input.openedAt],
    );
    return roundRow(result.rows[0]);
  }

  async saveDecision(roundId: number, weightsAfter: Weights, scores: { crypto: number; stocks: number }): Promise<void> {
    await this.pool.query("update rounds set weights_after = $2, scores = $3 where id = $1", [roundId, weightsAfter, scores]);
  }

  async markSettled(roundId: number, settledAt: string): Promise<void> {
    await this.pool.query("update rounds set settled_at = $2 where id = $1", [roundId, settledAt]);
  }

  async insertReport(report: Report): Promise<void> {
    await this.pool.query(
      `insert into reports (round_id, agent_id, blockchain_identifier, fee, decayed_return, volatility, result_hash)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        report.roundId,
        report.agentId,
        report.blockchainIdentifier,
        report.fee.toString(),
        report.decayedReturn,
        report.volatility,
        report.resultHash,
      ],
    );
  }

  async reportsFor(roundId: number): Promise<Report[]> {
    const result = await this.pool.query<{
      round_id: string;
      agent_id: string;
      blockchain_identifier: string | null;
      fee: string;
      decayed_return: number;
      volatility: number;
      result_hash: string | null;
    }>("select * from reports where round_id = $1", [roundId]);
    return result.rows.map((row) => ({
      roundId: Number(row.round_id),
      agentId: row.agent_id,
      blockchainIdentifier: row.blockchain_identifier,
      fee: big(row.fee),
      decayedReturn: Number(row.decayed_return),
      volatility: Number(row.volatility),
      resultHash: row.result_hash,
    }));
  }

  async listTransfers(roundId: number): Promise<Transfer[]> {
    const result = await this.pool.query("select * from transfers where round_id = $1 order by id", [roundId]);
    return result.rows.map(transferRow);
  }

  async insertTransfer(transfer: NewTransfer): Promise<Transfer> {
    const result = await this.pool.query(
      `insert into transfers (round_id, from_agent_id, to_agent_id, amount, status, tx_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        transfer.roundId,
        transfer.fromAgentId,
        transfer.toAgentId,
        transfer.amount.toString(),
        transfer.status,
        transfer.txId,
        transfer.detail,
      ],
    );
    return transferRow(result.rows[0]);
  }

  async updateTransfer(id: number, patch: Pick<Transfer, "status" | "txId" | "detail">): Promise<Transfer> {
    const result = await this.pool.query(
      "update transfers set status = $2, tx_id = $3, detail = $4 where id = $1 returning *",
      [id, patch.status, patch.txId, patch.detail],
    );
    return transferRow(result.rows[0]);
  }

  async allTransfers(): Promise<Transfer[]> {
    const result = await this.pool.query("select * from transfers order by id");
    return result.rows.map(transferRow);
  }

  async budgetTransfers(): Promise<Transfer[]> {
    return this.allTransfers();
  }
}

export async function ensureFund(
  pool: pg.Pool,
  input: { depositAddress: string; unit: string; agents: { role: Role; cardanoAddress: string; agentIdentifier: string; market: string | null; solanaAddress: string | null }[] },
): Promise<void> {
  await pool.query(
    `insert into funds (id, deposit_address, environment, unit) values ('demo', $1, 'preprod', $2)
     on conflict (id) do update set deposit_address = excluded.deposit_address, unit = excluded.unit`,
    [input.depositAddress, input.unit],
  );
  for (const agent of input.agents) {
    await pool.query(
      `insert into agents (id, fund_id, role, cardano_address, agent_identifier, market, solana_address)
       values ($1, 'demo', $1, $2, $3, $4, $5)
       on conflict (id) do update set
         cardano_address = excluded.cardano_address,
         agent_identifier = excluded.agent_identifier,
         market = excluded.market,
         solana_address = excluded.solana_address`,
      [agent.role, agent.cardanoAddress, agent.agentIdentifier, agent.market, agent.solanaAddress],
    );
  }
}
