from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
import re
import secrets

import httpx
import rfc8785
from sqlalchemy import select

from agents.common.config import V2_ADDRESSES
from agents.common.db import append_event, recognize
from agents.common.errors import DomainError
from agents.common.models import Agent, Intent, MasumiJob, new_id, utcnow


DEADLINES = {"payByTime": 5, "submitResultTime": 16, "unlockTime": 31, "externalDisputeUnlockTime": 46}


def input_hash(nonce: str, body: dict) -> str:
    if not re.fullmatch(r"[a-fA-F0-9]{14,26}", nonce):
        raise DomainError("Purchaser nonce must contain 14 to 26 hexadecimal characters")
    return hashlib.sha256(nonce.encode() + b";" + rfc8785.dumps(body)).hexdigest()


def output_hash(nonce: str, output: str) -> str:
    escaped = json.dumps(output, ensure_ascii=False)[1:-1]
    return hashlib.sha256(f"{nonce};{escaped}".encode()).hexdigest()


def select_source(sources: list[dict], settings, fee_raw: int) -> int:
    candidates = []
    for index, source in enumerate(sources):
        settlement = source.get("settlement", {})
        pricing = source.get("pricing", {})
        pricing_type = pricing.get("pricingType", pricing.get("type"))
        amounts = pricing.get("fixedPricing", pricing.get("fixed", []))
        if source.get("chain") != "Cardano" or source.get("network") != settings.environment.capitalize():
            continue
        if settlement.get("paymentSourceType") != "Web3CardanoV2" or settlement.get("address") != V2_ADDRESSES[settings.environment]:
            continue
        if pricing_type != "Fixed" or len(amounts) != 1:
            continue
        if amounts[0].get("unit") == settings.stablecoin_unit and str(amounts[0].get("amount")) == str(fee_raw) and fee_raw > 0:
            candidates.append(index)
    if len(candidates) != 1:
        raise DomainError("Seller must advertise one unambiguous V2 flat-fee source in the configured stablecoin")
    return candidates[0]


