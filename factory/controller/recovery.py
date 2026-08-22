"""Recovery — strategy not identity, domain-isolated budgets (§25)."""
from __future__ import annotations

from .domain import RecoveryDomain

# Budgets per domain — isolated
DEFAULT_BUDGETS: dict[RecoveryDomain, int] = {
    RecoveryDomain.WORKER_LIVENESS: 3,
    RecoveryDomain.SESSION_RESTORE: 3,
    RecoveryDomain.PRODUCT_CI: 3,
    RecoveryDomain.CI_INFRASTRUCTURE: 5,
    RecoveryDomain.SEMANTIC_REVIEW: 3,
    RecoveryDomain.INTEGRATION: 3,
}


def can_retry(domain: RecoveryDomain, used: int, budget: int | None = None) -> bool:
    limit = budget if budget is not None else DEFAULT_BUDGETS[domain]
    return used < limit


def next_strategy_epoch(current: int) -> int:
    return current + 1
