import pg from "pg";
import type {
  AgentReport,
  AgentState,
  Asset,
  BrokerAccount,
  Cycle,
  Fill,
  ManagerState,
  Role,
  Tick,
  Transfer,
  ValueSnapshot,
  Weights,
} from "../common/interface.js";
import type {
  AgentStore,
  BrokerStore,
  DeskCycle,
  DeskState,
  DeskStore,
  Ledger,
  ManagerStore,
} from "./interface.js";

const pools = new Map<string, pg.Pool>();

export const poolFor = (databaseUrl: string): pg.Pool => {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    pools.set(databaseUrl, pool);
  }
  return pool;
};

const iso = (value: Date | null): string | null => {
  return value ? value.toISOString() : null;
};

type TransferRow = {
  id: string;
  cycle_id: string | null;
  kind: Transfer["kind"];
  from_role: Role;
  to_role: Role;
  to_address: string;
  amount: string;
  status: Transfer["status"];
  tx_id: string | null;
  detail: string | null;
};

const transferRow = (row: TransferRow): Transfer => {
  return {
    id: row.id,
    cycleId: row.cycle_id == null ? null : Number(row.cycle_id),
    kind: row.kind,
    fromRole: row.from_role,
    toRole: row.to_role,
    toAddress: row.to_address,
    amount: BigInt(row.amount),
    status: row.status,
    txId: row.tx_id,
    detail: row.detail,
  };
};

type CycleRow = {
  id: string;
  phase: Cycle["phase"];
  started_at: Date;
  finished_at: Date | null;
  weights_before: Weights;
  weights_after: Weights | null;
  strategies: Cycle["strategies"];
  trends: Cycle["trends"];
  rationale: string | null;
  source: string | null;
  moves: { asset: Asset; direction: "collect" | "fund"; amount: string }[] | null;
  error: string | null;
};

const cycleRow = (row: CycleRow): Cycle => {
  return {
    id: Number(row.id),
    phase: row.phase,
    startedAt: row.started_at.toISOString(),
    finishedAt: iso(row.finished_at),
    weightsBefore: row.weights_before,
    weightsAfter: row.weights_after,
    strategies: row.strategies,
    trends: row.trends,
    rationale: row.rationale,
    source: row.source,
    moves: row.moves?.map((move) => ({ ...move, amount: BigInt(move.amount) })) ?? null,
    error: row.error,
  };
};

const CYCLE_COLUMNS: Record<string, string> = {
  phase: "phase",
  finishedAt: "finished_at",
  weightsBefore: "weights_before",
  weightsAfter: "weights_after",
  strategies: "strategies",
  trends: "trends",
  rationale: "rationale",
  source: "source",
  moves: "moves",
  error: "error",
};

const jsonSafe = (value: unknown): unknown => {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
};

class PgLedger implements Ledger {
  constructor(private pool: pg.Pool) {}

  async find(id: string): Promise<Transfer | null> {
    const result = await this.pool.query<TransferRow>("select * from transfers where id = $1", [id]);
    return result.rows[0] ? transferRow(result.rows[0]) : null;
  }

  async begin(transfer: Omit<Transfer, "status" | "txId" | "detail">): Promise<void> {
    await this.pool.query(
      `insert into transfers (id, cycle_id, kind, from_role, to_role, to_address, amount, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'signing')
       on conflict (id) do nothing`,
      [transfer.id, transfer.cycleId, transfer.kind, transfer.fromRole, transfer.toRole, transfer.toAddress, transfer.amount.toString()],
    );
  }

  async update(id: string, patch: { status: Transfer["status"]; txId: string | null; detail: string | null }): Promise<void> {
    await this.pool.query(
      "update transfers set status = $2, tx_id = coalesce($3, tx_id), detail = $4, updated_at = now() where id = $1",
      [id, patch.status, patch.txId, patch.detail],
    );
  }
}

class PgManagerStore implements ManagerStore {
  constructor(private pool: pg.Pool) {}

  async state(): Promise<ManagerState> {
    const result = await this.pool.query<{ running: boolean; cycle_id: string | null; next_at: Date | null }>(
      "select running, cycle_id, next_at from manager_state where id = 1",
    );
    const row = result.rows[0];
    return {
      running: row?.running ?? false,
      cycleId: row?.cycle_id == null ? null : Number(row.cycle_id),
      nextAt: iso(row?.next_at ?? null),
    };
  }

  async setState(patch: Partial<ManagerState>): Promise<void> {
    const current = await this.state();
    const next = { ...current, ...patch };
    await this.pool.query(
      "update manager_state set running = $1, cycle_id = $2, next_at = $3, updated_at = now() where id = 1",
      [next.running, next.cycleId, next.nextAt],
    );
  }

