from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


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
        )
        from .policy import validate_path_authority

        validate_path_authority(package)
        return package


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
        packages = tuple(WorkPackage.from_dict(item) for item in value.get("workPackages", []))
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


@dataclass
class PackageRecord:
    status: PackageStatus = PackageStatus.PLANNED
    issue_number: int | None = None
    session_id: str | None = None
    provider: str | None = None
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
    review_attempts: int = 0
    review_sha: str | None = None
    review_verdict: str | None = None
    replan_attempted: bool = False
    blocked_reason: str | None = None
    last_error: str | None = None
    started_at: str | None = None
    last_progress_at: str | None = None
    progress_fingerprint: str | None = None
    provider_selection: dict[str, Any] | None = None
    updated_at: str | None = None

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
            "correction_attempts": self.correction_attempts,
            "review_attempts": self.review_attempts,
            "review_sha": self.review_sha,
            "review_verdict": self.review_verdict,
            "replan_attempted": self.replan_attempted,
            "blocked_reason": self.blocked_reason,
            "last_error": self.last_error,
            "started_at": self.started_at,
            "last_progress_at": self.last_progress_at,
            "progress_fingerprint": self.progress_fingerprint,
            "provider_selection": self.provider_selection,
            "updated_at": self.updated_at,
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
