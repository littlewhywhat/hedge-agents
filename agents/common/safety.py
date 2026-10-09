from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN
import json

from agents.common.accounting import money
from agents.common.config import MARKETS
from agents.common.errors import DomainError


@dataclass(frozen=True)
class TradingView:
    agent_id: str
    policy_version: int
    policy: dict
    equity: Decimal
    token_value: Decimal
    usdc: Decimal
    token_price: Decimal
    multiplier: Decimal
    sampled_at: datetime
    snapshot_id: str
    valid: bool = True
    kill_switch: bool = False
    stopped: bool = False
    baseline_valid: bool = True
    unresolved: bool = False
    armed: bool = False
    headline: str | None = None

    @property
    def fraction(self):
        return self.token_value / self.equity if self.equity > 0 else Decimal(0)


def guard(view: TradingView, now: datetime, *, buy: bool = False):
    if view.kill_switch:
        raise DomainError("kill_switch", 423)
    if not view.armed:
        raise DomainError("Automation has not passed qualification and explicit arming", 423)
    sampled = view.sampled_at.replace(tzinfo=timezone.utc) if view.sampled_at.tzinfo is None else view.sampled_at
    if not view.valid or not 0 <= (now - sampled).total_seconds() <= 120:
        raise DomainError("Fresh reconciled balances and marks are required", 409)
    if view.equity <= 0 or view.token_price <= 0 or view.multiplier <= 0:
        raise DomainError("Nonpositive equity or mark requires manual review", 409)
    if view.unresolved:
        raise DomainError("Signing wallet has an unresolved transaction", 409)
    if buy and (view.stopped or not view.baseline_valid or view.policy.get("paused")):
        raise DomainError("Daily stop, missing UTC baseline, or pause blocks new buys", 423)


def parse_conviction(result) -> tuple[Decimal, str]:
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict) or isinstance(result.get("conviction"), bool):
        raise ValueError("Model must return a finite numeric conviction")
    conviction = money(result["conviction"])
    if not -1 <= conviction <= 1:
        raise ValueError("Conviction outside [-1, 1]")
    reasoning = result.get("reasoning")
    if not isinstance(reasoning, str) or not reasoning.strip():
        raise ValueError("Reasoning is missing")
    return conviction, reasoning[:1000]


def daily_stop(previous: dict | None, now: datetime, nav: Decimal | None, baseline: Decimal | None) -> dict:
    previous = previous or {}
    today = now.date().isoformat()
    if previous.get("day") == today and previous.get("stopped"):
        return previous
    if nav is None or baseline is None or nav <= 0 or baseline <= 0:
        return {**previous, "baseline_valid": False, "reason": "Missing or nonpositive UTC NAV"}
    change = nav / baseline - 1
    return {"day": today, "stopped": change < Decimal("-.05"), "baseline_valid": True, "daily_return": str(change), "reason": "daily_loss" if change < Decimal("-.05") else None}


def performance_score(samples: list[tuple[datetime, Decimal]], now: datetime) -> Decimal:
    ordered = sorted((time, value) for time, value in samples if 0 <= (now - time).total_seconds() <= 86400 and value > 0)
    intervals = []
    for previous, current in zip(ordered, ordered[1:]):
        if (current[0] - previous[0]).total_seconds() != 60:
            continue
        age_hours = Decimal(str((now - current[0]).total_seconds())) / 3600
        weight = Decimal(2) ** (-age_hours / 6)
        intervals.append((weight, current[1] / previous[1] - 1))
    if len(intervals) < 60:
        raise DomainError("At least 60 complete one-minute unit-NAV intervals are required", 409)
    total = sum(weight for weight, _ in intervals)
    average = sum(weight * change for weight, change in intervals) / total
    volatility = (sum(weight * (change - average) ** 2 for weight, change in intervals) / total).sqrt()
    score = max(average, Decimal(0)) / max(volatility, Decimal(".0001"))
    return score if score >= Decimal(".01") else Decimal(0)


