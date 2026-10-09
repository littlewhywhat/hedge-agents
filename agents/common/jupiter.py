import base64

import httpx
from solders.message import to_bytes_versioned
from solders.transaction import VersionedTransaction

from agents.common.config import MARKETS
from agents.common.errors import DomainError


def sign_taker(transaction_base64: str, keypair) -> tuple[bytes, str]:
    transaction = VersionedTransaction.from_bytes(base64.b64decode(transaction_base64, validate=True))
    message = to_bytes_versioned(transaction.message)
    required = list(transaction.message.account_keys[:transaction.message.header.num_required_signatures])
    if keypair.pubkey() not in required:
        raise DomainError("Taker is not a required signer in the Jupiter message")
    slot = required.index(keypair.pubkey())
    signatures = list(transaction.signatures)
    if len(signatures) != len(required):
        raise DomainError("Malformed versioned transaction signature slots")
    for index, signature in enumerate(signatures):
        if index != slot and not signature.verify(required[index], message):
            raise DomainError("Jupiter co-signer signature is missing or invalid")
    signatures[slot] = keypair.sign_message(message)
    signed = VersionedTransaction.populate(transaction.message, signatures)
    return bytes(signed), str(signed.signatures[0])


class JupiterClient:
    def __init__(self, settings, agent_id: str, taker: str, client: httpx.AsyncClient | None = None):
        self.settings, self.agent_id, self.taker = settings, agent_id, taker
        self.client = client or httpx.AsyncClient(timeout=25, follow_redirects=False)

    def headers(self):
        if not self.settings.jupiter_api_key.get_secret_value():
            raise DomainError("Jupiter API key is not configured", 503)
        return {"x-api-key": self.settings.jupiter_api_key.get_secret_value()}

    async def order(self, input_mint: str, output_mint: str, amount: int, slippage: int) -> dict:
        if self.settings.environment != "mainnet":
            raise DomainError("Jupiter tokenized markets do not exist on devnet", 409)
        if {input_mint, output_mint} != {self.settings.usdc_mint, MARKETS[self.agent_id]["mint"]} or input_mint == output_mint:
            raise DomainError("Mint is outside the trader allowlist")
        if self.agent_id == "stocks" and not self.settings.xstocks_eligible:
            raise DomainError("Operator xStocks eligibility must be explicitly acknowledged", 423)
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0 or not 0 < slippage <= 100:
            raise DomainError("Invalid base-unit amount or slippage")
        response = await self.client.get(self.settings.jupiter_url + "/swap/v2/order", headers=self.headers(), params={"inputMint": input_mint, "outputMint": output_mint, "amount": str(amount), "taker": self.taker, "slippageBps": slippage})
        response.raise_for_status()
        order = response.json()
        if not order.get("transaction") or not order.get("requestId") or not order.get("lastValidBlockHeight"):
            raise DomainError("Jupiter did not provide a complete executable order", 502)
        return order

    async def execute(self, signed_bytes: bytes, request_id: str) -> dict:
        response = await self.client.post(self.settings.jupiter_url + "/swap/v2/execute", headers=self.headers(), json={"signedTransaction": base64.b64encode(signed_bytes).decode(), "requestId": request_id})
        response.raise_for_status()
        return response.json()

    async def prices(self, mints: list[str]) -> dict:
        response = await self.client.get(self.settings.jupiter_url + "/price/v3", headers=self.headers(), params={"ids": ",".join(mints)})
        response.raise_for_status()
        return response.json()