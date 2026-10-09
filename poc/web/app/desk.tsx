"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeskCycle, DeskState, ManagerLive } from "@/interface";

const ASSETS = ["btc", "eth", "spx", "gold"] as const;
const NAMES: Record<string, string> = { btc: "Bitcoin", eth: "Ether", spx: "S&P 500", gold: "Gold", reserve: "reserve" };
const POLL_MS = 3000;

type State = DeskState & { live: ManagerLive | null };

const tada = (amount: string | bigint): string => {
  const value = typeof amount === "bigint" ? amount : BigInt(amount || "0");
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = ((abs % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
};

const time = (iso: string | null): string => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
};

const countdown = (iso: string | null, now: number): string => {
  if (!iso) return "";
  const left = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};

const pct = (value: number | undefined): string => `${Math.round((value ?? 0) * 100)}%`;

const Spark = ({ points, className }: { points: number[]; className: string }) => {
  if (points.length < 2) return <svg className="spark" viewBox="0 0 100 30" />;
  const low = Math.min(...points);
  const high = Math.max(...points);
  const span = high - low || 1;
  const line = points
    .map((value, index) => `${((index / (points.length - 1)) * 100).toFixed(2)},${(28 - ((value - low) / span) * 26).toFixed(2)}`)
    .join(" ");
  return (
    <svg className={`spark ${className}`} viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline points={line} />
    </svg>
  );
};

const Weights = ({ cycle }: { cycle: DeskCycle }) => {
  const after = cycle.weightsAfter;
  return (
    <div className="weights">
      {[...ASSETS, "reserve" as const].map((key) => (
        <div className="weight" key={key}>
          <b className={`name ${key}`}>{key}</b>
          <span>{pct(cycle.weightsBefore[key])}</span>
          <i>→</i>
          <span>{after ? pct(after[key]) : "…"}</span>
          <div className="bar">
            <div className={`fill ${key}`} style={{ width: pct(after?.[key] ?? cycle.weightsBefore[key]) }} />
          </div>
        </div>
      ))}
    </div>
  );
};

export const Desk = () => {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = (await fetch("/api/state", { cache: "no-store" }).then((res) => res.json())) as State;
        if (alive) setState(next);
      } catch {
        // keep the last good state on screen
      }
    };
    void load();
    const poll = window.setInterval(load, POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, []);

  const cycle = useMemo(() => {
    if (!state?.cycles.length) return null;
    return state.cycles.find((item) => item.id === selected) ?? state.cycles[0];
  }, [state, selected]);

  const command = async (name: "start" | "stop") => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/${name}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `${name} failed`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${name} failed`);
    } finally {
      setBusy(false);
    }
  };

  const live = state?.live;
  const current = state?.cycles[0];
  const status = !live
    ? "manager offline"
    : live.halting
      ? "stopping agents, withdrawing"
      : live.running
        ? `cycle ${current?.id ?? ""} · ${current?.phase ?? ""}${current?.phase === "running" ? ` · next in ${countdown(live.nextAt, now)}` : ""}`
        : "stopped";
  const total = (state?.agents ?? []).reduce((sum, agent) => sum + BigInt(agent.value || "0"), 0n);
  const wallet = (role: string) => state?.wallets.find((row) => row.role === role)?.address;

  return (
    <main className="desk">
      <header className="top">
        <div className="brand">
          <b>HEDGE DESK</b>
          <span>Cardano Preprod · tADA · simulated broker</span>
        </div>
        <div className="live">
          <i className={live?.running ? "dot" : "dot off"} />
          {status}
          {current?.error ? <em className="warn"> · retrying: {current.error}</em> : null}
        </div>
        <div className="controls">
          <button className="go" disabled={busy || !live || live.running || live.halting} onClick={() => void command("start")}>
            Start
          </button>
          <button className="halt" disabled={busy || !live || (!live.running && !live.looping)} onClick={() => void command("stop")}>
            Stop
          </button>
        </div>
      </header>
      <p className="err">{error}</p>
      <section className="grid">
        <aside className="panel agents">
          <header>
            <span>AGENTS</span>
            <b>{tada(total)} tADA at broker</b>
          </header>
          {ASSETS.map((asset) => {
            const agent = state?.agents.find((item) => item.role === asset);
            const prices = (state?.prices[asset] ?? []).map((point) => point.price);
            const last = prices[prices.length - 1];
            const connected = live?.agents?.[asset];
            return (
              <article className="agent" key={asset}>
                <div className="row">
                  <b className={`name ${asset}`}>{NAMES[asset]}</b>
                  <span className={`phase ${agent?.phase ?? "idle"}`}>
                    {connected === false ? "offline" : (agent?.phase ?? "idle")}
                  </span>
                </div>
                <Spark points={prices} className={asset} />
                <div className="row meta">
                  <span>{last ? last.toFixed(2) : "–"} tADA/unit</span>
                  <span>{agent?.stance ?? ""}</span>
                </div>
                <div className="row meta">
                  <span>cash {tada(agent?.cash ?? "0")}</span>
                  <span>units {(agent?.qty ?? 0).toFixed(6)}</span>
                  <span>value {tada(agent?.value ?? "0")}</span>
                </div>
                {agent?.experience ? <p className="note">{agent.experience}</p> : null}
              </article>
            );
          })}
        </aside>

        <section className="panel cycle">
          <header>
            <span>CYCLES</span>
            <div className="tabs">
              {(state?.cycles ?? []).slice(0, 12).map((item) => (
                <button key={item.id} className={item.id === cycle?.id ? "tab on" : "tab"} onClick={() => setSelected(item.id)}>
                  {item.id}
                </button>
              ))}
            </div>
          </header>
          {cycle ? (
            <div className="detail">
              <div className="row meta">
                <span>
                  #{cycle.id} · {cycle.phase} · started {time(cycle.startedAt)}
                  {cycle.finishedAt ? ` · ended ${time(cycle.finishedAt)}` : ""}
                </span>
                <span>{cycle.source ? `decision: ${cycle.source}` : ""}</span>
              </div>
              <Weights cycle={cycle} />
              {cycle.rationale ? (
                <article className="bubble manager">
                  <div className="who manager">manager</div>
                  <p>{cycle.rationale}</p>
                </article>
              ) : null}
              {cycle.reports.length ? (
                <>
                  <h4>REPORTS</h4>
                  {cycle.reports.map((report) => (
                    <article className={`bubble ${report.role}`} key={report.role}>
                      <div className={`who ${report.role}`}>
                        {report.role} · deposited {tada(report.deposited)} · returned {tada(report.withdrawn)} · pnl{" "}
                        <span className={BigInt(report.pnl) >= 0n ? "up" : "down"}>{tada(report.pnl)}</span> · {report.trades} trades
                      </div>
                      <p>{report.experience || "No trading yet."}</p>
                    </article>
                  ))}
                </>
              ) : null}
              {cycle.trends ? (
                <>
                  <h4>TRENDS</h4>
                  {ASSETS.map((asset) => (
                    <div className="trend" key={asset}>
                      <b className={`name ${asset}`}>{asset}</b>
                      <p>{cycle.trends?.[asset]}</p>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : (
            <p className="empty">No cycles yet. Press Start.</p>
          )}
        </section>

        <aside className="panel side">
          <header>WALLETS</header>
          <div className="balances">
            {(state?.wallets ?? []).map((row) => (
              <div className="row" key={row.role}>
                <b className={`name ${row.role}`}>{row.role}</b>
                <a href={`https://preprod.cardanoscan.io/address/${row.address}`} target="_blank" rel="noreferrer">
                  {row.address.slice(0, 14)}…
                </a>
              </div>
            ))}
          </div>
          <header>TRANSACTIONS</header>
          <div className="log">
            {(state?.transfers ?? []).map((transfer) => (
              <div className="tx" key={transfer.id}>
                <div>
                  <div>
                    <span className={`name ${transfer.from}`}>{transfer.from}</span> →{" "}
                    <span className={`name ${transfer.to}`}>{transfer.to}</span> <small>{transfer.kind}</small>
                  </div>
                  <em className={transfer.status}>
                    {transfer.status} · {time(transfer.at)}
                    {transfer.txId ? (
                      <>
                        {" · "}
                        <a href={`https://preprod.cardanoscan.io/transaction/${transfer.txId}`} target="_blank" rel="noreferrer">
                          {transfer.txId.slice(0, 10)}…
                        </a>
                      </>
                    ) : transfer.detail ? (
                      ` · ${transfer.detail}`
                    ) : null}
                  </em>
                </div>
                <span>{tada(transfer.amount)}</span>
              </div>
            ))}
          </div>
          {wallet("broker") ? null : <p className="empty">Wallets appear once the manager starts.</p>}
        </aside>
      </section>
    </main>
  );
};
