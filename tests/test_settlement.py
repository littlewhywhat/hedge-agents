from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select

from agents.common.accounting import Book
from agents.common.attempts import assert_handoff, reconcile_attempt
from agents.common.db import recognize
from agents.common.errors import DomainError
from agents.common.models import BookState, Controls, Inventory, MasumiJob, Wallet
from agents.gateway.settlement import SettlementService, VerifiedReceipt


@pytest.fixture
def gateway(database, settings):
    now = [datetime(2026, 10, 9, 23, 59, tzinfo=timezone.utc)]
    settings = settings.model_copy(update={"devnet_usdc_mint": "devnet-usdc"})
    service = SettlementService(database, settings, clock=lambda: now[0])
    with database.transaction() as session:
        session.get(Controls, 1).kill_switch = False
        for agent in ("btc", "gateway"):
            for chain in ("cardano", "solana"):
                role = "capital" if chain == "cardano" else ("trading" if agent == "btc" else "gateway_inventory")
                session.add(Wallet(id=f"{agent}:{chain}", agent_id=agent, environment="preprod", chain=chain, address=f"{agent}-{chain}", role=role, signer="facilitator" if chain == "cardano" else agent, belongs_to_fund=agent == "btc"))
        for row in session.scalars(select(Inventory)):
            row.confirmed_raw, row.low_water_raw, row.sampled_at = 500_000_000, 0, now[0]
        recognize(session, "btc", "contribution", 300, "external", source="capital")
        recognize(session, "btc", "contribution", 300, "sol-external", source="usdc")
        recognize(session, "btc", "contribution", 10, "fee-reserve", source="purchasing")
    return service, now


def prepare(service, request="request", direction="deposit_to_solana", amount=100_000_000):
    source, destination = ("cardano", "solana") if direction == "deposit_to_solana" else ("solana", "cardano")
    return service.prepare("btc", request, direction, amount, f"btc:{source}", f"btc:{destination}", f"btc:{source}")


def fund_fee(service, intent):
    with service.database.transaction() as session:
        job = MasumiJob(intent_id=intent["id"], name=intent["direction"], buyer="btc", seller="gateway", nonce=intent["id"].replace("-", "")[:20], input=intent["terms"], input_hash="0" * 64, terms={}, state="FundsLocked", price_raw=service.settings.gateway_fee_raw)
        session.add(job)
        session.flush()
        job_id = job.id
    service.fee_locked(intent["id"], job_id)
    return job_id


def receipt(service, intent, tx="source-tx", locator="0"):
    terms = intent["terms"]
    return VerifiedReceipt("preprod", terms["source_chain"], tx, locator, terms["source_asset"], int(terms["amount_raw"]), terms["source_address"], terms["gateway_source_address"], True, True, "block-1")


def confirmed(service, attempt_id, tx_id):
    with service.database.transaction() as session:
        reconcile_attempt(session, attempt_id, {"tx_id": tx_id, "state": "confirmed", "success": True, "confirmed": True})


def test_duplicate_request_and_terms_conflict(gateway):
    service, _ = gateway
    first = prepare(service)
    assert prepare(service)["id"] == first["id"]
    with pytest.raises(DomainError) as error:
        prepare(service, amount=99_000_000)
    assert error.value.status == 409
    assert service.availability()["active_reserved_raw"] == "100000000"


@pytest.mark.parametrize("field,value", [("environment", "mainnet"), ("chain", "solana"), ("asset", "wrong"), ("amount_raw", 1), ("source", "attacker"), ("destination", "other"), ("success", False), ("confirmed", False)])
def test_authenticity_is_required(gateway, field, value):
    service, _ = gateway
    intent = prepare(service)
    fund_fee(service, intent)
    with pytest.raises(DomainError):
        service.claim("btc", intent["id"], replace(receipt(service, intent), **{field: value}))


