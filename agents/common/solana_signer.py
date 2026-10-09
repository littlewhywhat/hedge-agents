import base64
import json

from pydantic import SecretStr
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction
from spl.token.instructions import create_idempotent_associated_token_account, get_associated_token_address, transfer_checked
from spl.token.models import TransferCheckedParams
from sqlalchemy import select

from agents.common.attempts import persist_attempt, public_attempt, reconcile_attempt
from agents.common.chains import SolanaClient
from agents.common.config import Settings, TOKEN_PROGRAM
from agents.common.db import append_event
from agents.common.errors import DomainError
from agents.common.models import AllocationRound, ChainAttempt, Controls, GateEvidence, GatewayQuota, Intent, Wallet, utcnow
from agents.gateway.settlement import aware


class SignerSettings(Settings):
    solana_private_key: SecretStr = SecretStr("")


def keypair_from_secret(secret: SecretStr) -> Keypair:
    try:
        value = secret.get_secret_value().strip()
        return Keypair.from_bytes(bytes(json.loads(value))) if value.startswith("[") else Keypair.from_base58_string(value)
    except Exception:
        raise DomainError("Solana signer is missing or invalid", 503) from None


def build_usdc_transfer(keypair: Keypair, destination: str, mint: str, amount_raw: int, blockhash: str) -> tuple[bytes, str]:
    if isinstance(amount_raw, bool) or not isinstance(amount_raw, int) or amount_raw <= 0:
        raise DomainError("USDC transfer requires a positive raw integer")
    owner, recipient, token = keypair.pubkey(), Pubkey.from_string(destination), Pubkey.from_string(mint)
    source_ata = get_associated_token_address(owner, token)
    destination_ata = get_associated_token_address(recipient, token)
    instructions = [create_idempotent_associated_token_account(owner, recipient, token), transfer_checked(TransferCheckedParams(program_id=Pubkey.from_string(TOKEN_PROGRAM), source=source_ata, mint=token, dest=destination_ata, owner=owner, amount=amount_raw, decimals=6, signers=[]))]
    message = MessageV0.try_compile(owner, instructions, [], Hash.from_string(blockhash))
    transaction = VersionedTransaction(message, [keypair])
    return bytes(transaction), str(transaction.signatures[0])


def qualification_authorized(session, settings, parent_id):
    controls = session.get(Controls, 1)
    qualification = controls.state.get("qualification", {}) if controls else {}
    if not isinstance(qualification, dict) or qualification.get("state") != "authorized" or qualification.get("environment") != settings.environment:
        return False
    from datetime import datetime
    if not qualification.get("expires_at") or utcnow() >= datetime.fromisoformat(qualification["expires_at"]):
        return False
    round = session.get(AllocationRound, qualification.get("round_id"))
    if not round or round.state not in ("planned", "executing", "partial"):
        return False
    if parent_id == round.id:
        return True
    intent = session.get(Intent, parent_id) if parent_id else None
    return bool(intent and intent.buyer_id == qualification.get("agent_id") and intent.amount_raw <= int(qualification.get("budget_raw", 0)) and any(leg["id"] == intent.request_id and leg["amount_raw"] == str(intent.amount_raw) for leg in round.legs))


def signing_gate(session, settings, *, existing_obligation=False, parent_id=None):
    controls = session.get(Controls, 1, with_for_update=True)
    if controls is None:
        raise DomainError("Controls unavailable; no signature authorized", 503)
    if existing_obligation:
        return
    bounded = qualification_authorized(session, settings, parent_id)
    if controls.kill_switch or (not controls.armed and not bounded):
        raise DomainError("New signing operations are halted or not explicitly armed", 423)
    required = {"offline_acceptance"} if bounded and settings.environment == "preprod" else {"offline_acceptance", "preprod_registry", "preprod_escrow", "preprod_x402", "devnet_transfer", "adapter_recovery"}
    if settings.environment == "mainnet" and not bounded:
        required.add("mainnet_qualification")
    passed = set(session.scalars(select(GateEvidence.id).where(GateEvidence.passed.is_(True))))
    if not required <= passed:
        raise DomainError("Required signing acceptance evidence is missing", 423)


