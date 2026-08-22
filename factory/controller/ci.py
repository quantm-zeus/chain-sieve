"""CI authority — exact-head binding (§23)."""
from __future__ import annotations

from typing import Literal

Classification = Literal["PRODUCT", "INFRASTRUCTURE", "UNKNOWN"]


def classify_failure(has_evidence: bool, passed: bool, infra_signals: tuple[str, ...] = ()) -> Classification:
    """Classify a CI failure — call only when has_evidence and not passed; PASS never classifies as PRODUCT_FAILURE."""
    if not has_evidence:
        return "UNKNOWN"
    if passed:
        raise ValueError("classify_failure called on passing CI — check passed before calling")
    # Heuristic: infra signals dominate
    if any(s in infra_signals for s in ("runner_down", "timeout", "network", "rate_limit")):
        return "INFRASTRUCTURE"
    return "PRODUCT"


def ci_is_stale(ci_head: str | None, current_head: str | None) -> bool:
    if not ci_head or not current_head:
        return True
    return ci_head.lower() != current_head.lower()


def ci_pass_for_head(
    observations: tuple[dict, ...],
    pr: int,
    head: str,
    required: tuple[str, ...],
) -> bool:
    for obs in observations:
        if obs.get("pr") == pr and obs.get("head", "").lower() == head.lower():
            if not obs.get("passed"):
                return False
            # gate set must cover required
            gates = set(obs.get("gate_set", ()))
            if not set(required).issubset(gates):
                return False
            return True
    return False
