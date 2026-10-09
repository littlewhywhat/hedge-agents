import pytest

from agents.common.db import recognize
from agents.common.errors import DomainError
from agents.common.models import AllocationRound, Wallet
from runtime.allocation import request_operation


def test_deploy_is_durable_and_chunks_gateway_limits(database, settings):
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 250, "deposit")
    result = request_operation(database, settings, "deploy", "btc", 250_000_000, "operator-request-1")
    assert result["state"] == "planned"
    assert request_operation(database, settings, "deploy", "btc", 250_000_000, "operator-request-1")["id"] == result["id"]
    with database.transaction() as session:
        legs = session.get(AllocationRound, result["id"]).legs
        assert [leg["amount_raw"] for leg in legs] == ["200000000", "50000000", "0"]
    with pytest.raises(DomainError):
        request_operation(database, settings, "deploy", "btc", 1, "operator-request-1")


def test_cashout_requires_registered_operator_and_liquid_reserve(database, settings):
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 100, "deposit")
    with pytest.raises(DomainError, match="distribution address"):
        request_operation(database, settings, "cashout", "btc", 98_000_000, "operator-request-1")
    with database.transaction() as session:
        session.add(Wallet(id="operator:cardano", agent_id="operator", environment="preprod", chain="cardano", address="registered-operator", role="distribution", signer="external", belongs_to_fund=False))
    with pytest.raises(DomainError, match="reserve"):
        request_operation(database, settings, "cashout", "btc", 100_000_000, "operator-request-1")
    result = request_operation(database, settings, "cashout", "btc", 98_000_000, "operator-request-1")
    with database.transaction() as session:
        assert session.get(AllocationRound, result["id"]).legs[0]["kind"] == "cashout"


def test_qualification_is_scoped_and_does_not_arm_normal_trading(database, settings):
    from fastapi.testclient import TestClient
    from agents.common.models import Controls, GateEvidence
    from agents.common.solana_signer import qualification_authorized, signing_gate
    from monitor.app import create_app
    with database.transaction() as session:
        recognize(session, "btc", "contribution", 5, "qualification-deposit")
        session.get(Controls, 1).kill_switch = False
        session.add(GateEvidence(id="offline_acceptance", passed=True, environment="preprod", evidence={"test": "fixture"}))
    with TestClient(create_app(settings, database)) as client:
        client.headers["Authorization"] = "Bearer " + settings.operator_token.get_secret_value()
        result = client.post("/qualification/deploy", json={"agent_id": "btc", "request_id": "qualification-operation", "amount_raw": 5_000_000, "confirmation": "QUALIFY PREPROD"})
        assert result.status_code == 200
        assert not result.json()["normal_automation"]
        assert not client.get("/fund").json()["armed"]
    with database.transaction() as session:
        assert qualification_authorized(session, settings, "qualification-operation")
        assert not qualification_authorized(session, settings, "unrelated")
        signing_gate(session, settings, parent_id="qualification-operation")
        with pytest.raises(DomainError):
            signing_gate(session, settings, parent_id="unrelated")