class TraderEngine:
    def __init__(self, settings, read_view, model, quote, execute, record, clock):
        self.settings, self.read_view, self.model = settings, read_view, model
        self.quote, self.execute, self.record, self.clock = quote, execute, record, clock

    async def tick(self, pinned_version: int, cash_target_usd: Decimal | None = None):
        view = await self.read_view()
        decision = {"agent": view.agent_id, "policy_version": pinned_version, "snapshot_ids": [view.snapshot_id], "conviction": None, "abstained": False, "action": "hold", "target_fraction": str(view.fraction), "reasoning": "", "status": "held"}
        try:
            guard(view, self.clock())
            if view.policy_version != pinned_version:
                raise DomainError("Pinned policy is no longer active", 409)
            if cash_target_usd is not None:
                if not cash_target_usd.is_finite() or cash_target_usd < 0:
                    raise DomainError("Invalid deterministic cash target")
                target = max(Decimal(0), view.token_value - max(Decimal(0), cash_target_usd - view.usdc)) / view.equity
                decision["reasoning"] = "Durable allocation leg; deterministic cash-raising clip"
            elif view.stopped:
                target = Decimal(0)
                decision["reasoning"] = "Daily-stop cash target; deterministic risk reduction"
            elif view.policy.get("paused"):
                decision["reasoning"] = "Discretionary activity paused"
                return await self.record(decision)
            else:
                try:
                    conviction, reasoning = parse_conviction(await self.model(view))
                except Exception:
                    decision.update(abstained=True, reasoning="Model unavailable or invalid response; current target retained")
                    return await self.record(decision)
                decision.update(conviction=str(conviction), reasoning=reasoning)
                target = max(Decimal(0), min(money(view.policy["max_token_pct"]), money(view.policy["base"]) + money(view.policy["k"]) * conviction))
            decision["target_fraction"] = str(target)
            difference = target * view.equity - view.token_value
            action = "buy" if difference > 0 else "sell"
            guard(view, self.clock(), buy=action == "buy")
            amount = min(abs(difference), view.equity * Decimal(".25"), Decimal(self.settings.max_trade_usd), view.usdc if action == "buy" else view.token_value)
            if amount < 1:
                decision["reasoning"] += "; below minimum trade size"
                return await self.record(decision)
            market = MARKETS[view.agent_id]
            input_mint = self.settings.usdc_mint if action == "buy" else market["mint"]
            output_mint = market["mint"] if action == "buy" else self.settings.usdc_mint
            raw = amount * 1_000_000 if action == "buy" else amount / (view.token_price * view.multiplier) * 10 ** market["decimals"]
            raw = int(raw.to_integral_value(rounding=ROUND_DOWN))
            slippage = int(view.policy.get("slippage_bps", 50))
            if not 0 < slippage <= 100 or raw <= 0:
                raise DomainError("Invalid slippage or trade amount")
            order = await self.quote(input_mint, output_mint, raw, slippage)
            fresh = await self.read_view()
            guard(fresh, self.clock(), buy=action == "buy")
            if fresh.policy_version != pinned_version or (fresh.policy.get("paused") and not fresh.stopped and cash_target_usd is None):
                raise DomainError("Controls or active policy changed before signing", 409)
            actual_amount = Decimal(raw) / 1_000_000 if action == "buy" else Decimal(raw) / 10 ** market["decimals"] * fresh.token_price * fresh.multiplier
            if actual_amount > min(fresh.equity * Decimal(".25"), Decimal(self.settings.max_trade_usd)) or actual_amount > (fresh.usdc if action == "buy" else fresh.token_value):
                raise DomainError("Latest balances or marks exceed per-order limits", 409)
            if action == "buy" and fresh.token_value + actual_amount > fresh.equity * money(fresh.policy["max_token_pct"]):
                raise DomainError("Position cap changed before signing", 409)
            if order.get("inputMint") != input_mint or order.get("outputMint") != output_mint or str(order.get("inAmount")) != str(raw):
                raise DomainError("Returned Jupiter order differs from the allowlisted request")
            decision.update(action=action, status="prepared", amount_raw=str(raw), input_mint=input_mint, output_mint=output_mint, quoted_in_usd=str(order.get("inUsdValue", "")), quoted_out_usd=str(order.get("outUsdValue", "")))
            return await self.execute(order, decision, fresh)
        except DomainError as error:
            decision.update(status="blocked", reason=str(error), action="hold")
            return await self.record(decision)
        except Exception:
            decision.update(status="blocked", reason="Adapter unavailable; no new order authorized", action="hold")
            return await self.record(decision)