class SolanaSigner:
    def __init__(self, database, settings: SignerSettings, rpc=None):
        self.database, self.settings = database, settings
        self.rpc = rpc or SolanaClient(settings)

    async def send_intent(self, intent_id: str, leg: str) -> dict:
        with self.database.transaction() as session:
            intent = session.get(Intent, intent_id)
            if not intent or intent.environment != self.settings.environment:
                raise DomainError("Intent is unavailable in this environment", 404)
            if leg == "source":
                wallet_id = intent.terms["source_wallet"]
                destination = intent.terms["gateway_source_address"]
                allowed = intent.buyer_id == self.settings.agent_id and intent.direction == "withdraw_to_cardano" and intent.state == "awaiting_inbound" and intent.fee_state == "FundsLocked" and utcnow() < aware(intent.expires_at)
            elif leg == "payout":
                wallet_id = intent.terms["gateway_destination_wallet"]
                destination = intent.terms["destination_address"]
                allowed = self.settings.agent_id == "gateway" and intent.direction == "deposit_to_solana" and intent.state in ("inbound_confirmed", "payout_pending") and intent.protected and intent.receipt_id and intent.reserved
            elif leg == "refund":
                wallet_id = intent.terms["gateway_refund_wallet"]
                destination = intent.terms["refund_address"]
                payout = session.get(ChainAttempt, intent.payout_attempt_id) if intent.payout_attempt_id else None
                allowed = self.settings.agent_id == "gateway" and intent.direction == "withdraw_to_cardano" and intent.state == "refund_pending" and intent.protected and intent.receipt_id and (payout is None or payout.state == "failed")
            else:
                raise DomainError("Unsupported Solana intent leg")
            wallet = session.get(Wallet, wallet_id)
            if not wallet or wallet.agent_id != self.settings.agent_id or wallet.chain != "solana" or wallet.signer != self.settings.agent_id:
                raise DomainError("Solana wallet is not owned by this signer", 403)
            existing = session.scalar(select(ChainAttempt).where(ChainAttempt.parent_id == intent_id, ChainAttempt.leg == leg, ChainAttempt.wallet_id == wallet_id))
            if existing:
                return public_attempt(existing)
            if not allowed:
                raise DomainError("Immutable intent does not authorize this Solana transfer", 409)
            amount = intent.amount_raw
            signing_gate(session, self.settings, existing_obligation=leg != "source", parent_id=intent_id)
            address = wallet.address
        accounts = await self.rpc.token_accounts(address, TOKEN_PROGRAM)
        balance = sum(int(row["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for row in accounts["value"] if row["account"]["data"]["parsed"]["info"]["mint"] == self.settings.usdc_mint)
        if balance < amount:
            raise DomainError("Confirmed Solana USDC inventory is insufficient", 409)
        mint = await self.rpc.mint_info(self.settings.usdc_mint)
        if mint["decimals"] != 6 or mint["program"] != TOKEN_PROGRAM:
            raise DomainError("Gateway transfers require six-decimal classic SPL USDC")
        block = (await self.rpc.rpc("getLatestBlockhash", [{"commitment": "confirmed"}]))["value"]
        keypair = keypair_from_secret(self.settings.solana_private_key)
        if str(keypair.pubkey()) != address:
            raise DomainError("Solana key does not match its registered wallet", 403)
        with self.database.transaction() as session:
            intent = session.get(Intent, intent_id, with_for_update=True)
            signing_gate(session, self.settings, existing_obligation=leg != "source", parent_id=intent_id)
            session.get(Wallet, wallet_id, with_for_update=True)
            previous = session.scalar(select(ChainAttempt).where(ChainAttempt.parent_id == intent_id, ChainAttempt.leg == leg, ChainAttempt.wallet_id == wallet_id))
            if previous:
                return public_attempt(previous)
            if leg == "source" and (intent.state != "awaiting_inbound" or utcnow() >= aware(intent.expires_at)):
                raise DomainError("Source funding was cancelled before signing", 409)
            if leg != "source" and (not intent.protected or intent.state not in ("inbound_confirmed", "refund_pending")):
                raise DomainError("Settlement intent changed before signing", 409)
            if leg == "payout":
                quota = session.get(GatewayQuota, 1, with_for_update=True)
                settled_today = quota.settled_raw if quota and quota.day == utcnow().date().isoformat() else 0
                if not quota or settled_today + quota.active_raw > self.settings.gateway_daily_usd * 1_000_000:
                    raise DomainError("Current UTC day quota blocks payout", 409)
            signed, signature = build_usdc_transfer(keypair, destination, self.settings.usdc_mint, amount, block["blockhash"])
            attempt = persist_attempt(session, wallet_id=wallet_id, parent_id=intent_id, leg=leg, chain="solana", tx_id=signature, signed_bytes=signed, validity={"last_valid_height": block["lastValidBlockHeight"], "blockhash": block["blockhash"], "locator": "1", "balances_before": {self.settings.usdc_mint: str(balance)}}, existing_obligation=leg != "source")
            if leg == "source":
                intent.source_attempt_id = attempt.id
            elif leg == "payout":
                intent.payout_attempt_id, intent.state = attempt.id, "payout_pending"
            else:
                intent.refund_attempt_id, intent.state = attempt.id, "refund_pending"
            attempt_id = attempt.id
        return await self.broadcast(attempt_id)

    async def broadcast(self, attempt_id: str) -> dict:
        with self.database.transaction() as session:
            attempt = session.get(ChainAttempt, attempt_id, with_for_update=True)
            wallet = session.get(Wallet, attempt.wallet_id) if attempt else None
            if not wallet or wallet.agent_id != self.settings.agent_id:
                raise DomainError("Attempt is not owned by this signer", 403)
            if attempt.state != "prepared":
                return public_attempt(attempt)
            signing_gate(session, self.settings, existing_obligation=attempt.leg in ("payout", "refund"), parent_id=attempt.parent_id)
            attempt.state = "submitted"
            signed, signature = attempt.signed_bytes, attempt.tx_id
            append_event(session, "attempt_submission_started", {"attempt_id": attempt.id, "tx_id": signature, "chain": "solana"})
        try:
            returned = await self.rpc.rpc("sendTransaction", [base64.b64encode(signed).decode(), {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "confirmed", "maxRetries": 0}])
            if returned != signature:
                raise DomainError("RPC returned a different transaction identity")
        except Exception:
            with self.database.transaction() as session:
                reconcile_attempt(session, attempt_id, {"tx_id": signature, "state": "unknown", "error": "Broadcast outcome unknown; original signature retained"})
        return await self.recover(attempt_id)

    async def recover(self, attempt_id: str):
        with self.database.transaction() as session:
            attempt = session.get(ChainAttempt, attempt_id)
            wallet = session.get(Wallet, attempt.wallet_id) if attempt else None
            if not wallet or wallet.agent_id != self.settings.agent_id:
                raise DomainError("Attempt is not owned by this signer", 403)
            if attempt.state in ("confirmed", "failed"):
                return public_attempt(attempt)
            signature, validity, created_at, address = attempt.tx_id, attempt.validity, aware(attempt.created_at), wallet.address
            prepared = attempt.state == "prepared"
        if prepared:
            return await self.broadcast(attempt_id)
        observation = await self.rpc.observe_attempt(signature, validity, address, created_at)
        with self.database.transaction() as session:
            return public_attempt(reconcile_attempt(session, attempt_id, observation))