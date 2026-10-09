from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select

from agents.common.attempts import persist_attempt
from agents.common.db import append_event, canonical_hash, iso, recognize
from agents.common.errors import DomainError
from agents.common.models import ChainAttempt, Controls, GatewayQuota, Intent, Inventory, MasumiJob, ReceiptClaim, Transfer, Wallet, utcnow


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


@dataclass(frozen=True)
class VerifiedReceipt:
    environment: str
    chain: str
    tx_id: str
    locator: str
    asset: str
    amount_raw: int
    source: str
    destination: str
    confirmed: bool
    success: bool
    block: str


def public_intent(intent: Intent) -> dict:
    return {"id": intent.id, "buyer_id": intent.buyer_id, "direction": intent.direction, "terms": intent.terms, "terms_hash": intent.terms_hash, "state": intent.state, "fee_state": intent.fee_state, "expires_at": iso(intent.expires_at), "source_attempt_id": intent.source_attempt_id, "payout_attempt_id": intent.payout_attempt_id, "refund_attempt_id": intent.refund_attempt_id, "result": intent.result, "reason": intent.reason}


class SettlementService:
    def __init__(self, database, settings, clock=utcnow):
        self.database, self.settings, self.clock = database, settings, clock

    def _inventory(self, session):
        rows = list(session.scalars(select(Inventory).order_by(Inventory.chain).with_for_update()))
        if len(rows) != 2:
            raise DomainError("Inventory is unavailable", 503)
        return {row.chain: row for row in rows}

    def _quota(self, session):
        quota = session.get(GatewayQuota, 1, with_for_update=True)
        if quota is None:
            raise DomainError("Quota state is unavailable", 503)
        today = self.clock().date().isoformat()
        if quota.day != today:
            quota.day, quota.settled_raw = today, 0
        return quota

    def _intent(self, session, intent_id, buyer_id=None):
        intent = session.get(Intent, intent_id, with_for_update=True)
        if intent is None:
            raise DomainError("Intent not found", 404)
        if buyer_id is not None and intent.buyer_id != buyer_id:
            raise DomainError("Intent belongs to another caller", 403)
        return intent

    def prepare(self, buyer_id: str, request_id: str, direction: str, amount_raw: int, source_wallet: str, destination_wallet: str, refund_wallet: str) -> dict:
        if not request_id or len(request_id) > 128 or direction not in ("deposit_to_solana", "withdraw_to_cardano"):
            raise DomainError("Invalid request identity or direction")
        if isinstance(amount_raw, bool) or not isinstance(amount_raw, int) or not 0 < amount_raw <= self.settings.gateway_per_job_usd * 1_000_000:
            raise DomainError("Gateway per-job limit exceeded or invalid raw amount")
        source_chain = "cardano" if direction == "deposit_to_solana" else "solana"
        destination_chain = "solana" if source_chain == "cardano" else "cardano"
        with self.database.transaction() as session:
            quota = self._quota(session)
            previous = session.scalar(select(Intent).where(Intent.environment == self.settings.environment, Intent.buyer_id == buyer_id, Intent.request_id == request_id))
            basic = {"amount_raw": str(amount_raw), "direction": direction, "source_wallet": source_wallet, "destination_wallet": destination_wallet, "refund_wallet": refund_wallet}
            if previous:
                if any(previous.terms.get(key) != value for key, value in basic.items()):
                    raise DomainError("Request id already has different immutable terms", 409)
                return public_intent(previous)
            controls = session.get(Controls, 1)
            if controls is None or controls.kill_switch:
                raise DomainError("kill_switch", 423)
            if not self.settings.usdc_mint:
                raise DomainError("A separate devnet USDC mint must be configured")
            wallets = {wallet.id: wallet for wallet in session.scalars(select(Wallet))}
            for wallet_id, chain in ((source_wallet, source_chain), (refund_wallet, source_chain), (destination_wallet, destination_chain)):
                wallet = wallets.get(wallet_id)
                required_role = "capital" if chain == "cardano" else "trading"
                if not wallet or wallet.agent_id != buyer_id or wallet.chain != chain or wallet.environment != self.settings.environment or wallet.role != required_role:
                    raise DomainError("Wallet is not a registered caller-owned principal wallet", 403)
            if refund_wallet != source_wallet:
                raise DomainError("Refunds must return to the immutable registered source")
            gateways = {wallet.chain: wallet for wallet in wallets.values() if wallet.agent_id == "gateway" and wallet.role in ("capital", "gateway_inventory")}
            if set(gateways) != {"cardano", "solana"}:
                raise DomainError("Gateway principal wallets are not configured", 503)
            inventory = self._inventory(session)
            destination = inventory[destination_chain]
            if not destination.sampled_at or not 0 <= (self.clock() - aware(destination.sampled_at)).total_seconds() <= 120:
                raise DomainError("Gateway inventory is stale", 503)
            available = destination.confirmed_raw - destination.reserved_raw - destination.protected_raw - destination.low_water_raw
            if amount_raw > available:
                raise DomainError("Insufficient unreserved gateway inventory", 409)
            if quota.settled_raw + quota.active_raw + amount_raw > self.settings.gateway_daily_usd * 1_000_000:
                raise DomainError("Gateway daily quota exhausted", 409)
            terms = {**basic, "environment": self.settings.environment, "source_chain": source_chain, "destination_chain": destination_chain, "source_address": wallets[source_wallet].address, "destination_address": wallets[destination_wallet].address, "refund_address": wallets[refund_wallet].address, "gateway_source_address": gateways[source_chain].address, "gateway_destination_wallet": gateways[destination_chain].id, "gateway_refund_wallet": gateways[source_chain].id, "source_asset": self.settings.stablecoin_unit if source_chain == "cardano" else self.settings.usdc_mint, "destination_asset": self.settings.usdc_mint if destination_chain == "solana" else self.settings.stablecoin_unit, "fee_raw": str(self.settings.gateway_fee_raw)}
            intent = Intent(environment=self.settings.environment, buyer_id=buyer_id, request_id=request_id, direction=direction, amount_raw=amount_raw, terms=terms, terms_hash=canonical_hash(terms), expires_at=self.clock() + timedelta(minutes=10))
            destination.reserved_raw += amount_raw
            quota.active_raw += amount_raw
            session.add(intent)
            session.flush()
            append_event(session, "gateway_reserved", {"intent_id": intent.id, "buyer": buyer_id, "amount_raw": str(amount_raw), "direction": direction})
            return public_intent(intent)

    def fee_locked(self, intent_id: str, job_id: str):
        with self.database.transaction() as session:
            intent = self._intent(session, intent_id)
            job = session.get(MasumiJob, job_id)
            if not job or job.intent_id != intent.id or job.state != "FundsLocked" or job.price_raw != self.settings.gateway_fee_raw:
                raise DomainError("A verified, matching fee lock is required")
            if intent.fee_state == "FundsLocked":
                return public_intent(intent)
            if intent.state != "reserved" or self.clock() >= aware(intent.expires_at):
                raise DomainError("Funding deadline has expired", 409)
            intent.fee_state, intent.state = "FundsLocked", "awaiting_inbound"
            recognize(session, intent.buyer_id, "fee_lock", Decimal(job.price_raw) / 1_000_000, f"job:{job.id}:lock", reference=job.id)
            append_event(session, "gateway_fee_locked", {"intent_id": intent.id, "job_id": job.id})
            return public_intent(intent)

    def claim(self, buyer_id: str, intent_id: str, proof: VerifiedReceipt) -> dict:
        with self.database.transaction() as session:
            self._quota(session)
            intent = self._intent(session, intent_id, buyer_id)
            expected = intent.terms
            if (proof.environment != expected["environment"] or proof.chain != expected["source_chain"] or proof.asset != expected["source_asset"] or proof.amount_raw != intent.amount_raw or proof.source != expected["source_address"] or proof.destination != expected["gateway_source_address"] or not proof.confirmed or not proof.success or not proof.tx_id or not proof.locator or not proof.block):
                raise DomainError("Receipt does not prove the immutable source principal")
            claimed = session.scalar(select(ReceiptClaim).where(ReceiptClaim.environment == proof.environment, ReceiptClaim.chain == proof.chain, ReceiptClaim.tx_id == proof.tx_id, ReceiptClaim.locator == proof.locator))
            if claimed:
                if claimed.intent_id != intent.id:
                    raise DomainError("Receipt is permanently claimed by another intent", 409)
                return public_intent(intent)
            if intent.receipt_id:
                raise DomainError("Intent already has a different source receipt", 409)
            if intent.state not in ("awaiting_inbound", "expired", "manual_review"):
                raise DomainError("Fee must be locked before source principal is admitted", 409)
            inventory = self._inventory(session)
            claim = ReceiptClaim(environment=proof.environment, chain=proof.chain, tx_id=proof.tx_id, locator=proof.locator, intent_id=intent.id, proof=asdict(proof))
            session.add(claim)
            session.flush()
            intent.receipt_id, intent.protected = claim.id, True
            inventory[proof.chain].confirmed_raw += intent.amount_raw
            inventory[proof.chain].protected_raw += intent.amount_raw
            late = intent.state == "expired" or self.clock() >= aware(intent.expires_at)
            intent.state = "refund_pending" if late else "inbound_confirmed"
            intent.reason = "Late principal will be returned on its original chain" if late else None
            recognize(session, buyer_id, "principal_out", Decimal(intent.amount_raw) / 1_000_000, f"{proof.chain}:{proof.tx_id}:{proof.locator}:principal", source="capital" if proof.chain == "cardano" else "usdc", reference=intent.id)
            session.add(Transfer(environment=proof.environment, chain=proof.chain, tx_id=proof.tx_id, locator=proof.locator, kind="x402" if proof.chain == "cardano" else "gateway_usdc", body={"intent_id": intent.id, "agent": buyer_id, "amount_raw": str(intent.amount_raw), "from": proof.source, "to": proof.destination}))
            append_event(session, "gateway_inbound_confirmed", {"intent_id": intent.id, "chain": proof.chain, "tx_id": proof.tx_id, "locator": proof.locator, "late": late})
            return public_intent(intent)

    def prepare_outcome(self, intent_id: str, leg: str, *, tx_id: str, signed_bytes: bytes, validity: dict, reserved_inputs: list | None = None) -> dict:
        if leg not in ("payout", "refund"):
            raise DomainError("Invalid settlement leg")
        with self.database.transaction() as session:
            quota = self._quota(session)
            intent = self._intent(session, intent_id)
            existing_id = intent.payout_attempt_id if leg == "payout" else intent.refund_attempt_id
            if existing_id:
                return public_intent(intent)
            if leg == "payout":
                if intent.state != "inbound_confirmed" or not intent.reserved or not intent.protected:
                    raise DomainError("Payout requires admitted, exclusively claimed principal", 409)
                if quota.settled_raw + quota.active_raw > self.settings.gateway_daily_usd * 1_000_000:
                    raise DomainError("Current UTC day quota blocks payout", 409)
                wallet_id = intent.terms["gateway_destination_wallet"]
                chain = intent.terms["destination_chain"]
            else:
                if intent.state not in ("inbound_confirmed", "refund_pending", "manual_review") or not intent.protected:
                    raise DomainError("Refund requires protected confirmed principal", 409)
                if intent.payout_attempt_id:
                    payout = session.get(ChainAttempt, intent.payout_attempt_id)
                    if payout is None or payout.state != "failed":
                        raise DomainError("Original payout may still land; refund is prohibited", 409)
                wallet_id = intent.terms["gateway_refund_wallet"]
                chain = intent.terms["source_chain"]
            attempt = persist_attempt(session, wallet_id=wallet_id, parent_id=intent.id, leg=leg, chain=chain, tx_id=tx_id, signed_bytes=signed_bytes, validity=validity, reserved_inputs=reserved_inputs, existing_obligation=True)
            if leg == "payout":
                intent.payout_attempt_id, intent.state = attempt.id, "payout_pending"
            else:
                intent.refund_attempt_id, intent.state = attempt.id, "refund_pending"
            append_event(session, "gateway_outcome_prepared", {"intent_id": intent.id, "leg": leg, "attempt_id": attempt.id, "tx_id": tx_id})
            return public_intent(intent)

    def choose_refund(self, intent_id: str) -> dict:
        with self.database.transaction() as session:
            intent = self._intent(session, intent_id)
            if intent.state == "refunded":
                return public_intent(intent)
            if not intent.protected or intent.state == "fulfilled":
                raise DomainError("No refundable confirmed principal", 409)
            if intent.payout_attempt_id:
                attempt = session.get(ChainAttempt, intent.payout_attempt_id)
                if not attempt or attempt.state != "failed":
                    raise DomainError("Original payout may still land; reconcile before refund", 409)
            intent.state = "refund_pending"
            intent.fee_state = "RefundRequested"
            append_event(session, "gateway_refund_selected", {"intent_id": intent.id, "chain": intent.terms["source_chain"]})
            return public_intent(intent)

    def finalize(self, intent_id: str) -> dict:
        with self.database.transaction() as session:
            quota = self._quota(session)
            intent = self._intent(session, intent_id)
            if intent.state in ("fulfilled", "refunded"):
                return public_intent(intent)
            refund = intent.state == "refund_pending"
            attempt_id = intent.refund_attempt_id if refund else intent.payout_attempt_id
            attempt = session.get(ChainAttempt, attempt_id) if attempt_id else None
            if not attempt or attempt.state != "confirmed":
                raise DomainError("Outcome is still pending independent chain confirmation", 409)
            inventory = self._inventory(session)
            source = inventory[intent.terms["source_chain"]]
            destination = inventory[intent.terms["destination_chain"]]
            if intent.reserved:
                destination.reserved_raw -= intent.amount_raw
                quota.active_raw -= intent.amount_raw
                intent.reserved = False
            source.protected_raw -= intent.amount_raw
            intent.protected = False
            if refund:
                source.confirmed_raw -= intent.amount_raw
            else:
                destination.confirmed_raw -= intent.amount_raw
                quota.settled_raw += intent.amount_raw
            bucket = "capital" if attempt.chain == "cardano" else "usdc"
            recognize(session, intent.buyer_id, "principal_refund" if refund else "principal_in", Decimal(intent.amount_raw) / 1_000_000, f"{attempt.chain}:{attempt.tx_id}:principal", destination=bucket, reference=intent.id)
            job = session.scalar(select(MasumiJob).where(MasumiJob.intent_id == intent.id))
            if job and not refund:
                recognize(session, intent.buyer_id, "fee_delivery", Decimal(job.price_raw) / 1_000_000, f"job:{job.id}:delivery", reference=job.id)
            intent.state = "refunded" if refund else "fulfilled"
            intent.result = {"intent_id": intent.id, "source_receipt": session.get(ReceiptClaim, intent.receipt_id).proof, "state": intent.state, "chain": attempt.chain, "tx_id": attempt.tx_id, "amount_raw": str(intent.amount_raw)}
            session.add(Transfer(environment=intent.environment, chain=attempt.chain, tx_id=attempt.tx_id, locator="outcome", kind="refund" if refund else ("x402" if attempt.chain == "cardano" else "gateway_usdc"), body={"intent_id": intent.id, "amount_raw": str(intent.amount_raw), "agent": intent.buyer_id}))
            append_event(session, f"gateway_{intent.state}", intent.result)
            return public_intent(intent)

    def expire_unfunded(self) -> int:
        count = 0
        with self.database.transaction() as session:
            quota = self._quota(session)
            inventory = self._inventory(session)
            intents = session.scalars(select(Intent).where(Intent.state.in_(("reserved", "awaiting_inbound"))).with_for_update())
            controls = session.get(Controls, 1)
            for intent in intents:
                if self.clock() < aware(intent.expires_at) and controls and not controls.kill_switch:
                    continue
                if intent.reserved:
                    inventory[intent.terms["destination_chain"]].reserved_raw -= intent.amount_raw
                    quota.active_raw -= intent.amount_raw
                    intent.reserved = False
                intent.state = "expired"
                if intent.fee_state == "FundsLocked":
                    intent.fee_state = "RefundRequested"
                append_event(session, "gateway_expired", {"intent_id": intent.id, "watch_late_receipts": True})
                count += 1
        return count

    def availability(self) -> dict:
        with self.database.transaction() as session:
            quota = self._quota(session)
            rows = list(session.scalars(select(Inventory)))
            return {"chains": [{"chain": row.chain, "confirmed_raw": str(row.confirmed_raw), "reserved_raw": str(row.reserved_raw), "protected_raw": str(row.protected_raw), "low_water_raw": str(row.low_water_raw), "available_raw": str(max(0, row.confirmed_raw - row.reserved_raw - row.protected_raw - row.low_water_raw)), "sampled_at": iso(row.sampled_at) if row.sampled_at else None} for row in rows], "active_reserved_raw": str(quota.active_raw), "settled_today_raw": str(quota.settled_raw), "daily_cap_raw": str(self.settings.gateway_daily_usd * 1_000_000)}