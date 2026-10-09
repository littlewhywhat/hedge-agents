from pydantic import SecretStr
from solders.hash import Hash
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
import pytest

from agents.common.errors import DomainError
from agents.common.solana_signer import build_usdc_transfer, keypair_from_secret, signing_gate


def test_usdc_transfer_builds_ata_and_checked_transfer_before_broadcast():
    sender, recipient, mint = Keypair(), Keypair(), Keypair()
    signed, signature = build_usdc_transfer(sender, str(recipient.pubkey()), str(mint.pubkey()), 1_000_000, str(Hash.default()))
    transaction = VersionedTransaction.from_bytes(signed)
    assert len(transaction.message.instructions) == 2
    assert str(transaction.signatures[0]) == signature
    assert all(transaction.verify_with_results())


def test_bad_private_key_does_not_escape_in_error():
    secret = "sensitive-invalid-value"
    with pytest.raises(DomainError) as error:
        keypair_from_secret(SecretStr(secret))
    assert secret not in str(error.value)


def test_missing_acceptance_gates_fail_closed(database, settings):
    with database.transaction() as session:
        with pytest.raises(DomainError):
            signing_gate(session, settings)
        signing_gate(session, settings, existing_obligation=True)