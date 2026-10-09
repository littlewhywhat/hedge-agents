from copy import deepcopy
from decimal import Decimal, ROUND_DOWN

from sqlalchemy import select

from agents.common.accounting import Book
from agents.common.allocation import AllocationBlocked, allocate
from agents.common.db import append_event
from agents.common.errors import DomainError
from agents.common.models import AllocationRound, BookState, Controls, RuntimeState, ValueSnapshot, new_id, utcnow
from agents.common.safety import performance_score
from agents.gateway.settlement import aware
from monitor.policy import activate_pending


def raw_down(usd: Decimal) -> int:
    return int((usd * 1_000_000).to_integral_value(rounding=ROUND_DOWN))


def ordered_legs(books: dict[str, Book], targets: dict[str, Decimal], initial=False) -> list[dict]:
    total = sum(book.equity for book in books.values())
    differences = {name: targets[name] * total - book.equity for name, book in books.items()}
    senders = [[name, -amount] for name, amount in sorted(differences.items()) if amount < -Decimal(".000001")]
    receivers = [[name, amount] for name, amount in sorted(differences.items()) if amount > Decimal(".000001")]
    capital = {name: book.assets["capital"] for name, book in books.items()}
    legs = []
    needs_deployment = set(books) if initial else set()
    def add(kind, agent, amount, **extra):
        raw = raw_down(amount)
        if raw <= 0:
            return
        legs.append({"id": new_id(), "kind": kind, "agent": agent, "amount_raw": str(raw), "state": "planned", "attempt_id": None, "intent_id": None, **extra})
    for sender in senders:
        for receiver in receivers:
            amount = min(sender[1], receiver[1])
            if amount < Decimal(".000001"):
                continue
            deficit = max(Decimal(0), amount - capital[sender[0]])
            if deficit:
                if books[sender[0]].assets["usdc"] < deficit:
                    add("raise_cash", sender[0], deficit)
                add("gateway_withdraw", sender[0], deficit)
                capital[sender[0]] += deficit
                needs_deployment.add(receiver[0])
            add("x402", sender[0], amount, sender=sender[0], receiver=receiver[0])
            capital[sender[0]] -= amount
            capital[receiver[0]] += amount
            sender[1] -= amount
            receiver[1] -= amount
    for name in sorted(needs_deployment):
        amount = max(Decimal(0), capital[name] - targets[name] * total * Decimal(".15"))
        if amount >= 1:
            add("gateway_deposit", name, min(amount, Decimal(200)))
            add("buy_target", name, Decimal(0))
            if legs and legs[-1]["kind"] == "gateway_deposit":
                legs.append({"id": new_id(), "kind": "buy_target", "agent": name, "amount_raw": "0", "state": "planned", "attempt_id": None, "intent_id": None})
    return legs


