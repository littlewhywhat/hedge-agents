from fastapi import Depends, FastAPI, Request
from decimal import Decimal
from fastapi.responses import JSONResponse
from masumi.config import Config
from masumi.models import StartJobRequest
from masumi.server import MasumiAgentServer
from sqlalchemy import select

from agents.common.auth import service_auth
from agents.common.config import V2_ADDRESSES
from agents.common.db import append_event, recognize
from agents.common.errors import DomainError
from agents.common.models import Agent, Controls, Intent, MasumiJob


def attach_routes(app, database, settings, jobs):
    authorize = service_auth(settings)

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, error: DomainError):
        return JSONResponse({"detail": str(error)}, status_code=error.status)

    @app.get("/health")
    def health():
        with database.transaction() as session:
            agent = session.get(Agent, settings.agent_id)
            return {"status": "ok", "agent_id": settings.agent_id, "environment": settings.environment, "registered": bool(agent and agent.registry_id)}

    @app.get("/availability")
    def availability():
        with database.transaction() as session:
            controls, agent = session.get(Controls, 1), session.get(Agent, settings.agent_id)
            available = controls is not None and not controls.kill_switch and agent is not None and agent.registry_id is not None
            return {"status": "available" if available else "unavailable", "type": "masumi-agent", "message": "V2 flat-fee service" if available else "Registration or safety controls block new jobs"}

    @app.get("/input_schema")
    def input_schema():
        fields = [{"id": "intent_id", "type": "text", "name": "Reserved transfer intent"}] if settings.agent_id == "gateway" else [{"id": "window", "type": "text", "name": "Report window"}]
        return {"input_data": fields}

    @app.post("/start_job")
    async def start_job(body: StartJobRequest, caller=Depends(authorize)):
        data = body.input_data or {}
        if settings.agent_id == "gateway":
            intent_id = data.get("intent_id")
            with database.transaction() as session:
                intent = session.get(Intent, intent_id) if isinstance(intent_id, str) else None
                if not intent or intent.buyer_id != caller:
                    raise DomainError("Caller-owned reserved intent required", 403)
                if data != {"intent_id": intent.id, "terms": intent.terms}:
                    raise DomainError("Job input must contain the original immutable terms", 409)
        else:
            if set(data) - {"window"} or not isinstance(data.get("window", "latest"), str):
                raise DomainError("Reports accept a window, never transaction instructions")
            intent_id = f"report:{caller}:{body.identifier_from_purchaser}"
        result = await jobs.open(caller, settings.agent_id, intent_id, data, body.identifier_from_purchaser)
        payment = result.pop("payment", None)
        if not payment:
            return JSONResponse(result, status_code=202)
        wallets = payment.get("SmartContractWallet") or []
        seller = wallets[0] if isinstance(wallets, list) and wallets else wallets
        return {**result, "agentIdentifier": payment.get("agentIdentifier"), "sellerVKey": seller.get("walletVkey") if isinstance(seller, dict) else None, **{name: int(payment[name]) for name in ("payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime")}}

    @app.get("/status")
    def status(job_id: str):
        with database.transaction() as session:
            job = session.get(MasumiJob, job_id)
            if not job or job.seller != settings.agent_id:
                raise DomainError("Job not found on this agent", 404)
        return jobs.status(job_id)


def make_agent_app(database, settings, jobs):
    with database.transaction() as session:
        agent = session.get(Agent, settings.agent_id)
        registry_id = agent.registry_id if agent else None
        seller_vkey = agent.details.get("seller_vkey") if agent else None
    if registry_id and seller_vkey and settings.payment_agent_key.get_secret_value():
        class DurableMasumiServer(MasumiAgentServer):
            def _register_endpoints(self):
                attach_routes(self.app, database, settings, jobs)
        config = Config(settings.payment_service_url, settings.payment_agent_key.get_secret_value(), preprod_address=V2_ADDRESSES["preprod"], mainnet_address=V2_ADDRESSES["mainnet"])
        server = DurableMasumiServer(config, agent_identifier=registry_id, network=settings.environment.capitalize(), seller_vkey=seller_vkey)
        return server.get_app()
    app = FastAPI(title=f"HedgeAgents {settings.agent_id}", version="0.1.0")
    attach_routes(app, database, settings, jobs)
    return app


async def sync_job_states(database, settings, client):
    records = await client.list_records("payment")
    changed = []
    with database.transaction() as session:
        for record in records:
            job = session.scalar(select(MasumiJob).where(MasumiJob.blockchain_identifier == record.get("blockchainIdentifier"), MasumiJob.seller == settings.agent_id).with_for_update())
            if not job:
                continue
            if record.get("inputHash") != job.input_hash or record.get("PaymentSource", {}).get("paymentSourceType") != "Web3CardanoV2":
                raise DomainError("Payment state cannot be reconciled to the persisted job", 409)
            state = record.get("onChainState")
            if state and state != job.state:
                job.state = state
                if state == "FundsLocked" and job.name == "report" and job.buyer in settings.agent_ids:
                    recognize(session, job.buyer, "fee_lock", Decimal(job.price_raw) / 1_000_000, f"job:{job.id}:lock", reference=job.id)
                if state == "RefundWithdrawn" and job.buyer in settings.agent_ids:
                    recognize(session, job.buyer, "fee_refund", Decimal(job.price_raw) / 1_000_000, f"job:{job.id}:refund", reference=job.id)
                append_event(session, "masumi_job_state", {"job_id": job.id, "state": state, "blockchain_identifier": job.blockchain_identifier})
                changed.append(job.id)
    return changed