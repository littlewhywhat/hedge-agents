from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json

import pytest
from sqlalchemy import func, select

from agents.common.models import BookState, Event, ReplayFrame
from runtime.marketdata import HISTORICAL_FILES, load_historical_cache, load_historical_files, price_frames
from runtime.replay import PaperRuntime, SCORES, store_tape


def fixture_prices():
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    return [{"time": (start + timedelta(days=index * 7)).isoformat(), "prices": {"btc": str(100000 + index * 500), "eth": str(3000 + index * 20), "gold": str(3000 + index * 10), "stocks": str(6000 + index * 15)}} for index in range(12)]


def test_every_frame_reconciles_to_recorded_paper_trades():
    frames, trades, headlines = PaperRuntime().run(fixture_prices())
    assert all(set(frame["agents"]) == set(HISTORICAL_FILES) for frame in frames)
    assert any(trade["agent"] == "gold" and trade["kind"] == "trade" for trade in trades)
    holdings = dict.fromkeys(SCORES, 0)
    for frame in frames:
        for trade in (row for row in trades if row["frame_id"] == frame["id"] and row["kind"] == "trade"):
            amount = Decimal(trade["amount_usd"])
            assert amount <= 100
            assert amount <= Decimal(trade["equity_before"]) * Decimal(".25")
            holdings[trade["agent"]] += int(trade["raw_amount"]) * (1 if trade["action"] == "buy" else -1)
        equity = Decimal(0)
        for name, agent in frame["agents"].items():
            assert holdings[name] == int(agent["token_raw"])
            token = Decimal(holdings[name]) * Decimal(frame["prices"][name]) / 100_000_000
            assert abs(token - Decimal(agent["token_value"])) < Decimal("1e-18")
            actual = token + sum(Decimal(agent[key]) for key in ("capital", "usdc", "purchasing")) - Decimal(agent["payable"])
            assert abs(actual - Decimal(agent["equity"])) < Decimal("1e-18")
            equity += actual
        assert abs(equity - Decimal(frame["equity"])) < Decimal("1e-18")
        assert Decimal(frame["net_pnl"]) == Decimal(frame["equity"]) - 900
    assert len(headlines) == 1
    shock = next(frame for frame in frames if frame["shock"])
    assert Decimal(shock["agents"]["btc"]["token_value"]) < Decimal(".01")
    assert Decimal(shock["target_weights"]["btc"]) <= Decimal(shock["weights_before"]["btc"])
    if shock["round_kind"] != "bound_repair":
        assert Decimal(shock["weights_before"]["btc"]) - Decimal(shock["target_weights"]["btc"]) <= Decimal(".20")


def test_tape_storage_never_writes_live_events(database):
    with database.transaction() as session:
        books_before = {row.agent_id: row.body for row in session.scalars(select(BookState))}
    frames, trades, headlines = PaperRuntime().run(fixture_prices())
    store_tape(database, frames, trades, headlines)
    store_tape(database, frames, trades, headlines)
    with database.transaction() as session:
        assert session.scalar(select(func.count()).select_from(Event)) == 0
        assert session.scalar(select(func.count()).select_from(ReplayFrame)) == 12
        assert {row.agent_id: row.body for row in session.scalars(select(BookState))} == books_before


def test_stock_close_is_carried_not_recompounded():
    stamps = [datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=index) for index in range(12)]
    data = {"bars": {"btc": [{"time": time.isoformat(), "close": "100"} for time in stamps], "eth": [{"time": time.isoformat(), "close": "20"} for time in stamps], "stocks": [{"time": stamps[0].isoformat(), "close": "6000"}]}}
    assert {frame["prices"]["stocks"] for frame in price_frames(data)} == {"6000"}


def historical_files(directory):
    start = datetime(2026, 7, 10, tzinfo=timezone.utc)
    records = {name: [] for name in HISTORICAL_FILES}
    for index in range(4):
        opened = start + timedelta(days=index)
        close = opened + timedelta(days=1) - timedelta(milliseconds=1)
        candle = {"open": "100.123456789123456789", "high": "102", "low": "99", "close": "101.123456789123456789", "volume": "50"}
        for name in ("btc", "eth"):
            records[name].append({"openTime": opened.isoformat(), "closeTime": close.isoformat(), **candle})
        records["stocks"].append({"date": opened.isoformat(), **candle})
        observed = opened + timedelta(hours=9, minutes=30)
        records["gold"].append({"date": observed.isoformat(), "timestamp": int(observed.timestamp() * 1000), "metal": "XAU", "currency": "USD", "price": str(2000 + index)})
    records["gold"].append({"date": "20260714", "error": "Source request failed"})
    for name, rows in records.items():
        (directory / HISTORICAL_FILES[name]).write_text(json.dumps(rows), encoding="utf-8")
    return records