  async saveWallets(addresses: Partial<Record<Role, string>>): Promise<void> {
    for (const [role, address] of Object.entries(addresses)) {
      if (!address) continue;
      await this.pool.query(
        "insert into wallets (role, address) values ($1, $2) on conflict (role) do update set address = excluded.address",
        [role, address],
      );
    }
  }

  async openCycle(weightsBefore: Weights): Promise<Cycle> {
    const result = await this.pool.query<CycleRow>(
      "insert into cycles (phase, weights_before) values ('stopping', $1) returning *",
      [JSON.stringify(weightsBefore)],
    );
    return cycleRow(result.rows[0]);
  }

  async cycle(id: number): Promise<Cycle | null> {
    const result = await this.pool.query<CycleRow>("select * from cycles where id = $1", [id]);
    return result.rows[0] ? cycleRow(result.rows[0]) : null;
  }

  async lastCycle(): Promise<Cycle | null> {
    const result = await this.pool.query<CycleRow>("select * from cycles order by id desc limit 1");
    return result.rows[0] ? cycleRow(result.rows[0]) : null;
  }

  async updateCycle(id: number, patch: Partial<Omit<Cycle, "id" | "startedAt">>): Promise<Cycle> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(patch)) {
      const column = CYCLE_COLUMNS[key];
      if (!column) continue;
      values.push(value != null && typeof value === "object" ? JSON.stringify(jsonSafe(value)) : value);
      sets.push(`${column} = $${values.length}`);
    }
    const result = sets.length
      ? await this.pool.query<CycleRow>(`update cycles set ${sets.join(", ")} where id = $1 returning *`, values)
      : await this.pool.query<CycleRow>("select * from cycles where id = $1", [id]);
    return cycleRow(result.rows[0]);
  }

  async saveReport(cycleId: number, report: AgentReport): Promise<void> {
    await this.pool.query(
      `insert into reports (cycle_id, role, phase, wallet, deposited, withdrawn, pnl, trades, experience)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (cycle_id, role) do update set
         phase = excluded.phase, wallet = excluded.wallet, deposited = excluded.deposited,
         withdrawn = excluded.withdrawn, pnl = excluded.pnl, trades = excluded.trades, experience = excluded.experience`,
      [
        cycleId,
        report.role,
        report.phase,
        report.wallet.toString(),
        report.deposited.toString(),
        report.withdrawn.toString(),
        report.pnl.toString(),
        report.trades,
        report.experience,
      ],
    );
  }

  async reports(cycleId: number): Promise<AgentReport[]> {
    const result = await this.pool.query<{
      role: Asset;
      phase: AgentReport["phase"];
      wallet: string;
      deposited: string;
      withdrawn: string;
      pnl: string;
      trades: number;
      experience: string;
    }>("select * from reports where cycle_id = $1 order by role", [cycleId]);
    return result.rows.map((row) => ({
      role: row.role,
      phase: row.phase,
      cycleId,
      wallet: BigInt(row.wallet),
      deposited: BigInt(row.deposited),
      withdrawn: BigInt(row.withdrawn),
      pnl: BigInt(row.pnl),
      trades: row.trades,
      experience: row.experience,
    }));
  }

  async netRebalanced(): Promise<bigint> {
    const result = await this.pool.query<{ net: string | null }>(
      `select coalesce(sum(case when to_role = 'manager' then amount else -amount end), 0)::text as net
       from transfers
       where kind = 'rebalance' and status = 'confirmed' and (to_role = 'manager' or from_role = 'manager')`,
    );
    return BigInt(result.rows[0]?.net ?? "0");
  }
}

class PgAgentStore implements AgentStore {
  constructor(private pool: pg.Pool) {}

  async load(role: Asset): Promise<AgentState | null> {
    const result = await this.pool.query<{
      phase: AgentState["phase"];
      cycle_id: string | null;
      strategy: AgentState["strategy"];
      deposited: string;
      withdrawn: string;
      experience: string;
    }>("select * from agent_state where role = $1", [role]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      role,
      phase: row.phase,
      cycleId: row.cycle_id == null ? null : Number(row.cycle_id),
      strategy: row.strategy,
      deposited: BigInt(row.deposited),
      withdrawn: BigInt(row.withdrawn),
      experience: row.experience,
    };
  }

