import hashlib
import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Sequence


GAP_STOPWORDS = {
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "being", "have",
    "has", "had", "do", "does", "did", "not", "but", "if", "that", "this",
    "it", "as", "into", "also", "issue", "issues", "problem", "problems",
    "fix", "fixes", "fixed", "fixing", "handle", "handles", "handled", "handling",
    "error", "errors", "bug", "bugs", "defect", "defects", "ensure", "ensures",
    "when", "where", "should", "must", "could", "would",
}


def generate_gap_fingerprint(
    milestone_id: str,
    requirement_ids: Sequence[str],
    acceptance: Sequence[str],
    objective: str = "",
    category: str = "GAP",
) -> str:
    """Generate canonical semantic product gap fingerprint invariant to formatting/minor wording."""
    m_id = (milestone_id or "").strip().lower()
    reqs = sorted({str(r).strip().upper() for r in requirement_ids if str(r).strip()})

    acc_tokens: list[str] = []
    for acc in acceptance:
        cleaned = re.sub(r"[^a-zA-Z0-9_\-\.]", " ", str(acc).lower())
        tokens = [t.strip("._-") for t in cleaned.split() if len(t.strip("._-")) > 1]
        acc_tokens.extend(t for t in tokens if t not in GAP_STOPWORDS)
    sorted_acc_tokens = sorted(set(acc_tokens))

    obj_cleaned = re.sub(r"[^a-zA-Z0-9_\-\.]", " ", str(objective).lower())
    obj_tokens = sorted({t.strip("._-") for t in obj_cleaned.split() if len(t.strip("._-")) > 1 and t not in GAP_STOPWORDS})

    key_str = f"{m_id}|{','.join(reqs)}|{' '.join(sorted_acc_tokens)}|{' '.join(obj_tokens)}|{category.upper()}"
    digest = hashlib.sha256(key_str.encode("utf-8")).hexdigest()[:16]
    req_prefix = reqs[0] if reqs else category
    return f"GAP-{req_prefix}-{digest}"


class PackageStatus(StrEnum):
    PLANNED = "PLANNED"
    READY = "READY"
    STARTING = "STARTING"
    ACTIVE = "ACTIVE"
    IDLE = "IDLE"
    WAITING_INPUT = "WAITING_INPUT"
    PR_WAITING = "PR_WAITING"
    CI = "CI"
    CI_FIX = "CI"
    REVIEW = "REVIEW"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"
    COMPLETE = "COMPLETE"
    COMPLETED = "COMPLETE"
    STUCK = "STUCK"


class FactoryStatus(StrEnum):
    RUNNING = "RUNNING"
    DEGRADED = "DEGRADED"
    BLOCKED = "BLOCKED"
    DONE = "DONE"
    STOPPED = "STOPPED"


class TransitionStage(StrEnum):
    CONVERGED = "CONVERGED"
    PLANNER_PRIMARY_CLAIMED = "PLANNER_PRIMARY_CLAIMED"
    PLANNER_PRIMARY_FAILED = "PLANNER_PRIMARY_FAILED"
    PLANNER_FALLBACK_CLAIMED = "PLANNER_FALLBACK_CLAIMED"
    NEXT_MILESTONE_VALIDATED = "NEXT_MILESTONE_VALIDATED"
    NEXT_MILESTONE_INSTALLED = "NEXT_MILESTONE_INSTALLED"
    TRANSITION_BLOCKED = "TRANSITION_BLOCKED"


