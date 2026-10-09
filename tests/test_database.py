import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from agents.common.config import Settings
from agents.common.db import append_event, recognize, verify_events
from agents.common.models import AccountingEntry, ChainAttempt, Event, Wallet


def test_hash_chain_and_atomic_recognition(database):
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 100, "tx:0")
        recognize(session, "btc", "contribution", 100, "tx:0")
        append_event(session, "checked", {"value": "100"})
    with database.transaction() as session:
        assert len(list(session.scalars(select(AccountingEntry)))) == 1
        events = list(session.scalars(select(Event).order_by(Event.id)))
        assert verify_events(events)["valid"]
        events[0].payload = {"tampered": True}
        assert not verify_events(events)["valid"]


def test_unresolved_wallet_survives_session_restart(database):
    with database.transaction() as session:
        session.add(Wallet(id="btc:solana", agent_id="btc", environment="preprod", chain="solana", address="address", role="trading", signer="btc", belongs_to_fund=True))
    with database.transaction() as session:
        session.add(ChainAttempt(wallet_id="btc:solana", parent_id="one", leg="swap", chain="solana", tx_id="sig1", signed_bytes=b"signed", validity={}, state="unknown"))
    with pytest.raises(IntegrityError):
        with database.transaction() as session:
            session.add(ChainAttempt(wallet_id="btc:solana", parent_id="two", leg="swap", chain="solana", tx_id="sig2", signed_bytes=b"signed", validity={}))


def test_wallet_roles_cannot_overlap(database):
    with pytest.raises(IntegrityError):
        with database.transaction() as session:
            for role in ("capital", "purchasing"):
                session.add(Wallet(id=role, agent_id="btc", environment="preprod", chain="cardano", address="same", role=role, signer=role, belongs_to_fund=True))


def test_network_pair_is_mandatory():
    with pytest.raises(ValueError, match="must match"):
        Settings(_env_file=None, environment="mainnet")