  async save(state: AgentState): Promise<void> {
    await this.pool.query(
      `insert into agent_state (role, phase, cycle_id, strategy, deposited, withdrawn, experience, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (role) do update set
         phase = excluded.phase, cycle_id = excluded.cycle_id, strategy = excluded.strategy,
         deposited = excluded.deposited, withdrawn = excluded.withdrawn, experience = excluded.experience,
         updated_at = now()`,
      [
        state.role,
        state.phase,
        state.cycleId,
        state.strategy ? JSON.stringify(state.strategy) : null,
        state.deposited.toString(),
        state.withdrawn.toString(),
        state.experience,
      ],
    );
  }

  async fills(role: Asset, cycleId: number): Promise<Fill[]> {
    const result = await this.pool.query<{
      side: Fill["side"];
      qty: number;
      price: number;
      cash: string;
      fee: string;
      reason: string;
    }>("select * from broker_orders where role = $1 and cycle_id = $2 order by id", [role, cycleId]);
    return result.rows.map((row) => ({
      role,
      cycleId,
      side: row.side,
      qty: Number(row.qty),
      price: Number(row.price),
      cash: BigInt(row.cash),
      fee: BigInt(row.fee),
      reason: row.reason,
    }));
  }

  async snapshot(row: ValueSnapshot): Promise<void> {
    await this.pool.query(
      "insert into value_snapshots (role, cash, qty, price, value) values ($1, $2, $3, $4, $5)",
      [row.role, row.cash.toString(), row.qty, row.price, row.value.toString()],
    );
  }
}

class PgBrokerStore implements BrokerStore {
  constructor(private pool: pg.Pool) {}

  async accounts(): Promise<BrokerAccount[]> {
    const result = await this.pool.query<{ role: Asset; cash: string; qty: number }>("select role, cash, qty from broker_accounts");
    return result.rows.map((row) => ({ role: row.role, cash: BigInt(row.cash), qty: Number(row.qty) }));
  }

