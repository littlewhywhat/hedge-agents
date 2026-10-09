from datetime import datetime, timedelta, timezone
import json

import httpx
from masumi.helper_functions import create_masumi_input_hash, create_masumi_output_hash
import pytest

from agents.common.config import V2_ADDRESSES
from agents.common.errors import DomainError
from agents.common.masumi import DEADLINES, MasumiClient, create_request, input_hash, output_hash, purchase_payload, select_source
from agents.common.models import MasumiJob


def source(settings):
    return {"chain": "Cardano", "network": "Preprod", "settlement": {"paymentSourceType": "Web3CardanoV2", "address": V2_ADDRESSES["preprod"]}, "pricing": {"pricingType": "Fixed", "fixedPricing": [{"amount": "100000", "unit": settings.stablecoin_unit}]}}


def test_selects_advertised_v2_index(settings):
    assert select_source([{"chain": "Base"}, source(settings)], settings, 100000) == 1
    with pytest.raises(DomainError):
        select_source([source(settings), source(settings)], settings, 100000)
    with pytest.raises(DomainError):
        select_source([source(settings)], settings, 100001)
    wrong = source(settings)
    wrong["settlement"]["paymentSourceType"] = "Web3CardanoV1"
    with pytest.raises(DomainError):
        select_source([wrong], settings, 100000)


def test_nonce_and_mip004_hashes():
    nonce, data = "ab" * 10, {"intent_id": "abc", "amount_raw": "25000000", "nested": {"z": 1, "a": 2}}
    assert input_hash(nonce, data) == create_masumi_input_hash(data, nonce)
    result = json.dumps(data)
    assert output_hash(nonce, result) == create_masumi_output_hash(result, nonce)
    with pytest.raises(DomainError):
        input_hash("default_purchaser_id", data)


def job_fixture(settings):
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    request = create_request(settings, "registry", 2, "ab" * 10, {}, now)
    payment = {name: str(int((now + timedelta(minutes=minutes)).timestamp() * 1000)) for name, minutes in DEADLINES.items()}
    payment.update({"SmartContractWallet": [{"walletVkey": "seller"}], "RequestedFunds": [{"amount": "100000", "unit": settings.stablecoin_unit}], "forceLayer": "L1"})
    return now, MasumiJob(id="job", source_index=2, blockchain_identifier="blockchain", nonce="ab" * 10, input_hash=request["inputHash"], terms={"request": request, "payment": payment})


def test_buffered_deadlines_and_purchase_reuses_returned_terms(settings):
    now, job = job_fixture(settings)
    payload = purchase_payload(settings, job, now, "buyer-address")
    for field, minutes in DEADLINES.items():
        assert datetime.fromisoformat(job.terms["request"][field].replace("Z", "+00:00")) - now == timedelta(minutes=minutes)
        assert payload[field] == job.terms["payment"][field]
    assert payload["unlockTime"] != payload["externalDisputeUnlockTime"]
    assert payload["supportedPaymentSourceIndex"] == 2
    assert payload["paymentForceLayer"] == "L1"
    assert "paymentType" not in payload


def test_exhausted_or_skewed_clock_blocks_funding(settings):
    now, job = job_fixture(settings)
    with pytest.raises(DomainError, match="buffer"):
        purchase_payload(settings, job, now + timedelta(minutes=2), "buyer")
    with pytest.raises(DomainError, match="Clock skew"):
        purchase_payload(settings, job, now - timedelta(minutes=2), "buyer")
    job.source_index = None
    with pytest.raises(DomainError):
        purchase_payload(settings, job, now, "buyer")


@pytest.mark.parametrize("index", [None, -1, 25, True])
def test_missing_or_invalid_selection_rejected(settings, index):
    with pytest.raises(DomainError):
        create_request(settings, "registry", index, "ab" * 10, {}, datetime.now(timezone.utc))


async def test_list_always_filters_v2(settings):
    seen = []
    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"Payments": []}})
    settings = settings.model_copy(update={"payment_read_key": settings.operator_token})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        await MasumiClient(settings, client).list_records("payment")
    assert seen[0].url.params["filterPaymentSourceType"] == "Web3CardanoV2"
    assert seen[0].headers["token"] == settings.operator_token.get_secret_value()


async def test_lost_creation_response_recovers_one_job_and_nonce(database, settings):
    from agents.common.models import Agent
    from agents.common.masumi import JobService
    with database.transaction() as session:
        agent = session.get(Agent, "btc")
        agent.registry_id = "registry-btc"
        advertised = source(settings)
        advertised["pricing"]["fixedPricing"][0]["amount"] = "10000"
        agent.details = {"supportedPaymentSources": [advertised]}
    now = datetime(2026, 10, 9, tzinfo=timezone.utc)
    class LostResponseClient:
        def __init__(self):
            self.creations, self.rows = 0, []

        async def request(self, method, path, payload):
            self.creations += 1
            payment = {"blockchainIdentifier": "one-chain-job", "inputHash": payload["inputHash"], "metadata": payload["metadata"], "RequestedFunds": [{"amount": "10000", "unit": settings.stablecoin_unit}], "PaymentSource": {"paymentSourceType": "Web3CardanoV2", "network": "Preprod", "smartContractAddress": V2_ADDRESSES["preprod"]}, **{name: str(int(datetime.fromisoformat(payload[name].replace("Z", "+00:00")).timestamp() * 1000)) for name in DEADLINES}}
            self.rows.append(payment)
            raise httpx.ReadTimeout("creation response lost")

        async def list_records(self, kind, **filters):
            return self.rows
    client = LostResponseClient()
    service = JobService(database, settings, client, clock=lambda: now)
    original = await service.open("btc", "btc", "report-one", {"window": "latest"})
    assert original["state"] == "creation_unknown"
    restarted = JobService(database, settings, client, clock=lambda: now)
    recovered = await restarted.open("btc", "btc", "report-one", {"window": "latest"})
    assert recovered["id"] == original["id"]
    assert recovered["identifierFromPurchaser"] == original["identifierFromPurchaser"]
    assert recovered["blockchainIdentifier"] == "one-chain-job"
    assert client.creations == 1