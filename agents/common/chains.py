from decimal import Decimal

import httpx
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address

from agents.common.config import TOKEN_PROGRAM
from agents.common.errors import DomainError
from agents.gateway.settlement import VerifiedReceipt


GENESIS = {"devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}


def verify_cardano_receipt(settings, tx_id: str, locator: str, transaction: dict, utxos: dict, confirmations: int, source: str, destination: str, amount_raw: int) -> VerifiedReceipt:
    try:
        output_index = int(locator)
    except ValueError as error:
        raise DomainError("Cardano receipt locator must be an output index") from error
    outputs = [output for output in utxos.get("outputs", []) if output.get("output_index") == output_index]
    inputs = [item for item in utxos.get("inputs", []) if not item.get("reference") and not item.get("collateral")]
    if transaction.get("hash") != tx_id or utxos.get("hash") != tx_id or transaction.get("valid_contract") is False or confirmations < 1 or not transaction.get("block"):
        raise DomainError("Cardano source is not successfully confirmed")
    if not inputs or any(item.get("address") != source for item in inputs):
        raise DomainError("Unsupported multi-source receipt or wrong Cardano source owner")
    if len(outputs) != 1 or outputs[0].get("address") != destination:
        raise DomainError("Cardano locator is not the expected gateway output")
    amount = sum(int(item["quantity"]) for item in outputs[0].get("amount", []) if item.get("unit") == settings.stablecoin_unit)
    if amount != amount_raw:
        raise DomainError("Cardano native asset or actual output amount is incorrect")
    return VerifiedReceipt(settings.environment, "cardano", tx_id, str(output_index), settings.stablecoin_unit, amount, source, destination, True, True, transaction["block"])


def verify_solana_receipt(settings, signature: str, locator: str, transaction: dict, status: dict, source: str, destination: str, amount_raw: int) -> VerifiedReceipt:
    meta = transaction.get("meta") or {}
    if "err" not in meta or meta["err"] is not None or status.get("err") is not None or status.get("confirmationStatus") not in ("confirmed", "finalized"):
        raise DomainError("Solana source transaction is not successfully confirmed")
    message = transaction.get("transaction", {}).get("message", {})
    if signature not in transaction.get("transaction", {}).get("signatures", []):
        raise DomainError("Solana signature does not identify the fetched transaction")
    accounts = message.get("accountKeys", [])
    keys = [item["pubkey"] if isinstance(item, dict) else item for item in accounts]
    signers = {item["pubkey"] for item in accounts if isinstance(item, dict) and item.get("signer")}
    instructions = {str(index): instruction for index, instruction in enumerate(message.get("instructions", []))}
    for group in meta.get("innerInstructions", []) or []:
        instructions.update({f"{group['index']}:{index}": instruction for index, instruction in enumerate(group["instructions"])})
    instruction = instructions.get(locator, {})
    info = instruction.get("parsed", {}).get("info", {})
    if instruction.get("programId") != TOKEN_PROGRAM or instruction.get("parsed", {}).get("type") != "transferChecked":
        raise DomainError("Receipt must identify an SPL Token transferChecked instruction")
    if info.get("mint") != settings.usdc_mint or info.get("tokenAmount", {}).get("decimals") != 6 or str(info.get("tokenAmount", {}).get("amount")) != str(amount_raw):
        raise DomainError("Wrong USDC mint, decimals, or raw transfer amount")
    expected_ata = str(get_associated_token_address(Pubkey.from_string(destination), Pubkey.from_string(settings.usdc_mint)))
    if info.get("destination") != expected_ata or info.get("authority") != source or source not in signers:
        raise DomainError("Wrong transfer authority or gateway destination ATA")
    try:
        source_index, destination_index = keys.index(info["source"]), keys.index(expected_ata)
    except (ValueError, KeyError) as error:
        raise DomainError("Token accounts are absent from the transaction") from error
    before = {row["accountIndex"]: row for row in meta.get("preTokenBalances", [])}
    after = {row["accountIndex"]: row for row in meta.get("postTokenBalances", [])}
    source_balance = before.get(source_index, {})
    destination_balance = after.get(destination_index, {})
    if source_balance.get("owner") != source or source_balance.get("mint") != settings.usdc_mint or destination_balance.get("owner") != destination or destination_balance.get("mint") != settings.usdc_mint:
        raise DomainError("Token account ownership or mint does not match principal wallets")
    related = [item.get("parsed", {}).get("info", {}) for item in instructions.values() if item.get("programId") == TOKEN_PROGRAM and item.get("parsed", {}).get("info", {}).get("destination") == expected_ata]
    if any(item.get("authority") != source or item.get("mint") != settings.usdc_mint for item in related):
        raise DomainError("Unsupported multi-source Solana receipt")
    total_transferred = sum(int(item.get("tokenAmount", {}).get("amount", 0)) for item in related)
    net = int(destination_balance["uiTokenAmount"]["amount"]) - int(before.get(destination_index, {}).get("uiTokenAmount", {}).get("amount", 0))
    source_net = int(source_balance["uiTokenAmount"]["amount"]) - int(after.get(source_index, {}).get("uiTokenAmount", {}).get("amount", 0))
    if net != total_transferred or source_net < amount_raw:
        raise DomainError("Confirmed net USDC movements do not reconcile to the receipt")
    return VerifiedReceipt(settings.environment, "solana", signature, locator, settings.usdc_mint, amount_raw, source, destination, True, True, str(transaction["slot"]))


class SolanaClient:
    def __init__(self, settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=25)
        self.network_verified = False

    async def rpc(self, method: str, params: list):
        if not self.network_verified and method != "getGenesisHash":
            genesis = await self.rpc("getGenesisHash", [])
            if genesis != GENESIS[self.settings.solana_cluster]:
                raise DomainError("Solana RPC belongs to the wrong network", 503)
            self.network_verified = True
        response = await self.client.post(self.settings.solana_rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        response.raise_for_status()
        body = response.json()
        if body.get("error") or "result" not in body:
            raise DomainError("Solana RPC could not establish transaction state", 503)
        return body["result"]

    async def transaction(self, signature: str):
        return await self.rpc("getTransaction", [signature, {"encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}])

    async def status(self, signature: str):
        result = await self.rpc("getSignatureStatuses", [[signature], {"searchTransactionHistory": True}])
        return result["value"][0]

    async def verify_receipt(self, signature: str, locator: str, source: str, destination: str, amount_raw: int):
        transaction, status = await self.transaction(signature), await self.status(signature)
        if not transaction or not status:
            raise DomainError("Original source transaction is pending or unknown", 409)
        return verify_solana_receipt(self.settings, signature, locator, transaction, status, source, destination, amount_raw)

    async def observe_attempt(self, signature: str, validity=None, owner=None, created_at=None):
        status = await self.status(signature)
        if not status:
            validity = validity or {}
            expected = validity.get("balances_before")
            height = validity.get("last_valid_height")
            if expected and height and owner and created_at:
                finalized_height = await self.rpc("getBlockHeight", [{"commitment": "finalized"}])
                if finalized_height > int(height):
                    history = await self.rpc("getSignaturesForAddress", [owner, {"limit": 1000, "commitment": "finalized"}])
                    complete = len(history) < 1000 or (history[-1].get("blockTime") and history[-1]["blockTime"] <= created_at.timestamp())
                    if complete and all(row.get("signature") != signature and row.get("blockTime") is not None for row in history):
                        from agents.common.config import TOKEN_2022_PROGRAM
                        observed = {}
                        for program in (TOKEN_PROGRAM, TOKEN_2022_PROGRAM):
                            accounts = await self.token_accounts(owner, program)
                            for row in accounts["value"]:
                                info = row["account"]["data"]["parsed"]["info"]
                                observed[info["mint"]] = observed.get(info["mint"], 0) + int(info["tokenAmount"]["amount"])
                        if all(observed.get(mint, 0) == int(amount) for mint, amount in expected.items()):
                            return {"tx_id": signature, "state": "failed", "expired": True, "history_checked": True, "inputs_unspent": True, "balance_effects_unchanged": True, "finality_reached": True}
            return {"tx_id": signature, "state": "unknown"}
        confirmed = status.get("confirmationStatus") in ("confirmed", "finalized")
        if status.get("err") is not None and confirmed:
            return {"tx_id": signature, "state": "failed", "confirmed_failure": True}
        return {"tx_id": signature, "state": "confirmed" if confirmed else "unknown", "success": status.get("err") is None, "confirmed": confirmed, "slot": status.get("slot")}

    async def token_accounts(self, owner: str, program: str):
        result = await self.rpc("getTokenAccountsByOwner", [owner, {"programId": program}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
        return result

    async def mint_info(self, mint: str):
        result = await self.rpc("getAccountInfo", [mint, {"encoding": "jsonParsed", "commitment": "confirmed"}])
        account = result.get("value")
        if not account:
            raise DomainError("Mint account is unavailable", 503)
        info = account["data"]["parsed"]["info"]
        multiplier = Decimal(1)
        for extension in info.get("extensions", []):
            if extension.get("extension") == "scaledUiAmountConfig":
                state = extension["state"]
                multiplier = Decimal(str(state["multiplier"]))
                from time import time
                if int(state.get("newMultiplierEffectiveTimestamp", 2 ** 63 - 1)) <= time():
                    multiplier = Decimal(str(state["newMultiplier"]))
        if not multiplier.is_finite() or multiplier <= 0:
            raise DomainError("Scaled-UI multiplier is invalid")
        return {"decimals": info["decimals"], "multiplier": str(multiplier), "program": account["owner"], "slot": result["context"]["slot"]}


class CardanoClient:
    def __init__(self, settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=25)

    async def get(self, path: str, params=None, allow_missing=False):
        key = self.settings.blockfrost_project_id.get_secret_value()
        if not key or not key.startswith(self.settings.environment):
            raise DomainError("A network-matched Blockfrost project key is required", 503)
        response = await self.client.get(self.settings.blockfrost_url + path, headers={"project_id": key}, params=params)
        if allow_missing and response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    async def verify_receipt(self, tx_id: str, locator: str, source: str, destination: str, amount_raw: int):
        transaction = await self.get(f"/txs/{tx_id}", allow_missing=True)
        if not transaction:
            raise DomainError("Original Cardano source is pending or unknown", 409)
        utxos = await self.get(f"/txs/{tx_id}/utxos")
        block = await self.get(f"/blocks/{transaction['block']}")
        return verify_cardano_receipt(self.settings, tx_id, locator, transaction, utxos, block.get("confirmations", 0), source, destination, amount_raw)