  async credit(input: { txId: string; role: Asset; amount: bigint }): Promise<BrokerAccount> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        "insert into broker_credits (tx_id, role, amount) values ($1, $2, $3) on conflict do nothing",
        [input.txId, input.role, input.amount.toString()],
      );
      const amount = inserted.rowCount ? input.amount : 0n;
      const result = await client.query<{ cash: string; qty: number }>(
        `insert into broker_accounts (role, cash, qty) values ($1, $2, 0)
         on conflict (role) do update set cash = broker_accounts.cash + $2, updated_at = now()
         returning cash, qty`,
        [input.role, amount.toString()],
      );
      await client.query("commit");
      return { role: input.role, cash: BigInt(result.rows[0].cash), qty: Number(result.rows[0].qty) };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async applyFill(account: BrokerAccount, fill: Fill): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into broker_accounts (role, cash, qty) values ($1, $2, $3)
         on conflict (role) do update set cash = excluded.cash, qty = excluded.qty, updated_at = now()`,
        [account.role, account.cash.toString(), account.qty],
      );
      await client.query(
        `insert into broker_orders (role, cycle_id, side, qty, price, cash, fee, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fill.role, fill.cycleId, fill.side, fill.qty, fill.price, fill.cash.toString(), fill.fee.toString(), fill.reason],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveWithdraw(input: {
    account: BrokerAccount;
    transfer: Omit<Transfer, "status" | "txId" | "detail">;
  }): Promise<void> {
    const { account, transfer } = input;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into broker_accounts (role, cash, qty) values ($1, $2, $3)
         on conflict (role) do update set cash = excluded.cash, qty = excluded.qty, updated_at = now()`,
        [account.role, account.cash.toString(), account.qty],
      );
      await client.query(
        `insert into transfers (id, cycle_id, kind, from_role, to_role, to_address, amount, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'signing')`,
        [transfer.id, transfer.cycleId, transfer.kind, transfer.fromRole, transfer.toRole, transfer.toAddress, transfer.amount.toString()],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async savePrices(ticks: Tick[]): Promise<void> {
    for (const tick of ticks) {
      await this.pool.query("insert into prices (asset, at, price) values ($1, $2, $3) on conflict do nothing", [
        tick.asset,
        tick.at,
        tick.price,
      ]);
    }
  }

  async lastPrices(): Promise<Partial<Record<Asset, number>>> {
    const result = await this.pool.query<{ asset: Asset; price: number }>(
      "select distinct on (asset) asset, price from prices order by asset, at desc",
    );
    return Object.fromEntries(result.rows.map((row) => [row.asset, Number(row.price)]));
  }
}

class PgDeskStore implements DeskStore {
  constructor(private pool: pg.Pool) {}

  async state(): Promise<DeskState> {
    const [manager, agents, accounts, latestValues, cycles, reports, transfers, prices, values, wallets] = await Promise.all([
      this.pool.query<{ running: boolean; cycle_id: string | null; next_at: Date | null }>("select * from manager_state where id = 1"),
      this.pool.query<{
        role: Asset;
        phase: string;
        cycle_id: string | null;
        strategy: { stance?: string; notes?: string } | null;
        experience: string;
        updated_at: Date;
      }>("select * from agent_state order by role"),
      this.pool.query<{ role: string; cash: string; qty: number }>("select role, cash::text, qty from broker_accounts"),
      this.pool.query<{ role: string; value: string }>(
        "select distinct on (role) role, value::text from value_snapshots order by role, at desc",
      ),
      this.pool.query<CycleRow>("select * from cycles order by id desc limit 20"),
      this.pool.query<{
        cycle_id: string;
        role: Asset;
        wallet: string;
        deposited: string;
        withdrawn: string;
        pnl: string;
        trades: number;
        experience: string;
      }>("select * from reports where cycle_id in (select id from cycles order by id desc limit 20)"),
      this.pool.query<TransferRow & { created_at: Date }>("select * from transfers order by created_at desc limit 80"),
      this.pool.query<{ asset: string; at: Date; price: number }>(
        "select asset, at, price from prices where at > now() - interval '15 minutes' order by at",
      ),
      this.pool.query<{ role: string; at: Date; value: string }>(
        "select role, at, value::text from value_snapshots where at > now() - interval '2 hours' order by at",
      ),
      this.pool.query<{ role: string; address: string }>("select role, address from wallets order by role"),
    ]);

    const account = new Map(accounts.rows.map((row) => [row.role, row]));
    const latest = new Map(latestValues.rows.map((row) => [row.role, row.value]));
    const byCycle = new Map<string, DeskCycle["reports"]>();
    for (const row of reports.rows) {
      const list = byCycle.get(row.cycle_id) ?? [];
      list.push({
        role: row.role,
        wallet: row.wallet,
        deposited: row.deposited,
        withdrawn: row.withdrawn,
        pnl: row.pnl,
        trades: row.trades,
        experience: row.experience,
      });
      byCycle.set(row.cycle_id, list);
    }
    const priceSeries: DeskState["prices"] = {};
    for (const row of prices.rows) {
      (priceSeries[row.asset] ??= []).push({ at: row.at.toISOString(), price: Number(row.price) });
    }
    const valueSeries: DeskState["values"] = {};
    for (const row of values.rows) {
      (valueSeries[row.role] ??= []).push({ at: row.at.toISOString(), value: row.value });
    }
    const head = manager.rows[0];

    return {
      manager: {
        running: head?.running ?? false,
        cycleId: head?.cycle_id == null ? null : Number(head.cycle_id),
        nextAt: iso(head?.next_at ?? null),
      },
      agents: agents.rows.map((row) => ({
        role: row.role,
        phase: row.phase,
        cycleId: row.cycle_id == null ? null : Number(row.cycle_id),
        stance: row.strategy?.stance ?? null,
        notes: row.strategy?.notes ?? null,
        experience: row.experience,
        cash: account.get(row.role)?.cash ?? "0",
        qty: Number(account.get(row.role)?.qty ?? 0),
        value: latest.get(row.role) ?? "0",
        updatedAt: row.updated_at.toISOString(),
      })),
      cycles: cycles.rows.map((row) => ({
        id: Number(row.id),
        phase: row.phase,
        startedAt: row.started_at.toISOString(),
        finishedAt: iso(row.finished_at),
        weightsBefore: row.weights_before,
        weightsAfter: row.weights_after,
        trends: row.trends,
        rationale: row.rationale,
        source: row.source,
        error: row.error,
        reports: byCycle.get(row.id) ?? [],
      })),
      transfers: transfers.rows.map((row) => ({
        id: row.id,
        cycleId: row.cycle_id == null ? null : Number(row.cycle_id),
        kind: row.kind,
        from: row.from_role,
        to: row.to_role,
        amount: row.amount,
        status: row.status,
        txId: row.tx_id,
        detail: row.detail,
        at: row.created_at.toISOString(),
      })),
      prices: priceSeries,
      values: valueSeries,
      wallets: wallets.rows,
    };
  }
}

export const openLedger = (databaseUrl: string): Ledger => new PgLedger(poolFor(databaseUrl));
export const openManagerStore = (databaseUrl: string): ManagerStore => new PgManagerStore(poolFor(databaseUrl));
export const openAgentStore = (databaseUrl: string): AgentStore => new PgAgentStore(poolFor(databaseUrl));
export const openBrokerStore = (databaseUrl: string): BrokerStore => new PgBrokerStore(poolFor(databaseUrl));
export const openDeskStore = (databaseUrl: string): DeskStore => new PgDeskStore(poolFor(databaseUrl));
