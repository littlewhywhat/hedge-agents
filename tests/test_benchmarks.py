from decimal import Decimal

from sqlalchemy import select

from agents.common.benchmarks import initialize_shadow, summary
from agents.common.config import MARKETS, Settings
from agents.common.db import Database, recognize
from agents.common.models import Benchmark, Price, utcnow


def test_mode1_lots_redeem_proportionally_at_withdrawal():
    settings = Settings(_env_file=None, fund_mode=1, active_agents="btc")
    database = Database("sqlite+pysqlite:///:memory:", testing=True)
    database.create_schema()
    database.seed(settings)
    with database.transaction() as session:
        session.add(Price(mint=MARKETS["btc"]["mint"], usd="100", multiplier="1", sampled_at=utcnow()))
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 100, "external")
        assert summary(session)["equity"] == "100"
        recognize(session, "btc", "distribution", 50, "withdrawal")
        result = summary(session)
        assert Decimal(result["equity"]) == 50
        assert Decimal(result["distributions"]) == 50
        recognize(session, "btc", "distribution", 50, "final-withdrawal")
        assert Decimal(summary(session)["equity"]) == 0
    database.engine.dispose()


def test_shadow_ownership_ignores_internal_allocations(database):
    with database.transaction() as session:
        for name in ("btc", "eth", "gold", "stocks"):
            recognize(session, name, "contribution", 100, "external:" + name)
        initialize_shadow(session, dict.fromkeys(("btc", "eth", "gold", "stocks"), Decimal(".25")))
        before = [row.body for row in session.scalars(select(Benchmark).order_by(Benchmark.proof))]
        recognize(session, "btc", "internal_out", 20, "send")
        recognize(session, "eth", "internal_in", 20, "receive")
        assert Decimal(summary(session)["equity"]) == 400
        after = [row.body for row in session.scalars(select(Benchmark).order_by(Benchmark.proof))]
        assert before == after


def test_missing_marks_do_not_invent_a_benchmark():
    settings = Settings(_env_file=None, fund_mode=1, active_agents="btc")
    database = Database("sqlite+pysqlite:///:memory:", testing=True)
    database.create_schema()
    database.seed(settings)
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 100, "external")
        assert summary(session)["status"] == "pending"
        assert summary(session)["equity"] is None
    database.engine.dispose()