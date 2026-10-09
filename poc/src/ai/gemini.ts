import { toAda } from "../common/ada.js";
import { ASSETS, type Asset, type Decision, type Stance, type Strategy, type TradeIdea, type Trends, type Weights } from "../common/interface.js";
import { errorText, log } from "../common/time.js";
import { fallbackDecision, fallbackExperience, fallbackTrade, fallbackTrends, NAMES } from "./fallback.js";
import type { Brain } from "./interface.js";

type Settings = { apiKey: string; model: string; role: string };

const STANCES: Stance[] = ["aggressive", "balanced", "defensive"];

const firstJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in model answer");
  return JSON.parse(text.slice(start, end + 1));
};

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
};

const ask = async (settings: Settings, prompt: string, options: { search?: boolean; temperature?: number }): Promise<unknown> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.apiKey },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(options.search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: {
          temperature: options.temperature ?? 0.4,
          ...(options.search ? {} : { responseMimeType: "application/json" }),
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`gemini ${response.status}`);
  const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  return firstJson(text);
};

const strategyOf = (value: unknown): Strategy => {
  const row = (value ?? {}) as Partial<Strategy>;
  return {
    stance: STANCES.includes(row.stance as Stance) ? (row.stance as Stance) : "balanced",
    maxPositionPct: clamp(row.maxPositionPct, 0, 100, 60),
    stopLossPct: clamp(row.stopLossPct, 1, 50, 5),
    notes: String(row.notes ?? "").slice(0, 400),
  };
};

const weightsOf = (value: unknown): Weights => {
  const row = (value ?? {}) as Partial<Weights>;
  return {
    btc: clamp(row.btc, 0, 1, 0),
    eth: clamp(row.eth, 0, 1, 0),
    spx: clamp(row.spx, 0, 1, 0),
    gold: clamp(row.gold, 0, 1, 0),
    reserve: clamp(row.reserve, 0, 1, 0),
  };
};

