import argparse
from decimal import Decimal, ROUND_DOWN
import json
from pathlib import Path

from sqlalchemy import delete

from agents.common.accounting import Book, money
from agents.common.allocation import allocate
from agents.common.config import Settings
from agents.common.db import Database
from agents.common.models import ReplayFrame, ReplayHeadline, ReplayTrade
from runtime.marketdata import load_historical_cache, load_historical_files, price_frames


SCORES = {
    "btc": ["0.80", "0.84", "0.87", "0.89", "0.90", "0.42", "0.47", "0.55", "0.59", "0.68", "0.72", "0.76"],
    "eth": ["0.62", "0.66", "0.62", "0.67", "0.66", "0.88", "0.88", "0.89", "0.84", "0.82", "0.81", "0.79"],
    "gold": ["0.58", "0.59", "0.61", "0.62", "0.64", "0.72", "0.73", "0.74", "0.72", "0.73", "0.75", "0.76"],
    "stocks": ["0.55", "0.55", "0.60", "0.61", "0.65", "0.65", "0.67", "0.69", "0.65", "0.62", "0.60", "0.65"],
}


def strings(values):
    return {name: str(value) for name, value in values.items()}


class PaperRuntime:
    def __init__(self, initial: Decimal = Decimal(900)):
        self.initial = initial
        self.books = {name: Book() for name in SCORES}
        self.holdings = dict.fromkeys(SCORES, 0)
        self.trades, self.frames, self.headlines = [], [], []
        self.frame_id, self.time, self.prices = 0, "", {}
        self.cooldown = set()
        self.shadow = {name: initial / len(SCORES) for name in SCORES}

    def record(self, name, kind, **body):
        row = {"id": len(self.trades) + 1, "frame_id": self.frame_id, "time": self.time, "agent": name, "kind": kind, **body}
        self.trades.append(row)
        return f"paper:{row['id']}"

    def fee(self, name, kind, amount):
        book = self.books[name]
        proof = self.record(name, "fee", component=kind, amount_usd=str(amount))
        if kind == "network":
            book.apply("network_fee", amount, proof)
            return
        if book.assets["purchasing"] < amount:
            missing = amount - book.assets["purchasing"]
            source = "capital" if book.assets["capital"] >= missing else "usdc"
            book.apply("move", missing, proof + ":reserve", source=source, destination="purchasing")
        book.apply("fee_lock", amount, proof + ":lock", reference=proof)
        book.apply("fee_delivery", amount, proof + ":delivery", reference=proof)

    def convert(self, name, source, destination, amount):
        if amount <= 0:
            return
        proof = self.record(name, "conversion", source=source, destination=destination, amount_usd=str(amount))
        self.books[name].apply("move", amount, proof, source=source, destination=destination)
        self.fee(name, "service", Decimal(".10"))
        self.fee(name, "network", Decimal(".04"))

    def trade(self, name, action, requested):
        book, price = self.books[name], money(self.prices[name])
        amount = min(requested, book.equity * Decimal(".25"), Decimal(100))
        if amount <= Decimal(".000001"):
            return False
        if action == "buy":
            amount = min(amount, book.assets["usdc"])
            raw_out = int((amount * Decimal(".999") / price * 100_000_000).to_integral_value(rounding=ROUND_DOWN))
            if raw_out <= 0:
                return False
            received = Decimal(raw_out) * price / 100_000_000
            proof = self.record(name, "trade", action="buy", amount_usd=str(amount), received_usd=str(received), raw_amount=str(raw_out), price=str(price), fee_usd=str(amount - received), equity_before=str(book.equity))
            book.apply("execution", amount, proof, source="usdc", destination="token", received=received)
            self.holdings[name] += raw_out
        else:
            raw_in = min(self.holdings[name], int((amount / price * 100_000_000).to_integral_value(rounding=ROUND_DOWN)))
            if raw_in <= 0:
                return False
            amount = Decimal(raw_in) * price / 100_000_000
            received = (amount * Decimal(".999")).quantize(Decimal(".000001"), rounding=ROUND_DOWN)
            proof = self.record(name, "trade", action="sell", amount_usd=str(amount), received_usd=str(received), raw_amount=str(raw_in), price=str(price), fee_usd=str(amount - received), equity_before=str(book.equity))
            book.apply("execution", amount, proof, source="token", destination="usdc", received=received)
            self.holdings[name] -= raw_in
        return True

    def ensure_capital(self, name, amount):
        book = self.books[name]
        missing = max(Decimal(0), amount - book.assets["capital"])
        if missing:
            for _ in range(100):
                if book.assets["usdc"] >= missing + Decimal(".25"):
                    break
                if not self.trade(name, "sell", missing + Decimal(".25") - book.assets["usdc"]):
                    break
            self.convert(name, "usdc", "capital", min(missing, book.assets["usdc"]))

    def rebalance(self, targets, before):
        total = sum(book.equity for book in self.books.values())
        deltas = {name: (targets[name] - before[name]) * total for name in targets}
        senders = [[name, -value] for name, value in sorted(deltas.items()) if value < -Decimal(".000001")]
        receivers = [[name, value] for name, value in sorted(deltas.items()) if value > Decimal(".000001")]
        for sender in senders:
            for receiver in receivers:
                amount = min(sender[1], receiver[1]).quantize(Decimal(".000001"), rounding=ROUND_DOWN)
                if amount <= 0:
                    continue
                self.ensure_capital(sender[0], amount)
                amount = min(amount, self.books[sender[0]].assets["capital"])
                proof = self.record(sender[0], "allocation", destination=receiver[0], amount_usd=str(amount), rail="paper Cardano x402", buffer_only=self.books[sender[0]].assets["capital"] >= amount)
                self.fee(sender[0], "network", Decimal(".04"))
                self.books[sender[0]].apply("internal_out", amount, proof + ":send")
                self.books[receiver[0]].apply("internal_in", amount, proof + ":receive")
                sender[1] -= amount
                receiver[1] -= amount

    def exposure(self, name, stopped):
        book = self.books[name]
        if stopped:
            for _ in range(100):
                if book.assets["token"] <= Decimal(".01") or not self.trade(name, "sell", book.assets["token"]):
                    break
            return
        for _ in range(100):
            difference = book.equity * Decimal(".85") - book.assets["token"]
            if abs(difference) < 1:
                break
            if difference > 0:
                if book.assets["usdc"] < min(difference, Decimal(100)):
                    available = max(Decimal(0), book.assets["capital"] - book.equity * Decimal(".15"))
                    if available > Decimal(".25"):
                        self.convert(name, "capital", "usdc", available - Decimal(".10"))
                if not self.trade(name, "buy", difference):
                    break
            elif not self.trade(name, "sell", -difference):
                break

    def run(self, frames: list[dict], provenance: dict | None = None):
        if len(frames) != len(SCORES["btc"]):
            raise ValueError("The authored score tape requires exactly twelve frames")
        if any(set(frame["prices"]) != set(self.books) for frame in frames):
            raise ValueError("Every replay frame must contain BTC, ETH, gold, and SPYx prices")
        for index, prices in enumerate(frames):
            self.frame_id, self.time, self.prices = index, prices["time"], prices["prices"]
            for name, book in self.books.items():
                if index == 0:
                    proof = self.record(name, "funding", amount_usd=str(self.initial / len(self.books)))
                    book.apply("contribution", self.initial / len(self.books), proof)
                    book.apply("move", ".50", proof + ":reserve", source="capital", destination="purchasing")
                else:
                    book.apply("mark", Decimal(self.holdings[name]) * money(self.prices[name]) / 100_000_000, f"mark:{index}:{name}", source="token")
            total = sum(book.equity for book in self.books.values())
            before = {name: book.equity / total for name, book in self.books.items()}
            scores = {name: money(series[index]) for name, series in SCORES.items()}
            stopped = {name for name, series in SCORES.items() if index and money(series[index - 1]) - scores[name] > Decimal(".20")}
            for name in stopped:
                self.exposure(name, True)
            result = allocate(before, scores, stopped=stopped, cooldown=self.cooldown, initial=index == 0)
            if index:
                self.rebalance(result.weights, before)
            for name in self.books:
                self.exposure(name, name in stopped)
            self.cooldown = {name for name in before if result.weights[name] < before[name] - Decimal("1e-9")}
            equity = sum(book.equity for book in self.books.values())
            costs = {kind: sum(book.costs[kind] for book in self.books.values()) for kind in ("execution", "network", "service", "impairment")}
            benchmark = sum(self.shadow[name] * (book.nav or Decimal(0)) for name, book in self.books.items())
            agents = {name: {"equity": str(book.equity), "weight": str(book.equity / equity), "token_raw": str(self.holdings[name]), "token_value": str(book.assets["token"]), "capital": str(book.assets["capital"]), "usdc": str(book.assets["usdc"]), "purchasing": str(book.assets["purchasing"]), "payable": str(book.payable), "units": str(book.units), "nav": str(book.nav), "net_pnl": str(book.net_pnl), "score": str(scores[name]), "stopped": name in stopped} for name, book in self.books.items()}
            objections = [{"agent": name, "type": "rule_breach" if name in stopped else "comment", "rule": "daily_stop" if name in stopped else None, "applied": name in stopped, "text": "No incoming allocation; cash target" if name in stopped else "No verified rule breach"} for name in self.books]
            frame = {"id": index, "time": self.time, "prices": self.prices, "source_times": prices.get("source_times", {}), "scores": strings(scores), "weights_before": strings(before), "target_weights": strings(result.weights), "settled_weights": {name: row["weight"] for name, row in agents.items()}, "agents": agents, "equity": str(equity), "contributions": str(self.initial), "distributions": "0", "net_pnl": str(equity - self.initial), "gross_pnl": str(equity - self.initial + sum(costs.values())), "fees": strings(costs), "benchmark": str(benchmark), "round_kind": result.kind, "overrides": result.overrides, "reason": result.reason, "shock": sorted(stopped), "objections": objections, "trade_count": len([row for row in self.trades if row["kind"] == "trade"]), "provenance": provenance or {"source": "test fixture"}, "score_source": "Handwritten replay-only score series", "cost_assumptions": {"execution_bps": 10, "gateway_fee_usd": "0.10", "network_fee_usd": "0.04"}}
            self.frames.append(frame)
            if stopped:
                name = sorted(stopped)[0]
                self.headlines.append({"id": len(self.headlines) + 1, "frame_id": index, "agent": name, "title": "Bitcoin score shock", "text": f"Authored score {SCORES[name][index - 1]} to {SCORES[name][index]}. Cash target; incoming budget blocked.", "caption_only": True})
        return self.frames, self.trades, self.headlines


