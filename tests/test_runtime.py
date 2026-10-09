from decimal import Decimal

from agents.common.accounting import Book
from agents.common.models import AllocationRound
from runtime.allocation import AllocationRuntime, ordered_legs


def books():
    result = {}
    for name in ("btc", "eth", "gold", "stocks"):
        book = Book()
        book.apply("contribution", 100, "test:" + name)
        result[name] = book
    return result


def test_buffer_only_allocation_uses_only_x402():
    values = books()
    legs = ordered_legs(values, {"btc": Decimal(".4"), "eth": Decimal(".2"), "gold": Decimal(".2"), "stocks": Decimal(".2")})
    assert len(legs) == 3
    assert all(leg["kind"] == "x402" for leg in legs)
    assert sum(int(leg["amount_raw"]) for leg in legs) == 60_000_000


def test_larger_move_orders_sale_withdraw_send_deposit_buy():
    values = books()
    values["eth"].apply("move", 95, "solana", source="capital", destination="usdc")
    values["eth"].apply("execution", 95, "swap", source="usdc", destination="token", received=95)
    legs = ordered_legs(values, {"btc": Decimal(".45"), "eth": Decimal(".10"), "gold": Decimal(".25"), "stocks": Decimal(".20")})
    kinds = [leg["kind"] for leg in legs]
    assert kinds[:3] == ["raise_cash", "gateway_withdraw", "x402"]
    assert kinds[-2:] == ["gateway_deposit", "buy_target"]
    assert len({leg["id"] for leg in legs}) == len(legs)


async def test_restart_never_repeats_confirmed_leg(database, settings):
    legs = [{"id": "leg-one", "state": "settled", "kind": "x402", "tx_id": "confirmed"}, {"id": "leg-two", "state": "pending", "kind": "x402"}]
    with database.transaction() as session:
        session.add(AllocationRound(id="round", state="partial", policy_version=1, weights_before={}, target_weights={"btc": ".5"}, snapshot_ids=[], scores={}, legs=legs))
    seen = []
    async def execute(round_id, leg, policy):
        seen.append(leg["id"])
        return {"state": "settled", "tx_id": "second"}
    runtime = AllocationRuntime(database, settings)
    assert runtime.plan() == "round"
    await runtime.advance("round", execute)
    assert seen == ["leg-two"]
    with database.transaction() as session:
        round = session.get(AllocationRound, "round")
        assert round.settled_weights is None
        assert round.legs[0]["tx_id"] == "confirmed"
        assert round.legs[1]["tx_id"] == "second"