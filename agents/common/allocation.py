from dataclasses import dataclass, field
from decimal import Decimal, localcontext
from itertools import product
from typing import Mapping


EPSILON = Decimal("1e-9")
FLOOR = Decimal("0.10")
CAP = Decimal("0.50")
MIN_MOVE = Decimal("0.05")
MAX_STEP = Decimal("0.20")


class AllocationBlocked(ValueError):
    pass


def decimal(value: object) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise AllocationBlocked("Values must be finite")
    return result


@dataclass(frozen=True)
class AllocationResult:
    weights: dict[str, Decimal]
    kind: str
    overrides: list[dict] = field(default_factory=list)
    reason: str = ""


def validate_caps(caps: Mapping[str, Decimal], stopped_bounds: Mapping[str, Decimal] | None = None) -> None:
    if len(caps) < 2:
        raise AllocationBlocked("Mode 2 needs at least two sleeves")
    if any(not decimal(value).is_finite() or not FLOOR <= value <= CAP for value in caps.values()):
        raise AllocationBlocked("Every Mode 2 cap must be between 10% and 50%")
    upper = {name: min(value, (stopped_bounds or {}).get(name, value)) for name, value in caps.items()}
    if any(value < FLOOR for value in upper.values()) or FLOOR * len(caps) > 1 or sum(upper.values()) < 1:
        raise AllocationBlocked("Infeasible floors, caps, or daily-stop restrictions")


def project(desired: Mapping[str, Decimal], lower: Mapping[str, Decimal], upper: Mapping[str, Decimal]) -> dict[str, Decimal]:
    names = sorted(desired)
    if set(names) != set(lower) or set(names) != set(upper):
        raise AllocationBlocked("Projection dimensions disagree")
    if any(lower[name] > upper[name] for name in names) or sum(lower.values()) > 1 or sum(upper.values()) < 1:
        raise AllocationBlocked("No feasible bounded simplex")
    with localcontext() as context:
        context.prec = 40
        left = min(desired[name] - upper[name] for name in names)
        right = max(desired[name] - lower[name] for name in names)
        weights = {}
        for _ in range(128):
            level = (left + right) / 2
            weights = {name: max(lower[name], min(upper[name], desired[name] - level)) for name in names}
            total = sum(weights.values())
            if abs(total - 1) <= EPSILON / 100:
                break
            if total > 1:
                left = level
            else:
                right = level
        residual = 1 - sum(weights.values())
        if abs(residual) > EPSILON:
            raise AllocationBlocked("Projection failed numerical validation")
        for name in names:
            if lower[name] <= weights[name] + residual <= upper[name]:
                weights[name] += residual
                residual = Decimal(0)
                break
        if residual or abs(sum(weights.values()) - 1) > EPSILON:
            raise AllocationBlocked("Projection residual cannot be assigned inside bounds")
        return weights


def allocate(
    current: Mapping[str, object],
    scores: Mapping[str, object],
    caps: Mapping[str, object] | None = None,
    *,
    paused: set[str] | None = None,
    stopped: set[str] | None = None,
    cooldown: set[str] | None = None,
    max_step: Decimal = MAX_STEP,
    initial: bool = False,
    kill_switch: bool = False,
) -> AllocationResult:
    if kill_switch:
        raise AllocationBlocked("kill_switch")
    names = sorted(current)
    if not names or set(scores) != set(names) or (caps is not None and set(caps) != set(names)):
        raise AllocationBlocked("Active sleeve set cannot change")
    before = {name: decimal(current[name]) for name in names}
    score = {name: decimal(scores[name]) for name in names}
    if any(value < 0 for value in before.values()) or any(value < 0 for value in score.values()):
        raise AllocationBlocked("Weights and scores cannot be negative")
    if abs(sum(before.values()) - 1) > EPSILON:
        raise AllocationBlocked("Current weights must sum to one")
    if len(names) == 1:
        return AllocationResult({names[0]: Decimal(1)}, "mode1", reason="Single sleeve; no allocator")
    if not MIN_MOVE <= max_step <= MAX_STEP:
        raise AllocationBlocked("Maximum step must be between 5 and 20 percentage points")
    paused, stopped, cooldown = paused or set(), stopped or set(), cooldown or set()
    ceilings = {name: decimal(caps[name]) if caps is not None else CAP for name in names}
    validate_caps(ceilings, {} if initial else {name: before[name] for name in stopped})
    lower = dict.fromkeys(names, FLOOR)
    upper = {name: min(ceilings[name], before[name]) if name in stopped and not initial else ceilings[name] for name in names}
    if initial:
        return AllocationResult(project(dict.fromkeys(names, Decimal(1) / len(names)), lower, upper), "initial")
    if any(before[name] < lower[name] or before[name] > upper[name] for name in names):
        target = project(before, lower, upper)
        overrides = []
        for name in names:
            change = target[name] - before[name]
            if abs(change) <= EPSILON:
                continue
            rules = []
            if abs(change) > max_step:
                rules.append("max_step")
            if abs(change) < MIN_MOVE:
                rules.append("min_move")
            if name in paused:
                rules.append("pause")
            if change < 0 and name in cooldown:
                rules.append("cooldown")
            if change > 0 and not score[name]:
                rules.append("zero_score")
            overrides.append({"agent": name, "rule": "hard_bound", "before": str(before[name]), "after": str(target[name]), "overrides": rules})
        return AllocationResult(target, "bound_repair", overrides, "Hard bounds take precedence over movement smoothing")
    if not sum(score.values()):
        return AllocationResult(before, "hold", reason="All scores are zero")
    desired = {name: score[name] / sum(score.values()) for name in names}
    best = None
    for choices in product(("hold", "send", "receive"), repeat=len(names)):
        combination_lower, combination_upper = {}, {}
        for name, choice in zip(names, choices):
            if choice != "hold" and name in paused:
                break
            if choice == "send" and name in cooldown:
                break
            if choice == "receive" and (name in stopped or not score[name]):
                break
            if choice == "hold":
                bottom = top = before[name]
            elif choice == "send":
                bottom, top = before[name] - max_step, before[name] - MIN_MOVE
            else:
                bottom, top = before[name] + MIN_MOVE, before[name] + max_step
            combination_lower[name] = max(lower[name], bottom)
            combination_upper[name] = min(upper[name], top)
        else:
            try:
                target = project(desired, combination_lower, combination_upper)
            except AllocationBlocked:
                continue
            distance = sum((target[name] - desired[name]) ** 2 for name in names)
            moved = sum(abs(target[name] - before[name]) > EPSILON for name in names)
            key = (moved, tuple(target[name] for name in names))
            if best is None or distance < best[0] - EPSILON or (abs(distance - best[0]) <= EPSILON and key < best[1]):
                best = (distance, key, target)
    if best is None:
        raise AllocationBlocked("No ordinary movement satisfies the active restrictions")
    kind = "ordinary" if best[1][0] else "hold"
    return AllocationResult(best[2], kind, reason="Minimum movement or restrictions" if kind == "hold" else "Performance projection")