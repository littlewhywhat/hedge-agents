import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import json

import httpx
from sqlalchemy import select, text

from agents.common.accounting import Book
from agents.common.chains import CardanoClient
from agents.common.config import Settings
from agents.common.db import Database, append_event, iso, recognize
from agents.common.errors import DomainError
from agents.common.models import AllocationRound, BookState, Controls, Policy, ReceiptClaim, RuntimeState, Transfer, Wallet, utcnow
from agents.common.solana_signer import qualification_authorized
from monitor.sampler import Sampler, network_cost
from runtime.allocation import AllocationRuntime


class FundRuntime:
    def __init__(self, database, settings):
        self.database, self.settings = database, settings
        self.allocator = AllocationRuntime(database, settings)
        self.sampler = Sampler(database, settings)
        self.cardano = CardanoClient(settings)
        self.http = httpx.AsyncClient(timeout=100)
        self.urls = json.loads(settings.trader_urls_json)

    async def call_trader(self, name, path, body):
        response = await self.http.post(self.urls[name] + path, headers={"Authorization": "Bearer " + self.settings.service_token.get_secret_value(), "X-Agent-Id": "runtime"}, json=body)
        response.raise_for_status()
        return response.json()

    async def recognize_budget(self, round_id, leg, receipt):
        if receipt.get("state") != "confirmed":
            return {"state": "pending", "attempt_id": receipt.get("id"), "tx_id": receipt.get("tx_id")}
        with self.database.transaction() as session:
            sender = session.scalar(select(Wallet).where(Wallet.agent_id == leg["sender"], Wallet.role == "capital"))
            receiver = session.scalar(select(Wallet).where(Wallet.agent_id == leg["receiver"], Wallet.role == "capital"))
            if not sender or not receiver:
                raise DomainError("Round capital wallets are not registered", 409)
        proof = await self.cardano.verify_receipt(receipt["tx_id"], receipt["locator"], sender.address, receiver.address, int(leg["amount_raw"]))
        transaction = await self.cardano.get(f"/txs/{proof.tx_id}")
        with self.database.transaction() as session:
            for name in sorted((leg["sender"], leg["receiver"])):
                session.get(BookState, name, with_for_update=True)
            claimed = session.scalar(select(ReceiptClaim).where(ReceiptClaim.environment == self.settings.environment, ReceiptClaim.chain == "cardano", ReceiptClaim.tx_id == proof.tx_id, ReceiptClaim.locator == proof.locator))
            if claimed and claimed.intent_id != leg["id"]:
                raise DomainError("Budget receipt is claimed by another operation", 409)
            if not claimed:
                at = datetime.fromtimestamp(transaction["block_time"], timezone.utc)
                network_cost(session, leg["sender"], "cardano", proof.tx_id, transaction["fees"], at)
                amount = Decimal(leg["amount_raw"]) / 1_000_000
                recognize(session, leg["sender"], "internal_out", amount, f"cardano:{proof.tx_id}:{proof.locator}:send")
                recognize(session, leg["receiver"], "internal_in", amount, f"cardano:{proof.tx_id}:{proof.locator}:receive")
                details = {"round_id": round_id, "leg_id": leg["id"], "sender": leg["sender"], "receiver": leg["receiver"], "amount_raw": leg["amount_raw"]}
                session.add(ReceiptClaim(environment=self.settings.environment, chain="cardano", tx_id=proof.tx_id, locator=proof.locator, intent_id=leg["id"], proof=details))
                session.add(Transfer(environment=self.settings.environment, chain="cardano", tx_id=proof.tx_id, locator=proof.locator, kind="x402", body=details))
                append_event(session, "budget_transfer_confirmed", {**details, "chain": "cardano", "tx_id": proof.tx_id})
        return {"state": "settled", "attempt_id": receipt["id"], "tx_id": proof.tx_id}

    async def execute_leg(self, round_id, leg, version):
        endpoints = {"raise_cash": "/cash-target", "gateway_withdraw": "/gateway-transfer", "gateway_deposit": "/gateway-transfer", "x402": "/capital/transfer", "buy_target": "/buy-target", "cashout": "/capital/transfer"}
        response = await self.call_trader(leg["agent"], endpoints[leg["kind"]], {"round_id": round_id, "leg_id": leg["id"]})
        if leg["kind"] == "x402":
            return await self.recognize_budget(round_id, leg, response)
        if leg["kind"] == "cashout":
            return await self.recognize_cashout(round_id, leg, response)
        return response

    async def recognize_cashout(self, round_id, leg, receipt):
        if receipt.get("state") != "confirmed":
            return {"state": "pending", "attempt_id": receipt.get("id"), "tx_id": receipt.get("tx_id")}
        with self.database.transaction() as session:
            source = session.scalar(select(Wallet).where(Wallet.agent_id == leg["agent"], Wallet.role == "capital"))
            destination = session.scalar(select(Wallet).where(Wallet.agent_id == "operator", Wallet.role == "distribution", Wallet.chain == "cardano"))
        if not source or not destination:
            raise DomainError("Cash-out wallets are not registered")
        proof = await self.cardano.verify_receipt(receipt["tx_id"], receipt["locator"], source.address, destination.address, int(leg["amount_raw"]))
        transaction = await self.cardano.get(f"/txs/{proof.tx_id}")
        with self.database.transaction() as session:
            row = session.get(BookState, leg["agent"], with_for_update=True)
            claimed = session.scalar(select(ReceiptClaim).where(ReceiptClaim.environment == self.settings.environment, ReceiptClaim.chain == "cardano", ReceiptClaim.tx_id == proof.tx_id, ReceiptClaim.locator == proof.locator))
            if claimed and claimed.intent_id != leg["id"]:
                raise DomainError("Cash-out receipt is already claimed", 409)
            if not claimed:
                network_cost(session, leg["agent"], "cardano", proof.tx_id, transaction["fees"], datetime.fromtimestamp(transaction["block_time"], timezone.utc))
                book = Book.from_json(row.body)
                amount = Decimal(leg["amount_raw"]) / 1_000_000
                repayment = min(amount, book.payable)
                if repayment:
                    recognize(session, leg["agent"], "expense_repayment", repayment, f"cardano:{proof.tx_id}:{proof.locator}:repayment")
                distribution = amount - repayment
                if distribution:
                    recognize(session, leg["agent"], "distribution", distribution, f"cardano:{proof.tx_id}:{proof.locator}:distribution")
                details = {"round_id": round_id, "agent": leg["agent"], "amount_raw": leg["amount_raw"], "expense_repayment_usd": str(repayment), "distribution_usd": str(distribution)}
                session.add(ReceiptClaim(environment=self.settings.environment, chain="cardano", tx_id=proof.tx_id, locator=proof.locator, intent_id=leg["id"], proof=details))
                session.add(Transfer(environment=self.settings.environment, chain="cardano", tx_id=proof.tx_id, locator=proof.locator, kind="cashout", body=details))
                append_event(session, "cashout_confirmed", {**details, "chain": "cardano", "tx_id": proof.tx_id})
        return {"state": "settled", "attempt_id": receipt["id"], "tx_id": proof.tx_id}

    async def tick(self):
        now = utcnow()
        with self.database.transaction() as session:
            state = dict(session.get(RuntimeState, 1).body)
        last_sample = datetime.fromisoformat(state["last_sample"]) if state.get("last_sample") else datetime.min.replace(tzinfo=timezone.utc)
        if (now - last_sample).total_seconds() >= self.settings.sample_seconds:
            await self.sampler.tick()
            with self.database.transaction() as session:
                runtime = session.get(RuntimeState, 1, with_for_update=True)
                runtime.body = {**runtime.body, "last_sample": iso(now)}
        boundary = int(now.timestamp()) // self.settings.allocation_seconds
        if state.get("last_boundary") != boundary:
            self.allocator.plan()
            with self.database.transaction() as session:
                runtime = session.get(RuntimeState, 1, with_for_update=True)
                runtime.body = {**runtime.body, "last_boundary": boundary}
        with self.database.transaction() as session:
            round = session.scalar(select(AllocationRound).where(AllocationRound.state.in_(("planned", "executing", "partial"))).order_by(AllocationRound.started_at).limit(1))
            round_id = round.id if round else None
            controls = session.get(Controls, 1)
            permitted = controls is not None and not controls.kill_switch and controls.armed
            if round_id and controls and not controls.kill_switch and qualification_authorized(session, self.settings, round_id):
                permitted = True
            policy = session.scalar(select(Policy).where(Policy.status == "active"))
            version = policy.version
        if round_id:
            if permitted:
                await self.allocator.advance(round_id, self.execute_leg)
            return
        if not permitted:
            return
        if state.get("last_anchor_boundary") != boundary:
            report = await self.call_trader(self.settings.agent_ids[0], "/anchor", {"request_id": f"boundary-{boundary}"})
            if report.get("state") in ("FundsLocked", "ResultSubmitted", "Withdrawn"):
                with self.database.transaction() as session:
                    runtime = session.get(RuntimeState, 1, with_for_update=True)
                    runtime.body = {**runtime.body, "last_anchor_boundary": boundary}
        last_tick = datetime.fromisoformat(state["last_tick"]) if state.get("last_tick") else datetime.min.replace(tzinfo=timezone.utc)
        if (now - last_tick).total_seconds() >= self.settings.tick_seconds:
            index = int(state.get("agent_index", 0)) % len(self.settings.agent_ids)
            await self.call_trader(self.settings.agent_ids[index], "/tick", {"policy_version": version})
            with self.database.transaction() as session:
                runtime = session.get(RuntimeState, 1, with_for_update=True)
                runtime.body = {**runtime.body, "last_tick": iso(now), "agent_index": index + 1}

    async def run(self):
        with self.database.engine.connect() as lease:
            if not lease.execute(text("SELECT pg_try_advisory_lock(684332701)")).scalar_one():
                raise RuntimeError("Another fund runtime owns the scheduler lease")
            print("Fund runtime started; normal signing remains gated by controls and recorded acceptance evidence.")
            try:
                while True:
                    try:
                        await self.tick()
                        self.sampler.component_status("runtime", "running")
                    except Exception:
                        self.sampler.component_status("runtime", "blocked", "Operation requires reconciliation; no dependent leg was admitted")
                    await asyncio.sleep(5)
            finally:
                await self.http.aclose()
                await self.cardano.client.aclose()
                await self.sampler.close()


def main():
    settings = Settings()
    asyncio.run(FundRuntime(Database(settings.database_url), settings).run())


if __name__ == "__main__":
    main()