def test_recovery_and_exactly_once_payout(gateway):
    service, _ = gateway
    intent = prepare(service)
    fund_fee(service, intent)
    proof = receipt(service, intent)
    service.claim("btc", intent["id"], proof)
    pending = service.prepare_outcome(intent["id"], "payout", tx_id="payout-tx", signed_bytes=b"one", validity={"last_valid_height": 100})
    restarted = SettlementService(service.database, service.settings, service.clock)
    with service.database.transaction() as session:
        reconcile_attempt(session, pending["payout_attempt_id"], {"tx_id": "payout-tx", "state": "unknown", "error": "lost HTTP response"})
    assert restarted.prepare_outcome(intent["id"], "payout", tx_id="different", signed_bytes=b"two", validity={"height": 200})["payout_attempt_id"] == pending["payout_attempt_id"]
    with pytest.raises(DomainError, match="may still land"):
        restarted.choose_refund(intent["id"])
    confirmed(service, pending["payout_attempt_id"], "payout-tx")
    result = restarted.finalize(intent["id"])
    assert restarted.finalize(intent["id"])["result"] == result["result"]
    assert restarted.claim("btc", intent["id"], proof)["result"] == result["result"]
    assert result["state"] == "fulfilled"
    with service.database.transaction() as session:
        book = Book.from_json(session.get(BookState, "btc").body)
        assert book.assets["receivable"] == 0
        assert book.costs["service"] == Decimal(".1")
        assert book.net_pnl == Decimal("-.1")


@pytest.mark.parametrize("direction,chain", [("deposit_to_solana", "cardano"), ("withdraw_to_cardano", "solana")])
def test_refund_on_original_chain_and_permanent_receipt_claim(gateway, direction, chain):
    service, _ = gateway
    intent = prepare(service, direction=direction)
    fund_fee(service, intent)
    proof = receipt(service, intent)
    service.claim("btc", intent["id"], proof)
    service.choose_refund(intent["id"])
    pending = service.prepare_outcome(intent["id"], "refund", tx_id="refund-tx", signed_bytes=b"refund", validity={"height": 100})
    confirmed(service, pending["refund_attempt_id"], "refund-tx")
    result = service.finalize(intent["id"])
    assert result["state"] == "refunded"
    assert result["result"]["chain"] == chain
    other = prepare(service, "other", direction)
    fund_fee(service, other)
    with pytest.raises(DomainError, match="permanently claimed"):
        service.claim("btc", other["id"], proof)
    assert service.availability()["settled_today_raw"] == "0"


def test_midnight_does_not_reset_reservations(gateway):
    service, now = gateway
    service.settings = service.settings.model_copy(update={"gateway_daily_usd": 150})
    prepare(service)
    now[0] += timedelta(minutes=1)
    with pytest.raises(DomainError, match="daily quota"):
        prepare(service, "second")
    assert service.availability()["active_reserved_raw"] == "100000000"


def test_late_principal_is_protected_and_refundable(gateway):
    service, now = gateway
    intent = prepare(service)
    fund_fee(service, intent)
    now[0] += timedelta(minutes=11)
    assert service.expire_unfunded() == 1
    result = service.claim("btc", intent["id"], receipt(service, intent))
    assert result["state"] == "refund_pending"
    rows = {row["chain"]: row for row in service.availability()["chains"]}
    assert rows["cardano"]["protected_raw"] == "100000000"
    assert rows["solana"]["reserved_raw"] == "0"


def test_missing_history_never_proves_failure(gateway):
    service, _ = gateway
    intent = prepare(service)
    fund_fee(service, intent)
    service.claim("btc", intent["id"], receipt(service, intent))
    pending = service.prepare_outcome(intent["id"], "payout", tx_id="unknown", signed_bytes=b"one", validity={"height": 100})
    with service.database.transaction() as session:
        result = reconcile_attempt(session, pending["payout_attempt_id"], {"tx_id": "unknown", "state": "failed", "expired": True})
        assert result.state == "unknown"
        with pytest.raises(DomainError):
            assert_handoff(session, "gateway:solana", True)
    with pytest.raises(DomainError):
        service.choose_refund(intent["id"])


def test_funded_obligation_survives_kill(gateway):
    service, _ = gateway
    intent = prepare(service)
    fund_fee(service, intent)
    service.claim("btc", intent["id"], receipt(service, intent))
    with service.database.transaction() as session:
        session.get(Controls, 1).kill_switch = True
    pending = service.prepare_outcome(intent["id"], "payout", tx_id="obligation", signed_bytes=b"one", validity={"height": 100})
    assert pending["state"] == "payout_pending"
    with pytest.raises(DomainError, match="kill_switch"):
        prepare(service, "new")


def test_inventory_cannot_be_double_reserved(gateway):
    service, _ = gateway
    with service.database.transaction() as session:
        session.get(Inventory, "solana").confirmed_raw = 150_000_000
    prepare(service)
    with pytest.raises(DomainError, match="unreserved"):
        prepare(service, "second")