def test_local_files_normalize_four_assets_without_network(tmp_path, monkeypatch):
    import httpx
    def no_network(*args, **kwargs):
        raise AssertionError("Local import must not download substitute prices")
    monkeypatch.setattr(httpx, "Client", no_network)
    historical_files(tmp_path)
    data = load_historical_files(tmp_path, now=datetime(2026, 7, 13, 12, tzinfo=timezone.utc))
    assert set(data["bars"]) == {"btc", "eth", "gold", "stocks"}
    assert data["source"] == "local_files"
    assert data["bars"]["btc"][0]["close"] == "101.123456789123456789"
    assert data["bars"]["gold"][0]["close"] == "2000"
    assert data["bars"]["stocks"][0]["time"] == "2026-07-11T00:00:00+00:00"
    assert data["bars"]["btc"][0]["time"] == data["bars"]["stocks"][0]["time"]
    assert data["files"]["btc"]["accepted_records"] == 3
    assert data["files"]["btc"]["skipped"]["unfinished"] == 1
    assert data["files"]["gold"]["skipped"]["source_errors"] == 1
    assert len(data["files"]["stocks"]["sha256"]) == 64


def test_local_import_never_modifies_original_files(tmp_path):
    historical_files(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    load_historical_files(tmp_path, now=datetime(2026, 7, 14, tzinfo=timezone.utc))
    assert before == {path.name: path.read_bytes() for path in tmp_path.iterdir()}


@pytest.mark.parametrize("price", ["NaN", "Infinity", "-1", "0", True])
def test_invalid_local_gold_prices_fail_closed(tmp_path, price):
    records = historical_files(tmp_path)
    records["gold"][0]["price"] = price
    (tmp_path / "gold.json").write_text(json.dumps(records["gold"]), encoding="utf-8")
    with pytest.raises(ValueError, match="gold.json"):
        load_historical_files(tmp_path, now=datetime(2026, 7, 14, tzinfo=timezone.utc))


def test_duplicate_local_observations_are_explicit_and_conflicts_fail(tmp_path):
    records = historical_files(tmp_path)
    records["gold"].append(dict(records["gold"][0]))
    (tmp_path / "gold.json").write_text(json.dumps(records["gold"]), encoding="utf-8")
    data = load_historical_files(tmp_path, now=datetime(2026, 7, 14, tzinfo=timezone.utc))
    assert data["files"]["gold"]["skipped"]["duplicates"] == 1
    records["gold"][-1]["price"] = "999"
    (tmp_path / "gold.json").write_text(json.dumps(records["gold"]), encoding="utf-8")
    with pytest.raises(ValueError, match="conflicting"):
        load_historical_files(tmp_path, now=datetime(2026, 7, 14, tzinfo=timezone.utc))


def test_missing_local_asset_does_not_fall_back_to_downloads(tmp_path):
    historical_files(tmp_path)
    (tmp_path / "gold.json").unlink()
    with pytest.raises(FileNotFoundError):
        load_historical_files(tmp_path)


def test_price_frames_never_use_a_future_gold_observation(tmp_path):
    historical_files(tmp_path)
    data = load_historical_files(tmp_path, now=datetime(2026, 7, 13, 12, tzinfo=timezone.utc))
    frames = price_frames(data, count=3)
    assert frames[0]["prices"]["gold"] == "2000"
    assert frames[-1]["prices"]["gold"] == "2002"
    for frame in frames:
        assert all(datetime.fromisoformat(stamp) <= datetime.fromisoformat(frame["time"]) for stamp in frame["source_times"].values())


def test_old_downloaded_cache_is_not_accepted(tmp_path):
    cache = tmp_path / "replay-bars.json"
    cache.write_text(json.dumps({"schema": 1, "source": "downloaded", "bars": {}}), encoding="utf-8")
    with pytest.raises(ValueError, match="--data-dir"):
        load_historical_cache(cache)


def test_local_cache_reproduces_exact_frame_prices(tmp_path):
    historical_files(tmp_path)
    data = load_historical_files(tmp_path, now=datetime(2026, 7, 13, 12, tzinfo=timezone.utc))
    cache = tmp_path / "replay-bars.json"
    cache.write_text(json.dumps(data), encoding="utf-8")
    assert price_frames(load_historical_cache(cache), count=3) == price_frames(data, count=3)


def test_gold_prices_are_required_for_the_four_asset_replay():
    frames = fixture_prices()
    frames[0]["prices"].pop("gold")
    with pytest.raises(ValueError, match="gold"):
        PaperRuntime().run(frames)