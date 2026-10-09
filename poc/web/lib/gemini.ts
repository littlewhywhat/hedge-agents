import { envFile } from "./db";

export type Line = { role: "manager" | "crypto" | "stocks"; text: string };

export type ScriptInput = {
  week: string;
  weightsBefore: { crypto: number; stocks: number; reserve: number };
  weightsAfter: { crypto: number; stocks: number; reserve: number };
  reports: { role: "crypto" | "stocks"; decayedReturn: number }[];
  transfers: { from: string; to: string; amount: string }[];
};

const cache = new Map<string, { lines: Line[]; source: "gemini" | "fallback" }>();

function pct(weight: number): string {
  return String(Math.round(weight * 100));
}

function money(amount: string): string {
  const value = Number(BigInt(amount)) / 1_000_000;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function dayPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

export function fallbackLines(input: ScriptInput): Line[] {
  const before = `${pct(input.weightsBefore.crypto)}/${pct(input.weightsBefore.stocks)}/${pct(input.weightsBefore.reserve)}`;
  const after = `${pct(input.weightsAfter.crypto)}/${pct(input.weightsAfter.stocks)}/${pct(input.weightsAfter.reserve)}`;
  const crypto = input.reports.find((report) => report.role === "crypto");
  const stocks = input.reports.find((report) => report.role === "stocks");
  const move =
    input.transfers.length === 0
      ? "Доли не двигаю: шаг меньше порога или агент уже уперся в потолок."
      : input.transfers
          .map((transfer) => `${transfer.from} → ${transfer.to} ${money(transfer.amount)} tUSDM`)
          .join(". ");
  return [
    { role: "manager", text: `Crypto, stocks. Как прошла неделя ${input.week}?` },
    {
      role: "crypto",
      text: crypto
        ? `Неделя ${dayPct(crypto.decayedReturn)} в день по последним снимкам. Это мой отчёт.`
        : "Снимков за неделю нет.",
    },
    {
      role: "stocks",
      text: stocks
        ? `У меня ${dayPct(stocks.decayedReturn)} в день. Цифра из тех же дневных снимков.`
        : "Снимков за неделю нет.",
    },
    {
      role: "manager",
      text: `Было ${before}, предлагаю ${after}. ${move}`,
    },
  ];
}

export async function scriptFor(input: ScriptInput): Promise<{ lines: Line[]; source: "gemini" | "fallback" }> {
  const key = JSON.stringify(input);
  const hit = cache.get(key);
  if (hit) return hit;

  const apiKey = envFile().GEMINI_API_KEY;
  if (!apiKey) return { lines: fallbackLines(input), source: "fallback" };

  const prompt = `Ты пишешь четыре реплики для демо хедж-фонда. Язык русский, разговорный, по одному-два коротких предложения. Без markdown и без списков.
Верни только JSON: {"ask":"","crypto":"","stocks":"","proposal":""}.
ask — менеджер спрашивает crypto и stocks, как прошла неделя ${input.week}.
crypto и stocks отвечают своими цифрами, не выдумывая других.
proposal — менеджер предлагает новые доли и называет перевод, если он есть. Если переводов нет, прямо говорит, что деньги не двигает.

Цифры, их нельзя менять:
crypto ${dayPct(input.reports.find((r) => r.role === "crypto")?.decayedReturn ?? 0)} в день
stocks ${dayPct(input.reports.find((r) => r.role === "stocks")?.decayedReturn ?? 0)} в день
доли было crypto/stocks/reserve ${pct(input.weightsBefore.crypto)}/${pct(input.weightsBefore.stocks)}/${pct(input.weightsBefore.reserve)}
доли станет ${pct(input.weightsAfter.crypto)}/${pct(input.weightsAfter.stocks)}/${pct(input.weightsAfter.reserve)}
переводы: ${
    input.transfers.length
      ? input.transfers.map((t) => `${t.from} -> ${t.to} ${money(t.amount)} tUSDM`).join("; ")
      : "нет"
  }`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
        }),
      },
    );
    if (!response.ok) throw new Error(`gemini ${response.status}`);
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { ask: string; crypto: string; stocks: string; proposal: string };
    const lines: Line[] = [
      { role: "manager", text: parsed.ask },
      { role: "crypto", text: parsed.crypto },
      { role: "stocks", text: parsed.stocks },
      { role: "manager", text: parsed.proposal },
    ];
    if (lines.some((line) => !line.text?.trim())) throw new Error("empty line");
    const value = { lines, source: "gemini" as const };
    cache.set(key, value);
    return value;
  } catch {
    const value = { lines: fallbackLines(input), source: "fallback" as const };
    cache.set(key, value);
    return value;
  }
}
