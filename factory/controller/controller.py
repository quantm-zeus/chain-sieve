from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .ao import AgentOrchestrator, review_gate
from .config import FactoryConfig
from .github import GitHub, ci_state
from .models import FactoryStatus, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot
from .policy import protected_path_violations, review_required, reviewer_for
from .prompts import issue_body, worker_prompt
from .store import StateStore, utc_now


TERMINAL_SESSION_STATES = {"terminated", "exited", "killed", "completed", "error"}


@dataclass(frozen=True)
class ResourceState:
    allowed: bool
    reason: str
    free_disk_gib: float
    free_memory_mib: int | None
    worktrees: int


class FactoryController:
    def __init__(
        self,
        root: Path,
        config: FactoryConfig,
        store: StateStore,
        github: GitHub,
        ao: AgentOrchestrator,
    ) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.github = github
        self.ao = ao

    def sync_issues(self, milestone: Milestone) -> dict[str, Any]:
        issues = self.github.issues()
        created: list[int] = []
        for package in milestone.packages:
            if package.id in issues:
                continue
            issue = self.github.create_issue(
                package.id,
                f"[{package.id}] {package.objective[:120]}",
                issue_body(milestone, package),
            )
            issues[package.id] = issue
            created.append(issue.number)
            self.store.event("WORK_PACKAGE_PLANNED", milestoneId=milestone.id, workPackageId=package.id, issue=issue.number)
        return {"created": created, "total": len(issues)}

    def snapshot(self) -> Snapshot:
        issues = self.github.issues()
        prs = self.github.prs()
        raw_sessions = self.ao.sessions()
        sessions: dict[str, list[Session]] = {}
        issue_to_package = {str(issue.number): package_id for package_id, issue in issues.items()}
        for issue_id, values in raw_sessions.items():
            normalized = issue_id.removeprefix("#")
            package_id = issue_to_package.get(normalized)
            if not package_id:
                digits = "".join(ch for ch in normalized if ch.isdigit())
                package_id = issue_to_package.get(digits)
            if package_id:
                sessions.setdefault(package_id, []).extend(values)
        return Snapshot(issues=issues, prs=prs, sessions=sessions)

    def reconcile(self, milestone: Milestone, snapshot: Snapshot | None = None) -> dict[str, PackageRecord]:
        snapshot = snapshot or self.snapshot()
        previous = self.store.load()
        records: dict[str, PackageRecord] = {}
        completed: set[str] = {
            package.id
            for package in milestone.packages
            if any(pr.merged_at or pr.state.upper() == "MERGED" for pr in snapshot.prs.get(package.id, []))
        }

        for package in milestone.packages:
            record = previous.get(package.id, PackageRecord())
            issue = snapshot.issues.get(package.id)
            if issue:
                record.issue_number = issue.number

            prs = snapshot.prs.get(package.id, [])
            merged = [pr for pr in prs if pr.merged_at or pr.state.upper() == "MERGED"]
            open_prs = [pr for pr in prs if pr.state.upper() == "OPEN"]
            all_sessions = snapshot.sessions.get(package.id, [])
            sessions = [item for item in all_sessions if item.status.lower() not in TERMINAL_SESSION_STATES]
            terminal = [item for item in all_sessions if item.status.lower() in TERMINAL_SESSION_STATES]

            if len(open_prs) > 1 or len(sessions) > 1:
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "ambiguous duplicate PR/session state; preserving existing work"
            elif merged:
                selected = sorted(merged, key=lambda item: item.number)[-1]
                _apply_pr(record, selected)
                record.status = PackageStatus.COMPLETED
                record.blocked_reason = None
                completed.add(package.id)
            elif open_prs:
                selected = open_prs[0]
                _apply_pr(record, selected)
                if sessions:
                    record.session_id = sessions[0].id
                    record.provider = sessions[0].harness or record.provider
                    record.ao_status = sessions[0].status
                    record.ao_activity = sessions[0].activity
                record.status = PackageStatus.PR_WAITING
            elif sessions:
                record.session_id = sessions[0].id
                record.provider = sessions[0].harness or record.provider
                record.ao_status = sessions[0].status
                record.ao_activity = sessions[0].activity
                record.branch = f"factory/{package.id}"
                record.status = PackageStatus.ACTIVE
            elif len(terminal) == 1 and record.session_id == terminal[0].id and record.task_attempts > 0:
                # Preserve and recover the exact AO session. Never create a
                # second worktree when a terminated one may contain work.
                record.provider = terminal[0].harness or record.provider
                record.ao_status = terminal[0].status
                record.ao_activity = terminal[0].activity
                record.status = PackageStatus.ACTIVE
            elif self.github.branch_exists(f"factory/{package.id}") or _local_worktree_has_branch(self.root, f"factory/{package.id}"):
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "branch/worktree exists without a correlated active AO session or PR; preserving work"
            elif record.status == PackageStatus.BLOCKED:
                # Budget/policy blockers are durable. A branch, PR, merge, or
                # explicitly edited state file is required to change them.
                pass
            elif issue and all(dependency in completed for dependency in package.dependencies):
                record.status = PackageStatus.READY
                record.blocked_reason = None
            elif issue:
                record.status = PackageStatus.PLANNED
                record.blocked_reason = None
            else:
                record.status = PackageStatus.PLANNED
            record.updated_at = utc_now()
            records[package.id] = record

        metadata = self.store.metadata()
        if metadata.get("milestoneId") not in {None, milestone.id}:
            metadata = {
                "previousMilestoneId": metadata.get("milestoneId"),
                "milestoneId": milestone.id,
                "milestoneStartedAt": utc_now(),
                "controllerStartedAt": metadata.get("controllerStartedAt"),
                "consecutiveTickFailures": 0,
            }
            self.store.event("MILESTONE_STARTED", milestoneId=milestone.id)
        metadata.update({"milestoneId": milestone.id, "reconciledAt": utc_now()})
        self.store.save(records, metadata)
        self.store.event("RECONCILED", milestoneId=milestone.id)
        return records

    def tick(self) -> dict[str, PackageRecord]:
        milestone = self.config.load_milestone()
        self.sync_issues(milestone)
        snapshot = self.snapshot()
        records = self.reconcile(milestone, snapshot)
        metadata = self.store.metadata()
        metadata.setdefault("milestoneStartedAt", utc_now())
        if _expired(metadata["milestoneStartedAt"], self.config.max_milestone_wall_clock_seconds):
            for package_id, record in records.items():
                if record.status != PackageStatus.COMPLETED:
                    self._block(milestone.id, package_id, record, "milestone wall-clock budget exhausted")
            metadata["milestoneTimedOut"] = True
            self.store.save(records, metadata)
            return records
        resources = self.resource_state()
        if not resources.allowed:
            self.store.event("CIRCUIT_BREAKER_OPENED", milestoneId=milestone.id, reason=resources.reason)
            self._notify("FATAL", resources.reason)
            return records

        packages = {item.id: item for item in milestone.packages}
        for package_id, record in records.items():
            package = packages[package_id]
            session = _single(snapshot.sessions.get(package_id, []))
            pr = _single([item for item in snapshot.prs.get(package_id, []) if item.state.upper() == "OPEN"])
            if record.status == PackageStatus.ACTIVE and session:
                if session.status.lower() in TERMINAL_SESSION_STATES:
                    self._handle_terminated(milestone, package_id, record, session)
                elif record.started_at and _expired(record.started_at, self.config.max_task_wall_clock_seconds):
                    self.ao.kill(session.id)
                    self._block(milestone.id, package_id, record, "task wall-clock budget exhausted; AO session terminated")
                else:
                    self._handle_activity(milestone, package_id, record, session)
            elif record.status == PackageStatus.PR_WAITING and pr:
                if session and session.status.lower() in TERMINAL_SESSION_STATES:
                    self._handle_terminated(milestone, package_id, record, session)
                elif any(records[dependency].status != PackageStatus.COMPLETED for dependency in package.dependencies):
                    record.last_error = "dependency integration condition no longer holds"
                else:
                    self._handle_pr(milestone, package, record, pr)

        active = sum(record.status in {PackageStatus.ACTIVE, PackageStatus.PR_WAITING, PackageStatus.CI_FIX, PackageStatus.REVIEW} for record in records.values())
        slots = max(0, self.config.max_active_workers - active)
        for package in milestone.packages:
            if slots <= 0:
                break
            record = records[package.id]
            if record.status != PackageStatus.READY:
                continue
            if not package.parallelizable and active > 0:
                continue
            if record.task_attempts >= self.config.max_task_attempts:
                self._block(milestone.id, package.id, record, "implementation attempt budget exhausted")
                continue
            assert record.issue_number is not None
            provider = _provider_for_attempt(package.preferred_provider, record.task_attempts)
            session_id = self.ao.spawn(
                package.id,
                record.issue_number,
                provider,
                worker_prompt(self.root, milestone, package),
                self.config.agy_model if provider == "agy" else None,
            )
            record.session_id = session_id
            record.provider = provider
            record.ao_status = "spawning"
            record.ao_activity = "spawning"
            record.branch = f"factory/{package.id}"
            record.task_attempts += 1
            record.provider_attempts[provider] = record.provider_attempts.get(provider, 0) + 1
            record.status = PackageStatus.ACTIVE
            record.started_at = utc_now()
            record.updated_at = utc_now()
            self.store.event(
                "WORKER_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                provider=provider, aoSessionId=session_id, attempt=record.task_attempts,
            )
            slots -= 1
            active += 1

        metadata.update({"milestoneId": milestone.id, "lastTickAt": utc_now(), "consecutiveTickFailures": 0})
        if records and all(record.status == PackageStatus.COMPLETED for record in records.values()):
            self._converge_if_needed(milestone, records, metadata)
        self.store.save(records, metadata)
        return records

    def run(self, once: bool = False) -> None:
        with self.store.lock():
            self.store.event("FACTORY_STARTED")
            records = self.store.load()
            metadata = self.store.metadata()
            metadata["controllerStartedAt"] = utc_now()
            metadata["consecutiveTickFailures"] = 0
            self.store.save(records, metadata)
            failures = 0
            while True:
                try:
                    self.tick()
                    failures = 0
                except Exception as error:
                    failures += 1
                    delay = min(300, self.config.poll_seconds * (2 ** min(failures - 1, 4)))
                    metadata = self.store.metadata()
                    metadata["consecutiveTickFailures"] = failures
                    metadata["lastTickFailure"] = str(error)[-2000:]
                    metadata["retryDelaySeconds"] = delay
                    self.store.save(self.store.load(), metadata)
                    self.store.event(
                        "FACTORY_TICK_FAILED", reason=str(error)[-2000:],
                        attempt=failures, retryDelaySeconds=delay,
                    )
                    if failures == 5:
                        self._notify("FATAL", f"factory infrastructure failed five consecutive ticks: {str(error)[-500:]}")
                    if once:
                        raise
                    time.sleep(delay)
                    continue
                if once:
                    return
                time.sleep(self.config.poll_seconds)

    def resource_state(self) -> ResourceState:
        disk = shutil.disk_usage(self.root)
        free_disk = disk.free / (1024**3)
        free_memory = _free_memory_mib()
        worktrees = _worktree_count(self.root)
        reasons: list[str] = []
        if free_disk < self.config.disk_min_free_gib:
            reasons.append(f"free disk {free_disk:.1f} GiB below {self.config.disk_min_free_gib:.1f} GiB")
        if free_memory is not None and free_memory < self.config.memory_min_free_mib:
            reasons.append(f"free memory {free_memory} MiB below {self.config.memory_min_free_mib} MiB")
        if worktrees >= self.config.max_worktrees:
            reasons.append(f"worktree count {worktrees} reached limit {self.config.max_worktrees}")
        return ResourceState(not reasons, "; ".join(reasons) or "resource gates pass", free_disk, free_memory, worktrees)

    def status(self) -> dict[str, Any]:
        milestone = self.config.load_milestone()
        records = self.store.load()
        for package in milestone.packages:
            records.setdefault(package.id, PackageRecord())
        counts = {status.value: 0 for status in PackageStatus}
        for record in records.values():
            counts[record.status.value] += 1
        metadata = self.store.metadata()
        resources = self.resource_state()
        if not metadata.get("controllerStartedAt"):
            overall = FactoryStatus.STOPPED
        elif counts[PackageStatus.BLOCKED.value]:
            overall = FactoryStatus.BLOCKED
        elif (
            counts[PackageStatus.COMPLETED.value] == len(records)
            and records
            and metadata.get("finalAuditConverged") is True
        ):
            overall = FactoryStatus.DONE
        elif not resources.allowed or int(metadata.get("consecutiveTickFailures", 0)) > 0:
            overall = FactoryStatus.DEGRADED
        else:
            overall = FactoryStatus.RUNNING
        return {
            "status": overall.value,
            "uptimeSeconds": _elapsed_seconds(metadata.get("controllerStartedAt")),
            "milestone": milestone.id,
            "progress": {"completed": counts[PackageStatus.COMPLETED.value], "total": len(records)},
            "counts": counts,
            "usage": {
                "workerStarts": sum(record.task_attempts for record in records.values()),
                "corrections": sum(record.correction_attempts for record in records.values()),
                "reviews": sum(record.review_attempts for record in records.values()),
                "byProvider": {
                    provider: sum(
                        record.provider_attempts.get(provider, 0)
                        if record.provider_attempts
                        else (record.task_attempts if record.provider == provider else 0)
                        for record in records.values()
                    )
                    for provider in ("muse", "agy")
                },
            },
            "packages": {key: value.to_dict() for key, value in records.items()},
            "resources": resources.__dict__,
            "convergence": {
                "passes": int(metadata.get("convergencePasses", 0)),
                "milestoneConverged": bool(metadata.get("milestoneConverged", False)),
                "finalAuditConverged": bool(metadata.get("finalAuditConverged", False)),
                "codexCalls": _codex_calls(self.config.state_dir),
            },
            "lastFailure": metadata.get("lastTickFailure"),
            "recentEvents": self.store.history(10),
        }

    def _handle_activity(self, milestone: Milestone, package_id: str, record: PackageRecord, session: Session) -> None:
        activity = session.activity.lower()
        if activity not in {"waiting_input", "blocked", "needs_input"}:
            return
        if record.correction_attempts < self.config.max_correction_attempts:
            self.ao.send(
                session.id,
                "You are in FULL AUTONOMOUS MODE. Do not wait for owner input. Resolve ordinary ambiguity from committed authority and evidence. If a tool permission prompt caused this state, exit it and continue with the preconfigured non-interactive permission mode.",
            )
            record.correction_attempts += 1
            self.store.event(
                "CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package_id,
                provider=record.provider, aoSessionId=session.id, attempt=record.correction_attempts,
            )
        else:
            self._block(milestone.id, package_id, record, "worker remained waiting for input after bounded remediation")

    def _handle_terminated(self, milestone: Milestone, package_id: str, record: PackageRecord, session: Session) -> None:
        if record.correction_attempts < self.config.max_correction_attempts:
            self.ao.restore(session.id)
            record.correction_attempts += 1
            record.started_at = utc_now()
            self.store.event(
                "WORKER_RESTORED", milestoneId=milestone.id, workPackageId=package_id,
                provider=record.provider, aoSessionId=session.id, attempt=record.correction_attempts,
            )
            return
        self._block(
            milestone.id,
            package_id,
            record,
            "AO session terminated after bounded restore; workspace preserved for evidence-safe recovery",
        )

    def _handle_pr(self, milestone: Milestone, package: Any, record: PackageRecord, pr: PullRequest) -> None:
        ci_status, ci_reason = ci_state(pr, self.config.required_checks)
        record.ci_status = ci_status
        if ci_status != "PASS":
            record.status = PackageStatus.CI_FIX
            if ci_status == "WAIT":
                record.last_error = ci_reason
                return
            token = f"CI:{pr.head_sha}:{ci_reason}"
            if record.session_id and record.last_error != token:
                if record.correction_attempts >= self.config.max_correction_attempts:
                    self._block(milestone.id, package.id, record, f"CI correction budget exhausted: {ci_reason}")
                    return
                self.ao.send(
                    record.session_id,
                    f"Required CI is not green for PR #{pr.number} at {pr.head_sha}: {ci_reason}. Inspect the check logs, implement the smallest authoritative fix, verify it, and push a new commit without asking for input.",
                )
                record.correction_attempts += 1
                record.last_error = token
                self.store.event(
                    "CI_CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                    provider=record.provider, aoSessionId=record.session_id, pr=pr.number,
                    attempt=record.correction_attempts, headSha=pr.head_sha,
                )
            return

        if review_required(package):
            if not record.session_id:
                self._block(milestone.id, package.id, record, "review-required PR has no correlated AO session")
                return
            reviews = self.ao.reviews(record.session_id or "")
            review_ok, review_reason, reviewer, verdict = review_gate(reviews, pr.head_sha)
            record.review_sha = pr.head_sha if reviewer else None
            record.review_verdict = verdict
            if not review_ok:
                if reviewer is None and record.review_attempts < self.config.max_review_cycles:
                    selected = reviewer_for(record.provider or package.preferred_provider)
                    self.ao.trigger_review(record.session_id or "", selected)
                    record.review_attempts += 1
                    self.store.event(
                        "REVIEW_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                        provider=selected, aoSessionId=record.session_id, pr=pr.number,
                        attempt=record.review_attempts, headSha=pr.head_sha,
                    )
                elif reviewer is not None and verdict not in {"approved", "pass"} and _review_pending(review_reason):
                    record.status = PackageStatus.REVIEW
                elif reviewer is not None and verdict not in {"approved", "pass"} and record.review_attempts < self.config.max_review_cycles:
                    token = f"REVIEW:{pr.head_sha}:{verdict}:{review_reason}"
                    if record.last_error != token:
                        self.ao.send(
                            record.session_id or "",
                            f"The independent {reviewer} review rejected PR #{pr.number} at {pr.head_sha}: {review_reason}. Read the machine-review evidence, fix every actionable finding, verify, and push a new commit.",
                        )
                        record.last_error = token
                        self.store.event(
                            "REVIEW_CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                            provider=record.provider, reviewer=reviewer, aoSessionId=record.session_id,
                            pr=pr.number, attempt=record.review_attempts, headSha=pr.head_sha,
                        )
                elif record.review_attempts >= self.config.max_review_cycles and verdict not in {"approved", "pass"}:
                    self._block(milestone.id, package.id, record, f"machine review budget exhausted: {review_reason}")
                else:
                    record.status = PackageStatus.REVIEW
                return

        violations = protected_path_violations(pr.files, self.config.protected_paths, package)
        if violations:
            self._block(milestone.id, package.id, record, f"unauthorized protected-path changes: {', '.join(violations)}")
            return
        if pr.mergeable.upper() != "MERGEABLE" or pr.merge_state.upper() in {"UNKNOWN", "DIRTY", "BLOCKED", "BEHIND"}:
            record.status = PackageStatus.PR_WAITING
            record.last_error = f"PR not mergeable: {pr.mergeable}/{pr.merge_state}"
            return

        self.github.merge(pr)
        record.status = PackageStatus.COMPLETED
        record.updated_at = utc_now()
        if record.issue_number:
            self.github.close_issue(record.issue_number, f"Automatically integrated by the factory at reviewed head `{pr.head_sha}`.")
        self.store.event(
            "PR_MERGED", milestoneId=milestone.id, workPackageId=package.id,
            provider=record.provider, aoSessionId=record.session_id, pr=pr.number, headSha=pr.head_sha,
        )
        self.store.event("WORK_PACKAGE_COMPLETED", milestoneId=milestone.id, workPackageId=package.id)

    def _block(self, milestone_id: str, package_id: str, record: PackageRecord, reason: str) -> None:
        record.status = PackageStatus.BLOCKED
        record.blocked_reason = reason
        record.last_error = reason
        self.store.event("CIRCUIT_BREAKER_OPENED", milestoneId=milestone_id, workPackageId=package_id, reason=reason)
        self._notify("FATAL", f"{package_id}: {reason}")

    def _notify(self, severity: str, message: str) -> None:
        if not self.config.notification_command:
            return
        # Notification executables get no provider, GitHub, or integration secrets.
        from .commands import CommandRunner

        CommandRunner(self.root).run(
            [*self.config.notification_command, severity, message],
            additions={"CHAINSIEVE_NOTIFICATION_SEVERITY": severity},
            timeout=30,
        )

    def _converge_if_needed(
        self,
        milestone: Milestone,
        records: dict[str, PackageRecord],
        metadata: dict[str, Any],
    ) -> None:
        if metadata.get("convergenceBlocked") is True or metadata.get("finalAuditConverged") is True:
            return
        if metadata.get("milestoneConverged") is True:
            self._advance_or_audit(milestone, records, metadata)
            return
        passes = int(metadata.get("convergencePasses", 0))
        if passes >= self.config.max_convergence_passes:
            metadata["convergenceBlocked"] = True
            reason = "milestone convergence pass budget exhausted"
            self.store.event("CIRCUIT_BREAKER_OPENED", milestoneId=milestone.id, reason=reason)
            self._notify("FATAL", reason)
            return
        from .reasoning import ReasoningRunner, write_remediation

        self.store.event("CONVERGENCE_STARTED", milestoneId=milestone.id, attempt=passes + 1)
        result = ReasoningRunner(self.root, self.config, self.store, self.github.runner).converge(milestone)
        metadata["convergencePasses"] = passes + 1
        if result["status"] == "CONVERGED":
            metadata["milestoneConverged"] = True
            self.store.event("MILESTONE_CONVERGED", milestoneId=milestone.id, attempt=passes + 1)
            self._notify("INFO", f"Milestone {milestone.id} converged")
            self._advance_or_audit(milestone, records, metadata)
            return
        write_remediation(self.config, milestone, result["gaps"])
        metadata["milestoneConverged"] = False
        for gap in result["gaps"]:
            self.store.event(
                "CONVERGENCE_GAP_FOUND", milestoneId=milestone.id,
                workPackageId=gap["id"], attempt=passes + 1,
            )

    def _advance_or_audit(
        self,
        milestone: Milestone,
        records: dict[str, PackageRecord],
        metadata: dict[str, Any],
    ) -> None:
        roadmap = _roadmap(self.root)
        ids = [item["id"] for item in roadmap]
        if milestone.id not in ids:
            self._block_factory(milestone.id, metadata, "active milestone is absent from committed roadmap")
            return
        index = ids.index(milestone.id)
        from .reasoning import ReasoningRunner, audit_remediation, write_remediation

        reasoning = ReasoningRunner(self.root, self.config, self.store, self.github.runner)
        if index + 1 < len(roadmap):
            target = roadmap[index + 1]
            self.store.archive(milestone.id, records, metadata)
            value = reasoning.plan_milestone(milestone, target)
            metadata["nextMilestoneId"] = value["id"]
            self.store.event("MILESTONE_PLANNED", milestoneId=value["id"], reason=f"after {milestone.id}")
            return

        output = self.config.state_dir / "final-audit.json"
        self.store.event("FINAL_AUDIT_STARTED", milestoneId=milestone.id)
        value = reasoning.final_audit(output)
        if value.get("status") == "CONVERGED":
            metadata["finalAuditConverged"] = True
            self.store.event("FACTORY_CONVERGED", milestoneId=milestone.id)
            self._notify("INFO", "ChainSieve final product audit converged")
            return
        package = audit_remediation(milestone, value)
        write_remediation(self.config, milestone, [package])
        metadata["finalAuditConverged"] = False
        metadata["milestoneConverged"] = False
        self.store.event("CONVERGENCE_GAP_FOUND", milestoneId=milestone.id, workPackageId=package["id"], reason="final audit")

    def _block_factory(self, milestone_id: str, metadata: dict[str, Any], reason: str) -> None:
        metadata["convergenceBlocked"] = True
        metadata["lastTickFailure"] = reason
        self.store.event("FATAL_BLOCKER", milestoneId=milestone_id, reason=reason)
        self._notify("FATAL", reason)


