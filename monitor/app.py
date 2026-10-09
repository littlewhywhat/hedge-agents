from contextlib import asynccontextmanager
from decimal import Decimal
import re

from fastapi import Depends, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from sqlalchemy import select

from agents.common.accounting import Book
from agents.common.auth import operator_auth
from agents.common.config import MARKETS, Settings, get_settings
from agents.common.db import Database, append_event, iso, verify_events
from agents.common.errors import DomainError
from agents.common.models import Agent, AllocationRound, AuditHead, BookState, ChatMessage, Controls, Decision, Event, GateEvidence, Intent, MasumiJob, ReplayFrame, ReplayHeadline, ReplayTrade, ValueSnapshot, Wallet, utcnow
from agents.gateway.settlement import SettlementService, aware, public_intent
from monitor.policy import build_policy, confirm, policy_state


REQUIRED_GATES = ("offline_acceptance", "preprod_registry", "preprod_escrow", "preprod_x402", "devnet_transfer", "adapter_recovery", "mainnet_qualification")


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KillSwitchInput(InputModel):
    enabled: StrictBool
    reason: str = Field(default="Operator control", max_length=500)


class PolicyInput(InputModel):
    expected_version: int = Field(ge=1)
    changes: dict


class ChatInput(InputModel):
    message: str = Field(min_length=1, max_length=2000)


class ArmInput(InputModel):
    confirmation: str


class OperationInput(InputModel):
    agent_id: str
    amount_raw: StrictInt = Field(gt=0, le=1_000_000_000)
    request_id: str = Field(min_length=14, max_length=128)
    confirmation: str


def fund_summary(session, settings):
    books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState))}
    equity = sum((book.equity for book in books.values()), Decimal(0))
    contributions = sum((book.contributions for book in books.values()), Decimal(0))
    distributions = sum((book.distributions for book in books.values()), Decimal(0))
    fees = {kind: str(sum((book.costs[kind] for book in books.values()), Decimal(0))) for kind in ("execution", "network", "service", "impairment")}
    snapshots = {}
    for agent in settings.agent_ids:
        row = session.scalar(select(ValueSnapshot).where(ValueSnapshot.agent_id == agent).order_by(ValueSnapshot.sampled_at.desc()).limit(1))
        snapshots[agent] = row
    fresh = bool(contributions) and all(row is not None and row.valid and 0 <= (utcnow() - aware(row.sampled_at)).total_seconds() <= 120 for name, row in snapshots.items() if books[name].units > 0)
    controls = session.get(Controls, 1)
    pending = session.scalar(select(Intent.id).where(Intent.state.in_(("awaiting_inbound", "inbound_confirmed", "payout_pending", "refund_pending", "manual_review"))))
    return {"environment": settings.environment, "mode": settings.fund_mode, "currency": "USD" if settings.environment == "mainnet" else "test USD", "equity": str(equity), "contributions": str(contributions), "distributions": str(distributions), "net_pnl": str(equity - contributions + distributions), "gross_pnl": str(equity - contributions + distributions + sum(Decimal(value) for value in fees.values())), "fees": fees, "principal_receivable": str(sum(book.assets["receivable"] for book in books.values())), "fee_prepayment": str(sum(book.assets["prepaid"] for book in books.values())), "expense_payable": str(sum(book.payable for book in books.values())), "data_status": "unfunded" if not contributions else ("reconciling" if pending else ("reconciled" if fresh else "stale")), "kill_switch": controls.kill_switch if controls else True, "armed": controls.armed if controls else False, "control_reason": controls.reason if controls else "Controls unavailable", "updated_at": iso(max(row.sampled_at for row in snapshots.values() if row)) if any(snapshots.values()) else None}