@dataclass(frozen=True)
class WorkPackage:
    id: str
    objective: str
    acceptance: tuple[str, ...]
    dependencies: tuple[str, ...] = ()
    parallelizable: bool = True
    preferred_provider: str = "muse"
    risk: str = "MEDIUM"
    requirement_ids: tuple[str, ...] = ()
    authorized_protected_paths: tuple[str, ...] = ()
    gap_fingerprint: str = ""
    plan_epoch: int = 0
    supersedes: tuple[str, ...] = ()
    superseded_by: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "WorkPackage":
        package_id = str(value["id"]).strip()
        if not package_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in package_id):
            raise ValueError(f"invalid work-package id: {package_id!r}")
        provider = str(value.get("preferredProvider", "muse")).lower()
        if provider not in {"muse", "agy"}:
            raise ValueError(f"unsupported provider for {package_id}: {provider}")
        risk = str(value.get("risk", "MEDIUM")).upper()
        if risk not in {"LOW", "MEDIUM", "HIGH", "CRITICAL"}:
            raise ValueError(f"invalid risk for {package_id}: {risk}")
        acceptance = tuple(str(item).strip() for item in value.get("acceptance", []) if str(item).strip())
        if not acceptance:
            raise ValueError(f"work package {package_id} has no acceptance criteria")
        dependencies = tuple(str(item) for item in value.get("dependencies", []))
        requirement_ids = tuple(str(item) for item in value.get("requirementIds", []))
        authorized_paths = tuple(str(item) for item in value.get("authorizedProtectedPaths", []))
        for name, items in (("dependencies", dependencies), ("requirementIds", requirement_ids), ("authorizedProtectedPaths", authorized_paths)):
            if len(items) != len(set(items)):
                raise ValueError(f"work package {package_id} has duplicate {name}")
        
        gap_fp = str(value.get("gapFingerprint") or value.get("gap_fingerprint") or "").strip()
        if not gap_fp:
            gap_fp = generate_gap_fingerprint(
                str(value.get("milestoneId", "")),
                requirement_ids,
                acceptance,
                objective=str(value.get("objective", "")),
            )
        
        plan_epoch = int(value.get("planEpoch") or value.get("plan_epoch") or 0)
        supersedes = tuple(str(item) for item in value.get("supersedes", []))
        superseded_by = str(value.get("supersededBy") or value.get("superseded_by") or "") or None

        package = cls(
            id=package_id,
            objective=str(value["objective"]).strip(),
            acceptance=acceptance,
            dependencies=dependencies,
            parallelizable=bool(value.get("parallelizable", True)),
            preferred_provider=provider,
            risk=risk,
            requirement_ids=requirement_ids,
            authorized_protected_paths=authorized_paths,
            gap_fingerprint=gap_fp,
            plan_epoch=plan_epoch,
            supersedes=supersedes,
            superseded_by=superseded_by,
        )
        from .policy import validate_path_authority

        validate_path_authority(package)
        return package

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "objective": self.objective,
            "acceptance": list(self.acceptance),
            "dependencies": list(self.dependencies),
            "parallelizable": self.parallelizable,
            "preferredProvider": self.preferred_provider,
            "risk": self.risk,
            "requirementIds": list(self.requirement_ids),
            "authorizedProtectedPaths": list(self.authorized_protected_paths),
            "gapFingerprint": self.gap_fingerprint,
            "planEpoch": self.plan_epoch,
            "supersedes": list(self.supersedes),
        }
        if self.superseded_by:
            d["supersededBy"] = self.superseded_by
        return d


@dataclass(frozen=True)
class Milestone:
    id: str
    objective: str
    packages: tuple[WorkPackage, ...]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Milestone":
        milestone_id = str(value["id"]).strip()
        if not milestone_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in milestone_id):
            raise ValueError(f"invalid milestone id: {milestone_id!r}")
        raw_packages = value.get("workPackages", [])
        packages_list: list[WorkPackage] = []
        for item in raw_packages:
            if isinstance(item, dict) and "milestoneId" not in item:
                item_copy = dict(item)
                item_copy["milestoneId"] = milestone_id
                packages_list.append(WorkPackage.from_dict(item_copy))
            else:
                packages_list.append(WorkPackage.from_dict(item))
        packages = tuple(packages_list)
        ids = [item.id for item in packages]
        if len(ids) != len(set(ids)):
            raise ValueError("work-package IDs must be unique")
        known = set(ids)
        for package in packages:
            unknown = set(package.dependencies) - known
            if unknown:
                raise ValueError(f"{package.id} has unknown dependencies: {sorted(unknown)}")
            if package.id in package.dependencies:
                raise ValueError(f"{package.id} depends on itself")
        _assert_acyclic(packages)
        return cls(id=milestone_id, objective=str(value["objective"]), packages=packages)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "objective": self.objective,
            "workPackages": [p.to_dict() for p in self.packages],
        }