def create_request(settings, registry_id: str, source_index: int, nonce: str, body: dict, now: datetime) -> dict:
    if isinstance(source_index, bool) or not isinstance(source_index, int) or not 0 <= source_index <= 24:
        raise DomainError("A valid supportedPaymentSourceIndex is mandatory")
    if now.tzinfo is None:
        raise DomainError("Payment clock must be UTC-aware")
    return {"network": settings.environment.capitalize(), "agentIdentifier": registry_id, "paymentSourceType": "Web3CardanoV2", "supportedPaymentSourceIndex": source_index, "identifierFromPurchaser": nonce, "inputHash": input_hash(nonce, body), "forceLayer": "L1", **{name: (now + timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z") for name, minutes in DEADLINES.items()}}


def purchase_payload(settings, job: MasumiJob, now: datetime, buyer_address: str) -> dict:
    payment = job.terms.get("payment")
    if not payment or job.source_index is None or not job.blockchain_identifier:
        raise DomainError("Payment creation is not reconciled", 409)
    times = {name: int(payment[name]) for name in DEADLINES}
    now_ms = int(now.timestamp() * 1000)
    request_clock = datetime.fromisoformat(job.terms["request"]["payByTime"].replace("Z", "+00:00")) - timedelta(minutes=5)
    if now < request_clock - timedelta(seconds=30) or times["payByTime"] <= now_ms or times["submitResultTime"] - now_ms < 15 * 60 * 1000:
        raise DomainError("Clock skew or exhausted payment submission buffer; do not mutate existing terms", 409)
    if times["submitResultTime"] - times["payByTime"] < 5 * 60 * 1000 or times["unlockTime"] - times["submitResultTime"] < 15 * 60 * 1000 or times["externalDisputeUnlockTime"] - times["unlockTime"] < 15 * 60 * 1000:
        raise DomainError("Returned payment deadlines violate the V2 contract")
    wallets = payment.get("SmartContractWallet") or []
    seller = wallets[0] if isinstance(wallets, list) and wallets else wallets
    if not isinstance(seller, dict) or not seller.get("walletVkey"):
        raise DomainError("Payment is missing its authenticated seller verification key")
    return {"network": settings.environment.capitalize(), "paymentSourceType": "Web3CardanoV2", "smartContractAddress": V2_ADDRESSES[settings.environment], "blockchainIdentifier": job.blockchain_identifier, "supportedPaymentSourceIndex": job.source_index, "identifierFromPurchaser": job.nonce, "inputHash": job.input_hash, "agentIdentifier": job.terms["request"]["agentIdentifier"], "sellerVkey": seller["walletVkey"], "Amounts": payment["RequestedFunds"], "buyerReturnAddress": buyer_address, "paymentForceLayer": payment.get("forceLayer"), **{name: str(payment[name]) for name in DEADLINES}, **({"sellerReturnAddress": payment["sellerReturnAddress"]} if payment.get("sellerReturnAddress") else {})}


class MasumiClient:
    def __init__(self, settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=30, follow_redirects=False)

    async def request(self, method: str, path: str, *, payload=None, params=None, read=False):
        key = self.settings.payment_read_key if read else self.settings.payment_agent_key
        if not key.get_secret_value():
            raise DomainError("Scoped Payment Service credential is not configured", 503)
        response = await self.client.request(method, self.settings.payment_service_url.rstrip("/") + path, headers={"token": key.get_secret_value()}, json=payload, params=params)
        if response.status_code >= 400:
            raise DomainError(f"Payment Service returned HTTP {response.status_code}; operation remains reconcilable", 502)
        body = response.json()
        if body.get("status") == "error":
            raise DomainError("Payment Service rejected the operation", 502)
        return body.get("data", body)

    async def list_records(self, kind: str, **filters) -> list[dict]:
        if kind not in ("payment", "purchase"):
            raise DomainError("Unsupported V2 record collection")
        rows, cursor = [], None
        for _ in range(100):
            params = {"network": self.settings.environment.capitalize(), "filterPaymentSourceType": "Web3CardanoV2", "limit": 100, **filters}
            if cursor:
                params["cursorId"] = cursor
            data = await self.request("GET", f"/{kind}/", params=params, read=True)
            page = data.get("Payments" if kind == "payment" else "Purchases", [])
            if not isinstance(page, list):
                raise DomainError("Invalid Payment Service list response", 502)
            rows.extend(page)
            if len(page) < 100:
                return rows
            next_cursor = page[-1]["id"]
            if next_cursor == cursor:
                break
            cursor = next_cursor
        raise DomainError("V2 history pagination is incomplete; reconciliation is blocked", 503)


class JobService:
    def __init__(self, database, settings, client: MasumiClient, clock=utcnow):
        self.database, self.settings, self.client, self.clock = database, settings, client, clock

    async def open(self, buyer_id: str, seller_id: str, intent_id: str, body: dict, nonce: str | None = None) -> dict:
        nonce = nonce or secrets.token_hex(10)
        input_hash(nonce, body)
        with self.database.transaction() as session:
            intent = session.get(Intent, intent_id, with_for_update=True)
            seller = session.get(Agent, seller_id)
            if not seller or not seller.registry_id:
                raise DomainError("Seller is not registered on Masumi V2", 503)
            if seller_id == "gateway":
                if not intent or intent.buyer_id != buyer_id or body != {"intent_id": intent.id, "terms": intent.terms}:
                    raise DomainError("Job must bind the caller's immutable reserved intent", 403)
            existing = session.scalar(select(MasumiJob).where(MasumiJob.intent_id == intent_id))
            if existing:
                if existing.input != body or existing.buyer != buyer_id or existing.seller != seller_id:
                    raise DomainError("Job retry changed immutable terms", 409)
                job_id = existing.id
                needs_creation = False
            else:
                fee = self.settings.gateway_fee_raw if seller_id == "gateway" else 10_000
                source = select_source(seller.details.get("supportedPaymentSources", []), self.settings, fee)
                request = create_request(self.settings, seller.registry_id, source, nonce, body, self.clock())
                job_id = new_id()
                request["metadata"] = f"hedge:{job_id}:{nonce}"
                job = MasumiJob(id=job_id, intent_id=intent_id, name=intent.direction if intent else "report", buyer=buyer_id, seller=seller_id, nonce=nonce, source_index=source, input=body, input_hash=request["inputHash"], terms={"request": request}, state="creating", price_raw=fee)
                session.add(job)
                session.flush()
                append_event(session, "job_creation_prepared", {"job_id": job.id, "intent_id": intent_id, "seller": seller_id, "fee_raw": str(fee)})
                job_id, needs_creation = job.id, True
        if needs_creation:
            try:
                payment = await self.client.request("POST", "/payment/", payload=request)
                self.accept_creation(job_id, payment)
            except (httpx.TransportError, DomainError):
                with self.database.transaction() as session:
                    session.get(MasumiJob, job_id, with_for_update=True).state = "creation_unknown"
        else:
            await self.recover_creation(job_id)
        return self.status(job_id)

    def accept_creation(self, job_id: str, payment: dict):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id, with_for_update=True)
            request = job.terms["request"]
            source = payment.get("PaymentSource", {})
            if payment.get("inputHash") != job.input_hash or source.get("paymentSourceType") != "Web3CardanoV2" or source.get("network") != self.settings.environment.capitalize() or source.get("smartContractAddress") != V2_ADDRESSES[self.settings.environment] or payment.get("RequestedFunds") != [{"amount": str(job.price_raw), "unit": self.settings.stablecoin_unit}]:
                raise DomainError("Returned payment does not match the selected V2 flat-fee contract")
            if not payment.get("blockchainIdentifier") or any(name not in payment for name in DEADLINES):
                raise DomainError("Payment creation response is incomplete")
            if job.blockchain_identifier and job.blockchain_identifier != payment["blockchainIdentifier"]:
                raise DomainError("Multiple payments match one purchaser nonce", 409)
            job.blockchain_identifier = payment["blockchainIdentifier"]
            job.terms = {**job.terms, "payment": payment, "request": request}
            job.state = payment.get("onChainState") or "awaiting_payment"
            append_event(session, "job_created", {"job_id": job.id, "blockchain_identifier": job.blockchain_identifier, "source_index": job.source_index})

    async def recover_creation(self, job_id: str):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id)
            if job.blockchain_identifier:
                return
            request = job.terms["request"]
        records = await self.client.list_records("payment", filterAgentIdentifier=request["agentIdentifier"])
        matches = [row for row in records if row.get("metadata") == request["metadata"] and row.get("inputHash") == request["inputHash"]]
        if len(matches) == 1:
            self.accept_creation(job_id, matches[0])
        else:
            with self.database.transaction() as session:
                session.get(MasumiJob, job_id, with_for_update=True).state = "manual_review" if len(matches) > 1 else "creation_unknown"

    async def purchase(self, job_id: str, buyer_id: str, buyer_address: str):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id, with_for_update=True)
            if not job or job.buyer != buyer_id:
                raise DomainError("Job is not owned by this purchaser", 403)
            if "purchase" in job.terms:
                return self.status(job_id)
            payload = purchase_payload(self.settings, job, self.clock(), buyer_address)
            job.terms = {**job.terms, "purchase": payload}
            job.state = "purchase_pending"
        try:
            await self.client.request("POST", "/purchase/", payload=payload)
        except (httpx.TransportError, DomainError):
            pass
        return self.status(job_id)

    def store_result(self, job_id: str, result: dict, audit_head: str | None = None):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id, with_for_update=True)
            if job.result is not None:
                return job.result
            if job.state not in ("FundsLocked", "ResultSubmitted"):
                raise DomainError("Service result requires a confirmed locked fee", 409)
            body = {**result, **({"audit_head": audit_head} if audit_head else {})}
            job.result = rfc8785.dumps(body).decode()
            job.result_hash = output_hash(job.nonce, job.result)
            job.audit_head = audit_head
            if job.name == "report" and job.buyer in self.settings.agent_ids:
                recognize(session, job.buyer, "fee_delivery", Decimal(job.price_raw) / 1_000_000, f"job:{job.id}:delivery", reference=job.id)
            append_event(session, "job_result_persisted", {"job_id": job.id, "result_hash": job.result_hash, "audit_head": audit_head})
            return job.result

    async def submit_result(self, job_id: str):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id)
            if not job or not job.result_hash:
                raise DomainError("Persist exact result before submission", 409)
            payload = {"network": self.settings.environment.capitalize(), "blockchainIdentifier": job.blockchain_identifier, "resultHash": job.result_hash}
        await self.client.request("POST", "/payment/submit-result", payload=payload)

    async def refund_fee(self, job_id: str, seller: bool):
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id)
            if not job or not job.blockchain_identifier:
                raise DomainError("Fee creation must be reconciled first", 409)
            if not seller and int(job.terms["payment"]["unlockTime"]) <= int(self.clock().timestamp() * 1000):
                raise DomainError("Buyer refund request window has closed", 409)
            payload = {"network": self.settings.environment.capitalize(), "blockchainIdentifier": job.blockchain_identifier}
        return await self.client.request("POST", "/payment/authorize-refund" if seller else "/purchase/request-refund", payload=payload)

    def status(self, job_id: str) -> dict:
        with self.database.transaction() as session:
            job = session.get(MasumiJob, job_id)
            if not job:
                raise DomainError("Job not found", 404)
            return {"id": job.id, "state": job.state, "status": "completed" if job.result is not None else ("running" if job.state == "FundsLocked" else "awaiting_payment"), "result": job.result, "result_hash": job.result_hash, "blockchainIdentifier": job.blockchain_identifier, "identifierFromPurchaser": job.nonce, "input_hash": job.input_hash, "supportedPaymentSourceIndex": job.source_index, "payment": job.terms.get("payment")}