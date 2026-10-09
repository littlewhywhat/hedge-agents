from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from agents.common.errors import DomainError
from agents.common.safety import TraderEngine, TradingView, daily_stop, performance_score


@pytest.fixture
def trader(settings):
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    view = TradingView("btc", 1, {"base": ".5", "k": ".25", "max_token_pct": ".85", "paused": False}, Decimal(100), Decimal(20), Decimal(80), Decimal(100), Decimal(1), now, "snapshot", armed=True)
    views = [view]
    async def read():
        return views[0]
    record = AsyncMock(side_effect=lambda decision: decision)
    quote = AsyncMock(side_effect=lambda input_mint, output_mint, raw, slippage: {"inputMint": input_mint, "outputMint": output_mint, "inAmount": str(raw)})
    execute = AsyncMock(return_value={"status": "submitted"})
    model = AsyncMock(return_value={"conviction": 0, "reasoning": "Neutral"})
    engine = TraderEngine(settings, read, model, quote, execute, record, lambda: now)
    return engine, views


@pytest.mark.parametrize("response", ["{bad", {"conviction": "NaN", "reasoning": "bad"}, {"conviction": 1.01, "reasoning": "bad"}, {"conviction": True, "reasoning": "bad"}, {"conviction": "Infinity", "reasoning": "bad"}])
async def test_model_abstention_is_terminal_hold(trader, response):
    engine, _ = trader
    engine.model.return_value = response
    result = await engine.tick(1)
    assert result["action"] == "hold" and result["abstained"]
    assert result["conviction"] is None and result["target_fraction"] == "0.2"
    engine.quote.assert_not_called()
    engine.execute.assert_not_called()


async def test_model_timeout_is_terminal_hold(trader):
    engine, _ = trader
    engine.model.side_effect = TimeoutError()
    result = await engine.tick(1)
    assert result["abstained"] and result["target_fraction"] == "0.2"
    engine.quote.assert_not_called()


async def test_valid_zero_is_neutral_not_abstention(trader):
    engine, _ = trader
    result = await engine.tick(1)
    assert result["status"] == "submitted"
    engine.quote.assert_awaited_once()
    assert engine.execute.call_args.args[1]["conviction"] == "0"


async def test_kill_during_model_prevents_signature(trader):
    engine, views = trader
    async def model(view):
        views[0] = replace(view, kill_switch=True)
        return {"conviction": 1, "reasoning": "Buy"}
    engine.model = model
    result = await engine.tick(1)
    assert result["status"] == "blocked"
    engine.execute.assert_not_called()


async def test_mark_becomes_stale_before_signature(trader):
    engine, views = trader
    async def quote(input_mint, output_mint, raw, slippage):
        views[0] = replace(views[0], sampled_at=views[0].sampled_at - timedelta(minutes=3))
        return {"inputMint": input_mint, "outputMint": output_mint, "inAmount": str(raw)}
    engine.quote = quote
    assert (await engine.tick(1))["status"] == "blocked"
    engine.execute.assert_not_called()


async def test_daily_stop_sells_without_llm(trader):
    engine, views = trader
    views[0] = replace(views[0], stopped=True)
    await engine.tick(1)
    engine.model.assert_not_called()
    assert engine.execute.call_args.args[1]["action"] == "sell"
    assert engine.execute.call_args.args[1]["target_fraction"] == "0"


def test_daily_stop_latch_and_next_day():
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    state = daily_stop({}, now, Decimal(".94"), Decimal(1))
    assert state["stopped"]
    assert daily_stop(state, now, Decimal(1), Decimal(1))["stopped"]
    assert not daily_stop(state, now + timedelta(days=1), Decimal(1), None)["baseline_valid"]
    assert not daily_stop(state, now + timedelta(days=1), Decimal(1), Decimal(1))["stopped"]
    assert not daily_stop({}, now, Decimal(1), Decimal(1))["stopped"]


def test_score_requires_complete_history():
    now = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
    samples = [(now - timedelta(minutes=60 - index), Decimal(1) + Decimal(index) / 1000) for index in range(61)]
    assert performance_score(samples, now) > 0
    with pytest.raises(DomainError):
        performance_score(samples[1:], now)
    with pytest.raises(DomainError):
        performance_score(samples[:30] + samples[31:], now)