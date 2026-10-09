from sqlalchemy import select

from agents.common.db import append_event
from agents.common.errors import DomainError
from agents.common.models import ChainAttempt, Controls, Wallet


UNRESOLVED = ("prepared", "submitted", "unknown")


def persist_attempt(session, *, wallet_id: str, parent_id: str, leg: str, chain: str, tx_id: str, signed_bytes: bytes, validity: dict, request_id: str | None = None, reserved_inputs: list | None = None, existing_obligation: bool = False) -> ChainAttempt:
    wallet = session.scalar(select(Wallet).where(Wallet.id == wallet_id).with_for_update())
    if wallet is None or wallet.chain != chain:
        raise DomainError("Unknown or wrong-chain signing wallet")
    previous = session.scalar(select(ChainAttempt).where(ChainAttempt.parent_id == parent_id, ChainAttempt.leg == leg, ChainAttempt.wallet_id == wallet_id).order_by(ChainAttempt.number.desc()))
    if previous:
        return previous
    controls = session.get(Controls, 1)
    if controls is None or (controls.kill_switch and not existing_obligation):
        raise DomainError("kill_switch", 423)
    if session.scalar(select(ChainAttempt.id).where(ChainAttempt.wallet_id == wallet_id, ChainAttempt.state.in_(UNRESOLVED))):
        raise DomainError("Wallet has an unresolved attempt", 409)
    if not signed_bytes or not tx_id or not validity:
        raise DomainError("Signed identity and validity must be durable before broadcast")
    attempt = ChainAttempt(wallet_id=wallet_id, parent_id=parent_id, leg=leg, chain=chain, tx_id=tx_id, signed_bytes=signed_bytes, validity=validity, request_id=request_id, reserved_inputs=reserved_inputs or [], state="prepared")
    session.add(attempt)
    session.flush()
    append_event(session, "attempt_prepared", {"attempt_id": attempt.id, "parent_id": parent_id, "wallet": wallet_id, "chain": chain, "tx_id": tx_id, "leg": leg})
    return attempt


def reconcile_attempt(session, attempt_id: str, observation: dict) -> ChainAttempt:
    attempt = session.scalar(select(ChainAttempt).where(ChainAttempt.id == attempt_id).with_for_update())
    if not attempt:
        raise DomainError("Attempt not found", 404)
    if observation.get("tx_id") != attempt.tx_id:
        raise DomainError("Observation does not identify the persisted transaction")
    if attempt.state in ("confirmed", "failed"):
        if observation.get("rollback"):
            controls = session.get(Controls, 1, with_for_update=True)
            controls.kill_switch = True
            controls.reason = "Confirmed chain rollback requires manual reconciliation"
            append_event(session, "chain_rollback", {"attempt_id": attempt.id, "tx_id": attempt.tx_id})
        return attempt
    state = observation.get("state")
    if state == "confirmed" and observation.get("success") is True and observation.get("confirmed") is True:
        attempt.state = "confirmed"
        attempt.confirmation = observation
    elif state == "failed" and (observation.get("confirmed_failure") is True or all(observation.get(key) is True for key in ("expired", "history_checked", "inputs_unspent", "finality_reached"))):
        attempt.state = "failed"
        attempt.confirmation = observation
    else:
        attempt.state = "unknown"
    attempt.error = observation.get("error")
    append_event(session, "attempt_reconciled", {"attempt_id": attempt.id, "state": attempt.state, "tx_id": attempt.tx_id})
    return attempt


def public_attempt(attempt: ChainAttempt) -> dict:
    return {"id": attempt.id, "parent_id": attempt.parent_id, "wallet_id": attempt.wallet_id, "leg": attempt.leg, "chain": attempt.chain, "tx_id": attempt.tx_id, "state": attempt.state, "error": attempt.error}


def assert_handoff(session, wallet_id: str, old_signer_stopped: bool):
    if not old_signer_stopped or session.scalar(select(ChainAttempt.id).where(ChainAttempt.wallet_id == wallet_id, ChainAttempt.state.in_(UNRESOLVED))):
        raise DomainError("Ownership handoff requires a stopped signer and no unresolved attempt", 409)