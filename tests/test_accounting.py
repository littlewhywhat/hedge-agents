import unittest
from decimal import Decimal

from agents.common.accounting import AccountingError, BenchmarkLot, Book, marked_value, raw_units


class AccountingTests(unittest.TestCase):
    def funded(self, amount=100, source="capital"):
        book = Book()
        book.apply("contribution", amount, "deposit:0", source=source)
        return book

    def test_transit_equity_and_duplicate_discovery(self):
        book = self.funded()
        book.apply("principal_out", 100, "inbound:0", reference="intent")
        self.assertEqual(book.equity, 100)
        self.assertEqual(book.assets["capital"], 0)
        book.apply("principal_in", 100, "payout:0", reference="intent")
        self.assertFalse(book.apply("principal_in", 100, "payout:0", reference="intent"))
        self.assertEqual(book.equity, 100)
        self.assertEqual(book.contributions, 100)
        self.assertEqual(book.net_pnl, 0)

    def test_execution_network_repayment_and_cashout(self):
        book = self.funded(source="usdc")
        book.apply("execution", 100, "swap:0", source="usdc", destination="token", received=99)
        self.assertEqual(book.net_pnl, -1)
        self.assertEqual(book.gross_pnl, 0)
        book.apply("network_fee", ".20", "swap:network")
        self.assertEqual(book.equity, Decimal("98.80"))
        self.assertEqual(book.net_pnl, Decimal("-1.20"))
        self.assertEqual(book.gross_pnl, 0)
        book.apply("execution", 99, "sale:0", source="token", destination="usdc", received=99)
        book.apply("expense_repayment", ".20", "repay:0", source="usdc")
        self.assertEqual(book.equity, Decimal("98.80"))
        book.apply("distribution", "98.80", "cashout:0", source="usdc")
        self.assertEqual(book.equity, 0)
        self.assertEqual(book.units, 0)
        self.assertEqual(book.net_pnl, Decimal("-1.20"))

    def test_escrow_refund_does_not_charge_fee(self):
        book = self.funded(2, "purchasing")
        book.apply("fee_lock", 2, "lock", reference="job")
        self.assertEqual(book.equity, 2)
        self.assertEqual(book.costs["service"], 0)
        book.apply("fee_refund", 2, "refund", reference="job")
        self.assertEqual(book.equity, 2)
        self.assertEqual(book.net_pnl, 0)

    def test_delivery_then_refund_reverses_once(self):
        book = self.funded(2, "purchasing")
        book.apply("fee_lock", 2, "lock", reference="job")
        book.apply("fee_delivery", 2, "delivery", reference="job")
        self.assertFalse(book.apply("fee_delivery", 2, "delivery", reference="job"))
        self.assertEqual(book.costs["service"], 2)
        book.apply("fee_refund", 2, "refund", reference="job")
        self.assertEqual(book.costs["service"], 0)
        self.assertEqual(book.equity, 2)

    def test_internal_capital_changes_units_not_nav(self):
        sender, receiver = self.funded(), self.funded()
        sender.apply("internal_out", 20, "budget:send")
        receiver.apply("internal_in", 20, "budget:receive")
        self.assertEqual((sender.equity, sender.units, sender.nav), (80, 80, 1))
        self.assertEqual((receiver.equity, receiver.units, receiver.nav), (120, 120, 1))
        self.assertEqual(sender.net_pnl + receiver.net_pnl, 0)

    def test_insufficient_funds_is_atomic(self):
        book = self.funded()
        original = book.json()
        with self.assertRaises(AccountingError):
            book.apply("move", 101, "bad")
        self.assertEqual(book.json(), original)

    def test_proof_cannot_change_terms(self):
        book = self.funded()
        with self.assertRaises(AccountingError):
            book.apply("contribution", 200, "deposit:0")

    def test_raw_units_multiplier_and_serialization(self):
        self.assertEqual(raw_units("25"), 25_000_000)
        with self.assertRaises(AccountingError):
            raw_units(".0000001")
        self.assertEqual(marked_value(100_000_000, 8, 100, "1.0039"), Decimal("100.3900"))
        book = self.funded()
        self.assertEqual(Book.from_json(book.json()).json(), book.json())

    def test_benchmark_full_withdrawal(self):
        lot = BenchmarkLot(Decimal(2))
        self.assertEqual(lot.redeem(Decimal(1), Decimal(55)), 110)
        self.assertEqual(lot.units, 0)
        self.assertEqual(lot.distributions, 110)


if __name__ == "__main__":
    unittest.main()