def _apply_pr(record: PackageRecord, pr: PullRequest) -> None:
    record.pr_number = pr.number
    record.pr_url = pr.url
    record.pr_state = pr.state
    record.branch = pr.branch
    if record.head_sha != pr.head_sha:
        record.review_sha = None
        record.review_verdict = None
        record.last_error = None
        record.ci_status = None
    record.head_sha = pr.head_sha


def _single(values: list[Any]) -> Any | None:
    return values[0] if len(values) == 1 else None


def _provider_for_attempt(preferred: str, completed_attempts: int) -> str:
    if completed_attempts == 0:
        return preferred
    return "agy" if preferred == "muse" else "muse"


def _worktree_count(root: Path) -> int:
    import subprocess

    result = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=root, text=True, capture_output=True, check=False)
    return sum(1 for line in result.stdout.splitlines() if line.startswith("worktree "))


def _local_worktree_has_branch(root: Path, branch: str) -> bool:
    import subprocess

    result = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=root, text=True, capture_output=True, check=False)
    return f"branch refs/heads/{branch}" in result.stdout.splitlines()


def _review_pending(reason: str) -> bool:
    value = reason.lower()
    return any(state in value for state in ("pending", "running", "queued", "in_progress", "started"))


def _free_memory_mib() -> int | None:
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        return None
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    return None


def _expired(started_at: str, limit_seconds: int) -> bool:
    if limit_seconds <= 0:
        return True
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    return (datetime.now(UTC) - started).total_seconds() >= limit_seconds


def _elapsed_seconds(started_at: Any) -> int | None:
    if not started_at:
        return None
    try:
        started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=UTC)
    return max(0, int((datetime.now(UTC) - started).total_seconds()))


def _codex_calls(state_dir: Path) -> int:
    import json

    path = state_dir / "usage.json"
    if not path.exists():
        return 0
    try:
        return int(json.loads(path.read_text(encoding="utf-8")).get("codexCalls", 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0


def _roadmap(root: Path) -> list[dict[str, Any]]:
    import json

    value = json.loads((root / "specs" / "factory" / "roadmap.json").read_text(encoding="utf-8"))
    milestones = value.get("milestones", [])
    ids = [str(item.get("id", "")) for item in milestones]
    if not milestones or len(ids) != len(set(ids)) or any(not item for item in ids):
        raise RuntimeError("invalid or duplicate committed roadmap milestone IDs")
    return milestones
