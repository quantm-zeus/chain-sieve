"""Pure deterministic reducer — no I/O, no clock internally (§9)."""
from __future__ import annotations

from typing import Any

from .commands import Command, CommandType
from .domain import WorkItem, WorkStatus
from .observations import Observations, CIObservation, ReviewObservation
from .transitions import can_merge as _can_merge


# Explicit transition table — every (state × observation-class) has an entry
# Represented as set of allowed transitions; used to generate tests (§32)
ALLOWED_TRANSITIONS: dict[tuple[str, str], str] = {
    # (from_status, observation_class) -> to_status or "NO_OP"
    ("PLANNED", "tick"): "READY",
    ("READY", "CREATE_ISSUE"): "IMPLEMENTING",
    ("IMPLEMENTING", "PR_OPEN"): "PR_OPEN",
    ("PR_OPEN", "CI_WAIT"): "CI_WAIT",
    ("CI_WAIT", "CI_PASS"): "REVIEW_BASELINE_WAIT",
    ("CI_WAIT", "CI_PRODUCT_FAIL"): "PRODUCT_FIX",
    ("CI_WAIT", "CI_INFRA_FAIL"): "CI_WAIT",
    ("PRODUCT_FIX", "CI_PASS"): "REVIEW_BASELINE_WAIT",
    ("REVIEW_BASELINE_WAIT", "BASELINE_PASS"): "MERGE_READY",
    ("REVIEW_BASELINE_WAIT", "BASELINE_REJECT"): "REVIEW_FIX",
    ("REVIEW_FIX", "CI_PASS"): "REVIEW_VERIFY_WAIT",
    ("REVIEW_VERIFY_WAIT", "VERIFY_PASS"): "MERGE_READY",
    ("REVIEW_VERIFY_WAIT", "VERIFY_REJECT"): "REVIEW_FIX",
    ("MERGE_READY", "MERGE"): "MERGING",
    ("MERGING", "MERGED"): "COMPLETE",
    # Recovery self-loops handled via RECOVERY status
}


