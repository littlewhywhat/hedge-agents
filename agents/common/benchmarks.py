from datetime import timezone
from decimal import Decimal

from sqlalchemy import select

from agents.common.accounting import Book
from agents.common.config import MARKETS
from agents.common.models import Benchmark, BookState, Price, RuntimeState, utcnow


def mark(session, owner, at):
    row = session.scalar(select(Price).where(Price.mint == MARKETS[owner]["mint"], Price.sampled_at <= at).order_by(Price.sampled_at.desc()).limit(1))
    if not row:
        return None
    stamp = row.sampled_at.replace(tzinfo=timezone.utc) if row.sampled_at.tzinfo is None else row.sampled_at
    if not 0 <= (at - stamp).total_seconds() <= 120:
        return None
    return Decimal(row.usd) * Decimal(row.multiplier)


def navs(session):
    return {row.agent_id: Book.from_json(row.body).nav for row in session.scalars(select(BookState))}


def lot_value(session, lot, at):
    if lot.get("status") != "ready":
        return None
    if lot["kind"] == "buy_hold":
        if Decimal(lot["units"]) == 0:
            return Decimal(0)
        price = mark(session, lot["agent_id"], at)
        return Decimal(lot["units"]) * price if price is not None else None
    current = navs(session)
    total = Decimal(0)
    for name, units in lot.get("shadow_units", {}).items():
        if Decimal(units) == 0:
            continue
        if current.get(name) is None:
            return None
        total += Decimal(units) * current[name]
    return total


def record_flow(session, owner, operation, amount, proof, fund_equity_before, at):
    if operation not in ("contribution", "distribution"):
        return
    rows = list(session.scalars(select(BookState)))
    if operation == "contribution":
        if len(rows) == 1:
            price = mark(session, owner, at)
            body = {"kind": "buy_hold", "agent_id": owner, "flow_usd": str(amount), "at": at.isoformat(), "units": str(amount / price) if price else "0", "status": "ready" if price else "pending_mark", "distributions": "0"}
        else:
            runtime = session.get(RuntimeState, 1)
            weights = runtime.body.get("initial_weights") if runtime else None
            current = navs(session)
            ready = weights and all(current.get(name) and current[name] > 0 for name in weights)
            body = {"kind": "shadow", "flow_usd": str(amount), "at": at.isoformat(), "shadow_units": {name: str(amount * Decimal(weight) / current[name]) for name, weight in weights.items()} if ready else {}, "status": "ready" if ready else "awaiting_initial_split", "distributions": "0"}
        session.add(Benchmark(kind=body["kind"], proof=proof, body=body))
    else:
        fraction = amount / fund_equity_before if fund_equity_before > 0 else Decimal(0)
        for row in session.scalars(select(Benchmark).with_for_update()):
            body = dict(row.body)
            value = lot_value(session, body, at)
            if value is None:
                body["status"] = "pending_redemption_mark"
                body["unpriced_redemption_fraction"] = str(fraction)
            else:
                body["distributions"] = str(Decimal(body.get("distributions", "0")) + value * fraction)
            if body["kind"] == "buy_hold":
                body["units"] = str(Decimal(body["units"]) * (1 - fraction))
            else:
                body["shadow_units"] = {name: str(Decimal(units) * (1 - fraction)) for name, units in body.get("shadow_units", {}).items()}
            row.body = body


def initialize_shadow(session, weights):
    runtime = session.get(RuntimeState, 1, with_for_update=True)
    runtime.body = {**runtime.body, "initial_weights": {name: str(weight) for name, weight in weights.items()}}
    current = navs(session)
    for row in session.scalars(select(Benchmark).where(Benchmark.kind == "shadow").with_for_update()):
        if row.body.get("status") != "awaiting_initial_split":
            continue
        amount = Decimal(row.body["flow_usd"])
        row.body = {**row.body, "status": "ready", "shadow_units": {name: str(amount * weight / (current.get(name) or Decimal(1))) for name, weight in weights.items()}}


def summary(session, at=None):
    at = at or utcnow()
    rows = list(session.scalars(select(Benchmark)))
    if not rows:
        return {"status": "unfunded", "equity": None, "distributions": "0", "kind": None}
    values = [lot_value(session, row.body, at) for row in rows]
    distributions = sum(Decimal(row.body.get("distributions", "0")) for row in rows)
    return {"status": "pending" if any(value is None for value in values) else "ready", "equity": str(sum(values)) if all(value is not None for value in values) else None, "distributions": str(distributions), "kind": rows[0].kind, "approximation": "Fixed shadow ownership in actual sleeve NAV, fills and costs" if rows[0].kind == "shadow" else "Hypothetical token lots; no agent fees"}