def create_app(settings: Settings | None = None, database: Database | None = None) -> FastAPI:
    settings = settings or get_settings()
    owns_database = database is None
    database = database or Database(settings.database_url)

    @asynccontextmanager
    async def lifespan(app):
        with database.transaction() as session:
            if session.get(Controls, 1) is None:
                raise RuntimeError("Database is not initialized; run infra.manage init-db")
        yield
        if owns_database:
            database.engine.dispose()

    app = FastAPI(title="HedgeAgents Monitor", version="0.1.0", lifespan=lifespan)
    app.state.database, app.state.settings = database, settings
    app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
    authorize = operator_auth(settings)
    settlement = SettlementService(database, settings)

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, error: DomainError):
        return JSONResponse({"detail": str(error)}, status_code=error.status)

    @app.get("/health")
    def health():
        with database.transaction() as session:
            ready = session.get(Controls, 1) is not None
        return {"status": "ok" if ready else "not_initialized", "environment": settings.environment, "signing_keys": False}

    @app.get("/fund")
    def fund():
        from agents.common.benchmarks import summary
        with database.transaction() as session:
            return {**fund_summary(session, settings), "benchmark": summary(session)}

    @app.get("/agents")
    def agents():
        with database.transaction() as session:
            controls = session.get(Controls, 1)
            books = {row.agent_id: Book.from_json(row.body) for row in session.scalars(select(BookState))}
            total = sum(book.equity for book in books.values())
            rows = []
            for agent in session.scalars(select(Agent).where(Agent.id != "gateway").order_by(Agent.id)):
                book = books[agent.id]
                wallets = list(session.scalars(select(Wallet).where(Wallet.agent_id == agent.id)))
                rows.append({"id": agent.id, **MARKETS[agent.id], "registry_id": agent.registry_id, "equity": str(book.equity), "net_pnl": str(book.net_pnl), "units": str(book.units), "nav": str(book.nav) if book.nav is not None else None, "weight": str(book.equity / total) if total > 0 else "0", "assets": {key: str(value) for key, value in book.assets.items()}, "stop": controls.state.get("stops", {}).get(agent.id, {}) if controls else {}, "wallets": [{"id": wallet.id, "role": wallet.role, "chain": wallet.chain, "address": wallet.address} for wallet in wallets]})
            return rows

    @app.get("/snapshots")
    def snapshots(limit: int = Query(600, ge=1, le=5000)):
        with database.transaction() as session:
            rows = list(session.scalars(select(ValueSnapshot).order_by(ValueSnapshot.sampled_at.desc()).limit(limit)))
            return [{"id": row.id, "agent_id": row.agent_id, "time": iso(row.sampled_at), "valid": row.valid, **row.body} for row in reversed(rows)]

    @app.get("/events")
    def events(limit: int = Query(100, ge=1, le=500), before: int | None = None):
        with database.transaction() as session:
            statement = select(Event).order_by(Event.id.desc()).limit(limit)
            if before:
                statement = statement.where(Event.id < before)
            rows = list(session.scalars(statement))
            return [{"id": row.id, "time": row.time, "kind": row.kind, "payload": row.payload, "prev_hash": row.prev_hash, "hash": row.hash} for row in rows]

    @app.get("/audit/verify")
    def verify_audit():
        with database.transaction() as session:
            result = verify_events(list(session.scalars(select(Event).order_by(Event.id))))
            head = session.get(AuditHead, 1)
            result["valid"] = result["valid"] and head is not None and result["head"] == head.hash
            anchors = list(session.scalars(select(MasumiJob).where(MasumiJob.audit_head.is_not(None))))
            result["anchors"] = [{"job_id": job.id, "head": job.audit_head, "result_hash": job.result_hash, "state": job.state, "blockchain_identifier": job.blockchain_identifier} for job in anchors]
            return result

    @app.get("/rounds")
    def rounds():
        with database.transaction() as session:
            return [{"id": row.id, "time": iso(row.started_at), "policy_version": row.policy_version, "state": row.state, "weights_before": row.weights_before, "target_weights": row.target_weights, "settled_weights": row.settled_weights, "scores": row.scores, "objections": row.objections, "legs": row.legs, "reason": row.reason} for row in session.scalars(select(AllocationRound).order_by(AllocationRound.started_at.desc()).limit(100))]

    @app.get("/decisions")
    def decisions():
        with database.transaction() as session:
            return [{"id": row.id, "agent_id": row.agent_id, "time": iso(row.time), "status": row.status, **row.body} for row in session.scalars(select(Decision).order_by(Decision.time.desc()).limit(100))]

    @app.get("/transfers")
    def transfers():
        with database.transaction() as session:
            return [public_intent(row) for row in session.scalars(select(Intent).order_by(Intent.created_at.desc()).limit(100))]

    @app.get("/inventory")
    def inventory():
        return settlement.availability()

    @app.get("/policy")
    def policy():
        with database.transaction() as session:
            return policy_state(session)

    @app.get("/readiness")
    def readiness():
        with database.transaction() as session:
            evidence = {row.id: row for row in session.scalars(select(GateEvidence))}
            return {"environment": settings.environment, "gates": [{"id": gate, "passed": bool(evidence.get(gate) and evidence[gate].passed), "evidence": evidence[gate].evidence if gate in evidence else None} for gate in REQUIRED_GATES], "configuration": {"jupiter": bool(settings.jupiter_api_key.get_secret_value()), "blockfrost": bool(settings.blockfrost_project_id.get_secret_value()), "payment_service": bool(settings.payment_read_key.get_secret_value()), "llm": bool(settings.llm_api_key.get_secret_value()), "wallets": len(list(session.scalars(select(Wallet.id)))), "xstocks_eligible": settings.xstocks_eligible}}

    @app.post("/kill-switch", dependencies=[Depends(authorize)])
    def kill_switch(body: KillSwitchInput):
        with database.transaction() as session:
            controls = session.get(Controls, 1, with_for_update=True)
            if controls is None:
                raise DomainError("Controls unavailable", 503)
            controls.kill_switch, controls.reason, controls.updated_at = body.enabled, body.reason, utcnow()
            if body.enabled:
                controls.armed = False
            append_event(session, "kill_switch_changed", {"enabled": body.enabled, "reason": body.reason, "by": "operator"})
        return {"enabled": body.enabled, "armed": False if body.enabled else controls.armed}

    @app.post("/operator/session", dependencies=[Depends(authorize)])
    def operator_session():
        return {"role": "operator"}

    @app.post("/operations/{kind}", dependencies=[Depends(authorize)])
    def operation(kind: str, body: OperationInput):
        from runtime.allocation import request_operation
        if body.confirmation != ("CASH OUT" if kind == "cashout" else "DEPLOY"):
            raise DomainError("Explicit operation confirmation is required")
        return request_operation(database, settings, kind, body.agent_id, body.amount_raw, body.request_id)

    @app.post("/qualification/{kind}", dependencies=[Depends(authorize)])
    def authorize_qualification(kind: str, body: OperationInput):
        from runtime.allocation import request_operation
        if kind not in ("deploy", "cashout") or body.amount_raw > settings.qualification_max_usd * 1_000_000 or body.confirmation != f"QUALIFY {settings.environment.upper()}":
            raise DomainError("Qualification requires explicit environment consent and at most five dollars")
        result = request_operation(database, settings, kind, body.agent_id, body.amount_raw, body.request_id, qualification=True)
        return {**result, "normal_automation": False}

    @app.post("/arm", dependencies=[Depends(authorize)])
    def arm(body: ArmInput):
        with database.transaction() as session:
            controls = session.get(Controls, 1, with_for_update=True)
            required = REQUIRED_GATES if settings.environment == "mainnet" else REQUIRED_GATES[:-1]
            passed = {row.id for row in session.scalars(select(GateEvidence).where(GateEvidence.passed.is_(True)))}
            missing = set(required) - passed
            if missing or not controls or controls.kill_switch or body.confirmation != f"ARM {settings.environment.upper()}":
                raise DomainError("Arming blocked: " + (", ".join(sorted(missing)) or "clear the halt and provide explicit environment confirmation"), 409)
            controls.armed = True
            append_event(session, "automation_armed", {"environment": settings.environment})
        return {"armed": True}

    @app.post("/policy/confirm", dependencies=[Depends(authorize)])
    def confirm_policy(body: PolicyInput):
        return confirm(database, settings, body.expected_version, body.changes)

    @app.get("/chat")
    def chat_history():
        with database.transaction() as session:
            return [{"id": row.id, "role": row.role, "text": row.text, **row.data} for row in session.scalars(select(ChatMessage).order_by(ChatMessage.time).limit(200))]

    @app.post("/chat", dependencies=[Depends(authorize)])
    def chat(body: ChatInput):
        with database.transaction() as session:
            state = policy_state(session)
            latest = state["pending"] or state["active"]
            text = body.message.strip()
            changes = None
            aliases = {"bitcoin": "btc", "btc": "btc", "ethereum": "eth", "eth": "eth", "stocks": "stocks", "stock": "stocks", "spy": "stocks", "s&p": "stocks", "gold": "gold"}
            cap = re.search(r"\bcap\s+(bitcoin|btc|ethereum|eth|stocks?|spy|s&p|gold)\s+(?:at|to)\s+(\d+(?:\.\d+)?)\s*%", text, re.I)
            pause = re.fullmatch(r"\s*(pause|resume)\s+(bitcoin|btc|ethereum|eth|stocks?|spy|s&p|gold)\s*", text, re.I)
            if cap:
                changes = {"agents": {aliases[cap[1].lower()]: {"cap": str(Decimal(cap[2]) / 100)}}}
            elif pause:
                changes = {"agents": {aliases[pause[2].lower()]: {"paused": pause[1].lower() == "pause"}}}
            elif re.search(r"\b(lower risk|conservative)\b", text, re.I):
                changes = {"risk": "conservative", "agents": {name: {"k": ".10", "max_token_pct": ".60"} for name in settings.agent_ids}}
            summary = fund_summary(session, settings)
            citations = ["books:" + name for name in settings.agent_ids] + ["policy:" + str(state["latest_version"])]
            if changes is not None:
                after = build_policy(latest["body"], changes, settings.agent_ids, settings.fund_mode)
                answer = "Policy proposal ready. Confirmation queues it for the next runtime boundary; settlement remains separate."
                data = {"proposal": {"changes": changes, "expected_version": state["latest_version"], "before": latest["body"], "after": after}, "citations": citations}
            elif re.search(r"\b(fees?|costs?)\b", text, re.I):
                answer = f"Recognized costs: execution {summary['fees']['execution']}, network {summary['fees']['network']}, service {summary['fees']['service']} {summary['currency']}. Outstanding expense payable: {summary['expense_payable']}."
                data = {"citations": citations}
            elif re.search(r"\b(profit|performance|value|fund|status|balance)\b", text, re.I):
                answer = f"The {settings.environment} fund has {summary['equity']} {summary['currency']} of equity and {summary['net_pnl']} net PnL. Data status: {summary['data_status']}. Automation is {'armed' if summary['armed'] else 'not armed'}."
                data = {"citations": citations}
            else:
                answer = f"Active policy is version {state['active']['version']}. The latest confirmed version is {state['latest_version']}. I can report fund value and fees, or propose an agent cap, pause, resume, or lower-risk policy. No transaction is authorized by this response."
                data = {"citations": citations}
            session.add(ChatMessage(role="operator", text=text, data={}))
            reply = ChatMessage(role="assistant", text=answer, data=data)
            session.add(reply)
            session.flush()
            return {"id": reply.id, "role": "assistant", "text": answer, **data}

    @app.post("/inventory/refresh", dependencies=[Depends(authorize)])
    async def refresh_inventory():
        from monitor.sampler import Sampler
        return await Sampler(database, settings).refresh_inventory()

    @app.get("/replay/frames")
    def replay_frames():
        with database.transaction() as session:
            return [{"id": row.id, "time": row.time, **row.body} for row in session.scalars(select(ReplayFrame).order_by(ReplayFrame.id))]

    @app.get("/replay/trades")
    def replay_trades():
        with database.transaction() as session:
            return [{"id": row.id, "frame_id": row.frame_id, "time": row.time, **row.body} for row in session.scalars(select(ReplayTrade).order_by(ReplayTrade.id))]

    @app.get("/replay/headlines")
    def replay_headlines():
        with database.transaction() as session:
            return [{"id": row.id, "frame_id": row.frame_id, **row.body} for row in session.scalars(select(ReplayHeadline).order_by(ReplayHeadline.id))]

    return app


app = create_app()