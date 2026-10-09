"use client";

import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, CirclePause, Copy, ExternalLink, Fingerprint, Hexagon, History, KeyRound, LayoutDashboard, LoaderCircle, LockKeyhole, MessageSquare, Pause, Play, Power, RadioTower, RefreshCw, Search, Send, Settings2, ShieldCheck, ShieldOff, SkipBack, SkipForward, SlidersHorizontal, Users, Wallet, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import LiveDesk from "./live-desk";
import type { AgentName, AuditEvent, Frame, Inventory, LiveData, Message, Numbers, PaperTrade, PolicyState, Proposal, Readiness, Round } from "./types";
import { Avatar, Empty, Pill, markets } from "./ui";

const historicalLabels: Record<string, string> = {
  btc: "BTC/USDT / daily candles",
  eth: "ETH/USDT / daily candles",
  gold: "XAU/USD / gold price proxy",
  stocks: "SPYx/USD / daily candles",
};
const tabs = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "team", label: "Agent team", icon: Users },
  { id: "audit", label: "Audit trail", icon: Fingerprint },
  { id: "chat", label: "Fund chat", icon: MessageSquare },
  { id: "controls", label: "Controls", icon: SlidersHorizontal },
  { id: "desk", label: "Live desk", icon: RadioTower },
];
const dollars = (value: string | number | undefined, digits = 2) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value || 0));
const percent = (value: string | number | undefined) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const date = (value: string | undefined, full = false) => value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(full ? { year: "numeric" } : {}) }) : "Awaiting history";
const title = (value: string) => value.replaceAll("_", " ");
const loadLabel = (action: string) => action === "more" ? "Load" : action === "release" ? "Release" : "Hold";
const signed = (value: string | number | undefined) => `${Number(value) > 0 ? "+" : ""}${dollars(value)}`;
const color = (value: string | number | undefined) => Number(value) >= 0 ? "positive" : "negative";

async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`/api/monitor/${path}`, { cache: "no-store", ...(body !== undefined ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token || ""}` } } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Request rejected. Check the submitted values.");
  return result;
}

function HistoricalSources({ frame }: { frame: Frame }) {
  const files = Object.entries(frame.provenance.files || {});
  const excluded = files.reduce((total, [, file]) => total + Object.values(file.skipped).reduce((sum, count) => sum + count, 0), 0);
  if (!files.length) return null;
  return <details className="historical-sources">
    <summary><Fingerprint size={14} /><strong>Historical data</strong><span>{files.length} local files</span>{excluded > 0 && <span className="source-warning">{excluded} excluded rows</span>}<ChevronDown size={14} /></summary>
    <div className="table-scroll"><table><thead><tr><th>Source</th><th>Accepted / total</th><th>Excluded</th><th>Price available (UTC)</th><th>File SHA-256</th></tr></thead><tbody>{files.map(([name, file]) => {
      const sourceTime = frame.source_times?.[name];
      const exclusions = Object.entries(file.skipped).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${title(kind)}`).join(", ");
      return <tr key={name}><td><strong>{file.name}</strong><small>{historicalLabels[name]}</small></td><td className="numeric">{file.accepted_records} / {file.input_records}</td><td title={file.error_dates.join(", ")}>{exclusions || "None"}</td><td><time dateTime={sourceTime}>{sourceTime ? new Date(sourceTime).toISOString().slice(0, 16).replace("T", " ") : "-"}</time></td><td><code title={file.sha256}>{file.sha256.slice(0, 12)}</code></td></tr>;
    })}</tbody></table></div>
  </details>;
}

