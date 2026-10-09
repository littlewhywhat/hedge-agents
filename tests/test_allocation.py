import unittest
from decimal import Decimal

from agents.common.allocation import AllocationBlocked, EPSILON, allocate


class AllocationTests(unittest.TestCase):
    names = ("btc", "eth", "gold", "stocks")

    def vector(self, values):
        return dict(zip(self.names, map(Decimal, map(str, values))))

    def assert_weights(self, result, expected):
        self.assertLessEqual(abs(sum(result.weights.values()) - 1), EPSILON)
        for name, value in self.vector(expected).items():
            self.assertLessEqual(abs(result.weights[name] - value), EPSILON, name)

    def test_concentrated_score(self):
        result = allocate(self.vector([.25] * 4), self.vector([1, 0, 0, 0]))
        self.assert_weights(result, [.45, .1833333333, .1833333333, .1833333333])

    def test_small_moves_hold(self):
        result = allocate(self.vector([.25] * 4), self.vector([.27, .25, .25, .23]))
        self.assert_weights(result, [.25] * 4)
        self.assertEqual(result.kind, "hold")

    def test_sender_cooldown(self):
        result = allocate(self.vector([.25] * 4), self.vector([0, 1, 0, 0]), cooldown={"btc"})
        self.assert_weights(result, [.25, .45, .15, .15])

    def test_hard_repair_overrides_smoothing(self):
        result = allocate(self.vector([.5, .2, .15, .15]), self.vector([0] * 4), self.vector([.2, .5, .5, .5]), cooldown={"btc"}, paused={"btc"})
        self.assert_weights(result, [.2, .3, .25, .25])
        self.assertEqual(result.kind, "bound_repair")
        self.assertIn("max_step", result.overrides[0]["overrides"])
        self.assertIn("cooldown", result.overrides[0]["overrides"])

    def test_kill_blocks_repair(self):
        with self.assertRaisesRegex(AllocationBlocked, "kill_switch"):
            allocate(self.vector([.5, .2, .15, .15]), self.vector([0] * 4), self.vector([.2, .5, .5, .5]), kill_switch=True)

    def test_infeasible_caps(self):
        with self.assertRaises(AllocationBlocked):
            allocate(self.vector([.25] * 4), self.vector([1] * 4), self.vector([.2] * 4))

    def test_stopped_below_floor_blocks(self):
        with self.assertRaises(AllocationBlocked):
            allocate(self.vector([.05, .35, .3, .3]), self.vector([1] * 4), stopped={"btc"})

    def test_paused_and_stopped(self):
        result = allocate(self.vector([.25] * 4), self.vector([1, 0, 0, 0]), paused={"eth"}, stopped={"btc"})
        self.assertEqual(result.weights["eth"], Decimal(".25"))
        self.assertLessEqual(result.weights["btc"], Decimal(".25"))

    def test_bootstrap_has_no_step_limit(self):
        result = allocate(self.vector([1, 0, 0, 0]), self.vector([0] * 4), initial=True)
        self.assert_weights(result, [.25] * 4)

    def test_reduced_modes(self):
        self.assertEqual(allocate({"btc": 1}, {"btc": 0}).weights, {"btc": Decimal(1)})
        self.assertEqual(allocate({"btc": .5, "eth": .5}, {"btc": 1, "eth": 0}).weights, {"btc": Decimal(".5"), "eth": Decimal(".5")})

    def test_three_round_gain_and_give_back(self):
        initial = self.vector([.25] * 4)
        first = allocate(initial, self.vector([1, 0, 0, 0]))
        second = allocate(first.weights, self.vector([1, 0, 0, 0]), cooldown={"eth", "gold", "stocks"})
        third = allocate(second.weights, self.vector([0, 1, 1, 1]), cooldown=set())
        self.assertGreater(first.weights["btc"], initial["btc"])
        self.assertLess(third.weights["btc"], second.weights["btc"])

    def test_nonfinite_rejected(self):
        with self.assertRaises(AllocationBlocked):
            allocate(self.vector([.25] * 4), self.vector(["NaN", 1, 1, 1]))


if __name__ == "__main__":
    unittest.main()