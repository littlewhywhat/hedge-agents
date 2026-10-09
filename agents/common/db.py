import hashlib
from contextlib import contextmanager
from datetime import timedelta

import rfc8785
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from agents.common.accounting import Book
from agents.common.config import MARKETS, Settings
from agents.common.models import AccountingEntry, Agent, AuditHead, Base, BookState, Controls, Event, GatewayQuota, Inventory, Policy, RuntimeState, utcnow


def canonical_hash(body: dict) -> str:
    return hashlib.sha256(rfc8785.dumps(body)).hexdigest()


def iso(time) -> str:
    from datetime import timezone
    if time.tzinfo is None:
        time = time.replace(tzinfo=timezone.utc)
    return time.isoformat(timespec="microseconds")


class Database:
    def __init__(self, url: str, *, testing: bool = False):
        if url.startswith("sqlite") and not testing:
            raise ValueError("SQLite is only allowed in isolated tests; runtime requires Postgres")
        kwargs = {"pool_pre_ping": True, "hide_parameters": True}
        if url.startswith("sqlite"):
            kwargs.update(connect_args={"check_same_thread": False}, poolclass=StaticPool)
        self.engine = create_engine(url, **kwargs)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    @contextmanager
    def transaction(self):
        with self.sessions.begin() as session:
            yield session

    def create_schema(self):
        Base.metadata.create_all(self.engine)

    def seed(self, settings: Settings):
        with self.transaction() as session:
            if session.get(Controls, 1):
                stored = list(session.scalars(select(Agent).where(Agent.id != "gateway")))
                if {agent.id for agent in stored} != set(settings.agent_ids) or any(agent.environment != settings.environment for agent in stored):
                    raise ValueError("Database belongs to a different environment or sleeve set")
                return
            session.add(Controls(id=1, state={"stops": {}, "qualification": "not_started"}))
            session.add(AuditHead(id=1, sequence=0, hash="0" * 64))
            session.add(GatewayQuota(id=1, day=utcnow().date().isoformat(), active_raw=0, settled_raw=0))
            session.add(RuntimeState(id=1, body={}))
            for chain in ("cardano", "solana"):
                session.add(Inventory(chain=chain, low_water_raw=settings.gateway_low_water_raw))
            for name in settings.agent_ids:
                session.add(Agent(id=name, market=name, name=MARKETS[name]["name"], environment=settings.environment, details=MARKETS[name]))
                session.add(BookState(agent_id=name, body=Book().json()))
            session.add(Agent(id="gateway", market="gateway", name="Settlement gateway", environment=settings.environment, details={}))
            body = {"agents": {name: {"cap": "1" if settings.fund_mode == 1 else "0.50", "paused": False, "max_token_pct": "0.85", "k": "0.25", "base": "0.50"} for name in settings.agent_ids}, "risk": "balanced", "max_step": "0.20", "daily_loss_pct": "0.05", "slippage_bps": 50}
            session.add(Policy(version=1, hash=canonical_hash(body), body=body, status="active", activation_boundary=utcnow() + timedelta(seconds=settings.allocation_seconds)))


def append_event(session: Session, kind: str, payload: dict) -> Event:
    head = session.scalar(select(AuditHead).where(AuditHead.id == 1).with_for_update())
    if head is None:
        raise RuntimeError("Audit head is missing; refusing unaudited mutation")
    row = {"id": head.sequence + 1, "time": iso(utcnow()), "kind": kind, "payload": payload, "prev_hash": head.hash}
    event = Event(**row, hash=canonical_hash(row))
    session.add(event)
    session.flush()
    if session.bind.dialect.name == "sqlite":
        head.sequence = event.id
        head.hash = event.hash
        session.flush()
    else:
        session.refresh(head)
    return event


def verify_events(events: list[Event]) -> dict:
    previous = "0" * 64
    sequence = 0
    for event in events:
        body = {"id": event.id, "time": event.time, "kind": event.kind, "payload": event.payload, "prev_hash": event.prev_hash}
        if event.id != sequence + 1 or event.prev_hash != previous or canonical_hash(body) != event.hash:
            return {"valid": False, "failed_at": event.id, "head": previous, "count": sequence}
        previous, sequence = event.hash, event.id
    return {"valid": True, "head": previous, "count": sequence}


def recognize(session: Session, agent_id: str, operation: str, amount, proof: str, flow_at=None, **kwargs) -> Book:
    row = session.scalar(select(BookState).where(BookState.agent_id == agent_id).with_for_update())
    if row is None:
        raise ValueError("No fund book for this owner")
    book = Book.from_json(row.body)
    fund_equity_before = sum(Book.from_json(item.body).equity for item in session.scalars(select(BookState))) if operation == "distribution" else None
    if book.apply(operation, amount, proof, **kwargs):
        row.body = book.json()
        if operation in ("contribution", "distribution"):
            from agents.common.benchmarks import record_flow
            from decimal import Decimal
            record_flow(session, agent_id, operation, Decimal(str(amount)), proof, fund_equity_before, flow_at or utcnow())
        terms = book.proofs[proof]
        session.add(AccountingEntry(owner=agent_id, proof=proof, component=operation, body=terms))
        append_event(session, "accounting_recognized", {"agent": agent_id, "proof": proof, **terms})
    return book