export default function Console() {
  const [tab, setTab] = useState("overview");
  const [mode, setMode] = useState<"replay" | "live">("replay");
  const [live, setLive] = useState<LiveData | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(1);
  const [chartMode, setChartMode] = useState<"value" | "weights">("value");
  const [period, setPeriod] = useState(90);
  const [token, setToken] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedRound, setSelectedRound] = useState<Frame | Round | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [chatInput, setChatInput] = useState("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const tokenDialog = useRef<HTMLDialogElement>(null);

  async function reload() {
    const [fund, agents, events, rounds, inventory, policy, audit, readiness, messages, snapshots] = await Promise.all([
      api<LiveData["fund"]>("fund"), api<LiveData["agents"]>("agents"), api<LiveData["events"]>("events"), api<LiveData["rounds"]>("rounds"), api<LiveData["inventory"]>("inventory"), api<LiveData["policy"]>("policy"), api<LiveData["audit"]>("audit/verify"), api<LiveData["readiness"]>("readiness"), api<LiveData["messages"]>("chat"), api<LiveData["snapshots"]>("snapshots"),
    ]);
    return { fund, agents, events, rounds, inventory, policy, audit, readiness, messages, snapshots };
  }

  async function refreshData() {
    const [data, replayFrames, replayTrades] = await Promise.all([reload(), api<Frame[]>("replay/frames"), api<PaperTrade[]>("replay/trades")]);
    setLive(data);
    setFrames(replayFrames);
    setTrades(replayTrades);
  }

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await reload();
        if (!disposed) startTransition(() => { setLive(data); setError(""); });
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Monitor connection lost");
      } finally { fetching = false; }
    };
    void poll();
    void Promise.all([api<Frame[]>("replay/frames"), api<PaperTrade[]>("replay/trades")]).then(([frames, trades]) => { if (!disposed) { setFrames(frames); setTrades(trades); } }).catch((failure: Error) => { if (!disposed) setError(failure.message); });
    const timer = setInterval(poll, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const step = (now - previous) / 60000;
      previous = now;
      setProgress((value) => Math.min(1, value + step));
    }, 100);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (tokenOpen) tokenDialog.current?.showModal();
    else tokenDialog.current?.close();
  }, [tokenOpen]);

  const replay = mode === "replay";
  const frameIndex = Math.min(frames.length - 1, Math.floor(progress * (frames.length - 1)));
  const frame = frames[Math.max(0, frameIndex)];
  const leader = frame?.requests && Object.entries(frame.requests).find(([, request]) => request.action === "more");
  const nextFrame = frames[Math.min(frames.length - 1, frameIndex + 1)];
  const interpolation = progress * (frames.length - 1) - frameIndex;
  const interpolate = (field: "equity" | "net_pnl" | "gross_pnl") => frame ? Number(frame[field]) + (Number(nextFrame?.[field] || frame[field]) - Number(frame[field])) * interpolation : 0;
  const value = replay ? interpolate("equity") : live?.fund.equity;
  const net = replay ? interpolate("net_pnl") : live?.fund.net_pnl;
  const fees = replay ? frame?.fees : live?.fund.fees;
  const totalFees = Object.values(fees || {}).reduce((sum, value) => sum + Number(value), 0);
  const capital = replay ? frame?.contributions : live?.fund.contributions;
  const equityReturn = Number(capital) > 0 ? Number(net) / Number(capital) : 0;
  const agents = replay ? Object.keys(frame?.agents || {}) : (live?.agents.map((agent) => agent.id) || []);
  const visibleTrades = trades.filter((trade) => trade.frame_id <= frameIndex);
  const chartStart = frames.length ? new Date(frames[frames.length - 1].time).getTime() - period * 86400000 : 0;
  const replayChart = frames.filter((row) => new Date(row.time).getTime() >= chartStart && row.id <= frameIndex).map((row) => ({ time: row.time, total: Number(row.equity), benchmark: Number(row.benchmark), ...Object.fromEntries(Object.entries(row.agents).map(([name, agent]) => [name, chartMode === "weights" ? Number(agent.weight) * 100 : Number(agent.equity)])) }));
  const snapshotMap = new Map<string, Record<string, string | number>>();
  for (const snapshot of live?.snapshots || []) {
    if (!snapshot.valid) continue;
    const row = snapshotMap.get(snapshot.time) || { time: snapshot.time };
    row[snapshot.agent_id] = Number(snapshot.equity);
    if (snapshot.benchmark_equity != null) row.benchmark = Number(snapshot.benchmark_equity);
    snapshotMap.set(snapshot.time, row);
  }
  const liveChart = [...snapshotMap.values()].filter((row) => (live?.agents || []).every((agent) => row[agent.id] !== undefined)).map((row) => {
    const total = (live?.agents || []).reduce((sum, agent) => sum + Number(row[agent.id]), 0);
    return { ...row, total, ...(chartMode === "weights" ? Object.fromEntries((live?.agents || []).map((agent) => [agent.id, total ? Number(row[agent.id]) / total * 100 : 0])) : {}) };
  });
  const chartData = replay ? replayChart : liveChart;

  async function mutate(path: string, body: unknown, success: string) {
    if (!token) { setTokenOpen(true); return; }
    setBusy(true);
    try {
      await api(path, body, token);
      setLive(await reload());
      setNotice(success);
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : "Request failed"); }
    finally { setBusy(false); }
  }

  async function confirmProposal(proposal: Proposal) {
    await mutate("policy/confirm", { expected_version: proposal.expected_version, changes: proposal.changes }, "Policy confirmed as pending. Active limits change at the next runtime boundary.");
  }

  async function sendChat(event: React.FormEvent) {
    event.preventDefault();
    if (!chatInput.trim()) return;
    if (!token) { setTokenOpen(true); return; }
    setBusy(true);
    try {
      await api<Message>("chat", { message: chatInput }, token);
      setChatInput("");
      setLive(await reload());
      requestAnimationFrame(() => messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (failure) { setNotice(failure instanceof Error ? failure.message : "Chat request failed"); }
    finally { setBusy(false); }
  }

  function switchMode(next: "replay" | "live") {
    setMode(next); setPlaying(false); setSelectedRound(null); setQuery("");
    if (next === "replay" && (tab === "controls" || tab === "chat")) setTab("overview");
  }

  function navigateTab(next: string) {
    setTab(next);
    if (next === "controls" || next === "chat") switchMode("live");
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="HedgeAgents home"><span className="brand-mark"><Hexagon size={25} /><Activity size={14} /></span><span>Hedge<span className="brand-light">Agents</span></span></Link>
      <div className="workspace-label">OPERATOR WORKSPACE</div>
      <div className="fund-select"><span className="fund-symbol">H</span><span><strong>Masumi Fund</strong><small>Single-operator fund</small></span><ChevronDown size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${tab === id ? "active" : ""}`} aria-current={tab === id ? "page" : undefined} title={label} onClick={() => navigateTab(id)}><Icon size={18} /><span>{label}</span>{tab === id && <span className="nav-indicator" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="rail-status"><span className={`status-dot ${error ? "red" : "green"}`} /><span>{error ? "Monitor disconnected" : live ? "Monitor connected" : "Connecting monitor"}</span></div><button className="operator-button" onClick={() => token ? setToken("") : setTokenOpen(true)}><span className="operator-avatar"><KeyRound size={16} /></span><span><strong>{token ? "Operator connected" : "Read-only session"}</strong><small>{token ? "Disconnect" : "Connect operator"}</small></span><ChevronRight size={14} /></button><div className="built-on"><Hexagon size={12} /> Settlement on Masumi <ArrowUpRight size={12} /></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Masumi Fund <ChevronRight size={13} /><span>{tabs.find((item) => item.id === tab)?.label}</span></div><div className="topbar-actions"><span className="network-indicator"><span className="status-dot amber" />{live?.fund.environment === "mainnet" ? "Mainnet" : "Preprod"}</span><span className="top-divider" /><button className="icon-button" title="Refresh fund data" aria-label="Refresh fund data" onClick={() => void refreshData().catch((failure: Error) => setNotice(failure.message))}><RefreshCw size={16} /></button><button className="icon-button" title="Operator access" aria-label="Operator access" onClick={() => setTokenOpen(true)}><KeyRound size={17} /></button></div></header>
      <main className="main-content">
        {tab === "desk" ? <LiveDesk /> : <>
        <div className="page-heading"><div><div className="eyebrow">MASUMI FUND / {replay ? "PAPER RECORDING" : "LIVE LEDGER"}</div><h1>{({ overview: "Fund overview", team: "Agent team", audit: "Audit trail", chat: "Fund chat", controls: "Fund controls" })[tab]}</h1></div><div className="mode-switch" role="group" aria-label="Data source"><button aria-pressed={replay} className={replay ? "selected" : ""} onClick={() => switchMode("replay")}><History size={15} />Replay</button><button aria-pressed={!replay} className={!replay ? "selected" : ""} onClick={() => switchMode("live")}><span className="status-dot" />Live fund</button></div></div>

        <div className={`environment-banner ${replay ? "recording" : "preprod"}`}><div><span className="banner-icon">{replay ? <History size={16} /> : <ShieldCheck size={16} />}</span><strong>{replay ? "Paper recording" : live?.fund.environment === "mainnet" ? "Mainnet" : "Preprod / play money"}</strong><span className="banner-detail">{replay ? "Your historical prices. Each sleeve asks for load from its own return." : live?.fund.environment === "mainnet" ? "Real assets. Confirmed receipts only." : "tUSDM + Solana devnet. Not real USD profit."}</span></div><span className="banner-end">{replay ? frame?.provenance.source === "local_files" ? `${Object.keys(frame.provenance.files || {}).length} local files` : "Historical tape" : live?.fund.armed ? "Automation armed" : "Automation not armed"}</span></div>
        {replay && frame && <HistoricalSources frame={frame} />}
        {error && <div className="error-banner" role="alert"><ShieldOff size={17} /><span>{error} Previously loaded values are not current.</span></div>}
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" title="Dismiss notification" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={15} /></button></div>}
        {live?.policy.pending && <div className="pending-banner"><CirclePause size={16} /><span>Policy v{live.policy.pending.version} pending. Active limits remain v{live.policy.active.version}.</span><button onClick={() => navigateTab("controls")}>Review <ArrowRight size={14} /></button></div>}

        {(tab === "overview" || tab === "team") && <>
          <section className="metrics" aria-label="Fund performance"><div className="metric primary"><span className="metric-label">Total fund value <span className="label-tag">{replay ? "PAPER" : "NET EQUITY"}</span></span><div className="fund-value">{live || frame ? dollars(value) : <span className="skeleton-number">$0.00</span>}</div><div className={`return-label ${color(net)}`}>{Number(net) >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />} {percent(equityReturn)} <span>since contribution</span></div></div><div className="metric"><span className="metric-label">Net profit <CircleHelp size={13}><title>Equity minus contributions plus distributions. Costs are included once.</title></CircleHelp></span><strong className={color(net)}>{signed(net)}</strong><small>After recognized costs</small></div><div className="metric"><span className="metric-label">Capital contributed</span><strong>{dollars(capital)}</strong><small>{replay ? `${agents.length} paper sleeves` : `${live?.agents.length || 4} configured sleeves`}</small></div><div className="metric"><span className="metric-label">Total costs</span><strong>{dollars(totalFees)}</strong><small>Execution, network & services</small></div></section>

          <div className="cost-strip"><span>Gross PnL <strong className={color(replay ? interpolate("gross_pnl") : live?.fund.gross_pnl)}>{signed(replay ? interpolate("gross_pnl") : live?.fund.gross_pnl)}</strong></span><span>Execution <strong>{dollars(fees?.execution)}</strong></span><span>Network <strong>{dollars(fees?.network)}</strong></span><span>Services <strong>{dollars(fees?.service)}</strong></span></div>
          <div className="overview-grid"><section className="performance-section"><div className="section-heading"><div><h2>{chartMode === "weights" ? "Capital allocation" : tab === "team" ? "Agent value over time" : "Portfolio performance"}</h2><span className="subtle">{replay ? `${date(frames[0]?.time)} - ${date(frame?.time, true)}` : live?.fund.updated_at ? `Latest snapshot ${date(live.fund.updated_at, true)}` : "Awaiting the first reconciled snapshot"}</span></div><div className="chart-actions"><div className="compact-segment"><button className={chartMode === "value" ? "selected" : ""} onClick={() => setChartMode("value")}>Value</button><button className={chartMode === "weights" ? "selected" : ""} onClick={() => setChartMode("weights")}>Weights</button></div>{replay && <select aria-label="Chart period" value={period} onChange={(event) => setPeriod(Number(event.target.value))}><option value={90}>90 days</option><option value={30}>30 days</option></select>}</div></div>
            {chartData.length > 0 ? <div className="chart-container"><ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={chartData} margin={{ top: 18, right: 12, left: 0, bottom: 4 }}><CartesianGrid vertical={false} stroke="#e9eeed" strokeDasharray="3 4" /><XAxis dataKey="time" tickFormatter={(value) => date(String(value))} axisLine={false} tickLine={false} tick={{ fill: "#87928d", fontSize: 11 }} minTickGap={40} dy={12} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "#87928d", fontSize: 11 }} tickFormatter={(value) => chartMode === "weights" ? `${Number(value).toFixed(0)}%` : dollars(value, 0)} width={65} domain={chartMode === "weights" ? [0, 100] : ["auto", "auto"]} /><Tooltip contentStyle={{ borderRadius: 6, border: "1px solid #dce5df", fontSize: 12, boxShadow: "0 4px 20px #172d2210" }} labelFormatter={(value) => date(String(value), true)} formatter={(value, name) => [chartMode === "weights" ? `${Number(value).toFixed(1)}%` : dollars(Number(value)), name]} />
              {chartMode === "value" && tab === "overview" ? <><Line dataKey="total" name="Net fund value" type="monotone" stroke="#208565" strokeWidth={2.6} dot={chartData.length === 1} activeDot={{ r: 5 }} isAnimationActive={false} />{(replay || live?.fund.benchmark?.status === "ready") && <Line dataKey="benchmark" name={!replay && live?.fund.mode === 1 ? "Buy and hold" : "No reallocation"} type="monotone" stroke="#a5afa9" strokeWidth={1.8} strokeDasharray="5 5" dot={false} isAnimationActive={false} />}</> : agents.map((name) => <Line key={name} dataKey={name} name={markets[name]?.name} type="monotone" stroke={markets[name]?.color} strokeWidth={2.2} dot={false} isAnimationActive={false} />)}
              {replay && frames.filter((row) => row.shock.length && row.id <= frameIndex).map((row) => <ReferenceLine key={row.id} x={row.time} stroke="#e3aa58" strokeDasharray="3 4" label={{ value: "Daily stop", position: "insideTopRight", fill: "#ac7937", fontSize: 10 }} />)}
            </LineChart></ResponsiveContainer></div> : <Empty icon={Activity} heading={replay ? "No recording loaded" : "No live performance yet"} text={replay ? "The replay data service has not returned a tape." : "The live book starts with a verified external contribution."} />}
            <div className="chart-legend">{chartMode === "value" && tab === "overview" ? <><span><i style={{ background: "#208565" }} />Net fund value</span>{(replay || live?.fund.benchmark?.status === "ready") && <span title={!replay && live?.fund.mode === 1 ? "Hypothetical token lots with proportional redemptions. No agent fees deducted." : "Fixed shadow ownership in actual sleeve NAV, including actual-fill and cost approximation."}><i className="dashed" />{!replay && live?.fund.mode === 1 ? "Buy and hold" : "No reallocation"} <CircleHelp size={12} /></span>}{!replay && live?.fund.benchmark?.status === "pending" && <span>Benchmark marks pending</span>}</> : agents.map((name) => <span key={name}><i style={{ background: markets[name]?.color }} />{markets[name]?.name}</span>)}<span className="legend-note">{replay ? "Paper execution, net of modeled costs" : "Confirmed, flow-adjusted value"}</span></div>
            {replay && frames.length > 0 && <div className="replay-player"><button className="play-button" aria-label={playing && progress < 1 ? "Pause replay" : "Play replay"} title={playing && progress < 1 ? "Pause replay" : "Play replay"} onClick={() => { if (progress >= 1) setProgress(0); setPlaying(!(playing && progress < 1)); }}>{playing && progress < 1 ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><div className="player-caption"><strong>{playing && progress < 1 ? "Playing recording" : "Replay timeline"}</strong><small>{String(Math.round(progress * 60)).padStart(2, "0")} / 60 sec</small></div><div className="scrubber"><input aria-label="Replay timeline" type="range" min={0} max={1} step={0.001} value={progress} onChange={(event) => { setPlaying(false); setProgress(Number(event.target.value)); }} /><div className="round-ticks">{frames.map((row) => <button key={row.id} title={`Inspect round ${row.id + 1}${row.shock.length ? ": daily stop" : row.requests && Object.values(row.requests).some((request) => request.action === "more") ? ": load request" : ""}`} aria-label={`Inspect round ${row.id + 1}`} className={row.shock.length ? "shock-tick" : ""} onClick={() => { setProgress(row.id / (frames.length - 1)); setPlaying(false); setSelectedRound(row); }}><span /></button>)}</div></div><button className="icon-button" title="Previous frame" aria-label="Previous frame" onClick={() => { setPlaying(false); setProgress(Math.max(0, (frameIndex - 1) / (frames.length - 1))); }}><SkipBack size={16} /></button><button className="icon-button" title="Next frame" aria-label="Next frame" onClick={() => { setPlaying(false); setProgress(Math.min(1, (frameIndex + 1) / (frames.length - 1))); }}><SkipForward size={16} /></button></div>}
          </section>

          <aside className="round-panel"><div className="section-heading"><h2>{replay ? "Allocation round" : "Fund status"}</h2>{replay ? <span className="round-number">{String(frameIndex + 1).padStart(2, "0")} / {String(frames.length).padStart(2, "0")}</span> : <LockKeyhole size={16} />}</div>{replay && frame ? <><div className="round-date"><span>{date(frame.time, true)}</span><Pill tone={frame.shock.length ? "amber" : "green"}>{frame.shock.length ? "Cash target" : title(frame.round_kind)}</Pill></div><div className="score-header"><span>Agent</span><span>Load request</span></div>{Object.entries(frame.scores).map(([name, score]) => { const request = frame.requests?.[name]; const width = request?.action === "more" ? 100 : request?.action === "release" ? 18 : 46; return <div className="score-row" key={name}><div><Avatar agent={name} small /><span>{markets[name].name}</span></div><span className="score-track"><i style={{ width: `${width}%`, background: markets[name].color }} /></span><strong>{request ? loadLabel(request.action) : Number(score).toFixed(2)}</strong></div>; })}<div className="round-note"><span className="round-note-icon"><ShieldCheck size={18} /></span><div><strong>{frame.shock.length ? "Risk-reduction branch" : leader ? `${markets[leader[0]].name} requested load` : "No load request"}</strong><p>{frame.shock.length ? "Cash target and no incoming load. Remaining proceeds stay with the stopped sleeve." : leader ? leader[1].reason : frame.round_kind === "hold" ? "No sleeve asked for load. Current allocation retained." : "10% floor, 50% cap. A granted request moves at most 10 points."}</p></div></div><button className="text-button" onClick={() => setSelectedRound(frame)}>Inspect round <ArrowRight size={15} /></button></> : <><Pill tone={live?.fund.kill_switch ? "amber" : "green"}>{live?.fund.kill_switch ? "Halted" : "Halt cleared"}</Pill><p className="status-copy">{live?.fund.control_reason || "Connecting to the monitor."}</p><div className="status-stat"><span>Principal in transit</span><strong>{dollars(live?.fund.principal_receivable)}</strong></div><div className="status-stat"><span>Expense payable</span><strong>{dollars(live?.fund.expense_payable)}</strong></div><div className="status-stat"><span>Audit events</span><strong>{live?.audit.count || 0}</strong></div><button className="text-button" onClick={() => navigateTab("controls")}>View readiness <ArrowRight size={15} /></button></>}</aside></div>

          <section className="allocation-section"><div className="section-heading"><div><h2>Agent allocation <span className="count-badge">{agents.length}</span></h2><span className="subtle">{replay ? "Paper positions at the selected frame" : "Settled balances, not planned targets"}</span></div><Pill tone="neutral">{replay ? "Long-only / paper" : `Mode ${live?.fund.mode || 2} / spot`}</Pill></div><div className="table-scroll"><table className="agent-table"><thead><tr><th>Agent / market</th><th>Fund value</th><th>Allocation</th><th>Net PnL</th><th>Token exposure</th><th>Status</th></tr></thead><tbody>{agents.map((name) => {
            const paper = frame?.agents[name]; const real = live?.agents.find((row) => row.id === name); const equity = replay ? paper?.equity : real?.equity; const weight = replay ? paper?.weight : real?.weight; const pnl = replay ? paper?.net_pnl : real?.net_pnl; const exposure = Number(replay ? paper?.token_value : real?.assets.token) / (Number(equity) || 1); const stopped = replay ? paper?.stopped : real?.stop.stopped;
            return <tr key={name}><td><div className="agent-identity"><Avatar agent={name} /><span><strong>{markets[name].name}</strong><small>{replay ? historicalLabels[name] : `${markets[name].symbol} / Solana`}</small></span></div></td><td className="numeric">{dollars(equity)}</td><td><div className="allocation-cell"><strong>{percent(weight)}</strong><span><i style={{ width: `${Number(weight) * 100}%`, background: markets[name].color }} /></span></div></td><td className={`numeric ${color(pnl)}`}>{signed(pnl)}</td><td className="numeric muted">{percent(exposure)}</td><td><Pill tone={stopped ? "amber" : !replay && !Number(equity) ? "neutral" : "green"}>{stopped ? "Stopped" : !replay && !Number(equity) ? "Unfunded" : "Active"}</Pill></td></tr>;
          })}</tbody></table></div></section>

          <section className="recent-section"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => setTab("audit")}>View all activity <ArrowRight size={15} /></button></div>{replay ? <div className="activity-list">{visibleTrades.filter((row) => row.kind === "trade" || row.kind === "allocation").slice(-4).reverse().map((trade) => <div className="activity-row" key={trade.id}><span className={`activity-icon ${trade.action === "sell" ? "sell" : ""}`}>{trade.kind === "allocation" ? <ArrowRight size={15} /> : trade.action === "sell" ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}</span><div><strong>{trade.kind === "allocation" ? `${markets[trade.agent].name} to ${markets[trade.destination || ""]?.name}` : `${trade.action === "sell" ? "Sold" : "Bought"} ${markets[trade.agent].name}`}</strong><small>{trade.kind === "allocation" ? "Paper budget transfer" : "Recorded paper trade"}</small></div><strong className="numeric">{dollars(trade.amount_usd)}</strong><time>{date(trade.time)}</time><span className="paper-tag">PAPER</span></div>)}</div> : live?.events.length ? <AuditRows events={live.events.slice(0, 4)} environment={live.fund.environment} /> : <Empty icon={History} heading="No on-chain activity" text="Confirmed deposits and settlement receipts will appear in the live audit." />}</section>
        </>}

        {tab === "audit" && <section className="audit-section"><div className="section-heading"><div><h2>{replay ? "Paper trade history" : "Tamper-evident event log"}</h2><span className="subtle">{replay ? `${visibleTrades.length} recorded operations` : `${live?.audit.count || 0} chained events`}</span></div><label className="search"><Search size={15} /><input aria-label="Search audit" placeholder="Search activity" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>{!replay && live && <div className="audit-integrity"><ShieldCheck size={18} /><span>{live.audit.valid ? "Local hash chain verified" : "Hash chain mismatch"}</span><code title={live.audit.head}>{live.audit.head}</code><button className="icon-button" title="Copy audit head" aria-label="Copy audit head" onClick={() => void navigator.clipboard.writeText(live.audit.head).then(() => setNotice("Audit head copied."))}><Copy size={15} /></button><Pill>{live.audit.anchors.length ? `${live.audit.anchors.length} anchors` : "Not anchored"}</Pill></div>}{replay ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>Agent</th><th>Operation</th><th>Amount</th><th>Cost</th><th>Record</th></tr></thead><tbody>{visibleTrades.filter((row) => JSON.stringify(row).toLowerCase().includes(deferredQuery.toLowerCase())).slice().reverse().map((row) => <tr key={row.id}><td>{date(row.time)}</td><td><span className="inline-agent"><Avatar agent={row.agent} small />{markets[row.agent]?.name}</span></td><td><span className={`operation ${row.action || row.kind}`}>{title(row.action || row.component || row.kind)}</span></td><td className="numeric">{dollars(row.amount_usd)}</td><td className="numeric muted">{row.fee_usd ? dollars(row.fee_usd) : "-"}</td><td className="mono muted">paper:{String(row.id).padStart(4, "0")}</td></tr>)}</tbody></table></div> : live?.events.length ? <AuditRows events={live.events.filter((row) => JSON.stringify(row).toLowerCase().includes(deferredQuery.toLowerCase()))} environment={live.fund.environment} /> : <Empty icon={Fingerprint} heading="The live audit is empty" text="Replay operations never enter this hash chain." />}</section>}

        {tab === "chat" && <section className="chat-layout"><div className="chat-main"><div className="section-heading"><div className="chat-title"><span className="chat-agent"><Hexagon size={20} /></span><div><h2>Fund operator</h2><span className="subtle">Database answers & policy proposals</span></div></div><Pill>Live policy</Pill></div><div className="messages">{live?.messages.length ? live.messages.map((message) => <div className={`message ${message.role}`} key={message.id}><div className="message-label">{message.role === "operator" ? "YOU" : "FUND"}</div><p>{message.text}</p>{message.proposal && <ProposalView proposal={message.proposal} pending={busy} onConfirm={() => void confirmProposal(message.proposal!)} stale={message.proposal.expected_version !== live.policy.latest_version} />}{message.citations && <div className="citations">{message.citations.map((citation) => <code key={citation}>{citation}</code>)}</div>}</div>) : <div className="chat-empty"><MessageSquare size={28} strokeWidth={1.3} /><h3>What needs your attention?</h3><div className="suggestions">{["What is the fund status?", "What fees have been recognized?", "Cap stocks at 20%"].map((text) => <button key={text} onClick={() => setChatInput(text)}>{text}<ArrowUpRight size={14} /></button>)}</div></div>}<div ref={messagesEnd} /></div><form className="chat-composer" onSubmit={sendChat}><input aria-label="Message the fund" placeholder="Ask about the fund or propose a policy..." value={chatInput} onChange={(event) => setChatInput(event.target.value)} maxLength={2000} /><button className="send-button" disabled={busy || !chatInput.trim()} title="Send message" aria-label="Send message">{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}</button></form><div className="chat-disclaimer"><LockKeyhole size={12} />Policy confirmation is separate. Chat cannot sign transactions.</div></div><aside className="chat-context"><h2>Active policy</h2><span className="subtle">Version {live?.policy.active.version || 1}</span>{Object.entries(live?.policy.active.body.agents || {}).map(([name, limits]) => <div className="policy-summary" key={name}><Avatar agent={name} small /><span>{markets[name]?.name}</span><strong>{percent(limits.cap)} cap</strong></div>)}<div className="context-divider" /><div className="status-stat"><span>Daily loss stop</span><strong>5%</strong></div><div className="status-stat"><span>Position cap</span><strong>85% maximum</strong></div><div className="status-stat"><span>Ordinary step</span><strong>20 points maximum</strong></div></aside></section>}

        {tab === "controls" && live && <><CapitalControls names={live.agents.map((agent) => agent.id)} environment={live.fund.environment} rounds={live.rounds} busy={busy} onSubmit={(kind, body, qualification) => void mutate(`${qualification ? "qualification" : "operations"}/${kind}`, body, "Operation queued with immutable terms. Signing and settlement remain gated.")} onInspect={setSelectedRound} /><ControlsView policy={live.policy} inventory={live.inventory} readiness={live.readiness} halted={live.fund.kill_switch} busy={busy} onKill={() => void mutate("kill-switch", { enabled: !live.fund.kill_switch, reason: "Operator console" }, live.fund.kill_switch ? "Halt cleared. Automation remains disarmed." : "Halted. Existing funded obligations remain recoverable.")} onRefresh={() => void mutate("inventory/refresh", {}, "Inventory observations reconciled; reservations preserved.")} onPolicy={(changes) => void mutate("policy/confirm", { expected_version: live.policy.latest_version, changes }, "Policy queued for the next runtime boundary.")} wallets={live.agents.flatMap((agent) => agent.wallets.map((wallet) => ({ ...wallet, agent: agent.id })))} /></>}

        {!live && !error && <div className="loading-line"><LoaderCircle size={16} className="spin" />Connecting to the fund monitor...</div>}
        <footer className="footer"><span><ShieldCheck size={13} />{replay ? "Historical replay / isolated paper ledger" : "Postgres ledger / confirmed chain receipts"}</span><span>{replay ? "The mechanism, not proof of a trading edge." : "One operator. One fund. No keys in the browser."}</span></footer>
        </>}
      </main>
    </div>

    <dialog ref={tokenDialog} className="modal" onCancel={() => setTokenOpen(false)} onClose={() => setTokenOpen(false)}><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setAuthError(""); try { await api("operator/session", {}, tokenInput); setToken(tokenInput); setTokenInput(""); setTokenOpen(false); setNotice("Operator connected for this page session."); } catch (failure) { setAuthError(failure instanceof Error ? failure.message : "Authorization failed"); } finally { setBusy(false); } }}><div className="modal-heading"><KeyRound size={20} /><h2>Operator access</h2><button type="button" className="icon-button" title="Close" aria-label="Close operator dialog" onClick={() => setTokenOpen(false)}><X size={18} /></button></div><label className="field-label" htmlFor="operator-token">Operator token</label><input id="operator-token" className="token-input" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoFocus placeholder="OPERATOR_TOKEN" /><p className="subtle">Local operator credential. Never enter a wallet seed or chain private key.</p>{authError && <p className="negative auth-error" role="alert">{authError}</p>}<button className="primary-button" disabled={busy || !tokenInput.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Connect operator</button></form></dialog>
    {selectedRound && <div className="drawer-backdrop" onClick={() => setSelectedRound(null)}><aside className="drawer" role="dialog" aria-modal="true" aria-label="Allocation round details" onClick={(event) => event.stopPropagation()}><div className="section-heading"><h2>Allocation details</h2><button className="icon-button" title="Close details" aria-label="Close round details" onClick={() => setSelectedRound(null)}><X size={18} /></button></div><p className="subtle">{date(selectedRound.time, true)}</p><Pill tone="green">{"round_kind" in selectedRound ? title(selectedRound.round_kind) : selectedRound.state}</Pill><h3>Planned and settled weights</h3><table className="round-table"><thead><tr><th>Agent</th><th>Before</th><th>Target</th><th>Settled</th></tr></thead><tbody>{Object.keys(selectedRound.weights_before).map((name) => <tr key={name}><td>{markets[name]?.name || name}</td><td>{percent(selectedRound.weights_before[name])}</td><td>{percent(selectedRound.target_weights[name])}</td><td>{selectedRound.settled_weights ? percent(selectedRound.settled_weights[name]) : "Pending"}</td></tr>)}</tbody></table><h3>Reason</h3><p>{selectedRound.reason || "Initial equal-weight deployment"}</p><h3>Objections</h3>{selectedRound.objections.map((objection, index) => <div className="objection" key={index}><CheckCheck size={16} /><div><strong>{markets[objection.agent]?.name}</strong><p>{objection.text}</p><small>{objection.applied ? "Verified by code" : "Comment; no weight adjustment"}</small></div></div>)}<div className="round-disclaimer">{"round_kind" in selectedRound ? "Recorded paper round. No chain receipt or Masumi anchor." : "Targets are not achieved weights until every required leg settles."}</div></aside></div>}
  </div>;
}

function ProposalView({ proposal, onConfirm, pending, stale }: { proposal: Proposal; onConfirm: () => void; pending: boolean; stale: boolean }) {
  const changes = Object.entries(proposal.after.agents).filter(([name, after]) => JSON.stringify(after) !== JSON.stringify(proposal.before.agents[name]));
  return <div className="proposal"><div className="proposal-label"><Settings2 size={15} />Policy diff <span>v{proposal.expected_version} to v{proposal.expected_version + 1}</span></div>{changes.map(([name, after]) => <div className="diff-row" key={name}><strong>{markets[name]?.name}</strong><span>{percent(proposal.before.agents[name].cap)} cap / {proposal.before.agents[name].paused ? "paused" : "active"}</span><ArrowRight size={14} /><span>{percent(after.cap)} cap / {after.paused ? "paused" : "active"}</span></div>)}<button className="primary-button" disabled={pending || stale} onClick={onConfirm}>{stale ? <Check size={15} /> : <CheckCheck size={15} />}{stale ? "Version already changed" : "Confirm pending policy"}</button></div>;
}

function AuditRows({ events, environment }: { events: AuditEvent[]; environment: string }) {
  return <div className="audit-rows">{events.map((event) => {
    const tx = typeof event.payload.tx_id === "string" ? event.payload.tx_id : null;
    const chain = event.payload.chain;
    const link = tx && chain === "cardano" && /^[a-f0-9]{64}$/i.test(tx) ? `https://${environment === "preprod" ? "preprod." : ""}cardanoscan.io/transaction/${tx}` : tx && chain === "solana" && /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(tx) ? `https://solscan.io/tx/${tx}${environment === "preprod" ? "?cluster=devnet" : ""}` : null;
    return <details key={event.id} className="audit-event"><summary><span className="audit-index">#{String(event.id).padStart(4, "0")}</span><span className="event-name">{title(event.kind)}</span><time>{date(event.time)}</time><Fingerprint size={15} /><ChevronDown size={14} /></summary><div className="audit-detail"><dl><dt>Hash</dt><dd>{event.hash}</dd><dt>Previous</dt><dd>{event.prev_hash}</dd></dl><pre>{JSON.stringify(event.payload, null, 2)}</pre>{link && <a href={link} target="_blank" rel="noreferrer">Confirmed receipt <ExternalLink size={13} /></a>}</div></details>;
  })}</div>;
}

