from copy import deepcopy

import pytest
from solders.keypair import Keypair

from agents.common.errors import DomainError
from infra.setup import validate_wallet_manifest


def manifest(settings):
    wallets = []
    for index, agent in enumerate(settings.agent_ids + ["gateway"]):
        for role_index, role in enumerate(("capital", "purchasing", "selling")):
            wallets.append({"id": f"{agent}:{role}", "agent_id": agent, "chain": "cardano", "role": role, "address": "addr_test1" + f"{index}{role_index}" * 30})
        wallets.append({"id": f"{agent}:solana", "agent_id": agent, "chain": "solana", "role": "gateway_inventory" if agent == "gateway" else "trading", "address": str(Keypair().pubkey())})
    return {"environment": "preprod", "wallets": wallets, "registry": []}


def test_wallet_roles_and_fund_ownership_are_derived(settings):
    rows = validate_wallet_manifest(manifest(settings), settings)
    assert len(rows) == 20
    assert all(row["signer"] == "facilitator" for row in rows if row["role"] == "capital")
    assert all(not row["belongs_to_fund"] for row in rows if row["agent_id"] == "gateway" or row["role"] == "selling")


def test_wallet_overlap_and_network_mismatch_are_rejected(settings):
    original = manifest(settings)
    overlap = deepcopy(original)
    overlap["wallets"][1]["address"] = overlap["wallets"][0]["address"]
    with pytest.raises(DomainError, match="distinct"):
        validate_wallet_manifest(overlap, settings)
    original["environment"] = "mainnet"
    with pytest.raises(DomainError, match="different"):
        validate_wallet_manifest(original, settings)