export const openBrain = (settings: Settings): Brain => {
  const enabled = Boolean(settings.apiKey);

  const guarded = async <T>(label: string, run: () => Promise<T>, fallback: () => T): Promise<T> => {
    if (!enabled) return fallback();
    try {
      return await run();
    } catch (error) {
      log(settings.role, `${label} fell back: ${errorText(error)}`);
      return fallback();
    }
  };

  return {
    trends: () =>
      guarded(
        "trends",
        async () => {
          const prompt = `Search the web for market news from the last 24 hours on ${ASSETS.map((asset) => NAMES[asset]).join(", ")}.
For each, write two short sentences: the direction of the trend and the main reason.
Answer with JSON only: {"btc":"","eth":"","spx":"","gold":""}`;
          const row = (await ask(settings, prompt, { search: true, temperature: 0.2 })) as Partial<Trends>;
          return Object.fromEntries(ASSETS.map((asset) => [asset, String(row[asset] ?? "No data.").slice(0, 600)])) as Trends;
        },
        fallbackTrends,
      ),

    allocate: (input) =>
      guarded(
        "allocate",
        async (): Promise<Decision> => {
          const reports = input.reports
            .map(
              (report) =>
                `${report.role}: deposited ${toAda(report.deposited).toFixed(2)}, returned ${toAda(report.withdrawn).toFixed(2)}, pnl ${toAda(report.pnl).toFixed(2)} tADA, ${report.trades} trades. Notes: ${report.experience}`,
            )
            .join("\n");
          const prompt = `You are the manager of a small fund with four trading agents: btc, eth, spx (S&P 500), gold. The rest stays in reserve.
Decide the share of the fund for each agent and the reserve for the next cycle, and a trading strategy for each agent.

Current shares: ${JSON.stringify(input.weights)}
Last cycle results:
${reports || "no results yet, this is the first cycle"}
Market news:
${ASSETS.map((asset) => `${asset}: ${input.trends[asset]}`).join("\n")}

This is a live demo: be bold. Back your strongest conviction hard, keep every agent in the game, and prefer aggressive stances with large positions unless the news is clearly bad.
Rules: shares are fractions that sum to 1. Each agent at least 0.1 and at most 0.5. Reserve between 0.05 and 0.2. Do not change any share by more than 0.3.
stance is one of aggressive, balanced, defensive. maxPositionPct is the most of the agent's cash it may hold in the asset (0-100). stopLossPct is the loss in percent at which it sells everything.
Answer with JSON only:
{"weights":{"btc":0,"eth":0,"spx":0,"gold":0,"reserve":0},"strategies":{"btc":{"stance":"","maxPositionPct":0,"stopLossPct":0,"notes":""},"eth":{...},"spx":{...},"gold":{...}},"rationale":"two or three sentences"}`;
          const row = (await ask(settings, prompt, { temperature: 0.3 })) as {
            weights?: unknown;
            strategies?: Record<string, unknown>;
            rationale?: unknown;
          };
          return {
            weights: weightsOf(row.weights),
            strategies: Object.fromEntries(ASSETS.map((asset) => [asset, strategyOf(row.strategies?.[asset])])) as Record<Asset, Strategy>,
            rationale: String(row.rationale ?? "").slice(0, 1200),
            source: "gemini",
          };
        },
        () => fallbackDecision(input),
      ),

    trade: (input) =>
      guarded(
        "trade",
        async (): Promise<TradeIdea> => {
          const last = input.prices[input.prices.length - 1] ?? 0;
          const sampled = input.prices.filter((_price, index) => index % 5 === 0 || index === input.prices.length - 1);
          const prompt = `You trade ${NAMES[input.asset]} on a simulated broker. Prices are in tADA per unit, one point every 5 seconds, oldest first:
${sampled.map((price) => price.toFixed(2)).join(", ")}
Cash: ${toAda(input.cash).toFixed(2)} tADA. Position: ${input.qty.toFixed(8)} units (worth ${(input.qty * last).toFixed(2)} tADA). Value at deposit: ${toAda(input.entryValue).toFixed(2)} tADA.
Strategy from the manager: stance ${input.strategy.stance}, hold at most ${input.strategy.maxPositionPct}% of value in the asset, sell everything at a ${input.strategy.stopLossPct}% loss. ${input.strategy.notes}
Decide one action. fraction is the share of cash to spend on a buy, or the share of the position to sell (0-1).
Answer with JSON only: {"side":"buy|sell|hold","fraction":0,"reason":"one short sentence"}`;
          const row = (await ask(settings, prompt, { temperature: 0.3 })) as Partial<TradeIdea>;
          const side = row.side === "buy" || row.side === "sell" ? row.side : "hold";
          return { side, fraction: side === "hold" ? 0 : clamp(row.fraction, 0, 1, 0), reason: String(row.reason ?? "").slice(0, 300) };
        },
        () => fallbackTrade(input),
      ),

    experience: (input) =>
      guarded(
        "experience",
        async () => {
          const fills = input.fills
            .slice(-30)
            .map((fill) => `${fill.side} ${fill.qty.toFixed(8)} at ${fill.price.toFixed(2)}: ${fill.reason}`)
            .join("\n");
          const prompt = `You are the ${NAMES[input.asset]} trading agent. Summarize your last cycle for the fund manager in two sentences: what the market did and what you learned.
Deposited ${toAda(input.deposited).toFixed(2)} tADA, result ${toAda(input.pnl).toFixed(2)} tADA.
Trades:
${fills || "no trades"}
Answer with JSON only: {"summary":""}`;
          const row = (await ask(settings, prompt, { temperature: 0.5 })) as { summary?: unknown };
          return String(row.summary ?? "").slice(0, 600) || fallbackExperience(input);
        },
        () => fallbackExperience(input),
      ),
  };
};