function ControlsView({ policy, inventory, readiness, halted, busy, onKill, onRefresh, onPolicy, wallets }: { policy: PolicyState; inventory: Inventory; readiness: Readiness; halted: boolean; busy: boolean; onKill: () => void; onRefresh: () => void; onPolicy: (changes: Record<string, unknown>) => void; wallets: { id: string; chain: string; role: string; address: string; agent: AgentName }[] }) {
  const [caps, setCaps] = useState<Numbers>({});
  const [paused, setPaused] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState("");
  return <div className="controls-layout"><section className="safety-section"><div className="section-heading"><div><h2>Trading halt</h2><p className="subtle">New trades and admissions stop. Funded obligations stay recoverable.</p></div><button className={`halt-button ${halted ? "halted" : ""}`} disabled={busy} onClick={onKill}><Power size={17} />{halted ? "Clear halt" : "Halt new activity"}</button></div><div className="halt-state"><Pill tone={halted ? "amber" : "green"}>{halted ? "Kill switch is on" : "Kill switch is off"}</Pill><span>Clearing the halt does not arm automation or liquidate positions.</span></div></section><section className="policy-editor"><div className="section-heading"><div><h2>Allocation limits</h2><p className="subtle">Active v{policy.active.version}{policy.pending ? ` / pending v${policy.pending.version}` : ""}</p></div><span className="label-tag">HARD BOUNDS</span></div><form onSubmit={(event) => { event.preventDefault(); const changes = Object.fromEntries(Object.entries(policy.active.body.agents).map(([name, limits]) => [name, { cap: String(Number(caps[name] ?? Number(limits.cap) * 100) / 100), paused: paused[name] ?? limits.paused }])); onPolicy({ agents: changes }); }}><div className="policy-fields">{Object.entries(policy.active.body.agents).map(([name, limits]) => <div className="policy-field" key={name}><span className="inline-agent"><Avatar agent={name} small /><strong>{markets[name]?.name}</strong></span><label><span>Weight cap</span><span className="percent-input"><input type="number" aria-label={`${markets[name]?.name} cap`} min={Object.keys(policy.active.body.agents).length === 1 ? 100 : 10} max={Object.keys(policy.active.body.agents).length === 1 ? 100 : 50} step={1} value={caps[name] ?? Number(limits.cap) * 100} onChange={(event) => setCaps({ ...caps, [name]: event.target.value })} />%</span></label><label className="pause-control"><input type="checkbox" checked={paused[name] ?? limits.paused} onChange={(event) => setPaused({ ...paused, [name]: event.target.checked })} />Pause</label></div>)}</div><button className="primary-button" disabled={busy}><CheckCheck size={16} />Confirm pending limits</button></form></section><section className="inventory-section"><div className="section-heading"><h2>Gateway inventory</h2><button className="secondary-button" disabled={busy} onClick={onRefresh}><RefreshCw size={14} />Reconcile</button></div><div className="table-scroll"><table><thead><tr><th>Chain</th><th>Confirmed</th><th>Reserved</th><th>Protected refunds</th><th>Available</th></tr></thead><tbody>{inventory.chains.map((row) => <tr key={row.chain}><td className="capitalize">{row.chain}</td><td className="numeric">{dollars(Number(row.confirmed_raw) / 1e6)}</td><td className="numeric">{dollars(Number(row.reserved_raw) / 1e6)}</td><td className="numeric">{dollars(Number(row.protected_raw) / 1e6)}</td><td className="numeric">{dollars(Number(row.available_raw) / 1e6)}</td></tr>)}</tbody></table></div><div className="quota-line"><span>Daily capacity, including pending prior-day reservations</span><strong>{dollars((Number(inventory.settled_today_raw) + Number(inventory.active_reserved_raw)) / 1e6)} / {dollars(Number(inventory.daily_cap_raw) / 1e6)}</strong></div></section><section className="readiness-section"><div className="section-heading"><div><h2>Automation readiness</h2><span className="subtle">Required evidence before signing real capital</span></div><Pill tone="amber">Disarmed until qualified</Pill></div><div className="gate-list">{readiness.gates.map((gate) => <div key={gate.id} className={`gate ${gate.passed ? "passed" : ""}`}><span>{gate.passed ? <Check size={15} /> : <LockKeyhole size={14} />}</span><strong>{title(gate.id)}</strong><small>{gate.passed ? "Verified" : "Not verified"}</small></div>)}</div></section><section className="wallet-section"><div className="section-heading"><h2>Fund wallets</h2><span className="subtle">Public addresses only</span></div>{wallets.length ? wallets.map((wallet) => <div className="wallet-row" key={wallet.id}><Avatar agent={wallet.agent} small /><span>{markets[wallet.agent].name} / {wallet.role}</span><code>{wallet.address}</code><button className="icon-button" title="Copy address" aria-label={`Copy ${wallet.agent} ${wallet.role} address`} onClick={() => void navigator.clipboard.writeText(wallet.address).then(() => setCopied(wallet.id))}>{copied === wallet.id ? <Check size={15} /> : <Copy size={15} />}</button></div>) : <Empty heading="No wallets registered" text="Capital, purchasing, selling, and Solana wallets have not been configured." />}</section></div>;
}

