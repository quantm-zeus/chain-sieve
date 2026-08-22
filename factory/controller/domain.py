"""V2 domain model — single explicit lifecycle, typed evidence."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class WorkStatus(StrEnum):
    PLANNED = "PLANNED"
    READY = "READY"
    IMPLEMENTING = "IMPLEMENTING"
    PR_OPEN = "PR_OPEN"
    CI_WAIT = "CI_WAIT"
    PRODUCT_FIX = "PRODUCT_FIX"
    REVIEW_BASELINE_WAIT = "REVIEW_BASELINE_WAIT"
    REVIEW_FIX = "REVIEW_FIX"
    REVIEW_VERIFY_WAIT = "REVIEW_VERIFY_WAIT"
    MERGE_READY = "MERGE_READY"
    MERGING = "MERGING"
    COMPLETE = "COMPLETE"
    RECOVERY = "RECOVERY"
    HUMAN_REQUIRED = "HUMAN_REQUIRED"


# Typed human-required reasons — only these can enter HUMAN_REQUIRED
class HumanRequiredReason(StrEnum):
    MISSING_CREDENTIAL = "MISSING_CREDENTIAL"
    MISSING_PERMISSION = "MISSING_PERMISSION"
    AUTHORITATIVE_SPEC_CONFLICT = "AUTHORITATIVE_SPEC_CONFLICT"
    DESTRUCTIVE_EXTERNAL_ACTION = "DESTRUCTIVE_EXTERNAL_ACTION"
    AUTONOMOUS_STRATEGIES_EXHAUSTED = "AUTONOMOUS_STRATEGIES_EXHAUSTED"


# Recovery domains — budgets isolated per domain (§25)
class RecoveryDomain(StrEnum):
    WORKER_LIVENESS = "worker_liveness"
    SESSION_RESTORE = "session_restore"
    PRODUCT_CI = "product_ci"
    CI_INFRASTRUCTURE = "ci_infrastructure"
    SEMANTIC_REVIEW = "semantic_review"
    INTEGRATION = "integration"


@dataclass(frozen=True)
class WorkItem:
    workId: str
    gapKey: str
    strategyEpoch: int = 0
    status: WorkStatus = WorkStatus.PLANNED
    # External bindings — assigned once, workId never changes (§15)
    issue_number: int | None = None
    branch: str | None = None
    pr_number: int | None = None
    session_id: str | None = None
    head_sha: str | None = None
    # Evidence pointers (typed, not boolean sprawl)
    ci_evidence_head: str | None = None
    review_evidence_head: str | None = None
    human_required_reason: HumanRequiredReason | None = None
    blocked_reason: str | None = None
    recovery_domain: RecoveryDomain | None = None
    # Per-domain counters — only where bounded policy needs them
    recovery_attempts: dict[str, int] = field(default_factory=dict)
    updated_at: str | None = None

    def with_status(self, status: WorkStatus, **kwargs: Any) -> WorkItem:
        data = {**self.__dict__, "status": status}
        data.update(kwargs)
        return WorkItem(**data)


@dataclass(frozen=True)
class CIResult:
    pr: int
    head: str
    gate_set: tuple[str, ...]
    passed: bool
    classification: str  # PRODUCT | INFRASTRUCTURE | UNKNOWN
    workflow_run: str | None = None


@dataclass(frozen=True)
class ReviewEvidence:
    workId: str
    pr: int
    targetHead: str
    reviewer: str
    implementationProvider: str
    mode: str  # BASELINE | VERIFY
    reviewScopeId: str
    contextDigest: str
    verdict: str  # PASS | CHANGES_REQUESTED
    blockingFindings: tuple[dict[str, Any], ...] = ()
    dispositions: tuple[dict[str, Any], ...] = ()
    schemaVersion: int = 1