def request_operation(database, settings, kind, agent_id, amount_raw, request_id, qualification=False):
    if kind not in ("deploy", "cashout") or agent_id not in settings.agent_ids or isinstance(amount_raw, bool) or not isinstance(amount_raw, int) or amount_raw <= 0:
        raise DomainError("Invalid operator operation")
    request = {"kind": kind, "agent_id": agent_id, "amount_raw": str(amount_raw), "qualification": qualification}
    with database.transaction() as session:
        session.get(RuntimeState, 1, with_for_update=True)
        controls = session.get(Controls, 1, with_for_update=True)
        if qualification:
            from agents.common.models import GateEvidence
            required = {"offline_acceptance"} if settings.environment == "preprod" else {"offline_acceptance", "preprod_registry", "preprod_escrow", "preprod_x402", "devnet_transfer", "adapter_recovery"}
            passed = set(session.scalars(select(GateEvidence.id).where(GateEvidence.passed.is_(True))))
            if not controls or controls.kill_switch or not required <= passed or amount_raw > settings.qualification_max_usd * 1_000_000:
                raise DomainError("Earlier acceptance gates must pass, budget must be bounded, and the halt must be cleared separately", 409)
        existing = session.get(AllocationRound, request_id)
        if existing:
            if not existing.legs or existing.legs[0].get("operator_request") != request:
                raise DomainError("Operation request id already has different terms", 409)
            return {"id": existing.id, "state": existing.state}
        if session.scalar(select(AllocationRound.id).where(AllocationRound.state.in_(("planned", "executing", "partial")))):
            raise DomainError("Resolve the current operation before admitting another", 409)
        books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState))}
        book = books[agent_id]
        amount = Decimal(amount_raw) / 1_000_000
        if kind == "deploy" and amount > book.assets["capital"]:
            raise DomainError("Deployment exceeds available Cardano principal")
        if kind == "cashout" and amount > book.equity - book.assets["prepaid"] - book.assets["receivable"] - Decimal(1):
            raise DomainError("Cash-out must leave one dollar of reserve and cannot spend claims or prepayments")
        from agents.common.models import Policy, Wallet
        if kind == "cashout" and not session.scalar(select(Wallet.id).where(Wallet.agent_id == "operator", Wallet.role == "distribution", Wallet.chain == "cardano")):
            raise DomainError("Register the operator's Cardano distribution address first")
        policy = session.scalar(select(Policy).where(Policy.status == "active"))
        total = sum(value.equity for value in books.values())
        if total <= 0:
            raise DomainError("Fund has no contributed principal")
        weights = {name: str(value.equity / total) for name, value in books.items()}
        legs = []
        def add(leg_kind, raw):
            legs.append({"id": new_id(), "kind": leg_kind, "agent": agent_id, "amount_raw": str(raw), "state": "planned", "attempt_id": None, "intent_id": None, "operator_request": request})
        if kind == "deploy":
            remaining = amount_raw
            while remaining:
                clip = min(remaining, settings.gateway_per_job_usd * 1_000_000)
                add("gateway_deposit", clip)
                remaining -= clip
            add("buy_target", 0)
        else:
            missing = max(Decimal(0), amount - book.assets["capital"])
            if book.assets["usdc"] < missing:
                add("raise_cash", raw_down(missing))
            remaining = raw_down(missing)
            while remaining:
                clip = min(remaining, settings.gateway_per_job_usd * 1_000_000)
                add("gateway_withdraw", clip)
                remaining -= clip
            add("cashout", amount_raw)
        round = AllocationRound(id=request_id, state="planned", policy_version=policy.version, weights_before=weights, target_weights=weights, snapshot_ids=[], scores={}, legs=legs, reason="operator_" + kind)
        session.add(round)
        if qualification:
            from datetime import timedelta
            from agents.common.db import iso
            controls.armed = False
            controls.state = {**controls.state, "qualification": {"state": "authorized", "round_id": round.id, "agent_id": agent_id, "budget_raw": str(amount_raw), "environment": settings.environment, "expires_at": iso(utcnow() + timedelta(hours=1))}}
            append_event(session, "qualification_authorized", {"round_id": round.id, "environment": settings.environment, "budget_raw": str(amount_raw), "normal_automation": False})
        append_event(session, "operator_operation_planned", {"round_id": round.id, **request})
        return {"id": round.id, "state": "planned", "signing": "requires active controls and acceptance gates"}


