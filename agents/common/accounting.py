from copy import deepcopy
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any


ZERO = Decimal(0)
ASSETS = ("capital", "purchasing", "usdc", "token", "receivable", "prepaid")
LIQUID = ("capital", "purchasing", "usdc")


class AccountingError(ValueError):
    pass


def money(value: Any) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise AccountingError("Money must be finite")
    return result


def raw_units(value: Any, decimals: int = 6) -> int:
    scaled = money(value) * 10 ** decimals
    if scaled < 0 or scaled != scaled.to_integral_value():
        raise AccountingError("Amount must be a nonnegative integer of base units")
    return int(scaled)


def marked_value(raw: int, decimals: int, price: Any, multiplier: Any = 1) -> Decimal:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise AccountingError("Token amount must be a nonnegative raw integer")
    if money(price) <= 0 or money(multiplier) <= 0:
        raise AccountingError("Price and scaled-UI multiplier must be positive")
    return Decimal(raw) * money(multiplier) * money(price) / 10 ** decimals


@dataclass
class Book:
    assets: dict[str, Decimal] = field(default_factory=lambda: dict.fromkeys(ASSETS, ZERO))
    payable: Decimal = ZERO
    units: Decimal = ZERO
    contributions: Decimal = ZERO
    distributions: Decimal = ZERO
    internal_in: Decimal = ZERO
    internal_out: Decimal = ZERO
    costs: dict[str, Decimal] = field(default_factory=lambda: dict.fromkeys(("execution", "network", "service", "impairment"), ZERO))
    claims: dict[str, Decimal] = field(default_factory=dict)
    prepayments: dict[str, Decimal] = field(default_factory=dict)
    delivered_fees: dict[str, Decimal] = field(default_factory=dict)
    proofs: dict[str, dict] = field(default_factory=dict)

    @property
    def equity(self) -> Decimal:
        return sum(self.assets.values()) - self.payable

    @property
    def nav(self) -> Decimal | None:
        return self.equity / self.units if self.units > 0 else None

    @property
    def net_pnl(self) -> Decimal:
        return self.equity - self.contributions + self.distributions - self.internal_in + self.internal_out

    @property
    def gross_pnl(self) -> Decimal:
        return self.net_pnl + sum(self.costs.values())

    def json(self) -> dict:
        def encode(value):
            if isinstance(value, Decimal):
                return str(value)
            if isinstance(value, dict):
                return {key: encode(item) for key, item in value.items()}
            return value
        return encode(asdict(self))

    @classmethod
    def from_json(cls, value: dict | None) -> "Book":
        if not value:
            return cls()
        result = cls()
        for name in ("assets", "costs", "claims", "prepayments", "delivered_fees"):
            setattr(result, name, {key: money(item) for key, item in value.get(name, {}).items()})
        for name in ("payable", "units", "contributions", "distributions", "internal_in", "internal_out"):
            setattr(result, name, money(value.get(name, 0)))
        result.proofs = value.get("proofs", {})
        return result

    def apply(self, operation: str, amount: Any, proof: str, *, source: str = "capital", destination: str = "usdc", reference: str = "", received: Any = 0) -> bool:
        amount, received = money(amount), money(received)
        if amount < 0 or received < 0 or not proof:
            raise AccountingError("A recognition requires nonnegative amounts and a unique proof")
        terms = {"operation": operation, "amount": str(amount), "source": source, "destination": destination, "reference": reference, "received": str(received)}
        if proof in self.proofs:
            if self.proofs[proof] != terms:
                raise AccountingError("Proof was already recognized with different terms")
            return False
        candidate = deepcopy(self)
        candidate._apply(operation, amount, source, destination, reference, received)
        if any(value < 0 for value in candidate.assets.values()) or candidate.payable < 0 or candidate.units < 0:
            raise AccountingError("Insufficient assets, expense payable, or ownership units")
        candidate.proofs[proof] = terms
        self.__dict__.update(candidate.__dict__)
        return True

    def _apply(self, operation: str, amount: Decimal, source: str, destination: str, reference: str, received: Decimal) -> None:
        if source not in ASSETS or destination not in ASSETS:
            raise AccountingError("Unknown asset bucket")
        if operation in ("contribution", "internal_in", "distribution", "internal_out"):
            if source not in LIQUID:
                raise AccountingError("Capital flows must use liquid assets")
            nav = self.nav if self.units else Decimal(1)
            if nav is None or nav <= 0:
                raise AccountingError("Nonpositive NAV requires manual review")
            if operation in ("contribution", "internal_in"):
                self.assets[source] += amount
                self.units += amount / nav
                field_name = "contributions" if operation == "contribution" else operation
            else:
                if amount > self.equity:
                    raise AccountingError("Distribution exceeds net equity")
                self.units = ZERO if amount == self.equity else self.units - amount / nav
                self.assets[source] -= amount
                field_name = "distributions" if operation == "distribution" else operation
            setattr(self, field_name, getattr(self, field_name) + amount)
        elif operation == "move":
            if source not in LIQUID or destination not in LIQUID:
                raise AccountingError("Reclassification requires liquid buckets")
            self.assets[source] -= amount
            self.assets[destination] += amount
        elif operation == "principal_out":
            if not reference or reference in self.claims or source not in LIQUID:
                raise AccountingError("Principal requires a new intent and liquid source")
            self.assets[source] -= amount
            self.assets["receivable"] += amount
            self.claims[reference] = amount
        elif operation in ("principal_in", "principal_refund"):
            if self.claims.get(reference) != amount or destination not in LIQUID:
                raise AccountingError("Settlement must replace the exact principal claim")
            self.assets["receivable"] -= amount
            self.assets[destination] += amount
            del self.claims[reference]
        elif operation == "fee_lock":
            if not reference or reference in self.prepayments or reference in self.delivered_fees:
                raise AccountingError("Escrow fee requires a new job")
            self.assets["purchasing"] -= amount
            self.assets["prepaid"] += amount
            self.prepayments[reference] = amount
        elif operation == "fee_delivery":
            if self.prepayments.get(reference) != amount:
                raise AccountingError("Delivery must consume its prepaid fee exactly once")
            self.assets["prepaid"] -= amount
            self.costs["service"] += amount
            self.delivered_fees[reference] = self.prepayments.pop(reference)
        elif operation == "fee_refund":
            if self.prepayments.get(reference) == amount:
                self.assets["prepaid"] -= amount
                del self.prepayments[reference]
            elif self.delivered_fees.get(reference) == amount:
                self.costs["service"] -= amount
                del self.delivered_fees[reference]
            else:
                raise AccountingError("No matching refundable fee")
            self.assets["purchasing"] += amount
        elif operation == "network_fee":
            self.payable += amount
            self.costs["network"] += amount
        elif operation == "expense_repayment":
            if source not in LIQUID:
                raise AccountingError("Expense repayment requires liquid cash")
            self.assets[source] -= amount
            self.payable -= amount
        elif operation == "execution":
            if source not in ("usdc", "token") or destination not in ("usdc", "token") or source == destination:
                raise AccountingError("Execution requires token/USDC exchange")
            self.assets[source] -= amount
            self.assets[destination] += received
            self.costs["execution"] += amount - received
        elif operation == "mark":
            if source != "token":
                raise AccountingError("Only tokens can be re-marked")
            self.assets["token"] = amount
        elif operation == "impairment":
            if self.claims.get(reference) != amount:
                raise AccountingError("Impairment requires an exact outstanding claim")
            self.assets["receivable"] -= amount
            self.costs["impairment"] += amount
            del self.claims[reference]
        else:
            raise AccountingError("Unknown recognition operation")


@dataclass
class BenchmarkLot:
    units: Decimal
    distributions: Decimal = ZERO

    def redeem(self, fraction: Decimal, price: Decimal) -> Decimal:
        if not ZERO <= fraction <= 1 or price <= 0:
            raise AccountingError("Invalid benchmark redemption")
        proceeds = self.units * fraction * price
        self.units *= 1 - fraction
        self.distributions += proceeds
        return proceeds