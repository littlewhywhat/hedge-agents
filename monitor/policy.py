from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from agents.common.accounting import Book, money
from agents.common.allocation import AllocationBlocked, validate_caps
from agents.common.db import append_event, canonical_hash, iso
from agents.common.errors import DomainError
from agents.common.models import AllocationRound, BookState, Controls, Policy, utcnow


def public_policy(row: Policy) -> dict:
    return {"version": row.version, "hash": row.hash, "body": row.body, "status": row.status, "activation_boundary": iso(row.activation_boundary), "applied_round_id": row.applied_round_id}


def next_boundary(now: datetime, interval: int) -> datetime:
    return datetime.fromtimestamp((int(now.timestamp()) // interval + 1) * interval, tz=timezone.utc)


def policy_state(session) -> dict:
    rows = list(session.scalars(select(Policy).order_by(Policy.version)))
    active = next((row for row in reversed(rows) if row.status == "active"), None)
    pending = next((row for row in reversed(rows) if row.status == "pending"), None)
    return {"active": public_policy(active) if active else None, "pending": public_policy(pending) if pending else None, "latest_version": rows[-1].version if rows else 0}


def build_policy(current: dict, changes: dict, agent_ids: list[str], mode: int, stopped_bounds: dict | None = None) -> dict:
    if not isinstance(changes, dict) or set(changes) - {"agents", "risk", "max_step", "slippage_bps"}:
        raise DomainError("Unknown or immutable policy field")
    updated = deepcopy(current)
    if "agents" in changes:
        if not isinstance(changes["agents"], dict) or not set(changes["agents"]) <= set(agent_ids):
            raise DomainError("Active sleeve set cannot be changed")
        for name, fields in changes["agents"].items():
            if not isinstance(fields, dict) or set(fields) - {"cap", "paused", "k", "max_token_pct"}:
                raise DomainError("Unknown or immutable agent policy field")
            updated["agents"][name].update(fields)
    for field in ("risk", "max_step", "slippage_bps"):
        if field in changes:
            updated[field] = changes[field]
    try:
        if mode == 2:
            validate_caps({name: money(body["cap"]) for name, body in updated["agents"].items()}, stopped_bounds)
        elif any(money(body["cap"]) != 1 for body in updated["agents"].values()):
            raise DomainError("Mode 1 has no portfolio weight controls")
        for body in updated["agents"].values():
            if not isinstance(body["paused"], bool) or not 0 <= money(body["k"]) <= Decimal(".25") or not 0 <= money(body["max_token_pct"]) <= Decimal(".85"):
                raise DomainError("Policy cannot exceed hard-coded token exposure or conviction limits")
            for key in ("cap", "k", "max_token_pct", "base"):
                body[key] = str(money(body[key]))
        if not Decimal(".05") <= money(updated["max_step"]) <= Decimal(".20"):
            raise DomainError("Maximum step must be between 5 and 20 percentage points")
        if isinstance(updated["slippage_bps"], bool) or not isinstance(updated["slippage_bps"], int) or not 0 < updated["slippage_bps"] <= 100:
            raise DomainError("Slippage must be an integer between 1 and 100 bps")
        if updated["risk"] not in ("conservative", "balanced"):
            raise DomainError("Unknown risk profile")
    except (AllocationBlocked, ArithmeticError, KeyError, TypeError, ValueError) as error:
        raise DomainError(str(error)) from error
    return updated


def confirm(database, settings, expected_version: int, changes: dict, clock=utcnow) -> dict:
    with database.transaction() as session:
        controls = session.get(Controls, 1, with_for_update=True)
        if controls is None:
            raise DomainError("Controls are unavailable", 503)
        state = policy_state(session)
        if expected_version != state["latest_version"]:
            raise DomainError("Policy changed since this proposal; review the latest version", 409)
        latest = state["pending"] or state["active"]
        books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState))}
        total = sum(book.equity for book in books.values())
        stops = controls.state.get("stops", {})
        stopped_bounds = {name: books[name].equity / total for name, stop in stops.items() if stop.get("stopped") and name in books} if total > 0 else {}
        body = build_policy(latest["body"], changes, settings.agent_ids, settings.fund_mode, stopped_bounds)
        pending = Policy(version=expected_version + 1, hash=canonical_hash(body), body=body, status="pending", activation_boundary=next_boundary(clock(), settings.allocation_seconds))
        for row in session.scalars(select(Policy).where(Policy.status == "pending")):
            row.status = "superseded"
        session.add(pending)
        append_event(session, "policy_confirmed", {"version": pending.version, "hash": pending.hash, "changes": changes, "status": "pending", "activation_boundary": iso(pending.activation_boundary)})
        return public_policy(pending)


def activate_pending(session, now: datetime) -> Policy:
    session.get(Controls, 1, with_for_update=True)
    active = session.scalar(select(Policy).where(Policy.status == "active"))
    unresolved = session.scalar(select(AllocationRound.id).where(AllocationRound.state.in_(("planned", "executing", "partial"))))
    pending = session.scalar(select(Policy).where(Policy.status == "pending").order_by(Policy.version.desc()))
    if pending and not unresolved:
        boundary = pending.activation_boundary
        if boundary.tzinfo is None:
            boundary = boundary.replace(tzinfo=timezone.utc)
        if now >= boundary:
            if active:
                active.status = "superseded"
            pending.status = "active"
            append_event(session, "policy_activated", {"version": pending.version, "hash": pending.hash})
            active = pending
    if not active:
        raise DomainError("Active policy is missing", 503)
    return active