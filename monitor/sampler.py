from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from agents.common.accounting import Book, marked_value
from agents.common.attempts import UNRESOLVED
from agents.common.chains import CardanoClient, SolanaClient
from agents.common.config import MARKETS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, V2_ADDRESSES
from agents.common.db import append_event, iso, recognize
from agents.common.errors import DomainError
from agents.common.jupiter import JupiterClient
from agents.common.models import AccountingEntry, BookState, ChainAttempt, Controls, Decision, Intent, Inventory, Price, ReceiptClaim, RuntimeState, Trade, Transfer, ValueSnapshot, Wallet, utcnow
from agents.common.safety import daily_stop
from agents.gateway.settlement import aware


SOL_MINT = "So11111111111111111111111111111111111111112"


def token_holdings(session, agent_id: str) -> int:
    raw = 0
    mint = MARKETS[agent_id]["mint"]
    for row in session.scalars(select(Trade).where(Trade.agent_id == agent_id)):
        if row.body.get("output_mint") == mint:
            raw += int(row.body["output_raw"])
        if row.body.get("input_mint") == mint:
            raw -= int(row.body["input_raw"])
    if raw < 0:
        raise DomainError("Confirmed token journal has a negative balance", 409)
    return raw


def network_cost(session, agent_id, chain, tx_id, fee_raw, confirmed_at):
    mint = "ADA" if chain == "cardano" else SOL_MINT
    mark = session.scalar(select(Price).where(Price.mint == mint, Price.sampled_at <= confirmed_at).order_by(Price.sampled_at.desc()).limit(1))
    if not mark or not 0 <= (aware(confirmed_at) - aware(mark.sampled_at)).total_seconds() <= 120:
        raise DomainError("Confirmation-time network-fee mark is unavailable; recognition remains pending", 409)
    fee = Decimal(fee_raw) / (1_000_000 if chain == "cardano" else 1_000_000_000) * Decimal(mark.usd)
    recognize(session, agent_id, "network_fee", fee, f"{chain}:{tx_id}:network")


