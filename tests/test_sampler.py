from decimal import Decimal

import pytest

from agents.common.errors import DomainError
from agents.common.models import RuntimeState, Trade
from monitor.sampler import Sampler, token_holdings


async def test_unconfigured_sampler_reports_blocked_not_fake_balances(database, settings):
    sampler = Sampler(database, settings)
    result = await sampler.tick()
    assert result["status"] == "blocked"
    assert len(result["reasons"]) == 4
    with database.transaction() as session:
        assert session.get(RuntimeState, 1).body["sampler"]["status"] == "blocked"
    await sampler.close()


async def test_inventory_refresh_does_not_invent_wallets(database, settings):
    sampler = Sampler(database, settings)
    with pytest.raises(DomainError, match="Register"):
        await sampler.refresh_inventory()
    await sampler.close()


def test_raw_position_comes_from_confirmed_trades(database):
    from agents.common.config import MARKETS, USDC_MINT
    with database.transaction() as session:
        session.add(Trade(agent_id="btc", signature="buy", body={"input_mint": USDC_MINT, "output_mint": MARKETS["btc"]["mint"], "input_raw": "1000000", "output_raw": "2000"}))
        session.add(Trade(agent_id="btc", signature="sell", body={"input_mint": MARKETS["btc"]["mint"], "output_mint": USDC_MINT, "input_raw": "500", "output_raw": "250000"}))
    with database.transaction() as session:
        assert token_holdings(session, "btc") == Decimal(1500)