def work_key(milestone_id: str, package_id: str) -> str:
    return f"{milestone_id}--{package_id}"


def _assert_acyclic(packages: tuple[WorkPackage, ...]) -> None:
    graph = {item.id: item.dependencies for item in packages}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visited:
            return
        if node in visiting:
            raise ValueError(f"dependency cycle contains {node}")
        visiting.add(node)
        for dependency in graph[node]:
            visit(dependency)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)


class ReviewDispatchState(StrEnum):
    CLAIMED = "CLAIMED"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    STALE = "STALE"
    FAILED = "FAILED"
    UNKNOWN = "UNKNOWN"


def review_dispatch_key(
    work_key_str: str,
    pr_number: int,
    head_sha: str,
    reviewer: str,
    context_digest: str,
) -> str:
    return f"{work_key_str}:{pr_number}:{head_sha.lower()}:{reviewer.lower()}:{context_digest.lower()}"


class BlockerClass(StrEnum):
    HUMAN_REQUIRED_CREDENTIAL = "HUMAN_REQUIRED_CREDENTIAL"
    HUMAN_REQUIRED_PERMISSION = "HUMAN_REQUIRED_PERMISSION"
    HUMAN_REQUIRED_SPEC_CONFLICT = "HUMAN_REQUIRED_SPEC_CONFLICT"
    HUMAN_REQUIRED_DESTRUCTIVE_ACTION = "HUMAN_REQUIRED_DESTRUCTIVE_ACTION"
    AUTONOMOUS_RECOVERY_EXHAUSTED = "AUTONOMOUS_RECOVERY_EXHAUSTED"
    EXTERNAL_INFRASTRUCTURE_EXHAUSTED = "EXTERNAL_INFRASTRUCTURE_EXHAUSTED"
    DOMAIN_BUDGET_EXHAUSTED = "DOMAIN_BUDGET_EXHAUSTED"
    GENERIC_BLOCKED = "GENERIC_BLOCKED"


def classify_blocker(reason: str) -> str:
    r = (reason or "").lower()
    if any(k in r for k in ("credential", "missing secret", "missing token", "gh_token", "github_token", "auth header", "login required")):
        return BlockerClass.HUMAN_REQUIRED_CREDENTIAL.value
    if any(k in r for k in ("permission", "unauthorized protected-path", "push denied", "write access forbidden", "protected-path changes")):
        return BlockerClass.HUMAN_REQUIRED_PERMISSION.value
    if any(k in r for k in ("architecture contradiction", "contradiction", "irreconcilable", "spec conflict", "spec contradiction", "specification conflict", "normative conflict")):
        return BlockerClass.HUMAN_REQUIRED_SPEC_CONFLICT.value
    if any(k in r for k in ("destructive", "delete repo", "drop table", "purge production", "destructive external action", "destructive action", "force wipe")):
        return BlockerClass.HUMAN_REQUIRED_DESTRUCTIVE_ACTION.value
    if any(k in r for k in ("autonomous recovery exhausted", "recovery epochs exhausted", "max recovery epochs", "replan calls exhausted", "replan budget exhausted", "escalation loop", "no-progress", "no progress")):
        return BlockerClass.AUTONOMOUS_RECOVERY_EXHAUSTED.value
    if any(k in r for k in ("external service", "network unreachable", "github outage", "dns failure", "external infrastructure", "500 error", "api 500")):
        return BlockerClass.EXTERNAL_INFRASTRUCTURE_EXHAUSTED.value
    if "budget exhausted" in r:
        return BlockerClass.AUTONOMOUS_RECOVERY_EXHAUSTED.value
    return BlockerClass.GENERIC_BLOCKED.value


