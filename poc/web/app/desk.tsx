"use client";

import { useEffect, useMemo, useState } from "react";

type Weights = { crypto: number; stocks: number; reserve: number };
type Report = { role: "crypto" | "stocks"; decayedReturn: number };
type Transfer = {
  id: number;
  roundId: number | null;
  from: string | null;
  to: string | null;
  amount: string;
  status: string;
  txId: string | null;
  detail: string | null;
};
type Round = {
  id: number;
  week: string;
  weightsBefore: Weights;
  weightsAfter: Weights;
  settledAt: string | null;
  reports: Report[];
};
type Line = { role: "manager" | "crypto" | "stocks"; text: string };
type State = { rounds: Round[]; transfers: Transfer[] };

const ORDER = ["manager", "crypto", "stocks", "reserve"] as const;

function tusdm(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function label(week: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${week}T00:00:00Z`),
  );
}

function split(weights: Weights): string {
  return [weights.crypto, weights.stocks, weights.reserve].map((value) => Math.round(value * 100)).join(" / ");
}

function holdings(transfers: Transfer[]): Record<string, bigint> {
  const book: Record<string, bigint> = { manager: 0n, crypto: 0n, stocks: 0n };
  for (const transfer of transfers) {
    if (transfer.status !== "confirmed") continue;
    const amount = BigInt(transfer.amount);
    if (transfer.to) book[transfer.to] = (book[transfer.to] ?? 0n) + amount;
    if (transfer.from) book[transfer.from] = (book[transfer.from] ?? 0n) - amount;
  }
  return book;
}

export function Desk() {
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [settledView, setSettledView] = useState(false);
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(prefer?: string) {
    const next = (await fetch("/api/state").then((res) => res.json())) as State;
    setState(next);
    setSelected((current) => prefer ?? current ?? next.rounds[0]?.week ?? null);
    return next;
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!state || !selected) return;
    const round = state.rounds.find((item) => item.week === selected);
    if (!round) return;
    let cancelled = false;
    const timers: number[] = [];
    setLines([]);
    setShown(0);
    setRevealed(false);
    setSettledView(false);
    setTyping("manager");
    setError("");

    void (async () => {
      const script = await fetch("/api/lines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          week: round.week,
          weightsBefore: round.weightsBefore,
          weightsAfter: round.weightsAfter,
          reports: round.reports,
          transfers: state.transfers
            .filter((transfer) => transfer.roundId === round.id)
            .map((transfer) => ({ from: transfer.from, to: transfer.to, amount: transfer.amount })),
        }),
      }).then((res) => res.json());
      if (cancelled) return;
      const scriptLines = script.lines as Line[];
      setSource(script.source === "gemini" ? "Gemini" : "шаблон");
      setLines(scriptLines);
      scriptLines.forEach((line, index) => {
        timers.push(window.setTimeout(() => setTyping(line.role), index * 1700));
        timers.push(
          window.setTimeout(() => {
            setTyping(null);
            setShown(index + 1);
            if (index === scriptLines.length - 1) {
              setRevealed(true);
              timers.push(window.setTimeout(() => setSettledView(true), 1200));
            }
          }, index * 1700 + 800),
        );
      });
    })();

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [selected, state]);

  const round = state?.rounds.find((item) => item.week === selected) ?? null;

  const visibleTransfers = useMemo(() => {
    if (!state || !round) return [];
    return state.transfers.filter((transfer) => {
      if (transfer.roundId == null) return true;
      const owner = state.rounds.find((item) => item.id === transfer.roundId);
      if (!owner) return false;
      if (owner.week < round.week) return true;
      if (owner.week === round.week) return revealed;
      return false;
    });
  }, [state, round, revealed]);

  const book = useMemo(() => {
    const rows = visibleTransfers.filter((transfer) => {
      if (!settledView && transfer.roundId === round?.id) return false;
      return true;
    });
    return holdings(rows);
  }, [visibleTransfers, settledView, round]);

  const total = (book.manager ?? 0n) + (book.crypto ?? 0n) + (book.stocks ?? 0n);

  async function forward() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/forward", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "неделя не запустилась");
      await load(body.week);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "неделя не запустилась");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="desk">
      <header className="top">
        <div className="brand">
          <b>HEDGE DESK</b>
          <span>Preprod · tUSDM · локальный прогон</span>
        </div>
        <div className="live">
          <i className="dot" />
          {typing ? `${typing} печатает` : source ? `реплики: ${source}` : "ждёт неделю"}
        </div>
      </header>
      <section className="grid">
        <aside className="panel rounds">
          <header>РАУНДЫ</header>
          {state?.rounds.map((item) => (
            <button key={item.week} className={item.week === selected ? "round on" : "round"} onClick={() => setSelected(item.week)}>
              <span className="when">{label(item.week)}</span>
              <span className="split">{split(item.weightsAfter)}</span>
            </button>
          ))}
        </aside>
        <section className="panel chat">
          <header>
            <span>ЧАТ</span>
            <b>{round ? label(round.week) : ""}</b>
          </header>
          <div className="thread">
            {lines.slice(0, shown).map((line, index) => (
              <article key={`${line.role}-${index}`} className={`bubble ${line.role}`}>
                <div className={`who ${line.role}`}>{line.role}</div>
                <p>{line.text}</p>
              </article>
            ))}
            {typing ? <div className="typing">···</div> : null}
          </div>
        </section>
        <aside className="panel side">
          <header>НЕДЕЛЯ</header>
          <button className="forward" disabled={busy || Boolean(typing)} onClick={() => void forward()}>
            one week forward
            <small>запустить новый раунд</small>
          </button>
          {error ? <p className="err">{error}</p> : null}
          <header>БАЛАНС</header>
          <div className="balances">
            {ORDER.filter((role) => role !== "reserve").map((role) => (
              <div className="row" key={role}>
                <b className={`name ${role}`}>{role === "manager" ? "reserve" : role}</b>
                <span>{tusdm(book[role] ?? 0n)} tUSDM</span>
              </div>
            ))}
            <div className="row total">
              <b>всего</b>
              <span>{tusdm(total)} tUSDM</span>
            </div>
          </div>
          <header>ТРАНЗАКЦИИ</header>
          <div className="log">
            {visibleTransfers
              .filter((transfer) => transfer.roundId != null)
              .map((transfer) => {
                const owner = state?.rounds.find((item) => item.id === transfer.roundId);
                const status = settledView || transfer.roundId !== round?.id ? transfer.status : "pending";
                const tx = transfer.txId?.startsWith("demo") ? "демо, не Cardano" : transfer.txId || transfer.detail || "";
                return (
                  <div className="tx" key={transfer.id}>
                    <div>
                      <div>
                        {owner ? label(owner.week) : ""} {transfer.from} → {transfer.to}
                      </div>
                      <em className={status}>{status}{tx ? ` · ${tx}` : ""}</em>
                    </div>
                    <span>{tusdm(BigInt(transfer.amount))}</span>
                  </div>
                );
              })}
          </div>
        </aside>
      </section>
    </main>
  );
}