class AllocationRuntime:
    def __init__(self, database, settings, clock=utcnow):
        self.database, self.settings, self.clock = database, settings, clock

    def plan(self):
        with self.database.transaction() as session:
            runtime = session.get(RuntimeState, 1, with_for_update=True)
            previous = session.scalar(select(AllocationRound).where(AllocationRound.state.in_(("planned", "executing", "partial"))).order_by(AllocationRound.started_at))
            if previous:
                return previous.id
            policy = activate_pending(session, self.clock())
            controls = session.get(Controls, 1)
            if not controls or controls.kill_switch or not controls.armed or self.settings.fund_mode == 1:
                return None
            books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState).order_by(BookState.agent_id))}
            total = sum(book.equity for book in books.values())
            if total <= 0:
                return None
            weights = {name: book.equity / total for name, book in books.items()}
            snapshots, scores = {}, {}
            reason = ""
            initial = not runtime.body.get("initial_deployment_complete", False)
            stopped = {name for name, stop in controls.state.get("stops", {}).items() if stop.get("stopped")}
            try:
                for name in books:
                    snapshot = session.scalar(select(ValueSnapshot).where(ValueSnapshot.agent_id == name).order_by(ValueSnapshot.sampled_at.desc()).limit(1))
                    if not snapshot or not snapshot.valid or not 0 <= (self.clock() - aware(snapshot.sampled_at)).total_seconds() <= 120:
                        raise DomainError("Missing fresh reconciled allocation snapshot", 409)
                    snapshots[name] = snapshot.id
                hard_repair = any(weights[name] < Decimal(".1") or weights[name] > Decimal(policy.body["agents"][name]["cap"]) for name in books)
                for name in books:
                    if initial or hard_repair:
                        scores[name] = Decimal(0)
                    else:
                        history = list(session.scalars(select(ValueSnapshot).where(ValueSnapshot.agent_id == name, ValueSnapshot.valid.is_(True)).order_by(ValueSnapshot.sampled_at.desc()).limit(1441)))
                        samples = [(aware(row.sampled_at), Decimal(row.body["nav"])) for row in history if row.body.get("nav") is not None]
                        scores[name] = performance_score(samples, self.clock())
                previous_completed = session.scalar(select(AllocationRound).where(AllocationRound.state == "settled").order_by(AllocationRound.started_at.desc()).limit(1))
                cooldown = {name for name in books if previous_completed and Decimal(previous_completed.target_weights[name]) < Decimal(previous_completed.weights_before[name]) - Decimal("1e-9")}
                result = allocate(weights, scores, {name: policy.body["agents"][name]["cap"] for name in books}, initial=initial, stopped=stopped, paused={name for name in books if policy.body["agents"][name]["paused"]}, cooldown=cooldown, max_step=Decimal(policy.body["max_step"]))
                targets = result.weights
                if initial:
                    from agents.common.benchmarks import initialize_shadow
                    initialize_shadow(session, targets)
                legs = ordered_legs(books, targets, initial)
                state = "planned" if legs else "settled"
                reason = "initial" if initial else result.kind + ": " + result.reason
                for override in result.overrides:
                    append_event(session, "ClampEvent", override)
            except (DomainError, AllocationBlocked) as error:
                targets, legs, state, reason = {}, [], "blocked", str(error)
                controls.state = {**controls.state, "allocation_blocked": reason}
            round = AllocationRound(policy_version=policy.version, started_at=self.clock(), state=state, weights_before={name: str(value) for name, value in weights.items()}, target_weights={name: str(value) for name, value in targets.items()}, settled_weights={name: str(value) for name, value in weights.items()} if state == "settled" else None, snapshot_ids=list(snapshots.values()), scores={name: str(value) for name, value in scores.items()}, legs=legs, objections=[], reason=reason)
            session.add(round)
            session.flush()
            if state != "blocked":
                controls.state = {**controls.state, "allocation_blocked": None}
            if state == "settled" and initial:
                runtime.body = {**runtime.body, "initial_deployment_complete": True}
            policy.applied_round_id = round.id
            append_event(session, "allocation_planned" if state == "planned" else "allocation_" + state, {"round_id": round.id, "policy_version": policy.version, "state": state, "target_weights": round.target_weights, "settled_weights": round.settled_weights, "reason": reason})
            return round.id

    async def advance(self, round_id: str, execute):
        with self.database.transaction() as session:
            session.get(RuntimeState, 1, with_for_update=True)
            round = session.get(AllocationRound, round_id, with_for_update=True)
            if not round or round.state in ("settled", "blocked"):
                return round.state if round else "missing"
            index = next((index for index, leg in enumerate(round.legs) if leg["state"] != "settled"), None)
            if index is None:
                books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState))}
                total = sum(book.equity for book in books.values())
                if total <= 0:
                    raise DomainError("Cannot settle a round with nonpositive equity")
                round.settled_weights = {name: str(book.equity / total) for name, book in books.items()}
                round.state = "settled"
                runtime = session.get(RuntimeState, 1)
                if round.reason == "initial":
                    runtime.body = {**runtime.body, "initial_deployment_complete": True}
                append_event(session, "allocation_settled", {"round_id": round.id, "target_weights": round.target_weights, "settled_weights": round.settled_weights})
                return "settled"
            leg = deepcopy(round.legs[index])
            policy_version = round.policy_version
            round.state = "executing"
        try:
            result = await execute(round_id, leg, policy_version)
        except Exception:
            result = {"state": "pending", "reason": "Leg adapter unavailable; original operation must be reconciled"}
        with self.database.transaction() as session:
            round = session.get(AllocationRound, round_id, with_for_update=True)
            legs = deepcopy(round.legs)
            if legs[index]["state"] == "settled":
                return round.state
            for key in ("attempt_id", "intent_id", "tx_id", "reason"):
                if result.get(key) is not None:
                    legs[index][key] = result[key]
            legs[index]["state"] = "settled" if result.get("state") == "settled" else "pending"
            round.legs = legs
            round.state = "executing" if legs[index]["state"] == "settled" else "partial"
            append_event(session, "allocation_leg_progress", {"round_id": round.id, "leg_id": leg["id"], "state": legs[index]["state"], "tx_id": result.get("tx_id")})
            return round.state