def reduce_state(
    work: WorkItem,
    obs: Observations,
    *,
    required_checks: tuple[str, ...] = (),
    review_scope: str | None = None,
    review_digest: str | None = None,
    state_version: int = 0,
) -> tuple[WorkItem, list[Command]]:
    """Pure function: (state, observations) -> (next_state, commands)."""
    # Enforce determinism: sort observations deterministically
    ci_map: dict[tuple[int, str], CIObservation] = {(c.pr, c.head.lower()): c for c in obs.ci}
    review_map: dict[str, ReviewObservation] = {r.workId: r for r in obs.reviews}

    # No op if no relevant observations — must not emit side effects (§12)
    next_work = work
    cmds: list[Command] = []

    # PLANNED -> READY when milestone converged tick (clock always present)
    if work.status == WorkStatus.PLANNED:
        next_work = work.with_status(WorkStatus.READY)
        return next_work, cmds

    # READY -> need CREATE_ISSUE if no issue
    if work.status == WorkStatus.READY and work.issue_number is None:
        cmds.append(
            Command.new(work.workId, CommandType.CREATE_ISSUE, state_version, {"gapKey": work.gapKey})
        )
        return next_work, cmds

    # IMPLEMENTING -> START_WORKER if no session and issue exists
    if work.status == WorkStatus.IMPLEMENTING and work.session_id is None and work.issue_number is not None:
        cmds.append(
            Command.new(work.workId, CommandType.START_WORKER, state_version, {"branch": work.branch or f"work/{work.gapKey}"})
        )
        return next_work, cmds

    # Determine PR head from observations
    pr_obs = None
    for p in obs.prs:
        if work.pr_number is not None and p.pr == work.pr_number:
            pr_obs = p
            break

    # Update head_sha from PR observation if advancing
    if pr_obs and pr_obs.head_sha and work.head_sha != pr_obs.head_sha.lower():
        next_work = WorkItem(**{**next_work.__dict__, "head_sha": pr_obs.head_sha.lower()})

    # CI_WAIT / PRODUCT_FIX logic — classify CI for current head
    if work.status in (WorkStatus.CI_WAIT, WorkStatus.PRODUCT_FIX, WorkStatus.PR_OPEN, WorkStatus.REVIEW_FIX):
        if next_work.head_sha:
            ci_key = (next_work.pr_number or 0, next_work.head_sha.lower())
            ci = ci_map.get(ci_key)
            if ci is not None:
                if ci.has_evidence and ci.passed:
                    # CI PASS makes old review stale is handled by next phase
                    if work.status in (WorkStatus.CI_WAIT, WorkStatus.PRODUCT_FIX, WorkStatus.REVIEW_FIX):
                        # advance toward review
                        if work.status == WorkStatus.REVIEW_FIX:
                            next_work = next_work.with_status(WorkStatus.REVIEW_VERIFY_WAIT)
                            # need VERIFY review trigger after product fix
                            cmds.append(Command.new(next_work.workId, CommandType.TRIGGER_REVIEW, state_version, {"mode": "VERIFY", "head": next_work.head_sha}))
                        else:
                            next_work = next_work.with_status(WorkStatus.REVIEW_BASELINE_WAIT)
                            cmds.append(Command.new(next_work.workId, CommandType.TRIGGER_REVIEW, state_version, {"mode": "BASELINE", "head": next_work.head_sha}))
                        return next_work, cmds
                elif ci.has_evidence and not ci.passed:
                    if ci.classification == "INFRASTRUCTURE":
                        cmds.append(Command.new(next_work.workId, CommandType.RETRY_CI_INFRA, state_version, {"head": next_work.head_sha}))
                        return next_work, cmds
                    elif ci.classification == "PRODUCT":
                        if next_work.status != WorkStatus.PRODUCT_FIX:
                            next_work = next_work.with_status(WorkStatus.PRODUCT_FIX)
                            cmds.append(Command.new(next_work.workId, CommandType.SEND_PRODUCT_CORRECTION, state_version, {"head": next_work.head_sha}))
                        return next_work, cmds
                    else:  # UNKNOWN -> fail closed, no product correction (INV)
                        return next_work, cmds
                elif not ci.has_evidence:
                    # UNKNOWN -> no correction
                    return next_work, cmds

    # Review handling — BASELINE / VERIFY
    if work.status in (WorkStatus.REVIEW_BASELINE_WAIT, WorkStatus.REVIEW_VERIFY_WAIT):
        rev = review_map.get(work.workId)
        if rev is not None:
            if rev.malformed:
                return next_work, cmds  # zero effect INV-06
            # stale check: head/scope/digest mismatch => STALE (zero effect)
            is_stale = False
            if next_work.head_sha and rev.targetHead.lower() != next_work.head_sha.lower():
                is_stale = True
            if review_scope and rev.reviewScopeId != review_scope:
                is_stale = True
            if review_digest and rev.contextDigest != review_digest:
                is_stale = True
            if is_stale:
                return next_work, cmds  # INV-05
            if rev.mode == "BASELINE" and work.status == WorkStatus.REVIEW_BASELINE_WAIT:
                if rev.verdict == "PASS":
                    next_work = next_work.with_status(WorkStatus.MERGE_READY)
                    return next_work, cmds
                elif rev.verdict == "CHANGES_REQUESTED":
                    next_work = next_work.with_status(WorkStatus.REVIEW_FIX)
                    cmds.append(Command.new(next_work.workId, CommandType.SEND_PRODUCT_CORRECTION, state_version, {"findings": list(rev.blockingFindings)}))
                    return next_work, cmds
            if rev.mode == "VERIFY" and work.status == WorkStatus.REVIEW_VERIFY_WAIT:
                if rev.verdict == "PASS":
                    next_work = next_work.with_status(WorkStatus.MERGE_READY)
                    return next_work, cmds
                elif rev.verdict == "CHANGES_REQUESTED":
                    next_work = next_work.with_status(WorkStatus.REVIEW_FIX)
                    cmds.append(Command.new(next_work.workId, CommandType.SEND_PRODUCT_CORRECTION, state_version, {"findings": list(rev.blockingFindings)}))
                    return next_work, cmds

    # PR_OPEN -> CI_WAIT after PR observed
    if work.status == WorkStatus.PR_OPEN and pr_obs and pr_obs.state == "open":
        next_work = next_work.with_status(WorkStatus.CI_WAIT)
        return next_work, cmds

    # MERGE_READY -> emit MERGE_PR exactly once via predicate
    if work.status == WorkStatus.MERGE_READY and next_work.head_sha and next_work.pr_number:
        # Use current CI/review evidence to decide — if can_merge would pass, emit MERGE_PR
        # Caller supplies durable evidence via next tick; here we emit optimistically if PR open & mergeable
        if pr_obs and pr_obs.state == "open" and pr_obs.mergeable:
            # ci pass check via ci_map
            ci_key = (next_work.pr_number, next_work.head_sha.lower())
            ci = ci_map.get(ci_key)
            ci_pass = bool(ci and ci.has_evidence and ci.passed and ci.classification != "UNKNOWN")
            rev = review_map.get(work.workId)
            # Only emit if both evidences present and not stale/malformed
            if ci_pass and rev and not rev.malformed and rev.verdict == "PASS" and rev.mode == "VERIFY":
                # check head matches
                if rev.targetHead.lower() == next_work.head_sha.lower():
                    cmds.append(Command.new(next_work.workId, CommandType.MERGE_PR, state_version, {"pr": next_work.pr_number, "head": next_work.head_sha}))
                    next_work = next_work.with_status(WorkStatus.MERGING)
                    return next_work, cmds

    return next_work, cmds