@dataclass
class PackageRecord:
    status: PackageStatus = PackageStatus.PLANNED
    issue_number: int | None = None
    session_id: str | None = None
    provider: str | None = None
    initial_provider: str | None = None
    ao_status: str | None = None
    ao_activity: str | None = None
    branch: str | None = None
    pr_number: int | None = None
    pr_url: str | None = None
    pr_state: str | None = None
    head_sha: str | None = None
    ci_status: str | None = None
    task_attempts: int = 0
    provider_attempts: dict[str, int] = field(default_factory=dict)
    correction_attempts: int = 0
    ci_corrections_used: int = 0
    ci_corrections_used_in_epoch: int | None = None
    ci_correction_authorized_from_sha: str | None = None
    liveness_remediations_used: int = 0
    session_restore_attempts: int = 0
    integration_corrections_used: int = 0
    integration_correction_authorized_for_head: str | None = None
    ci_infra_retries_used: int = 0
    ci_infra_retry_authorized_from_sha: str | None = None
    review_attempts: int = 0
    review_corrections_used: int = 0
    review_corrections_used_in_epoch: int | None = None
    review_correction_authorized_from_sha: str | None = None
    review_terminal_rejection_sha: str | None = None
    review_sha: str | None = None
    review_verdict: str | None = None
    review_dispatch_key: str | None = None
    review_dispatch_state: str | None = None
    review_dispatch_pr: int | None = None
    review_dispatch_sha: str | None = None
    review_dispatch_reviewer: str | None = None
    review_dispatch_context_digest: str | None = None
    review_dispatch_attempt: int = 0
    review_dispatch_run_id: str | None = None
    review_dispatch_requested_at: str | None = None
    review_dispatch_trigger_attempts: int = 0
    review_dispatch_last_attempt_at: str | None = None
    replan_attempted: bool = False
    recovery_epoch: int = 0
    replan_cycles_used: int = 0
    recovery_epoch_started_from_sha: str | None = None
    recovery_epoch_reason: str | None = None
    recovery_epoch_plan_digest: str | None = None
    no_progress_epochs: int = 0
    blocker_class: str | None = None
    blocked_reason: str | None = None
    last_error: str | None = None
    started_at: str | None = None
    last_progress_at: str | None = None
    progress_fingerprint: str | None = None
    provider_selection: dict[str, Any] | None = None
    review_baseline_id: str | None = None
    review_baseline_head: str | None = None
    review_baseline_context_digest: str | None = None
    review_mode: str | None = None
    review_findings: list[dict[str, Any]] = field(default_factory=list)
    review_closure_round: int = 0
    final_confirmation_used: bool = False
    updated_at: str | None = None
    authority_schema_version: int = 0
    gap_fingerprint: str | None = None
    plan_epoch: int = 0
    supersedes: list[str] = field(default_factory=list)
    superseded_by: str | None = None

    def __post_init__(self) -> None:
        # correction_attempts is telemetry-only: always derived from domain
        # counters.  It MUST NOT fabricate granular authority from a legacy
        # generic counter.  See §4 / §10 of the maintenance contract.
        self.correction_attempts = (
            self.ci_corrections_used
            + self.liveness_remediations_used
            + self.integration_corrections_used
        )
        if self.replan_cycles_used > 0:
            self.replan_attempted = True
        if self.review_corrections_used_in_epoch is None:
            self.review_corrections_used_in_epoch = (
                self.review_corrections_used if self.recovery_epoch == 0 else 0
            )
        if self.ci_corrections_used_in_epoch is None:
            self.ci_corrections_used_in_epoch = (
                self.ci_corrections_used if self.recovery_epoch == 0 else 0
            )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "PackageRecord":
        fields = cls.__dataclass_fields__
        cleaned = {key: item for key, item in value.items() if key in fields}
        if "status" in cleaned:
            cleaned["status"] = PackageStatus(cleaned["status"])
        return cls(**cleaned)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "issue_number": self.issue_number,
            "session_id": self.session_id,
            "provider": self.provider,
            "initial_provider": self.initial_provider,
            "ao_status": self.ao_status,
            "ao_activity": self.ao_activity,
            "branch": self.branch,
            "pr_number": self.pr_number,
            "pr_url": self.pr_url,
            "pr_state": self.pr_state,
            "head_sha": self.head_sha,
            "ci_status": self.ci_status,
            "task_attempts": self.task_attempts,
            "provider_attempts": self.provider_attempts,
            "correction_attempts": (
                self.ci_corrections_used + self.liveness_remediations_used + self.integration_corrections_used
            ),
            "ci_corrections_used": self.ci_corrections_used,
            "ci_corrections_used_in_epoch": self.ci_corrections_used_in_epoch,
            "ci_correction_authorized_from_sha": self.ci_correction_authorized_from_sha,
            "liveness_remediations_used": self.liveness_remediations_used,
            "session_restore_attempts": self.session_restore_attempts,
            "integration_corrections_used": self.integration_corrections_used,
            "integration_correction_authorized_for_head": self.integration_correction_authorized_for_head,
            "ci_infra_retries_used": self.ci_infra_retries_used,
            "ci_infra_retry_authorized_from_sha": self.ci_infra_retry_authorized_from_sha,
            "review_attempts": self.review_attempts,
            "review_corrections_used": self.review_corrections_used,
            "review_corrections_used_in_epoch": self.review_corrections_used_in_epoch,
            "review_correction_authorized_from_sha": self.review_correction_authorized_from_sha,
            "review_terminal_rejection_sha": self.review_terminal_rejection_sha,
            "review_sha": self.review_sha,
            "review_verdict": self.review_verdict,
            "review_dispatch_key": self.review_dispatch_key,
            "review_dispatch_state": self.review_dispatch_state,
            "review_dispatch_pr": self.review_dispatch_pr,
            "review_dispatch_sha": self.review_dispatch_sha,
            "review_dispatch_reviewer": self.review_dispatch_reviewer,
            "review_dispatch_context_digest": self.review_dispatch_context_digest,
            "review_dispatch_attempt": self.review_dispatch_attempt,
            "review_dispatch_run_id": self.review_dispatch_run_id,
            "review_dispatch_requested_at": self.review_dispatch_requested_at,
            "review_dispatch_trigger_attempts": self.review_dispatch_trigger_attempts,
            "review_dispatch_last_attempt_at": self.review_dispatch_last_attempt_at,
            "replan_attempted": self.replan_attempted,
            "recovery_epoch": self.recovery_epoch,
            "replan_cycles_used": self.replan_cycles_used,
            "recovery_epoch_started_from_sha": self.recovery_epoch_started_from_sha,
            "recovery_epoch_reason": self.recovery_epoch_reason,
            "recovery_epoch_plan_digest": self.recovery_epoch_plan_digest,
            "no_progress_epochs": self.no_progress_epochs,
            "blocker_class": self.blocker_class,
            "blocked_reason": self.blocked_reason,
            "last_error": self.last_error,
            "started_at": self.started_at,
            "last_progress_at": self.last_progress_at,
            "progress_fingerprint": self.progress_fingerprint,
            "provider_selection": self.provider_selection,
            "review_baseline_id": self.review_baseline_id,
            "review_baseline_head": self.review_baseline_head,
            "review_baseline_context_digest": self.review_baseline_context_digest,
            "review_mode": self.review_mode,
            "review_findings": self.review_findings,
            "review_closure_round": self.review_closure_round,
            "final_confirmation_used": self.final_confirmation_used,
            "updated_at": self.updated_at,
            "authority_schema_version": self.authority_schema_version,
            "gap_fingerprint": self.gap_fingerprint,
            "plan_epoch": self.plan_epoch,
            "supersedes": list(self.supersedes),
            "superseded_by": self.superseded_by,
        }


@dataclass(frozen=True)
class Issue:
    number: int
    state: str
    body: str
    url: str
    author: str
    title: str = ""


@dataclass(frozen=True)
class PullRequest:
    number: int
    state: str
    branch: str
    head_sha: str
    url: str
    mergeable: str
    merge_state: str
    checks: tuple[dict[str, Any], ...] = ()
    files: tuple[str, ...] = ()
    merged_at: str | None = None
    base_branch: str = ""
    author: str = ""
    updated_at: str | None = None


@dataclass(frozen=True)
class Session:
    id: str
    branch: str
    harness: str
    status: str
    activity: str
    issue_id: str | None = None
    workspace_path: str | None = None
    last_activity_at: str | None = None


@dataclass
class Snapshot:
    issues: dict[str, Issue] = field(default_factory=dict)
    prs: dict[str, list[PullRequest]] = field(default_factory=dict)
    sessions: dict[str, list[Session]] = field(default_factory=dict)
