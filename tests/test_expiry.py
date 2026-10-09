from datetime import datetime, timezone

from agents.common.chains import SolanaClient


class FakeSolana(SolanaClient):
    def __init__(self, settings, balance=100, finalized=200):
        self.settings, self.balance, self.finalized = settings, balance, finalized

    async def status(self, signature):
        return None

    async def rpc(self, method, params):
        return self.finalized if method == "getBlockHeight" else []

    async def token_accounts(self, owner, program):
        from agents.common.config import TOKEN_PROGRAM
        return {"value": [{"account": {"data": {"parsed": {"info": {"mint": "usdc", "tokenAmount": {"amount": str(self.balance)}}}}}}] if program == TOKEN_PROGRAM else []}


async def test_expiry_requires_finalized_history_and_unchanged_balances(settings):
    now = datetime.now(timezone.utc)
    validity = {"last_valid_height": 100, "balances_before": {"usdc": "100"}}
    assert (await FakeSolana(settings).observe_attempt("sig", validity, "owner", now))["state"] == "failed"
    assert (await FakeSolana(settings, balance=90).observe_attempt("sig", validity, "owner", now))["state"] == "unknown"
    assert (await FakeSolana(settings, finalized=90).observe_attempt("sig", validity, "owner", now))["state"] == "unknown"
    assert (await FakeSolana(settings).observe_attempt("sig"))["state"] == "unknown"