function CapitalControls({ names, environment, rounds, busy, onSubmit, onInspect }: { names: string[]; environment: string; rounds: Round[]; busy: boolean; onSubmit: (kind: string, body: Record<string, unknown>, qualification: boolean) => void; onInspect: (round: Round) => void }) {
  const [agent, setAgent] = useState(names[0] || "btc");
  const [kind, setKind] = useState("deploy");
  const [amount, setAmount] = useState("5");
  const [qualification, setQualification] = useState(true);
  return <section className="capital-controls"><div className="section-heading"><div><h2>Capital operations</h2><span className="subtle">Live ledger / {environment}. Registered destinations only.</span></div><Wallet size={18} /></div><form onSubmit={(event) => { event.preventDefault(); const raw = Math.round(Number(amount) * 1e6); if (!Number.isSafeInteger(raw) || raw <= 0) return; onSubmit(kind, { agent_id: agent, amount_raw: raw, request_id: crypto.randomUUID(), confirmation: qualification ? `QUALIFY ${environment.toUpperCase()}` : kind === "deploy" ? "DEPLOY" : "CASH OUT" }, qualification); }}><div className="capital-fields"><label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Capital operation agent">{names.map((name) => <option value={name} key={name}>{markets[name]?.name}</option>)}</select></label><label>Operation<select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Capital operation"><option value="deploy">Deploy to Solana</option><option value="cashout">Cash out to operator</option></select></label><label>Amount in {environment === "mainnet" ? "USD" : "test USD"}<input type="number" min="0.01" max={qualification ? "5" : "1000"} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} aria-label="Capital operation amount" /></label><button className="primary-button" disabled={busy}><ArrowUpRight size={16} />{qualification ? "Authorize qualification" : "Queue operation"}</button></div><label className="qualification-toggle"><input type="checkbox" checked={qualification} onChange={(event) => setQualification(event.target.checked)} />Bounded qualification / maximum $5 / normal automation stays off</label></form>{rounds.slice(0, 3).map((round) => <button className="operation-row" key={round.id} onClick={() => onInspect(round)}><span>{title(round.reason.split(":")[0] || "Allocation round")}</span><code>{round.id.slice(0, 8)}</code><Pill>{round.state}</Pill><ChevronRight size={14} /></button>)}</section>;
}