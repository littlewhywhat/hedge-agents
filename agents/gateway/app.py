import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends
import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import select

from agents.common.auth import service_auth
from agents.common.chains import CardanoClient, SolanaClient
from agents.common.db import Database
from agents.common.errors import DomainError
from agents.common.masumi import JobService, MasumiClient
from agents.common.mip import make_agent_app, sync_job_states
from agents.common.models import ChainAttempt, Intent, MasumiJob
from agents.common.solana_signer import SignerSettings, SolanaSigner
from agents.gateway.settlement import SettlementService, public_intent


class PrepareInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    direction: str
    amount_raw: StrictInt
    source_wallet: str
    destination_wallet: str
    refund_wallet: str


class ReceiptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tx_id: str = Field(min_length=1, max_length=128)
    locator: str = Field(min_length=1, max_length=30)


def create_app(settings=None, database=None):
    settings = settings or SignerSettings(agent_id="gateway")
    database = database or Database(settings.database_url)
    payment = MasumiClient(settings)
    jobs = JobService(database, settings, payment)
    settlement = SettlementService(database, settings)
    solana = SolanaClient(settings)
    cardano = CardanoClient(settings)
    signer = SolanaSigner(database, settings, solana)
    app = make_agent_app(database, settings, jobs)
    authorize = service_auth(settings)

    async def progress(intent_id):
        with database.transaction() as session:
            intent = session.get(Intent, intent_id)
            if not intent:
                raise DomainError("Intent not found", 404)
            state, direction = intent.state, intent.direction
            leg = "refund" if state == "refund_pending" else "payout"
            attempt_id = intent.refund_attempt_id if leg == "refund" else intent.payout_attempt_id
        if state in ("inbound_confirmed", "refund_pending") and not attempt_id:
            chain = "solana" if (direction == "deposit_to_solana") == (leg == "payout") else "cardano"
            if chain == "solana":
                await signer.send_intent(intent_id, leg)
            else:
                async with httpx.AsyncClient(timeout=85) as client:
                    response = await client.post(settings.facilitator_url + "/transfers", headers={"Authorization": "Bearer " + settings.service_token.get_secret_value(), "X-Agent-Id": "gateway"}, json={"parent_id": intent_id, "leg": leg})
                    response.raise_for_status()
        with database.transaction() as session:
            intent = session.get(Intent, intent_id)
            attempt_id = intent.refund_attempt_id if intent.state == "refund_pending" else intent.payout_attempt_id
            attempt = session.get(ChainAttempt, attempt_id) if attempt_id else None
            chain = attempt.chain if attempt else None
        if attempt_id and chain == "solana":
            await signer.recover(attempt_id)
        with database.transaction() as session:
            attempt = session.get(ChainAttempt, attempt_id) if attempt_id else None
            confirmed = attempt is not None and attempt.state == "confirmed"
            failed_payout = attempt is not None and attempt.state == "failed" and attempt.leg == "payout"
            job = session.scalar(select(MasumiJob).where(MasumiJob.intent_id == intent_id))
            job_id = job.id if job else None
        if failed_payout:
            settlement.choose_refund(intent_id)
            return await progress(intent_id)
        if confirmed:
            result = settlement.finalize(intent_id)
            if job_id and result["state"] == "fulfilled":
                jobs.store_result(job_id, result["result"])
                await jobs.submit_result(job_id)
        with database.transaction() as session:
            return public_intent(session.get(Intent, intent_id))

    @app.post("/transfers/prepare")
    def prepare(body: PrepareInput, caller=Depends(authorize)):
        return settlement.prepare(caller, **body.model_dump())

    @app.get("/transfers/{intent_id}")
    def status(intent_id: str, caller=Depends(authorize)):
        with database.transaction() as session:
            intent = session.get(Intent, intent_id)
            if not intent or intent.buyer_id != caller:
                raise DomainError("Caller-owned intent not found", 404)
            return public_intent(intent)

    @app.post("/transfers/{intent_id}/receipt")
    async def attach_receipt(intent_id: str, body: ReceiptInput, caller=Depends(authorize)):
        with database.transaction() as session:
            intent = session.get(Intent, intent_id)
            if not intent or intent.buyer_id != caller:
                raise DomainError("Caller-owned intent not found", 404)
            terms, amount = intent.terms, intent.amount_raw
        adapter = cardano if terms["source_chain"] == "cardano" else solana
        proof = await adapter.verify_receipt(body.tx_id, body.locator, terms["source_address"], terms["gateway_source_address"], amount)
        settlement.claim(caller, intent_id, proof)
        return await progress(intent_id)

    @app.post("/transfers/{intent_id}/recover")
    async def recover(intent_id: str, caller=Depends(authorize)):
        with database.transaction() as session:
            intent = session.get(Intent, intent_id)
            if not intent or caller not in (intent.buyer_id, "runtime", "gateway"):
                raise DomainError("Intent recovery is outside caller scope", 403)
        return await progress(intent_id)

    async def recover_existing():
        while True:
            try:
                if settings.payment_read_key.get_secret_value():
                    await sync_job_states(database, settings, payment)
                settlement.expire_unfunded()
                with database.transaction() as session:
                    fee_jobs = [(job.intent_id, job.id) for job in session.scalars(select(MasumiJob).where(MasumiJob.seller == "gateway", MasumiJob.state == "FundsLocked"))]
                    pending = list(session.scalars(select(Intent.id).where(Intent.state.in_(("inbound_confirmed", "payout_pending", "refund_pending", "fulfilled")))))
                    refunds = [job.id for job in session.scalars(select(MasumiJob).join(Intent, Intent.id == MasumiJob.intent_id).where(Intent.state.in_(("refunded", "expired")), MasumiJob.blockchain_identifier.is_not(None), MasumiJob.state.not_in(("RefundWithdrawn", "DisputedWithdrawn"))))]
                    inbound = [(row.id, row.buyer_id, row.terms, row.amount_raw, row.source_attempt_id) for row in session.scalars(select(Intent).where(Intent.source_attempt_id.is_not(None), Intent.receipt_id.is_(None)))]
                for intent_id, job_id in fee_jobs:
                    with database.transaction() as session:
                        intent = session.get(Intent, intent_id)
                        if intent and intent.state == "reserved":
                            settlement.fee_locked(intent_id, job_id)
                for intent_id, buyer_id, terms, amount, source_id in inbound:
                    with database.transaction() as session:
                        source = session.get(ChainAttempt, source_id)
                        signature, validity, chain = source.tx_id, source.validity, source.chain
                    adapter = cardano if chain == "cardano" else solana
                    locator = str(validity.get("output_index", validity.get("locator", "1")))
                    try:
                        proof = await adapter.verify_receipt(signature, locator, terms["source_address"], terms["gateway_source_address"], amount)
                        settlement.claim(buyer_id, intent_id, proof)
                        await progress(intent_id)
                    except (DomainError, httpx.HTTPError):
                        continue
                for intent_id in pending:
                    try:
                        await progress(intent_id)
                    except (DomainError, httpx.HTTPError):
                        continue
                for job_id in refunds:
                    try:
                        await jobs.refund_fee(job_id, seller=True)
                    except (DomainError, httpx.HTTPError):
                        continue
            except Exception:
                pass
            await asyncio.sleep(20)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(recover_existing())
        yield
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await payment.client.aclose()
        await solana.client.aclose()
        await cardano.client.aclose()

    app.router.lifespan_context = lifespan
    return app


app = create_app()