class Sampler:
    def __init__(self, database, settings, cardano=None, solana=None, jupiter=None):
        self.database, self.settings = database, settings
        self.cardano = cardano or CardanoClient(settings)
        self.solana = solana or SolanaClient(settings)
        self.jupiter = jupiter or JupiterClient(settings, settings.agent_ids[0], "")

    def component_status(self, component, status, reason=""):
        with self.database.transaction() as session:
            row = session.get(RuntimeState, 1, with_for_update=True)
            if row:
                row.body = {**row.body, component: {"status": status, "reason": reason, "updated_at": iso(utcnow())}}

    async def refresh_inventory(self):
        with self.database.transaction() as session:
            wallets = {wallet.chain: wallet for wallet in session.scalars(select(Wallet).where(Wallet.agent_id == "gateway", Wallet.role.in_(("capital", "gateway_inventory"))))}
        if set(wallets) != {"cardano", "solana"} or not self.settings.usdc_mint:
            raise DomainError("Register the gateway's two principal wallets and environment-specific USDC mint first", 409)
        cardano = await self.cardano.get(f"/addresses/{wallets['cardano'].address}", allow_missing=True)
        accounts = await self.solana.token_accounts(wallets["solana"].address, TOKEN_PROGRAM)
        observed = {"cardano": sum(int(amount["quantity"]) for amount in (cardano or {}).get("amount", []) if amount["unit"] == self.settings.stablecoin_unit), "solana": sum(int(row["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for row in accounts["value"] if row["account"]["data"]["parsed"]["info"]["mint"] == self.settings.usdc_mint)}
        with self.database.transaction() as session:
            busy = session.scalar(select(Intent.id).where(Intent.state.not_in(("fulfilled", "refunded", "expired"))))
            unknown = session.scalar(select(ChainAttempt.id).where(ChainAttempt.state.in_(UNRESOLVED)))
            rows = list(session.scalars(select(Inventory).order_by(Inventory.chain).with_for_update()))
            for row in rows:
                if (busy or unknown) and row.confirmed_raw != observed[row.chain]:
                    raise DomainError("Inventory changed during unresolved work; reconcile receipts before accepting a top-up", 409)
                if observed[row.chain] < row.reserved_raw + row.protected_raw:
                    raise DomainError("Observed inventory does not cover existing obligations", 409)
                row.confirmed_raw = observed[row.chain]
                row.sampled_at = utcnow()
            append_event(session, "inventory_reconciled", {chain: str(value) for chain, value in observed.items()})
        return {"status": "reconciled", "observed_raw": {chain: str(value) for chain, value in observed.items()}, "reservations_preserved": True}

    async def collect_prices(self):
        if self.settings.environment != "mainnet":
            return
        mints = [self.settings.usdc_mint, SOL_MINT] + [MARKETS[name]["mint"] for name in self.settings.agent_ids]
        if self.settings.ada_price_mint:
            mints.append(self.settings.ada_price_mint)
        result = await self.jupiter.prices(mints)
        now = utcnow()
        rows = []
        for mint in mints:
            data = result.get(mint)
            if not data or "usdPrice" not in data:
                raise DomainError("A required Jupiter valuation mark is missing", 503)
            price = Decimal(str(data["usdPrice"]))
            if not price.is_finite() or price <= 0:
                raise DomainError("Jupiter returned an invalid valuation mark", 503)
            multiplier = "1"
            if mint in {MARKETS[name]["mint"] for name in self.settings.agent_ids}:
                info = await self.solana.mint_info(mint)
                market = next(market for market in MARKETS.values() if market["mint"] == mint)
                expected_program = TOKEN_2022_PROGRAM if market["program"] == "token2022" else TOKEN_PROGRAM
                if info["decimals"] != market["decimals"] or info["program"] != expected_program:
                    raise DomainError("Allowlisted mint metadata changed; operator review required", 409)
                multiplier = info["multiplier"]
            rows.append(Price(mint="ADA" if mint == self.settings.ada_price_mint else mint, usd=str(price), multiplier=multiplier, block_id=str(data.get("blockId", "")), sampled_at=now))
        with self.database.transaction() as session:
            session.add_all(rows)

    async def discover_contributions(self, wallet):
        with self.database.transaction() as session:
            known = {row.address for row in session.scalars(select(Wallet))} | set(V2_ADDRESSES.values())
        for page_number in range(1, 11):
            transactions = await self.cardano.get(f"/addresses/{wallet.address}/transactions", params={"order": "desc", "count": 100, "page": page_number}, allow_missing=True) or []
            for transaction in transactions:
                tx_id = transaction["tx_hash"]
                utxos = await self.cardano.get(f"/txs/{tx_id}/utxos")
                inputs = [row for row in utxos.get("inputs", []) if not row.get("reference") and not row.get("collateral")]
                if not inputs or any(row["address"] in known for row in inputs):
                    continue
                details = await self.cardano.get(f"/txs/{tx_id}")
                block = await self.cardano.get(f"/blocks/{details['block']}")
                if details.get("valid_contract") is False or block.get("confirmations", 0) < 1:
                    continue
                for output in utxos["outputs"]:
                    if output["address"] != wallet.address:
                        continue
                    raw = sum(int(value["quantity"]) for value in output["amount"] if value["unit"] == self.settings.stablecoin_unit)
                    if raw <= 0:
                        continue
                    locator = str(output["output_index"])
                    with self.database.transaction() as session:
                        session.get(BookState, wallet.agent_id, with_for_update=True)
                        if session.scalar(select(ReceiptClaim.id).where(ReceiptClaim.environment == self.settings.environment, ReceiptClaim.chain == "cardano", ReceiptClaim.tx_id == tx_id, ReceiptClaim.locator == locator)):
                            continue
                        holdings = token_holdings(session, wallet.agent_id)
                        if holdings:
                            at = datetime.fromtimestamp(details["block_time"], timezone.utc)
                            mark = session.scalar(select(Price).where(Price.mint == MARKETS[wallet.agent_id]["mint"], Price.sampled_at <= at).order_by(Price.sampled_at.desc()).limit(1))
                            if not mark or (at - aware(mark.sampled_at)).total_seconds() > 120:
                                raise DomainError("Contribution-time NAV cannot be reconstructed", 409)
                            value = marked_value(holdings, MARKETS[wallet.agent_id]["decimals"], mark.usd, mark.multiplier)
                            recognize(session, wallet.agent_id, "mark", value, f"cardano:{tx_id}:{locator}:pre_flow_mark", source="token")
                        proof = {"wallet_id": wallet.id, "amount_raw": str(raw), "block": details["block"], "source_addresses": sorted({row["address"] for row in inputs})}
                        session.add(ReceiptClaim(environment=self.settings.environment, chain="cardano", tx_id=tx_id, locator=locator, intent_id="external:" + wallet.id, proof=proof))
                        session.add(Transfer(environment=self.settings.environment, chain="cardano", tx_id=tx_id, locator=locator, kind="deposit", body=proof))
                        recognize(session, wallet.agent_id, "contribution", Decimal(raw) / 1_000_000, f"cardano:{tx_id}:{locator}:deposit", source="purchasing" if wallet.role == "purchasing" else "capital", flow_at=datetime.fromtimestamp(details["block_time"], timezone.utc))
                        append_event(session, "external_contribution", {"agent": wallet.agent_id, "chain": "cardano", "tx_id": tx_id, "locator": locator, "amount_raw": str(raw), "role": wallet.role})
            if len(transactions) < 100:
                return
        raise DomainError("Deposit history exceeds the bounded scan; checkpoint reconciliation is required", 409)

    async def sample_agent(self, name):
        now = utcnow().replace(second=0, microsecond=0)
        with self.database.transaction() as session:
            wallets = {row.role: row for row in session.scalars(select(Wallet).where(Wallet.agent_id == name))}
        if not {"capital", "purchasing", "trading"} <= set(wallets):
            raise DomainError("Principal, purchasing, and trading wallets are not configured", 409)
        observed = {}
        for role in ("capital", "purchasing"):
            await self.discover_contributions(wallets[role])
            balance = await self.cardano.get(f"/addresses/{wallets[role].address}", allow_missing=True) or {}
            observed[role] = sum(int(row["quantity"]) for row in balance.get("amount", []) if row["unit"] == self.settings.stablecoin_unit)
        tokens, slots = {}, []
        for program in (TOKEN_PROGRAM, TOKEN_2022_PROGRAM):
            result = await self.solana.token_accounts(wallets["trading"].address, program)
            slots.append(result["context"]["slot"])
            for row in result["value"]:
                info = row["account"]["data"]["parsed"]["info"]
                tokens[info["mint"]] = tokens.get(info["mint"], 0) + int(info["tokenAmount"]["amount"])
        with self.database.transaction() as session:
            state = session.get(BookState, name, with_for_update=True)
            book = Book.from_json(state.body)
            expected_token = token_holdings(session, name)
            valid, reason = True, ""
            latest = session.scalar(select(Price).where(Price.mint == MARKETS[name]["mint"]).order_by(Price.sampled_at.desc()).limit(1))
            if expected_token:
                if not latest or (utcnow() - aware(latest.sampled_at)).total_seconds() > 120:
                    valid, reason = False, "Stale or missing token valuation"
                else:
                    marked = marked_value(expected_token, MARKETS[name]["decimals"], latest.usd, latest.multiplier)
                    book = recognize(session, name, "mark", marked, f"mark:{name}:{latest.id}", source="token")
            expected = {"capital": book.assets["capital"] * 1_000_000, "purchasing": book.assets["purchasing"] * 1_000_000, "usdc": book.assets["usdc"] * 1_000_000, "token": Decimal(expected_token)}
            observed.update(usdc=tokens.get(self.settings.usdc_mint, 0), token=tokens.get(MARKETS[name]["mint"], 0))
            if any(abs(Decimal(observed[bucket]) - expected[bucket]) > 1 for bucket in expected):
                valid, reason = False, "reconcile_mismatch: observed raw balances differ from the ledger"
            unresolved = session.scalar(select(ChainAttempt.id).where(ChainAttempt.wallet_id.in_([wallet.id for wallet in wallets.values()]), ChainAttempt.state.in_(UNRESOLVED)))
            pending_decision = session.scalar(select(Decision.id).where(Decision.agent_id == name, Decision.status.in_(("prepared", "submitted", "valuation_pending"))))
            if unresolved or pending_decision:
                valid, reason = False, "Unresolved transaction or pending fill accounting"
            first_today = session.scalar(select(ValueSnapshot).where(ValueSnapshot.agent_id == name, ValueSnapshot.valid.is_(True), ValueSnapshot.sampled_at >= now.replace(hour=0, minute=0)).order_by(ValueSnapshot.sampled_at).limit(1))
            previous_day = session.scalar(select(ValueSnapshot.id).where(ValueSnapshot.agent_id == name, ValueSnapshot.sampled_at < now.replace(hour=0, minute=0), ValueSnapshot.valid.is_(True)).limit(1))
            baseline = None
            if first_today and (aware(first_today.sampled_at).hour == 0 and aware(first_today.sampled_at).minute == 0):
                baseline = Decimal(first_today.body["nav"]) if first_today.body.get("nav") else None
            elif not previous_day and book.units:
                oldest = session.scalar(select(AccountingEntry).where(AccountingEntry.owner == name, AccountingEntry.component == "contribution").order_by(AccountingEntry.recognized_at).limit(1))
                if oldest and aware(oldest.recognized_at).date() == now.date():
                    baseline = Decimal(1)
            controls = session.get(Controls, 1, with_for_update=True)
            stops = dict(controls.state.get("stops", {}))
            stops[name] = daily_stop(stops.get(name), now, book.nav if valid else None, baseline)
            controls.state = {**controls.state, "stops": stops}
            existing = session.scalar(select(ValueSnapshot).where(ValueSnapshot.agent_id == name, ValueSnapshot.sampled_at == now))
            body = {"equity": str(book.equity), "units": str(book.units), "nav": str(book.nav) if book.nav is not None else None, "assets": {key: str(value) for key, value in book.assets.items()}, "payable": str(book.payable), "reason": reason, "observed_raw": {key: str(value) for key, value in observed.items()}, "solana_slots": slots, "price_id": latest.id if latest else None, "dust_raw": "1", "baseline_valid": baseline is not None}
            if existing:
                existing.body, existing.valid = body, valid
            else:
                session.add(ValueSnapshot(agent_id=name, sampled_at=now, valid=valid, body=body))
            if not valid:
                append_event(session, "reconcile_mismatch", {"agent": name, "reason": reason})
        return valid

    async def tick(self):
        failures = []
        try:
            await self.collect_prices()
        except Exception:
            failures.append("Valuation source unavailable")
        for name in self.settings.agent_ids:
            try:
                if not await self.sample_agent(name):
                    failures.append(name + ": reconciliation pending")
            except DomainError as error:
                failures.append(name + ": " + str(error))
            except Exception:
                failures.append(name + ": chain observation unavailable")
        self.component_status("sampler", "blocked" if failures else "ready", "; ".join(failures))
        if not failures:
            from agents.common.benchmarks import summary
            with self.database.transaction() as session:
                benchmark = summary(session)
                for name in self.settings.agent_ids:
                    row = session.scalar(select(ValueSnapshot).where(ValueSnapshot.agent_id == name).order_by(ValueSnapshot.sampled_at.desc()).limit(1))
                    if row:
                        row.body = {**row.body, "benchmark_equity": benchmark["equity"], "benchmark_status": benchmark["status"]}
        return {"status": "blocked" if failures else "ready", "reasons": failures}

    async def close(self):
        await self.cardano.client.aclose()
        await self.solana.client.aclose()
        await self.jupiter.client.aclose()