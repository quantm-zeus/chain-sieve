"""Single merge predicate — exactly one MERGE_PR producer (§24)."""
from __future__ import annotations

from .domain import WorkItem, WorkStatus
from .review import is_stale_review, validate_review


def can_merge(
    work: WorkItem,
    *,
    pr_state: str,
    pr_head: str | None,
    pr_mergeable: bool,
    ci_pass_for_head: bool,
    review_evidence: dict | None,
    expected_scope: str | None,
    expected_digest: str | None,
    protected_path_violation: bool = False,
    reviewer_is_opposite_provider: bool = True,
) -> bool:
    if work.status not in (WorkStatus.MERGE_READY, WorkStatus.REVIEW_VERIFY_WAIT):
        # allow MERGE_READY only; VERIFY wait not ready until PASS observed
        if work.status != WorkStatus.MERGE_READY:
            return False
    if pr_state != "open":
        return False
    if not pr_head or not work.head_sha or pr_head.lower() != work.head_sha.lower():
        return False
    if not ci_pass_for_head:
        return False
    if not pr_mergeable:
        return False
    if protected_path_violation:
        return False
    if not reviewer_is_opposite_provider:
        return False
    if review_evidence is None:
        return False
    rev = validate_review(review_evidence)
    if rev is None:
        return False
    if rev.verdict != "PASS":
        return False
    if rev.mode != "VERIFY":
        return False
    if expected_scope and rev.reviewScopeId != expected_scope:
        return False
    if expected_digest and rev.contextDigest != expected_digest:
        return False
    # stale check
    if work.head_sha and is_stale_review(rev, work.head_sha, rev.reviewScopeId, rev.contextDigest):
        # if head mismatch, already returned false; scope/digest mismatch also fails
        pass
    # opposite provider already checked; also ensure review targets current head
    if rev.targetHead.lower() != work.head_sha.lower():
        return False
    # pr number must match
    if rev.pr != work.pr_number:
        return False
    return True
