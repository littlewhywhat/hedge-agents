import asyncio
from contextlib import asynccontextmanager
from decimal import Decimal

from fastapi import Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from agents.common.accounting import Book
from agents.common.auth import service_auth
from agents.common.db import Database
from agents.common.errors import DomainError
from agents.common.mip import make_agent_app, sync_job_states
from agents.common.models import AuditHead, BookState, ChainAttempt, Decision, MasumiJob, Wallet
from agents.common.solana_signer import SignerSettings, signing_gate
from agents.trader.service import TraderService


class TickInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy_version: int = Field(ge=1)


class LegInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    round_id: str
    leg_id: str


class AnchorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100)


def create_app(settings=None, database=None):
    settings = settings or SignerSettings()
    database = database or Database(settings.database_url)
    service = TraderService(database, settings)
    app = make_agent_app(database, settings, service.jobs)
    runtime_only = service_auth(settings, {"runtime"})

    @app.post("/tick")
    async def tick(body: TickInput, caller=Depends(runtime_only)):
        return await service.engine.tick(body.policy_version)

    @app.post("/capital/transfer")
    async def capital(body: LegInput, caller=Depends(runtime_only)):
        return await service.capital_transfer(body.round_id, body.leg_id)

    @app.post("/gateway-transfer")
    async def gateway_transfer(body: LegInput, caller=Depends(runtime_only)):
        return await service.gateway_transfer(body.round_id, body.leg_id)

    @app.post("/cash-target")
    async def cash_target(body: LegInput, caller=Depends(runtime_only)):
        leg, version = service.get_leg(body.round_id, body.leg_id)
        if leg["kind"] != "raise_cash":
            raise DomainError("Leg is not a deterministic cash target")
        target = Decimal(leg["amount_raw"]) / 1_000_000
        with database.transaction() as session:
            book = Book.from_json(session.get(BookState, settings.agent_id).body)
            if book.assets["usdc"] >= target:
                return {"state": "settled"}
        result = await service.operation_engine(body.round_id).tick(version, cash_target_usd=target)
        return {"state": "pending", "decision": result}

    @app.post("/buy-target")
    async def buy_target(body: LegInput, caller=Depends(runtime_only)):
        leg, version = service.get_leg(body.round_id, body.leg_id)
        if leg["kind"] != "buy_target":
            raise DomainError("Leg is not a token target")
        result = await service.operation_engine(body.round_id).tick(version)
        state = "settled" if result.get("status") in ("held", "blocked") or result.get("state") == "confirmed" else "pending"
        return {"state": state, "reason": result.get("reasoning") or result.get("reason"), "decision": result}

    @app.post("/objection")
    async def objection(body: TickInput, caller=Depends(runtime_only)):
        view = await service.read_view()
        rule = "kill_switch" if view.kill_switch else ("daily_stop" if view.stopped else None)
        return {"agent": settings.agent_id, "type": "rule_breach" if rule else "comment", "rule": rule, "text": "Local safety state requires review" if rule else "No locally verified rule breach"}

    @app.post("/anchor")
    async def anchor(body: AnchorInput, caller=Depends(runtime_only)):
        with database.transaction() as session:
            signing_gate(session, settings)
            purchasing = session.scalar(select(Wallet).where(Wallet.agent_id == settings.agent_id, Wallet.role == "purchasing"))
            if not purchasing:
                raise DomainError("Report purchaser wallet is not registered", 409)
            book = Book.from_json(session.get(BookState, settings.agent_id).body)
            if book.assets["purchasing"] < Decimal(".01"):
                raise DomainError("Report needs a separately funded fee reserve", 409)
        report = await service.jobs.open(settings.agent_id, settings.agent_id, f"report:{settings.agent_id}:{body.request_id}", {"window": body.request_id})
        if report.get("blockchainIdentifier"):
            await service.jobs.purchase(report["id"], settings.agent_id, purchasing.address)
        return service.jobs.status(report["id"])

    async def recover_existing():
        while True:
            try:
                with database.transaction() as session:
                    pending_decisions = list(session.scalars(select(Decision.id).where(Decision.agent_id == settings.agent_id, Decision.status.in_(("prepared", "submitted", "valuation_pending")))))
                    attempts = list(session.scalars(select(ChainAttempt.id).where(ChainAttempt.parent_id.in_(pending_decisions), ChainAttempt.leg == "swap")))
                for attempt_id in attempts:
                    await service.recover_swap(attempt_id)
                if settings.payment_read_key.get_secret_value():
                    await sync_job_states(database, settings, service.payment)
                    with database.transaction() as session:
                        reports = list(session.scalars(select(MasumiJob.id).where(MasumiJob.seller == settings.agent_id, MasumiJob.name == "report", MasumiJob.state.in_(("FundsLocked", "ResultSubmitted")))))
                    for job_id in reports:
                        with database.transaction() as session:
                            book = Book.from_json(session.get(BookState, settings.agent_id).body)
                            head = session.get(AuditHead, 1).hash
                            job = session.get(MasumiJob, job_id)
                            stored = job.result is not None
                        if not stored:
                            service.jobs.store_result(job_id, {"agent": settings.agent_id, "equity": str(book.equity), "nav": str(book.nav) if book.nav else None, "net_pnl": str(book.net_pnl), "position_usd": str(book.assets["token"])}, head)
                        await service.jobs.submit_result(job_id)
            except Exception:
                pass
            await asyncio.sleep(20)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(recover_existing())
        yield
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await service.close()

    app.router.lifespan_context = lifespan
    return app


app = create_app()