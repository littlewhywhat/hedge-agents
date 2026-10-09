"use client";

import { startTransition, useEffect, useState } from "react";
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, ExternalLink, History, LoaderCircle, Play, Power, RadioTower, ShieldCheck, ShieldOff, Sparkles, Trophy, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DeskAgent, DeskCycle, DeskData, DeskTrade } from "./types";
import { Avatar, Empty, Pill, markets } from "./ui";

const assets = ["btc", "eth", "spx", "gold"] as const;
const scan = "https://preprod.cardanoscan.io";
const key = (role: string) => role === "spx" ? "stocks" : role;
const label = (role: string) => markets[key(role)]?.name || role.charAt(0).toUpperCase() + role.slice(1);
const zero = BigInt(0);
const unit = BigInt(1_000_000);
const cent = BigInt(10_000);
const tada = (lovelace: string | number | bigint | undefined) => {
  const value = BigInt(lovelace || 0);
  const abs = value < zero ? -value : value;
  return `${value < zero ? "-" : ""}${(abs / unit).toLocaleString("en-US")}.${((abs % unit) / cent).toString().padStart(2, "0")}`;
};
const percent = (value: number | undefined) => `${Math.round((value || 0) * 100)}%`;
const clock = (value: string | null | undefined, seconds = true) => value ? new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }) : "-";
const countdown = (value: string | null | undefined, now: number) => {
  if (!value) return "-";
  const left = Math.max(0, Math.round((new Date(value).getTime() - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};
const ago = (value: string, now: number) => {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
};
const price = (value: number | null | undefined) => value == null ? "-" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlOf = (agent: DeskAgent) => agent.phase === "trading" && BigInt(agent.deposited || 0) > zero ? Number(BigInt(agent.value) - BigInt(agent.deposited)) / 1e6 : 0;
const waiting: Record<string, string> = { idle: "Waiting for the manager's next start.", depositing: "Sending tADA to the broker on Preprod.", withdrawing: "Closing the position and withdrawing to its wallet." };
const phaseTone = (phase: string) => ["trading", "running", "done", "confirmed"].includes(phase) ? "green" : ["idle", "neutral"].includes(phase) ? "neutral" : "amber";

async function desk<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch(`/api/desk/${path}`, { method, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Manager rejected the request.");
  return result;
}

function Spark({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return <span className="muted">-</span>;
  return <LineChart width={86} height={26} data={points.map((value, index) => ({ index, value }))}><YAxis hide domain={["dataMin", "dataMax"]} /><Line dataKey="value" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} /></LineChart>;
}

function Ticker({ data }: { data: DeskData | null }) {
  const current = Object.fromEntries(assets.map((asset) => [asset, data?.agents.find((agent) => agent.role === asset)?.price ?? null]));
  const [last, setLast] = useState(current);
  const [moves, setMoves] = useState<Record<string, string>>({});
  if (assets.some((asset) => current[asset] !== last[asset])) {
    setMoves(Object.fromEntries(assets.map((asset) => [asset, last[asset] == null || current[asset] == null || current[asset] === last[asset] ? "" : current[asset]! > last[asset]! ? "up" : "down"])));
    setLast(current);
  }
  return <div className="desk-ticker">{assets.map((asset) => {
    const series = data?.prices[asset] || [];
    const change = series.length && current[asset] ? (current[asset]! / series[0].price - 1) * 100 : 0;
    return <div className="ticker-cell" key={asset}><Avatar agent={key(asset)} small /><span><small>{label(asset)}</small><strong key={`${asset}-${current[asset]}`} className={`numeric tick-${moves[asset] || "flat"}`}>{price(current[asset])}</strong></span><em className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</em></div>;
  })}</div>;
}

function Trades({ trades, now }: { trades: DeskTrade[]; now: number }) {
  if (!trades.length) return <Empty icon={Activity} heading="No trades yet" text="Fills appear here the moment an agent buys or sells at the broker." />;
  return <div className="activity-list desk-trades">{trades.slice(0, 10).map((trade) => <div className="activity-row trade-row" key={trade.id}><span className={`activity-icon ${trade.side === "sell" ? "sell" : ""}`}>{trade.side === "sell" ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}</span><div><strong>{label(trade.role)} {trade.side === "sell" ? "sold" : "bought"} {trade.qty.toFixed(4)} @ {price(trade.price)}</strong><small>{trade.reason}</small></div><strong className="numeric">{tada(trade.cash)} tADA</strong><time>{ago(trade.at, now)}</time></div>)}</div>;
}

function Leaderboard({ agents }: { agents: DeskAgent[] }) {
  const rows = assets.map((asset) => {
    const agent = agents.find((row) => row.role === asset);
    const pnl = agent ? pnlOf(agent) : 0;
    const base = agent ? Number(BigInt(agent.deposited || 0)) / 1e6 : 0;
    return { asset, pnl, pct: base > 0 && agent?.phase === "trading" ? pnl / base * 100 : 0 };
  }).sort((a, b) => b.pct - a.pct);
  const scale = Math.max(0.05, ...rows.map((row) => Math.abs(row.pct)));
  return <aside className="round-panel desk-leaders"><div className="section-heading"><h2>Leaderboard</h2><Trophy size={16} /></div><div className="score-header"><span>Since deposit</span><span>PnL</span></div>{rows.map((row, index) => <div className="leader-row" key={row.asset}><span className="leader-rank">{index + 1}</span><Avatar agent={key(row.asset)} small /><span className="leader-name">{label(row.asset)}</span><span className="leader-track"><i className={row.pct >= 0 ? "up" : "down"} style={{ width: `${Math.abs(row.pct) / scale * 50}%` }} /></span><strong className={`numeric ${row.pct >= 0 ? "positive" : "negative"}`}>{row.pct >= 0 ? "+" : ""}{row.pct.toFixed(2)}%<small>{row.pnl >= 0 ? "+" : ""}{row.pnl.toFixed(2)}</small></strong></div>)}</aside>;
}

function Thinking({ agent, now }: { agent: DeskAgent | undefined; now: number }) {
  if (!agent || agent.phase !== "trading" || !agent.thought) return <span className="desk-thought"><small>{waiting[agent?.phase || "idle"] || "Starting to trade."}</small></span>;
  const { thought } = agent;
  const left = Math.ceil((new Date(thought.nextAt).getTime() - now) / 1000);
  const due = left <= 0;
  return <span className="desk-thought"><span><span className={`operation ${thought.side}`}>{thought.side}{thought.side !== "hold" ? ` ${Math.round(thought.fraction * 100)}%` : ""}</span><time>{ago(thought.at, now)}</time></span><small title={thought.reason}>{thought.reason}</small><em>{due ? <><LoaderCircle className="spin" size={11} />Thinking...</> : `Next decision in ${left}s`}</em></span>;
}

function Round({ cycle, index, count, onMove }: { cycle: DeskCycle; index: number; count: number; onMove: (step: number) => void }) {
  const weights = cycle.weightsAfter || cycle.weightsBefore;
  return <aside className="round-panel">
    <div className="section-heading"><h2>Allocation round</h2><span className="round-stepper"><button className="icon-button" title="Older cycle" aria-label="Older cycle" disabled={index >= count - 1} onClick={() => onMove(1)}><ChevronLeft size={15} /></button><span className="round-number">#{String(cycle.id).padStart(2, "0")}</span><button className="icon-button" title="Newer cycle" aria-label="Newer cycle" disabled={index <= 0} onClick={() => onMove(-1)}><ChevronRight size={15} /></button></span></div>
    <div className="round-date"><span>{clock(cycle.startedAt)}{cycle.finishedAt ? ` - ${clock(cycle.finishedAt)}` : ""}</span><Pill tone={cycle.error ? "amber" : phaseTone(cycle.phase)}>{cycle.phase}</Pill></div>
    <div className="score-header"><span>Sleeve</span><span>Before / after</span></div>
    {[...assets, "reserve" as const].map((name) => <div className="score-row" key={name}><div><Avatar agent={key(name)} small /><span>{label(name)}</span></div><span className="score-track"><i style={{ width: `${Math.min(100, weights[name] * 250)}%`, background: markets[key(name)]?.color || "#a5afa9" }} /></span><strong>{percent(cycle.weightsBefore[name])} / {cycle.weightsAfter ? percent(cycle.weightsAfter[name]) : "-"}</strong></div>)}
    <div className="round-note"><span className="round-note-icon">{cycle.error ? <ShieldOff size={18} /> : <Sparkles size={18} />}</span><div><strong>{cycle.error ? "Retrying phase" : cycle.source === "gemini" ? "Gemini allocation" : cycle.source ? "Fallback allocation" : "Awaiting decision"}</strong><p>{cycle.error || cycle.rationale || "The manager stops the agents, reads trends, then decides the split."}</p></div></div>
  </aside>;
}

export default function LiveDesk() {
  const [data, setData] = useState<DeskData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [chartMode, setChartMode] = useState<"value" | "prices">("value");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await desk<DeskData>("desk");
        if (!disposed) startTransition(() => { setData(next); setError(""); });
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Manager connection lost");
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; clearInterval(timer); clearInterval(tick); };
  }, []);

  async function command(name: "start" | "stop") {
    setBusy(true);
    try {
      await desk(name, "POST");
      setNotice(name === "start" ? "Manager started. The first cycle stops agents, reads trends, then funds the sleeves." : "Stopping. Agents withdraw from the broker; this takes a few Preprod blocks.");
      setData(await desk<DeskData>("desk"));
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : "Command failed"); }
    finally { setBusy(false); }
  }

  const live = data?.live;
  const cycles = data?.cycles || [];
  const index = Math.max(0, cycles.findIndex((cycle) => cycle.id === selected));
  const cycle = cycles[index];
  const current = cycles[0];
  const total = (data?.agents || []).reduce((sum, agent) => sum + BigInt(agent.value || 0), zero);
  const confirmed = (data?.transfers || []).filter((transfer) => transfer.status === "confirmed").length;
  const trading = (data?.agents || []).filter((agent) => agent.phase === "trading").length;
  const pnl = (data?.agents || []).reduce((sum, agent) => sum + pnlOf(agent), 0);
  const status = !live ? "Manager offline" : live.halting ? "Stopping agents" : live.running ? `Cycle ${current?.id ?? ""} / ${current?.phase ?? ""}` : "Stopped";

  const chartData = (() => {
    const rows = new Map<string, Record<string, number | string>>();
    for (const asset of assets) {
      const series = chartMode === "value" ? (data?.values[asset] || []).map((point) => ({ at: point.at, y: Number(point.value) / 1e6 })) : (data?.prices[asset] || []).map((point, i, all) => ({ at: point.at, y: (point.price / all[0].price - 1) * 100 }));
      for (const point of series) rows.set(point.at, { ...(rows.get(point.at) || { time: point.at }), [asset]: point.y });
    }
    return [...rows.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  })();

  return <>
    <div className="page-heading"><div><div className="eyebrow">MASUMI FUND / CARDANO DESK</div><h1>Live desk</h1></div><div className="desk-actions"><button className="primary-button" disabled={busy || !live || live.running || live.halting} onClick={() => void command("start")}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" />}Start manager</button><button className="halt-button" disabled={busy || !live || (!live.running && !live.looping)} onClick={() => void command("stop")}><Power size={16} />Stop and withdraw</button></div></div>

    <div className="environment-banner preprod"><div><span className="banner-icon"><RadioTower size={16} /></span><strong>Preprod / tADA</strong><span className="banner-detail">Every wallet move is a Cardano Preprod transaction. Broker prices are simulated.</span></div><span className="banner-end">{status}{live?.running && current?.phase === "running" ? ` / next revision in ${countdown(live.nextAt, now)}` : ""}</span></div>
    {error && <div className="error-banner" role="alert"><ShieldOff size={17} /><span>{error} Previously loaded values are not current.</span></div>}
    {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" title="Dismiss notification" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={15} /></button></div>}
    <Ticker data={data} />

    <section className="metrics" aria-label="Desk state"><div className="metric primary"><span className="metric-label">Value at broker <span className="label-tag">tADA</span></span><div className="fund-value">{data ? tada(total) : <span className="skeleton-number">0.00</span>}</div><div className={`return-label ${pnl >= 0 ? "positive" : "negative"}`}>{pnl >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />} {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} tADA <span>since deposit / {trading} of 4 trading</span></div></div><div className="metric"><span className="metric-label">Cycle</span><strong>{current ? `#${current.id}` : "-"}</strong><small>{current?.phase || "No cycle yet"}</small></div><div className="metric"><span className="metric-label">Next revision</span><strong>{live?.running && current?.phase === "running" ? countdown(live.nextAt, now) : "-"}</strong><small>{live?.running ? "Manager loop running" : "Manager loop stopped"}</small></div><div className="metric"><span className="metric-label">Transactions</span><strong>{confirmed}</strong><small>Confirmed on Preprod</small></div></section>

    <div className="overview-grid"><section className="performance-section"><div className="section-heading"><div><h2>{chartMode === "value" ? "Agent value at broker" : "Simulated price change"}</h2><span className="subtle">{chartMode === "value" ? "Cash plus position, marked at broker prices" : "Percent from the first stored tick"}</span></div><div className="chart-actions"><div className="compact-segment"><button className={chartMode === "value" ? "selected" : ""} onClick={() => setChartMode("value")}>Value</button><button className={chartMode === "prices" ? "selected" : ""} onClick={() => setChartMode("prices")}>Prices</button></div></div></div>
      {chartData.length > 1 ? <div className="chart-container"><ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={chartData} margin={{ top: 18, right: 12, left: 0, bottom: 4 }}><CartesianGrid vertical={false} stroke="#e9eeed" strokeDasharray="3 4" /><XAxis dataKey="time" tickFormatter={(value) => clock(String(value), false)} axisLine={false} tickLine={false} tick={{ fill: "#87928d", fontSize: 11 }} minTickGap={40} dy={12} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "#87928d", fontSize: 11 }} tickFormatter={(value) => chartMode === "value" ? `${Number(value).toFixed(0)}` : `${Number(value).toFixed(1)}%`} width={55} domain={["auto", "auto"]} /><Tooltip contentStyle={{ borderRadius: 6, border: "1px solid #dce5df", fontSize: 12, boxShadow: "0 4px 20px #172d2210" }} labelFormatter={(value) => clock(String(value))} formatter={(value, name) => [chartMode === "value" ? `${Number(value).toFixed(2)} tADA` : `${Number(value).toFixed(2)}%`, label(String(name))]} />
        {assets.map((asset) => <Line key={asset} dataKey={asset} name={asset} type="monotone" stroke={markets[key(asset)].color} strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer></div> : <Empty icon={Activity} heading="No desk history yet" text="Press Start. Values appear once agents deposit to the broker." />}
      <div className="chart-legend">{assets.map((asset) => <span key={asset}><i style={{ background: markets[key(asset)].color }} />{label(asset)}</span>)}<span className="legend-note">Simulated broker, real tADA deposits</span></div>
    </section>
    {cycle ? <Round cycle={cycle} index={index} count={cycles.length} onMove={(step) => setSelected(cycles[Math.min(cycles.length - 1, Math.max(0, index + step))].id)} /> : <aside className="round-panel"><div className="section-heading"><h2>Allocation round</h2></div><p className="status-copy">No cycles yet. Start the manager to run the first revision.</p></aside>}</div>

    <div className="overview-grid desk-live-grid"><section className="performance-section"><div className="section-heading"><div><h2>Live trades <span className="live-dot" /></h2><span className="subtle">Broker fills with the agent&apos;s own reason</span></div></div><Trades trades={data?.trades || []} now={now} /></section><Leaderboard agents={data?.agents || []} /></div>

    <section className="allocation-section"><div className="section-heading"><div><h2>Agent desk <span className="count-badge">4</span></h2><span className="subtle">Broker balances and the strategy each agent received</span></div><Pill tone={live?.running ? "green" : "neutral"}>{live?.running ? "Loop running" : "Loop stopped"}</Pill></div><div className="table-scroll"><table className="agent-table"><thead><tr><th>Agent / market</th><th>Value</th><th>Allocation</th><th>Cash</th><th>Units</th><th>Price</th><th>Thinking</th><th>Status</th></tr></thead><tbody>{assets.map((asset) => {
      const agent = data?.agents.find((row) => row.role === asset);
      const prices = (data?.prices[asset] || []).map((point) => point.price);
      const weight = (current?.weightsAfter || current?.weightsBefore)?.[asset];
      const offline = live?.agents[asset] === false;
      return <tr key={asset}><td><div className="agent-identity"><Avatar agent={key(asset)} /><span><strong>{label(asset)}</strong><small title={agent?.notes || undefined} className="capitalize">{agent?.stance ? `${agent.stance} strategy` : "No strategy yet"}</small></span></div></td><td className="numeric">{tada(agent?.value)}</td><td><div className="allocation-cell"><strong>{percent(weight)}</strong><span><i style={{ width: percent(weight), background: markets[key(asset)].color }} /></span></div></td><td className="numeric">{tada(agent?.cash)}</td><td className="numeric muted">{(agent?.qty || 0).toFixed(4)}</td><td><div className="desk-price"><Spark points={prices} color={markets[key(asset)].color} /><span className="numeric">{price(agent?.price)}</span></div></td><td><Thinking agent={agent} now={now} /></td><td><Pill tone={offline ? "amber" : phaseTone(agent?.phase || "idle")}>{offline ? "Offline" : agent?.phase || "idle"}</Pill></td></tr>;
    })}</tbody></table></div></section>

    {cycle && (cycle.reports.length > 0 || cycle.trends) && <section className="recent-section"><div className="section-heading"><div><h2>Cycle #{cycle.id} reports</h2><span className="subtle">What each agent returned and learned, and the trends the manager read</span></div></div><div className="desk-reports">
      <div className="activity-list">{cycle.reports.length ? cycle.reports.map((report) => <div className="activity-row" key={report.role}><Avatar agent={key(report.role)} small /><div><strong>{label(report.role)} / {report.trades} trades</strong><small>{report.experience || "No trading yet."}</small></div><span className="desk-flow numeric">{tada(report.deposited)} in / {tada(report.withdrawn)} out</span><strong className={`numeric ${BigInt(report.pnl) >= zero ? "positive" : "negative"}`}>{BigInt(report.pnl) > zero ? "+" : ""}{tada(report.pnl)}</strong></div>) : <p className="status-copy">Reports arrive when agents stop at the next revision.</p>}</div>
      {cycle.trends && <div className="desk-trends"><h3>Market trends</h3>{assets.map((asset) => <div className="desk-trend" key={asset}><Avatar agent={key(asset)} small /><p>{cycle.trends?.[asset] || "-"}</p></div>)}</div>}
    </div></section>}

    <section className="recent-section"><div className="section-heading"><div><h2>Cardano transactions</h2><span className="subtle">Manager funding, broker deposits and withdrawals</span></div></div>{data?.transfers.length ? <div className="activity-list">{data.transfers.slice(0, 12).map((transfer) => <div className="activity-row" key={transfer.id}><span className={`activity-icon ${transfer.to === "manager" || transfer.kind.includes("withdraw") ? "sell" : ""}`}>{transfer.to === "manager" ? <ArrowDownLeft size={15} /> : <ArrowRight size={15} />}</span><div><strong>{label(transfer.from)} to {label(transfer.to)}</strong><small>{transfer.kind} / cycle {transfer.cycleId ?? "-"}{transfer.detail && !transfer.txId ? ` / ${transfer.detail}` : ""}</small></div><strong className="numeric">{tada(transfer.amount)} tADA</strong><time>{clock(transfer.at)}</time>{transfer.txId ? <a className="text-button" href={`${scan}/transaction/${transfer.txId}`} target="_blank" rel="noreferrer">{transfer.txId.slice(0, 8)} <ExternalLink size={12} /></a> : <Pill tone={phaseTone(transfer.status)}>{transfer.status}</Pill>}</div>)}</div> : <Empty icon={History} heading="No transactions yet" text="Funding and broker transfers appear here with Cardanoscan links." />}</section>

    <section className="wallet-section recent-section"><div className="section-heading"><h2>Desk wallets</h2><span className="subtle">Public Preprod addresses</span></div>{(data?.wallets || []).map((wallet) => <div className="wallet-row" key={wallet.role}><Avatar agent={key(wallet.role)} small /><span>{label(wallet.role)}</span><code>{wallet.address}</code><a className="icon-button" href={`${scan}/address/${wallet.address}`} target="_blank" rel="noreferrer" title="Open in Cardanoscan" aria-label={`Open ${wallet.role} wallet in Cardanoscan`}><ExternalLink size={15} /></a></div>)}</section>

    <footer className="footer"><span><ShieldCheck size={13} />Postgres ledger / Cardano Preprod receipts</span><span>Gemini decides the split. Code caps every move.</span></footer>
  </>;
}