def store_tape(database, frames, trades, headlines):
    with database.transaction() as session:
        for model in (ReplayTrade, ReplayHeadline, ReplayFrame):
            session.execute(delete(model))
        for row in frames:
            session.add(ReplayFrame(id=row["id"], time=row["time"], body={key: value for key, value in row.items() if key not in ("id", "time")}))
        for row in trades:
            session.add(ReplayTrade(id=row["id"], frame_id=row["frame_id"], time=row["time"], body={key: value for key, value in row.items() if key not in ("id", "time", "frame_id")}))
        for row in headlines:
            session.add(ReplayHeadline(id=row["id"], frame_id=row["frame_id"], body={key: value for key, value in row.items() if key not in ("id", "frame_id")}))


def main():
    parser = argparse.ArgumentParser(description="Build an isolated paper replay from your BTC, ETH, gold, and SPYx historical JSON files")
    parser.add_argument("--data-dir", type=Path, help="Folder containing btc.json, eth.json, gold.json, and spyx.json; otherwise reuse the imported local cache")
    parser.add_argument("--refresh", action="store_true", help="Re-import --data-dir; network downloads are never used")
    args = parser.parse_args()
    if args.refresh and args.data_dir is None:
        parser.error("--refresh requires --data-dir so prices are reloaded from your files")
    settings = Settings()
    cache = Path(__file__).resolve().parents[1] / "data" / "replay-bars.json"
    try:
        bars = load_historical_files(args.data_dir) if args.data_dir else load_historical_cache(cache)
        prices = price_frames(bars)
        frames, trades, headlines = PaperRuntime().run(prices, {key: value for key, value in bars.items() if key != "bars"})
    except (OSError, ValueError) as error:
        parser.error(str(error))
    store_tape(Database(settings.database_url), frames, trades, headlines)
    if args.data_dir:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(bars, separators=(",", ":")), encoding="utf-8")
    for name, details in bars["files"].items():
        print(f"{name}: {details['accepted_records']} accepted observations from {details['name']}; excluded {details['skipped']}")
    print(f"Stored {len(frames)} replay frames, {len(trades)} paper records, and {len(headlines)} authored shock caption. Live ledger unchanged.")


if __name__ == "__main__":
    main()