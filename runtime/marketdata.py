from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path


HISTORICAL_FILES = {"btc": "btc.json", "eth": "eth.json", "gold": "gold.json", "stocks": "spyx.json"}
HISTORICAL_SOURCES = {
    "btc": "User file: Binance BTC/USDT daily candles",
    "eth": "User file: Binance ETH/USDT daily candles",
    "gold": "User file: GoldAPI XAU/USD observations; gold price proxy, not PAXG fills",
    "stocks": "User file: GeckoTerminal SPYx/USD daily pool candles",
}


def utc_timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Expected an ISO timestamp with a timezone")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Historical timestamps must include a timezone")
    return result.astimezone(timezone.utc)


def price_number(value, *, allow_zero=False) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError("Historical prices and volumes must be numeric")
    result = Decimal(value)
    if not result.is_finite() or result < 0 or (result == 0 and not allow_zero):
        raise ValueError("Historical prices must be finite and positive; volumes cannot be negative")
    return result


def load_historical_files(directory: Path, *, now: datetime | None = None) -> dict:
    directory = Path(directory).expanduser().resolve()
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Import cutoff must include a timezone")
    bars, files = {}, {}
    for asset, filename in HISTORICAL_FILES.items():
        content = (directory / filename).read_bytes()
        records = json.loads(content.decode("utf-8-sig"), parse_float=Decimal)
        if not isinstance(records, list) or not records:
            raise ValueError(f"{filename}: expected a nonempty array of historical records")
        accepted = {}
        skipped = {"source_errors": 0, "unfinished": 0, "duplicates": 0}
        error_dates = []
        for index, record in enumerate(records):
            if not isinstance(record, dict):
                raise ValueError(f"{filename}: record {index + 1} must be an object")
            if record.get("error"):
                skipped["source_errors"] += 1
                error_dates.append(str(record.get("date", "unknown"))[:40])
                continue
            try:
                if asset == "gold":
                    if record.get("metal") != "XAU" or record.get("currency") != "USD":
                        raise ValueError("Gold observations must identify XAU in USD")
                    available_at = utc_timestamp(record["date"])
                    milliseconds = price_number(record["timestamp"])
                    if milliseconds != milliseconds.to_integral_value():
                        raise ValueError("Gold timestamp must be integer milliseconds")
                    observed_at = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=int(milliseconds))
                    if available_at != observed_at:
                        raise ValueError("Gold date and timestamp disagree")
                    row = {"time": available_at.isoformat(), "close": str(price_number(record["price"]))}
                else:
                    opened_at = utc_timestamp(record["date"] if asset == "stocks" else record["openTime"])
                    if asset == "stocks":
                        available_at = opened_at + timedelta(days=1)
                    else:
                        available_at = utc_timestamp(record["closeTime"]) + timedelta(milliseconds=1)
                    if available_at - opened_at != timedelta(days=1):
                        raise ValueError("Expected a complete daily candle interval")
                    prices = {field: price_number(record[field]) for field in ("open", "high", "low", "close")}
                    if not prices["low"] <= min(prices["open"], prices["close"]) <= max(prices["open"], prices["close"]) <= prices["high"]:
                        raise ValueError("Candle high/low do not contain its open and close")
                    row = {"time": available_at.isoformat(), "open_time": opened_at.isoformat(), **{field: str(value) for field, value in prices.items()}, "volume": str(price_number(record["volume"], allow_zero=True))}
            except (KeyError, ValueError, ArithmeticError, OverflowError) as error:
                raise ValueError(f"{filename}: invalid historical record {index + 1}: {error}") from error
            if available_at > now:
                skipped["unfinished"] += 1
                continue
            previous = accepted.get(available_at)
            if previous is not None:
                if previous != row:
                    raise ValueError(f"{filename}: conflicting observations at {available_at.isoformat()}")
                skipped["duplicates"] += 1
                continue
            accepted[available_at] = row
        if not accepted:
            raise ValueError(f"{filename}: no valid completed observations before the import cutoff")
        bars[asset] = [accepted[stamp] for stamp in sorted(accepted)]
        files[asset] = {"name": filename, "sha256": hashlib.sha256(content).hexdigest(), "input_records": len(records), "accepted_records": len(accepted), "skipped": skipped, "error_dates": error_dates, "first_available_at": bars[asset][0]["time"], "last_available_at": bars[asset][-1]["time"]}
    common_start = max(utc_timestamp(rows[0]["time"]) for rows in bars.values())
    timeline = [row for row in bars["btc"] if utc_timestamp(row["time"]) >= common_start]
    if not timeline:
        raise ValueError("Historical files have no common replay timeline")
    return {"schema": 2, "source": "local_files", "imported_at": now.isoformat(), "start": timeline[0]["time"], "end": timeline[-1]["time"], "sources": HISTORICAL_SOURCES, "files": files, "time_basis": "Completed daily candles; gold observations carried forward only after their recorded timestamp", "bars": bars}


def load_historical_cache(cache: Path) -> dict:
    if not cache.is_file():
        raise ValueError("No local historical cache; import the four JSON files with --data-dir first")
    data = json.loads(cache.read_text(encoding="utf-8"))
    if data.get("schema") != 2 or data.get("source") != "local_files" or set(data.get("bars", {})) != set(HISTORICAL_FILES):
        raise ValueError("Replay requires your four-asset historical files; run with --data-dir to replace the old downloaded tape")
    return data


def price_frames(data: dict, count: int | None = 12) -> list[dict]:
    rows = {name: sorted((utc_timestamp(row["time"]), row["close"]) for row in series) for name, series in data["bars"].items()}
    if "btc" not in rows or any(not series for series in rows.values()):
        raise ValueError("Replay has missing historical observations")
    common_start = max(series[0][0] for series in rows.values())
    crypto = [row for row in rows["btc"] if row[0] >= common_start]
    if count is None:
        selected = [stamp for stamp, _price in crypto]
    else:
        if count < 2:
            raise ValueError("Replay needs at least two frames")
        if len(crypto) < count:
            raise ValueError("Not enough common completed daily observations for the replay frames")
        selected = [crypto[index * (len(crypto) - 1) // (count - 1)][0] for index in range(count)]
    if len(selected) < 2:
        raise ValueError("Replay needs at least two frames")
    frames = []
    for time in selected:
        prices, source_times = {}, {}
        for name, series in rows.items():
            available = [(stamp, price) for stamp, price in series if stamp <= time]
            if not available:
                raise ValueError("Price frame would require a future price")
            source_time, prices[name] = available[-1]
            source_times[name] = source_time.isoformat()
        frames.append({"time": time.isoformat(), "prices": prices, "source_times": source_times})
    return frames