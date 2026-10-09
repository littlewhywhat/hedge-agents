import base64
from copy import deepcopy

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0, to_bytes_versioned
from solders.signature import Signature
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction
from spl.token.instructions import get_associated_token_address

from agents.common.chains import verify_cardano_receipt, verify_solana_receipt
from agents.common.config import TOKEN_PROGRAM
from agents.common.errors import DomainError
from agents.common.jupiter import sign_taker


def test_preserves_jupiter_cosigner_signature():
    payer, taker, destination = Keypair(), Keypair(), Keypair()
    message = MessageV0.try_compile(payer.pubkey(), [transfer(TransferParams(from_pubkey=payer.pubkey(), to_pubkey=destination.pubkey(), lamports=1)), transfer(TransferParams(from_pubkey=taker.pubkey(), to_pubkey=destination.pubkey(), lamports=1))], [], Hash.default())
    signatures = [payer.sign_message(to_bytes_versioned(message)), Signature.default()]
    unsigned = VersionedTransaction.populate(message, signatures)
    signed, identity = sign_taker(base64.b64encode(bytes(unsigned)).decode(), taker)
    transaction = VersionedTransaction.from_bytes(signed)
    assert transaction.signatures[0] == signatures[0]
    assert transaction.signatures[1].verify(taker.pubkey(), to_bytes_versioned(message))
    assert identity == str(signatures[0])


def test_cardano_output_locator_and_source_owner(settings):
    transaction = {"hash": "tx", "block": "block", "valid_contract": True}
    utxos = {"hash": "tx", "inputs": [{"address": "source"}], "outputs": [{"output_index": 0, "address": "gateway", "amount": [{"unit": settings.stablecoin_unit, "quantity": "100"}]}, {"output_index": 1, "address": "gateway", "amount": [{"unit": settings.stablecoin_unit, "quantity": "100"}]}]}
    first = verify_cardano_receipt(settings, "tx", "0", transaction, utxos, 1, "source", "gateway", 100)
    second = verify_cardano_receipt(settings, "tx", "1", transaction, utxos, 1, "source", "gateway", 100)
    assert first.locator != second.locator
    with pytest.raises(DomainError):
        verify_cardano_receipt(settings, "tx", "2", transaction, utxos, 1, "source", "gateway", 100)
    with pytest.raises(DomainError):
        verify_cardano_receipt(settings, "tx", "0", transaction, utxos, 1, "attacker", "gateway", 100)


def test_solana_net_amount_program_owner_and_destination(settings):
    source, gateway, mint = Keypair().pubkey(), Keypair().pubkey(), Keypair().pubkey()
    source_ata, gateway_ata = get_associated_token_address(source, mint), get_associated_token_address(gateway, mint)
    settings = settings.model_copy(update={"devnet_usdc_mint": str(mint)})
    def balance(index, owner, amount):
        return {"accountIndex": index, "mint": str(mint), "owner": str(owner), "uiTokenAmount": {"amount": str(amount), "decimals": 6}}
    transaction = {"slot": 123, "transaction": {"signatures": ["signature"], "message": {"accountKeys": [{"pubkey": str(source), "signer": True}, {"pubkey": str(source_ata)}, {"pubkey": str(gateway_ata)}], "instructions": [{"programId": TOKEN_PROGRAM, "parsed": {"type": "transferChecked", "info": {"source": str(source_ata), "destination": str(gateway_ata), "authority": str(source), "mint": str(mint), "tokenAmount": {"amount": "100", "decimals": 6}}}}]}}, "meta": {"err": None, "preTokenBalances": [balance(1, source, 200), balance(2, gateway, 0)], "postTokenBalances": [balance(1, source, 100), balance(2, gateway, 100)]}}
    status = {"err": None, "confirmationStatus": "confirmed"}
    assert verify_solana_receipt(settings, "signature", "0", transaction, status, str(source), str(gateway), 100).amount_raw == 100
    broken = deepcopy(transaction)
    broken["meta"]["err"] = {"InstructionError": [0, "failed"]}
    with pytest.raises(DomainError):
        verify_solana_receipt(settings, "signature", "0", broken, status, str(source), str(gateway), 100)
    broken = deepcopy(transaction)
    broken["meta"]["postTokenBalances"][1]["uiTokenAmount"]["amount"] = "99"
    with pytest.raises(DomainError):
        verify_solana_receipt(settings, "signature", "0", broken, status, str(source), str(gateway), 100)