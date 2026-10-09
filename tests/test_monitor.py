from datetime import timedelta

from fastapi.testclient import TestClient
import pytest

from agents.common.models import AllocationRound, utcnow
from monitor.app import create_app
from monitor.policy import activate_pending


@pytest.fixture
def client(database, settings):
    with TestClient(create_app(settings, database)) as client:
        client.headers["Authorization"] = "Bearer " + settings.operator_token.get_secret_value()
        yield client


def test_live_book_stays_empty_and_separate_from_replay(client):
    assert client.get("/fund").json()["data_status"] == "unfunded"
    assert client.get("/fund").json()["contributions"] == "0"
    assert client.get("/events").json() == []
    assert client.get("/replay/frames").json() == []
    assert client.get("/audit/verify").json()["valid"]


def test_mutations_require_operator_token(client):
    client.headers.pop("Authorization")
    assert client.post("/kill-switch", json={"enabled": False}).status_code == 401
    assert client.post("/chat", json={"message": "cap stocks at 20%"}).status_code == 401
    assert client.get("/fund").status_code == 200


def test_chat_proposes_but_confirmation_is_separate(client):
    reply = client.post("/chat", json={"message": "cap stocks at 20%"}).json()
    assert reply["proposal"]["changes"] == {"agents": {"stocks": {"cap": "0.2"}}}
    assert client.get("/policy").json()["latest_version"] == 1
    response = client.post("/policy/confirm", json={"expected_version": 1, "changes": reply["proposal"]["changes"]})
    assert response.status_code == 200
    assert response.json()["status"] == "pending"
    policy = client.get("/policy").json()
    assert policy["active"]["version"] == 1
    assert policy["pending"]["version"] == 2
    assert client.post("/policy/confirm", json={"expected_version": 1, "changes": {}}).status_code == 409


def test_infeasible_caps_and_arming_are_rejected(client):
    changes = {"agents": {name: {"cap": ".20"} for name in ("btc", "eth", "gold", "stocks")}}
    assert client.post("/policy/confirm", json={"expected_version": 1, "changes": changes}).status_code == 422
    assert client.post("/arm", json={"confirmation": "ARM PREPROD"}).status_code == 409
    assert not client.get("/fund").json()["armed"]


def test_policy_does_not_activate_mid_round(client, database):
    client.post("/policy/confirm", json={"expected_version": 1, "changes": {"agents": {"stocks": {"cap": ".20"}}}})
    with database.transaction() as session:
        session.add(AllocationRound(id="partial-round", policy_version=1, state="partial", weights_before={}, target_weights={}, snapshot_ids=[], scores={}, legs=[]))
    with database.transaction() as session:
        assert activate_pending(session, utcnow() + timedelta(hours=1)).version == 1
        session.get(AllocationRound, "partial-round").state = "settled"
    with database.transaction() as session:
        assert activate_pending(session, utcnow() + timedelta(hours=1)).version == 2


def test_kill_switch_is_audited_and_cannot_implicitly_arm(client):
    assert client.post("/kill-switch", json={"enabled": False}).status_code == 200
    assert not client.get("/fund").json()["armed"]
    client.post("/kill-switch", json={"enabled": True})
    assert client.get("/fund").json()["kill_switch"]
    assert len(client.get("/events").json()) == 2
    assert client.get("/audit/verify").json()["valid"]