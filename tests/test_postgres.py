import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
import psycopg
from psycopg import sql
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from agents.common.db import Database, append_event, verify_events
from agents.common.errors import DomainError
from agents.common.models import Controls, Event, GatewayQuota, Inventory, Wallet, utcnow
from agents.gateway.settlement import SettlementService
from infra.manage import dsn


@pytest.fixture
def postgres():
    url = os.getenv("HEDGE_POSTGRES_URL")
    if not url:
        pytest.skip("Run infra.manage test to include real Podman/Postgres checks")
    database = Database(url)
    yield database
    database.engine.dispose()


def test_application_role_cannot_rewrite_events(postgres):
    with pytest.raises(DBAPIError):
        with postgres.transaction() as session:
            session.execute(text("UPDATE events SET kind = 'tampered'"))


def test_application_role_cannot_read_signed_bytes(postgres):
    with pytest.raises(DBAPIError):
        with postgres.transaction() as session:
            session.execute(text("SELECT signed_bytes FROM chain_attempts"))


def test_database_rejects_wrong_previous_hash(postgres):
    with pytest.raises(DBAPIError):
        with postgres.transaction() as session:
            session.execute(text("INSERT INTO events (id, time, kind, payload, prev_hash, hash) VALUES (999999, 'test', 'test', '{}', 'wrong', 'bad')"))


def test_audit_writer_can_lock_and_append_without_tail_write_privileges(postgres):
    with postgres.sessions() as session:
        transaction = session.begin()
        event = append_event(session, "postgres_permission_probe", {"rollback": True})
        assert event.id > 0
        assert session.execute(text("SELECT hash FROM audit_heads WHERE id = 1")).scalar_one() == event.hash
        transaction.rollback()


@pytest.fixture
def race_database(settings):
    url = os.getenv("HEDGE_TEST_ADMIN_URL")
    if not url:
        pytest.skip("Run infra.setup verify to include disposable-database race checks")
    name = "hedge_test_" + uuid4().hex
    with psycopg.connect(dsn(url), autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    from sqlalchemy.engine import make_url
    engine_url = make_url(url).set(database=name).render_as_string(hide_password=False)
    database = Database(engine_url)
    try:
        database.create_schema()
        database.seed(settings)
        with psycopg.connect(dsn(engine_url)) as connection:
            connection.execute((Path(__file__).resolve().parents[1] / "infra/schema.sql").read_text(encoding="utf-8"))
        yield database
    finally:
        database.engine.dispose()
        with psycopg.connect(dsn(url), autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def test_two_concurrent_admissions_cannot_share_inventory(race_database, settings):
    settings = settings.model_copy(update={"devnet_usdc_mint": "devnet-usdc"})
    with race_database.transaction() as session:
        session.get(Controls, 1).kill_switch = False
        for name in ("btc", "gateway"):
            for chain in ("cardano", "solana"):
                role = "capital" if chain == "cardano" else ("gateway_inventory" if name == "gateway" else "trading")
                session.add(Wallet(id=f"{name}:{chain}", agent_id=name, environment="preprod", chain=chain, role=role, signer=name, address=f"{name}-{chain}", belongs_to_fund=name == "btc"))
        for row in session.scalars(select(Inventory)):
            row.confirmed_raw, row.low_water_raw, row.sampled_at = 100_000_000, 0, utcnow()
    service = SettlementService(race_database, settings)
    def admit(request_id):
        try:
            service.prepare("btc", request_id, "deposit_to_solana", 80_000_000, "btc:cardano", "btc:solana", "btc:cardano")
            return 200
        except DomainError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(admit, ("first", "second")))
    assert sorted(results) == [200, 409]
    with race_database.transaction() as session:
        assert session.get(Inventory, "solana").reserved_raw == 80_000_000
        assert session.get(GatewayQuota, 1).active_raw == 80_000_000


def test_concurrent_audit_writers_extend_one_chain(race_database):
    def write(value):
        with race_database.transaction() as session:
            append_event(session, "concurrency_fixture", {"value": value})
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(write, range(12)))
    with race_database.transaction() as session:
        result = verify_events(list(session.scalars(select(Event).order_by(Event.id))))
        assert result["valid"] and result["count"] == 12