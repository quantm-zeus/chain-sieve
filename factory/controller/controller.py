from __future__ import annotations

import json
import os
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .ao import AgentOrchestrator, review_gate
from .config import FactoryConfig
from .github import GitHub, causal_ci_check, ci_state, classify_ci_failure
from .models import (
    FactoryStatus,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    ReviewDispatchState,
    Session,
    Snapshot,
    TransitionStage,
    review_dispatch_key,
    work_key,
)
from .policy import protected_path_violations, review_required, reviewer_for, select_implementation_provider
from .prompts import issue_body, worker_prompt
from .store import StateStore, utc_now


TERMINAL_SESSION_STATES = {"terminated", "exited", "killed", "completed", "error"}
REVIEW_DISPATCH_AMBIGUITY_GRACE_SECONDS = 30
MAX_REVIEW_DISPATCH_TRIGGER_ATTEMPTS = 2


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None


@dataclass(frozen=True)
class ResourceState:
    allowed: bool
    reason: str
    free_disk_gib: float
    free_memory_mib: int | None
    worktrees: int


def _reconstruct_authorities_from_events(
    events_path: Path,
    work_key_str: str,
    package_id: str,
) -> dict[str, Any] | None:
    """Reconstruct granular authority counters from historical events.

    Authority epoch rules (§5 / §12):
    - LIVENESS: scoped to current session/worker-attempt epoch.
      ALTERNATE_PROVIDER_REQUEUED resets to zero.
    - SESSION RESTORE: scoped to current session/provider-attempt epoch.
      ALTERNATE_PROVIDER_REQUEUED resets to zero.
    - CI CORRECTIONS: PR/work-package lifecycle, deduplicated by
      authorization SHA (same head → one correction).
    - INTEGRATION: PR/integration lifecycle, deduplicated by authorized head.
    """
    if not events_path.exists():
        return None

    ci_correction_shas: set[str] = set()
    last_ci_sha: str | None = None
    liveness_remediations = 0
    session_restores = 0
    integration_heads: set[str] = set()
    found_any = False

    try:
        with events_path.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("workKey") != work_key_str and ev.get("workPackageId") != package_id:
                    continue
                found_any = True
                ev_type = ev.get("type")

                # Epoch boundary: clean alternate-provider requeue resets
                # session-scoped authority (liveness + restore).
                if ev_type == "ALTERNATE_PROVIDER_REQUEUED":
                    liveness_remediations = 0
                    session_restores = 0
                    continue

                if ev_type == "CI_CORRECTION_STARTED":
                    head = ev.get("headSha")
                    if head and head not in ci_correction_shas:
                        ci_correction_shas.add(head)
                    if head:
                        last_ci_sha = str(head)
                elif ev_type in {"CORRECTION_STARTED", "LIVENESS_REMEDIATION_STARTED"}:
                    liveness_remediations += 1
                elif ev_type in {"WORKER_RESTORED", "SESSION_RESTORE_STARTED"}:
                    session_restores += 1
                elif ev_type in {"MERGE_UPDATE_STARTED", "INTEGRATION_CORRECTION_AUTHORIZED"}:
                    head = ev.get("headSha")
                    if head:
                        integration_heads.add(head)
                    else:
                        integration_heads.add(f"_anon_{len(integration_heads)}")
    except Exception:
        return None

    if not found_any:
        return None

    return {
        "ci_corrections_used": len(ci_correction_shas),
        "ci_correction_authorized_from_sha": last_ci_sha,
        "liveness_remediations_used": liveness_remediations,
        "session_restore_attempts": session_restores,
        "integration_corrections_used": len(integration_heads),
    }


class FactoryController:
    def __init__(
        self,
        root: Path,
        config: FactoryConfig,
        store: StateStore,
        github: GitHub,
        ao: AgentOrchestrator,
        reasoner: Any | None = None,
    ) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.github = github
        self.ao = ao
        self.reasoner = reasoner

    @property
    def runner(self) -> Any:
        from .commands import CommandRunner
        return getattr(self.github, "runner", None) or CommandRunner(self.root)

    def _sync_and_verify_integration_head(self, milestone_id: str) -> tuple[bool, str | None, str | None]:
        runner = self.runner
        runner.run(["git", "fetch", "origin", self.config.integration_branch], check=False)
        local_res = runner.run(["git", "rev-parse", "HEAD"], check=False)
        local_head = (local_res.stdout or "").strip().lower() if local_res.returncode == 0 else None
        remote_res = runner.run(["git", "rev-parse", f"origin/{self.config.integration_branch}"], check=False)
        remote_head = (remote_res.stdout or "").strip().lower() if remote_res.returncode == 0 else None

        if not local_head or not remote_head or len(local_head) != 40 or len(remote_head) != 40:
            return False, local_head, remote_head

        if local_head != remote_head:
            dirty_res = runner.run(["git", "status", "--porcelain"], check=False)
            branch_res = runner.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], check=False)
            current_branch = (branch_res.stdout or "").strip()
            anc_res = runner.run(["git", "merge-base", "--is-ancestor", local_head, remote_head], check=False)

            is_clean = dirty_res.returncode == 0 and not (dirty_res.stdout or "").strip()
            is_int_branch = current_branch == self.config.integration_branch
            is_ancestor = anc_res.returncode == 0

            if is_clean and is_int_branch and is_ancestor:
                ff_res = runner.run(["git", "merge", "--ff-only", f"origin/{self.config.integration_branch}"], check=False)
                if ff_res.returncode == 0:
                    new_local_res = runner.run(["git", "rev-parse", "HEAD"], check=False)
                    local_head = (new_local_res.stdout or "").strip().lower() if new_local_res.returncode == 0 else local_head

            if local_head != remote_head:
                self.store.event(
                    "INTEGRATION_HEAD_NOT_READY",
                    milestoneId=milestone_id,
                    localHead=local_head,
                    remoteHead=remote_head,
                )
                return False, local_head, remote_head

        return True, local_head, remote_head

    def sync_issues(self, milestone: Milestone) -> dict[str, Any]:
        issues = self.github.issues()
        created: list[int] = []
        updated: list[int] = []
        for package in milestone.packages:
            key = work_key(milestone.id, package.id)
            expected_title = f"[{milestone.id}/{package.id}] {package.objective[:120]}"
            expected_body = f"<!-- chainsieve-work-package:{key} -->\n\n{issue_body(milestone, package).rstrip()}\n"
            if key in issues:
                existing = issues[key]
                body_changed = existing.body.strip() != expected_body.strip()
                title_changed = bool(existing.title and existing.title.strip() != expected_title.strip())
                if (body_changed or title_changed) and hasattr(self.github, "update_issue"):
                    self.github.update_issue(existing.number, expected_title, expected_body)
                    updated.append(existing.number)
                continue
            issue = self.github.create_issue(
                key,
                expected_title,
                issue_body(milestone, package),
            )
            issues[key] = issue
            created.append(issue.number)
            self.store.event("WORK_PACKAGE_PLANNED", milestoneId=milestone.id, workPackageId=package.id, workKey=key, issue=issue.number)
        return {"created": created, "updated": updated, "total": len(issues)}

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
        from .reasoning import reconcile_durable_state

        reconcile_durable_state(self.store, milestone, self.root, self.ao)
        snapshot = snapshot or self.snapshot()
        previous = self.store.load()
        records: dict[str, PackageRecord] = {}
        completed: set[str] = {
            work_key(milestone.id, package.id)
            for package in milestone.packages
            if any(pr.merged_at or pr.state.upper() == "MERGED" for pr in snapshot.prs.get(work_key(milestone.id, package.id), []))
        }

        for package in milestone.packages:
            key = work_key(milestone.id, package.id)
            record = previous.get(key, PackageRecord())
            issue = snapshot.issues.get(key)
            if issue:
                record.issue_number = issue.number

            prs = snapshot.prs.get(key, [])
            merged = [pr for pr in prs if pr.merged_at or pr.state.upper() == "MERGED"]
            open_prs = [pr for pr in prs if pr.state.upper() == "OPEN"]
            all_sessions = snapshot.sessions.get(key, [])
            sessions = [item for item in all_sessions if item.status.lower() not in TERMINAL_SESSION_STATES]
            terminal = [item for item in all_sessions if item.status.lower() in TERMINAL_SESSION_STATES]

            if not merged:
                # Schema-versioned migration (§11): run exactly once per
                # package.  authority_schema_version=0 → legacy unmigrated;
                # authority_schema_version=1 → DOMAIN_AUTHORITY_V1 (migrated).
                if record.authority_schema_version < 1:
                    events_info = _reconstruct_authorities_from_events(self.store.events_path, key, package.id)
                    needs_migration = (
                        record.ci_corrections_used == 0
                        and record.liveness_remediations_used == 0
                        and record.correction_attempts > 0
                    ) or (
                        record.status == PackageStatus.BLOCKED
                        and record.blocked_reason
                        and "ci correction budget exhausted" in record.blocked_reason.lower()
                    )
                    if needs_migration and events_info is not None:
                        old_generic = record.correction_attempts
                        record.ci_corrections_used = events_info["ci_corrections_used"]
                        if events_info["ci_correction_authorized_from_sha"]:
                            record.ci_correction_authorized_from_sha = events_info["ci_correction_authorized_from_sha"]
                        record.liveness_remediations_used = events_info["liveness_remediations_used"]
                        record.session_restore_attempts = events_info["session_restore_attempts"]
                        record.integration_corrections_used = events_info["integration_corrections_used"]

                        if (
                            record.status == PackageStatus.BLOCKED
                            and record.blocked_reason
                            and "ci correction budget exhausted" in record.blocked_reason.lower()
                            and record.ci_corrections_used < self.config.max_ci_correction_rounds
                        ):
                            old_reason = record.blocked_reason
                            record.blocked_reason = None
                            record.last_error = None
                            record.replan_attempted = False
                            self.store.event(
                                "LEGACY_CORRECTION_BUDGET_RECONCILED",
                                milestoneId=milestone.id,
                                workPackageId=package.id,
                                workKey=key,
                                pr=record.pr_number or (open_prs[0].number if open_prs else None),
                                headSha=record.head_sha or (open_prs[0].head_sha if open_prs else None),
                                oldGenericCorrectionAttempts=old_generic,
                                reconstructedCiCorrectionsUsed=record.ci_corrections_used,
                                reconstructedLivenessRemediationsUsed=record.liveness_remediations_used,
                                reconstructedSessionRestores=record.session_restore_attempts,
                                reconstructedIntegrationCorrectionsUsed=record.integration_corrections_used,
                                clearedBlockedReason=old_reason,
                            )
                    elif needs_migration and events_info is None:
                        # Fail closed (§4): legacy counter > 0 but no events
                        # to prove the breakdown.  Do NOT fabricate authority.
                        self.store.event(
                            "LEGACY_MIGRATION_AMBIGUOUS",
                            milestoneId=milestone.id,
                            workPackageId=package.id,
                            workKey=key,
                            oldGenericCorrectionAttempts=record.correction_attempts,
                            reason="no usable historical events to reconstruct domain authority",
                        )
                    # Mark migration complete regardless of whether events
                    # existed — prevents double-counting on restart (§11).
                    record.authority_schema_version = 1

            if len(open_prs) > 1 or len(sessions) > 1:
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "ambiguous duplicate PR/session state; preserving existing work"
            elif merged:
                selected = sorted(merged, key=lambda item: item.number)[-1]
                _apply_pr(record, selected, self.root)
                record.status = PackageStatus.COMPLETED
                record.blocked_reason = None
                record.ao_status = "merged"
                record.ao_activity = "merged"
                record.last_error = None
                completed.add(key)
                for s in sessions:
                    try:
                        self.ao.kill(s.id)
                    except Exception:
                        pass
            elif open_prs:
                selected = open_prs[0]
                _apply_pr(record, selected, self.root)
                record.started_at = record.started_at or selected.updated_at or utc_now()
                if sessions:
                    _apply_session(record, sessions[0])
                    observed_at = _latest_iso(sessions[0].last_activity_at, selected.updated_at)
                    _note_progress(record, _progress_fingerprint(sessions[0], selected, record), observed_at)
                else:
                    _note_progress(record, _progress_fingerprint(None, selected, record), selected.updated_at)
                if record.review_dispatch_sha and record.review_dispatch_sha != selected.head_sha:
                    record.review_dispatch_state = ReviewDispatchState.STALE.value
                    record.review_verdict = None
                    record.review_sha = None
                    record.review_dispatch_trigger_attempts = 0
                    record.review_dispatch_last_attempt_at = None
                if record.review_terminal_rejection_sha and record.review_terminal_rejection_sha != selected.head_sha:
                    if record.review_correction_authorized_from_sha == record.review_terminal_rejection_sha:
                        record.review_terminal_rejection_sha = None
                if (
                    record.review_dispatch_state == ReviewDispatchState.ACTIVE.value
                    and record.review_dispatch_sha == selected.head_sha
                ):
                    record.status = PackageStatus.REVIEW
                else:
                    record.status = PackageStatus.PR_WAITING
                if record.blocked_reason and any(
                    token in record.blocked_reason.lower()
                    for token in (
                        "wall-clock",
                        "replan",
                        "stagnant",
                        "machine review budget exhausted",
                        "review terminal rejection",
                    )
                ):
                    if record.review_terminal_rejection_sha is None:
                        record.blocked_reason = None
                        record.last_error = None
                        record.replan_attempted = False
            elif sessions:
                _apply_session(record, sessions[0])
                record.branch = f"factory/{key}"
                _note_progress(record, _progress_fingerprint(sessions[0], None, record), sessions[0].last_activity_at)
                record.status = _session_package_status(record, sessions[0], self.config)
                if record.blocked_reason and any(token in record.blocked_reason.lower() for token in ("wall-clock", "budget exhausted", "replan", "stagnant")):
                    record.blocked_reason = None
                    record.replan_attempted = False
            elif record.task_attempts > 0 and record.session_id and any(item.id == record.session_id for item in terminal):
                # Preserve and recover the exact AO session. Never create a
                # second worktree when a terminated one may contain work.
                selected = next(item for item in terminal if item.id == record.session_id)
                _apply_session(record, selected)
                _note_progress(record, _progress_fingerprint(selected, None, record), selected.last_activity_at)
                record.status = PackageStatus.FAILED
                if record.blocked_reason and any(token in record.blocked_reason.lower() for token in ("wall-clock", "budget exhausted", "replan", "stagnant")):
                    record.blocked_reason = None
                    record.replan_attempted = False
            elif terminal and record.task_attempts > 0:
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "terminated AO sessions exist but none matches durable controller ownership; preserving work"
            elif self.github.branch_exists(f"factory/{key}") or _local_worktree_has_branch(self.root, f"factory/{key}"):
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "branch/worktree exists without a correlated active AO session or PR; preserving work"
            elif record.status == PackageStatus.BLOCKED:
                # Budget/policy blockers are durable. A branch, PR, merge, or
                # explicitly edited state file is required to change them.
                pass
            elif issue and all(work_key(milestone.id, dependency) in completed for dependency in package.dependencies):
                record.status = PackageStatus.READY
                record.blocked_reason = None
            elif issue:
                record.status = PackageStatus.PLANNED
                record.blocked_reason = None
            else:
                record.status = PackageStatus.PLANNED
            record.updated_at = utc_now()
            records[key] = record

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
        latest_milestone_progress = max(
            (r.last_progress_at for r in records.values() if r.last_progress_at),
            default=metadata.get("milestoneStartedAt", utc_now()),
        )
        if _expired(metadata["milestoneStartedAt"], self.config.max_milestone_wall_clock_seconds) and _expired(
            latest_milestone_progress, self.config.max_idle_seconds
        ):
            for key, record in records.items():
                if record.status != PackageStatus.COMPLETED:
                    package_id = key.removeprefix(f"{milestone.id}--")
                    self._block(milestone.id, package_id, record, "milestone stagnant without progress beyond idle watchdog", key)
            metadata["milestoneTimedOut"] = True
            self.store.save(records, metadata)
            return records
        resources = self.resource_state()
        if not resources.allowed:
            if metadata.get("resourceBlockedReason") != resources.reason:
                self.store.event("CIRCUIT_BREAKER_OPENED", milestoneId=milestone.id, reason=resources.reason)
                self._notify("FATAL", resources.reason)
            metadata["resourceBlockedReason"] = resources.reason
        elif metadata.pop("resourceBlockedReason", None):
            self.store.event("CIRCUIT_BREAKER_CLOSED", milestoneId=milestone.id, reason="resource gates recovered")

        packages = {work_key(milestone.id, item.id): item for item in milestone.packages}
        for key, record in records.items():
            package = packages[key]
            package_sessions = snapshot.sessions.get(key, [])
            live_sessions = [item for item in package_sessions if item.status.lower() not in TERMINAL_SESSION_STATES]
            terminal_sessions = [item for item in package_sessions if item.status.lower() in TERMINAL_SESSION_STATES]
            session = _single(live_sessions) or next(
                (item for item in terminal_sessions if item.id == record.session_id),
                None,
            )
            pr = _single([item for item in snapshot.prs.get(key, []) if item.state.upper() == "OPEN"])
            if record.status in {
                PackageStatus.STARTING,
                PackageStatus.ACTIVE,
                PackageStatus.IDLE,
                PackageStatus.WAITING_INPUT,
                PackageStatus.STUCK,
                PackageStatus.FAILED,
            } and session:
                if session.status.lower() in TERMINAL_SESSION_STATES:
                    if pr:
                        ci_status, _ = ci_state(pr, self.config.required_checks)
                        if ci_status == "PASS" and record.review_correction_authorized_from_sha != pr.head_sha:
                            record.status = PackageStatus.PR_WAITING
                            self._handle_pr(milestone, package, record, pr, session)
                        else:
                            self._handle_terminated(milestone, package, key, record, session, pr)
                    else:
                        self._handle_terminated(milestone, package, key, record, session, pr)
                else:
                    self._handle_activity(milestone, package, key, record, session, pr)
            elif record.status in {PackageStatus.PR_WAITING, PackageStatus.REVIEW} and pr:
                if any(records[work_key(milestone.id, dependency)].status != PackageStatus.COMPLETED for dependency in package.dependencies):
                    record.last_error = "dependency integration condition no longer holds"
                else:
                    self._handle_pr(milestone, package, record, pr, session)

        active = sum(record.status in {
            PackageStatus.STARTING, PackageStatus.ACTIVE, PackageStatus.IDLE, PackageStatus.WAITING_INPUT,
            PackageStatus.STUCK, PackageStatus.PR_WAITING, PackageStatus.CI, PackageStatus.REVIEW,
        } for record in records.values())
        slots = max(0, self.config.max_active_workers - active) if resources.allowed else 0
        for package in milestone.packages:
            if slots <= 0:
                break
            key = work_key(milestone.id, package.id)
            record = records[key]
            if record.status != PackageStatus.READY:
                continue
            if not package.parallelizable and active > 0:
                continue
            if record.task_attempts >= self.config.max_task_attempts:
                self._escalate_replan(milestone, package, key, record, "implementation attempt budget exhausted")
                continue
            assert record.issue_number is not None
            provider, selection_reason = select_implementation_provider(package, record, records, self.config)
            try:
                session_id = self.ao.spawn(
                    key,
                    record.issue_number,
                    provider,
                    worker_prompt(self.root, milestone, package, self.config.integration_branch),
                    self.config.agy_model if provider == "agy" else None,
                )
            except Exception as error:
                record.last_error = f"spawn failed: {error}"
                record.last_progress_at = utc_now()
                if "checked out in another worktree" in str(error).lower() or _local_worktree_has_branch(self.root, f"factory/{key}"):
                    self._block(milestone.id, package.id, record, f"spawn failed: {error}; branch checked out in existing worktree", key)
                else:
                    self._block(milestone.id, package.id, record, f"spawn failed: {error}", key)
                continue
            record.session_id = session_id
            record.provider = provider
            record.initial_provider = record.initial_provider or provider
            record.provider_selection = {
                "provider": provider,
                "reason": selection_reason,
                "initialProvider": record.initial_provider,
            }
            record.ao_status = "spawning"
            record.ao_activity = "spawning"
            record.branch = f"factory/{key}"
            record.task_attempts += 1
            record.provider_attempts[provider] = record.provider_attempts.get(provider, 0) + 1
            record.status = PackageStatus.STARTING
            record.started_at = utc_now()
            record.last_progress_at = record.started_at
            record.progress_fingerprint = f"spawn:{session_id}"
            record.updated_at = utc_now()
            self.store.event(
                "WORKER_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                workKey=key, provider=provider, providerSelection={"provider": provider, "reason": selection_reason},
                aoSessionId=session_id, attempt=record.task_attempts,
            )
            slots -= 1
            active += 1

        metadata.update({
            "milestoneId": milestone.id,
            "lastTickAt": utc_now(),
            "lastSuccessfulTickAt": utc_now(),
            "consecutiveTickFailures": 0,
        })
        metadata.pop("externalBlocker", None)
        if self.config.convergence_enabled and resources.allowed and records and all(
            record.status == PackageStatus.COMPLETED for record in records.values()
        ):
            self._converge_if_needed(milestone, records, metadata)
        self.store.save(records, metadata)
        return records

    def run(self, once: bool = False) -> None:
        import threading

        with self.store.lock():
            self.store.event("FACTORY_STARTED")
            records = self.store.load()
            metadata = self.store.metadata()
            metadata["controllerStartedAt"] = utc_now()
            metadata["consecutiveTickFailures"] = 0
            self.store.save(records, metadata)
            heartbeat_stop = threading.Event()
            heartbeat_thread = threading.Thread(
                target=self._heartbeat_loop,
                args=(heartbeat_stop,),
                name="chainsieve-factory-heartbeat",
                daemon=True,
            )
            heartbeat_thread.start()
            failures = 0
            try:
                while True:
                    try:
                        self.tick()
                        failures = 0
                    except Exception as error:
                        failures += 1
                        delay = _retry_delay(self.config.poll_seconds, failures)
                        metadata = self.store.metadata()
                        metadata["consecutiveTickFailures"] = failures
                        metadata["lastTickFailure"] = str(error)[-2000:]
                        metadata["retryDelaySeconds"] = delay
                        if _is_github_auth_blocker(error):
                            metadata["externalBlocker"] = "GITHUB_AUTH"
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
            finally:
                heartbeat_stop.set()
                heartbeat_thread.join(timeout=2)
                self.store.heartbeat(active=False)

    def _heartbeat_loop(self, stop: Any) -> None:
        interval = min(30, max(1, self.config.poll_seconds))
        while not stop.is_set():
            try:
                self.store.heartbeat(active=True)
            except OSError:
                pass
            if stop.wait(interval):
                return

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
            records.setdefault(work_key(milestone.id, package.id), PackageRecord())
        counts = {status.value: 0 for status in PackageStatus}
        for record in records.values():
            counts[record.status.value] += 1
        metadata = self.store.metadata()
        resources = self.resource_state()
        codex_usage = _codex_usage(self.config.state_dir)
        reasoning_providers = _reasoning_provider_status(self.config, self.config.state_dir)
        heartbeat = self.store.heartbeat_state()
        heartbeat_age = _elapsed_seconds(heartbeat.get("controllerHeartbeatAt"))
        stale_after = self.config.max_tick_duration_seconds + (2 * self.config.poll_seconds)
        if not heartbeat or heartbeat.get("active") is not True:
            liveness = "STOPPED_UNKNOWN"
        elif heartbeat_age is None or heartbeat_age > stale_after:
            liveness = "STALE"
        else:
            liveness = "ACTIVE"
        if (
            counts[PackageStatus.BLOCKED.value]
            or counts[PackageStatus.FAILED.value]
            or counts[PackageStatus.STUCK.value]
            or metadata.get("convergenceBlocked") is True
            or metadata.get("transitionStage") == TransitionStage.TRANSITION_BLOCKED.value
        ):
            overall = FactoryStatus.BLOCKED
        elif (
            counts[PackageStatus.COMPLETED.value] == len(records)
            and records
            and (not self.config.convergence_enabled or metadata.get("finalAuditConverged") is True)
        ):
            overall = FactoryStatus.DONE
        elif liveness != "ACTIVE" or not resources.allowed or int(metadata.get("consecutiveTickFailures", 0)) > 0:
            overall = FactoryStatus.DEGRADED
        else:
            overall = FactoryStatus.RUNNING
        active_op = metadata.get("reasoningOperation")
        if active_op and isinstance(active_op, dict) and active_op.get("startedAt"):
            op_started = active_op.get("startedAt")
            reasoning_operation = {
                "role": active_op.get("role"),
                "provider": active_op.get("provider"),
                "milestoneId": active_op.get("milestoneId"),
                "startedAt": op_started,
                "ageSeconds": _elapsed_seconds(op_started),
            }
        else:
            reasoning_operation = None
        return {
            "status": overall.value,
            "controllerLiveness": {
                "state": liveness,
                "heartbeatAt": heartbeat.get("controllerHeartbeatAt"),
                "ageSeconds": heartbeat_age,
                "staleAfterSeconds": stale_after,
            },
            "uptimeSeconds": _elapsed_seconds(metadata.get("controllerStartedAt")),
            "milestone": milestone.id,
            "progress": {"completed": counts[PackageStatus.COMPLETED.value], "total": len(records)},
            "counts": counts,
            "reasoningOperation": reasoning_operation,
            "usage": {
                "workerStarts": sum(record.task_attempts for record in records.values()),
                "corrections": sum(
                    (record.ci_corrections_used + record.liveness_remediations_used + record.integration_corrections_used)
                    if (record.ci_corrections_used or record.liveness_remediations_used or record.integration_corrections_used)
                    else record.correction_attempts
                    for record in records.values()
                ),
                "ciCorrections": sum(record.ci_corrections_used for record in records.values()),
                "livenessRemediations": sum(record.liveness_remediations_used for record in records.values()),
                "sessionRestores": sum(record.session_restore_attempts for record in records.values()),
                "integrationCorrections": sum(record.integration_corrections_used for record in records.values()),
                "reviews": sum(record.review_attempts for record in records.values()),
                "codex": codex_usage,
                "codexPlannerCalls": codex_usage["plannerCalls"],
                "codexReplanCalls": codex_usage["replanCalls"],
                "codexFinalAuditCalls": codex_usage["finalAuditCalls"],
                "codexEmergencyCalls": codex_usage["emergencyCalls"],
                "museFallbackCount": reasoning_providers["museFallbackSuccesses"],
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
            "reasoningProviders": reasoning_providers,
            "resources": resources.__dict__,
            "convergence": {
                "passes": int(metadata.get("convergencePasses", 0)),
                "milestoneConverged": bool(metadata.get("milestoneConverged", False)),
                "finalAuditConverged": bool(metadata.get("finalAuditConverged", False)),
                "codexCalls": codex_usage["total"],
            },
            "lastFailure": metadata.get("lastTickFailure"),
            "externalBlocker": metadata.get("externalBlocker"),
            "recentEvents": self.store.history(10),
        }

    def _handle_activity(
        self,
        milestone: Milestone,
        package: Any,
        key: str,
        record: PackageRecord,
        session: Session,
        pr: PullRequest | None,
    ) -> None:
        if record.status in {PackageStatus.REVIEW, PackageStatus.COMPLETED}:
            return
        activity = session.activity.lower()
        waiting = record.status == PackageStatus.WAITING_INPUT or activity in {"waiting_input", "blocked", "needs_input"}
        stuck = record.status == PackageStatus.STUCK
        if not waiting and not stuck:
            return
        if pr is not None and stuck and record.liveness_remediations_used >= self.config.max_liveness_remediations:
            ci_status, _ = ci_state(pr, self.config.required_checks)
            if ci_status == "PASS" and record.review_correction_authorized_from_sha != pr.head_sha:
                self.ao.kill(session.id)
                record.status = PackageStatus.PR_WAITING
                record.last_progress_at = utc_now()
                self._handle_pr(milestone, package, record, pr, session)
                return
        if record.liveness_remediations_used < self.config.max_liveness_remediations:
            reason = "stopped making meaningful progress" if stuck else "is waiting for input"
            try:
                self.ao.send(
                    session.id,
                    f"You {reason}. Continue in FULL AUTONOMOUS MODE. Do not wait for owner input. Resolve ordinary ambiguity from committed authority and evidence. If a tool permission prompt caused this state, exit it and continue with the preconfigured non-interactive permission mode.",
                )
                record.liveness_remediations_used += 1
                record.last_progress_at = utc_now()
                self.store.event(
                    "CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                    workKey=key, provider=record.provider, aoSessionId=session.id,
                    attempt=record.liveness_remediations_used, domain="liveness",
                    remediationsUsed=record.liveness_remediations_used,
                )
            except Exception as error:
                record.liveness_remediations_used += 1
                record.last_error = f"AO send correction failed: {error}"
                record.last_progress_at = utc_now()
                self.store.event(
                    "CORRECTION_FAILED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=key,
                    provider=record.provider,
                    aoSessionId=session.id,
                    attempt=record.liveness_remediations_used,
                    domain="liveness",
                    remediationsUsed=record.liveness_remediations_used,
                    error=str(error),
                    reason=str(error),
                )
                failure = "worker remained stuck" if stuck else "worker remained waiting for input"
                self._retry_or_replan(milestone, package, key, record, session, pr, f"{failure} (AO send failed: {error})")
        else:
            failure = "worker remained stuck" if stuck else "worker remained waiting for input"
            self._retry_or_replan(milestone, package, key, record, session, pr, f"{failure} after bounded remediation")

    def _handle_terminated(
        self,
        milestone: Milestone,
        package: Any,
        key: str,
        record: PackageRecord,
        session: Session,
        pr: PullRequest | None,
    ) -> None:
        if pr is not None and pr.state.upper() == "OPEN":
            ci_status, _ = ci_state(pr, self.config.required_checks)
            if ci_status == "PASS" and record.review_correction_authorized_from_sha != pr.head_sha:
                record.status = PackageStatus.PR_WAITING
                record.last_progress_at = utc_now()
                self._handle_pr(milestone, package, record, pr, session)
                return
        if record.session_restore_attempts < self.config.max_session_restores:
            try:
                self.ao.restore(session.id)
                record.session_restore_attempts += 1
                record.started_at = utc_now()
                record.last_progress_at = utc_now()
                self.store.event(
                    "WORKER_RESTORED", milestoneId=milestone.id, workPackageId=package.id,
                    workKey=key, provider=record.provider, aoSessionId=session.id,
                    attempt=record.session_restore_attempts, domain="session_restore",
                    sessionRestores=record.session_restore_attempts,
                )
                return
            except Exception as error:
                record.session_restore_attempts += 1
                record.last_error = f"AO restore failed: {error}"
                record.last_progress_at = utc_now()
                self.store.event(
                    "WORKER_RESTORE_FAILED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=key,
                    provider=record.provider,
                    aoSessionId=session.id,
                    attempt=record.session_restore_attempts,
                    domain="session_restore",
                    sessionRestores=record.session_restore_attempts,
                    error=str(error),
                    reason=str(error),
                )
                self._retry_or_replan(
                    milestone,
                    package,
                    key,
                    record,
                    session,
                    pr,
                    f"AO session restore failed: {error}",
                )
                return
        self._retry_or_replan(
            milestone,
            package,
            key,
            record,
            session,
            pr,
            "terminated AO session exceeded restore budget",
        )

    def _retry_or_replan(
        self,
        milestone: Milestone,
        package: Any,
        key: str,
        record: PackageRecord,
        session: Session,
        pr: PullRequest | None,
        failure: str,
    ) -> None:
        if pr is not None and pr.state.upper() == "OPEN":
            ci_status, _ = ci_state(pr, self.config.required_checks)
            if ci_status == "PASS" and record.review_correction_authorized_from_sha != pr.head_sha:
                record.status = PackageStatus.PR_WAITING
                record.last_progress_at = utc_now()
                self._handle_pr(milestone, package, record, pr, session)
                return
        remote_branch = self.github.branch_exists(f"factory/{key}")
        safe, evidence = _safe_alternate_retry(
            self.root, self.config.integration_branch, f"factory/{key}", session, pr, remote_branch
        )
        if safe:
            freed = False
            try:
                freed = self.ao.kill(session.id)
            except Exception:
                pass
            if hasattr(self.ao, "cleanup"):
                try:
                    self.ao.cleanup()
                except Exception:
                    pass
            worktree = _worktree_for_branch(self.root, f"factory/{key}")
            if not freed and (
                (session.workspace_path and Path(session.workspace_path).exists())
                or (worktree and worktree.exists())
            ):
                self._escalate_replan(milestone, package, key, record, f"{failure}; AO refused to clean a supposedly clean worktree")
                return

            if record.task_attempts < self.config.max_task_attempts:
                previous_provider = record.provider
                record.status = PackageStatus.READY
                record.session_id = None
                record.ci_corrections_used = 0
                record.ci_correction_authorized_from_sha = None
                record.liveness_remediations_used = 0
                record.session_restore_attempts = 0
                record.integration_corrections_used = 0
                record.integration_correction_authorized_for_head = None
                record.ci_infra_retries_used = 0
                record.ci_infra_retry_authorized_from_sha = None
                record.ao_status = "terminated-clean"
                record.ao_activity = "requeued"
                record.started_at = None
                record.last_progress_at = utc_now()
                record.last_error = evidence
                self.store.event(
                    "ALTERNATE_PROVIDER_REQUEUED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=key,
                    provider=previous_provider,
                    attempt=record.task_attempts + 1,
                    reason=evidence,
                )
                return
            self._escalate_replan(milestone, package, key, record, f"{failure}; both implementation providers exhausted after clean failures")
            return
        if record.task_attempts < self.config.max_task_attempts:
            try:
                try:
                    self.ao.kill(session.id)
                except Exception:
                    pass
                self.ao.restore(session.id)
                record.task_attempts += 1
                record.liveness_remediations_used = 0
                record.session_restore_attempts = 0
                record.started_at = utc_now()
                record.last_progress_at = utc_now()
                record.last_error = evidence
                self.store.event(
                    "WORKER_RESTORED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=key,
                    provider=record.provider,
                    aoSessionId=session.id,
                    attempt=record.task_attempts,
                )
                return
            except Exception as error:
                record.task_attempts += 1
                record.last_error = f"AO restore failed: {error}; preserved work: {evidence}"
                record.last_progress_at = utc_now()
                self.store.event(
                    "WORKER_RESTORE_FAILED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=key,
                    provider=record.provider,
                    aoSessionId=session.id,
                    attempt=record.task_attempts,
                    error=str(error),
                    reason=str(error),
                )
                self._escalate_replan(
                    milestone,
                    package,
                    key,
                    record,
                    f"{failure}; AO restore failed ({error}); preserved work: {evidence}",
                )
                return
        self._escalate_replan(
            milestone,
            package,
            key,
            record,
            f"{failure}; task attempts exhausted; preserved work: {evidence}",
        )

    def _handle_pr(
        self,
        milestone: Milestone,
        package: Any,
        record: PackageRecord,
        pr: PullRequest,
        session: Session | None = None,
    ) -> None:
        if record.status == PackageStatus.BLOCKED:
            return
        ci_status, ci_reason = ci_state(pr, self.config.required_checks)
        record.ci_status = ci_status
        if ci_status != "PASS":
            record.status = PackageStatus.CI_FIX
            if ci_status == "WAIT":
                record.last_error = ci_reason
                return

            causal_check = causal_ci_check(pr, self.config.required_checks)
            failure_kind, failure_detail, run_id = classify_ci_failure(pr, causal_check, self.github)

            if failure_kind == "INFRASTRUCTURE" and run_id is not None:
                # Idempotency (§9): derive a durable key from head+run+attempt
                # to prevent duplicate reruns across ticks/restarts.
                infra_idempotency_token = f"CI_INFRA_RETRY:{pr.head_sha}:{run_id}:{record.ci_infra_retries_used}"
                if record.last_error == infra_idempotency_token:
                    # Already dispatched for this exact run attempt — wait.
                    return
                if record.ci_infra_retries_used < self.config.max_ci_infra_retries:
                    try:
                        self.github.rerun_failed_jobs(run_id)
                        record.ci_infra_retries_used += 1
                        record.ci_infra_retry_authorized_from_sha = pr.head_sha
                        record.last_progress_at = utc_now()
                        infra_idempotency_token = f"CI_INFRA_RETRY:{pr.head_sha}:{run_id}:{record.ci_infra_retries_used}"
                        record.last_error = infra_idempotency_token
                        self.store.event(
                            "CI_INFRA_RETRY_STARTED",
                            milestoneId=milestone.id,
                            workPackageId=package.id,
                            workKey=work_key(milestone.id, package.id),
                            provider=record.provider,
                            aoSessionId=record.session_id,
                            pr=pr.number,
                            attempt=record.ci_infra_retries_used,
                            headSha=pr.head_sha,
                            runId=run_id,
                            detail=failure_detail,
                            domain="ci_infrastructure",
                            idempotencyKey=infra_idempotency_token,
                        )
                        return
                    except Exception as error:
                        # DEFECT C (§6): rerun dispatch failure MUST NOT fall
                        # through to product correction path.
                        record.last_error = f"CI_INFRA_RETRY_DISPATCH_FAILED:{pr.head_sha}:{run_id}"
                        self.store.event(
                            "CI_INFRA_RETRY_DISPATCH_FAILED",
                            milestoneId=milestone.id,
                            workPackageId=package.id,
                            workKey=work_key(milestone.id, package.id),
                            pr=pr.number,
                            headSha=pr.head_sha,
                            runId=run_id,
                            infraRetryAttempt=record.ci_infra_retries_used,
                            exceptionClass=type(error).__name__,
                            exceptionMessage=str(error)[:500],
                            domain="ci_infrastructure",
                        )
                        return
                else:
                    self._block(
                        milestone.id,
                        package.id,
                        record,
                        f"CI infrastructure retry budget exhausted on head {pr.head_sha}: {ci_reason}",
                        work_key(milestone.id, package.id),
                    )
                    return

            token = f"CI:{pr.head_sha}:{ci_reason}"
            if record.session_id and record.last_error != token:
                # DEFECT D (§7): UNKNOWN classification MUST NOT consume product
                # CI correction budget or prompt the worker to edit code.
                if failure_kind == "UNKNOWN":
                    record.last_error = f"CI_UNKNOWN:{pr.head_sha}:{failure_detail}"
                    self.store.event(
                        "CI_FAILURE_CLASSIFICATION_UNKNOWN",
                        milestoneId=milestone.id,
                        workPackageId=package.id,
                        workKey=work_key(milestone.id, package.id),
                        pr=pr.number,
                        headSha=pr.head_sha,
                        causalCheck=str((causal_check or {}).get("name", "")),
                        detail=failure_detail,
                        runId=run_id,
                    )
                    return

                already_authorized_for_head = (record.ci_correction_authorized_from_sha == pr.head_sha)
                if not already_authorized_for_head:
                    if record.ci_corrections_used >= self.config.max_ci_correction_rounds:
                        self._block(
                            milestone.id,
                            package.id,
                            record,
                            f"CI correction budget exhausted: {ci_reason}",
                            work_key(milestone.id, package.id),
                        )
                        return
                    record.ci_corrections_used += 1
                    record.ci_correction_authorized_from_sha = pr.head_sha

                self.ao.send(
                    record.session_id,
                    f"Required CI is not green for PR #{pr.number} at {pr.head_sha}: {ci_reason}. Create a new additive correction commit and normal push. Do not amend, rebase, or force-push the existing reviewed history.",
                )
                record.last_error = token
                record.last_progress_at = utc_now()
                self.store.event(
                    "CI_CORRECTION_STARTED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=work_key(milestone.id, package.id),
                    provider=record.provider,
                    aoSessionId=record.session_id,
                    pr=pr.number,
                    attempt=record.ci_corrections_used,
                    headSha=pr.head_sha,
                    domain="product_ci",
                    ciCorrectionsUsed=record.ci_corrections_used,
                )
                return
            if record.session_id and record.last_error == token and session is not None:
                if session.status.lower() in TERMINAL_SESSION_STATES:
                    self._handle_terminated(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                    return
                session_status = _session_package_status(record, session, self.config)
                if session_status in {PackageStatus.STUCK, PackageStatus.WAITING_INPUT}:
                    record.status = session_status
                    self._handle_activity(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                    return
            return

        if review_required(package):
            if not record.session_id:
                self._block(milestone.id, package.id, record, "review-required PR has no correlated AO session", work_key(milestone.id, package.id))
                return
            context_path = self.store.write_review_context(milestone.id, package, pr.head_sha)
            context = json.loads(context_path.read_text(encoding="utf-8"))
            expected_context_digest = str(context["contextDigest"])
            required_reviewer = reviewer_for(record.provider or package.preferred_provider)
            target_dispatch_key = review_dispatch_key(
                work_key(milestone.id, package.id),
                pr.number,
                pr.head_sha,
                required_reviewer,
                expected_context_digest,
            )

            if record.review_dispatch_key and record.review_dispatch_key != target_dispatch_key:
                record.review_dispatch_state = ReviewDispatchState.STALE.value
                record.review_verdict = None
                record.review_sha = None
                record.review_dispatch_trigger_attempts = 0
                record.review_dispatch_last_attempt_at = None
                if (
                    record.review_terminal_rejection_sha
                    and record.review_correction_authorized_from_sha == record.review_terminal_rejection_sha
                ):
                    record.review_terminal_rejection_sha = None

            reviews = self.ao.reviews(record.session_id or "")
            review_ok, review_reason, reviewer, verdict = review_gate(
                reviews, pr.head_sha, required_reviewer, expected_context_digest,
            )

            raw_runs = reviews.get("reviews") or reviews.get("data") or []
            runs = [r.get("latestRun") if isinstance(r, dict) and r.get("latestRun") else r for r in raw_runs if isinstance(r, dict)]
            matching_runs = [
                item for item in runs
                if isinstance(item, dict)
                and item.get("targetSha") == pr.head_sha
                and (required_reviewer is None or str(item.get("harness", "")) == required_reviewer)
            ]
            matching_run = sorted(matching_runs, key=lambda item: str(item.get("createdAt", "")))[-1] if matching_runs else None

            if matching_run is not None:
                run_status = str(matching_run.get("status", "")).lower()
                run_id = matching_run.get("id") or matching_run.get("reviewId")
                record.review_dispatch_key = target_dispatch_key
                record.review_dispatch_pr = pr.number
                record.review_dispatch_sha = pr.head_sha
                record.review_dispatch_reviewer = required_reviewer
                record.review_dispatch_context_digest = expected_context_digest
                record.review_dispatch_run_id = str(run_id) if run_id else None
                record.review_dispatch_trigger_attempts = 0
                record.review_dispatch_last_attempt_at = None

                if run_status not in {"complete", "completed", "delivered"}:
                    record.review_dispatch_state = ReviewDispatchState.ACTIVE.value
                    record.status = PackageStatus.REVIEW
                    record.last_progress_at = utc_now()
                    return

                record.review_sha = pr.head_sha
                record.review_verdict = verdict
                record.review_dispatch_state = ReviewDispatchState.COMPLETED.value

                if not review_ok:
                    if reviewer is not None and verdict in {"approved", "pass"}:
                        self._block(
                            milestone.id,
                            package.id,
                            record,
                            f"approved machine review failed semantic authority proof: {review_reason}",
                            work_key(milestone.id, package.id),
                        )
                    elif reviewer is not None and verdict not in {"approved", "pass"} and _review_pending(review_reason):
                        record.status = PackageStatus.REVIEW
                    elif reviewer is not None and verdict not in {"approved", "pass"} and record.review_corrections_used < self.config.max_review_cycles:
                        token = f"REVIEW:{pr.head_sha}:{verdict}:{review_reason}"
                        if record.last_error != token:
                            record.review_corrections_used += 1
                            record.review_correction_authorized_from_sha = pr.head_sha
                            self.ao.send(
                                record.session_id or "",
                                f"The independent {reviewer} review rejected PR #{pr.number} at {pr.head_sha}: {review_reason}. Create a new additive correction commit and normal push. Do not amend, rebase, or force-push the existing reviewed history.",
                            )
                            record.last_error = token
                            record.last_progress_at = utc_now()
                            self.store.event(
                                "REVIEW_CORRECTION_AUTHORIZED", milestoneId=milestone.id, workPackageId=package.id,
                                workKey=work_key(milestone.id, package.id), provider=record.provider, reviewer=reviewer, aoSessionId=record.session_id,
                                pr=pr.number, attempt=record.review_corrections_used, headSha=pr.head_sha, reviewRunId=record.review_dispatch_run_id,
                                contextDigest=expected_context_digest,
                            )
                            self.store.event(
                                "REVIEW_CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                                workKey=work_key(milestone.id, package.id), provider=record.provider, reviewer=reviewer, aoSessionId=record.session_id,
                                pr=pr.number, attempt=record.review_corrections_used, headSha=pr.head_sha,
                            )
                            record.status = PackageStatus.PR_WAITING
                            return
                        record.status = PackageStatus.PR_WAITING
                        if record.session_id and session is not None:
                            if session.status.lower() in TERMINAL_SESSION_STATES:
                                self._handle_terminated(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                                return
                            session_status = _session_package_status(record, session, self.config)
                            if session_status in {PackageStatus.STUCK, PackageStatus.WAITING_INPUT} or session.activity.lower() in {"waiting_input", "blocked", "needs_input"}:
                                record.status = session_status
                                self._handle_activity(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                                return
                        return
                    elif (
                        record.review_corrections_used >= self.config.max_review_cycles
                        and verdict not in {"approved", "pass"}
                        and record.review_correction_authorized_from_sha == pr.head_sha
                    ):
                        record.status = PackageStatus.PR_WAITING
                        if record.session_id and session is not None:
                            if session.status.lower() in TERMINAL_SESSION_STATES:
                                self._handle_terminated(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                                return
                            session_status = _session_package_status(record, session, self.config)
                            if session_status in {PackageStatus.STUCK, PackageStatus.WAITING_INPUT} or session.activity.lower() in {"waiting_input", "blocked", "needs_input"}:
                                record.status = session_status
                                self._handle_activity(milestone, package, work_key(milestone.id, package.id), record, session, pr)
                                return
                        return
                    elif record.review_corrections_used >= self.config.max_review_cycles and verdict not in {"approved", "pass"}:
                        record.review_terminal_rejection_sha = pr.head_sha
                        self._escalate_replan(
                            milestone,
                            package,
                            work_key(milestone.id, package.id),
                            record,
                            f"semantic review correction budget exhausted after final exact-head verification: {review_reason}",
                        )
                    else:
                        record.status = PackageStatus.REVIEW
                    return
                else:
                    record.review_terminal_rejection_sha = None
                    record.blocked_reason = None
                    record.last_error = None
            else:
                if (
                    record.review_dispatch_key == target_dispatch_key
                    and record.review_dispatch_state == ReviewDispatchState.ACTIVE.value
                ):
                    record.status = PackageStatus.REVIEW
                    return
                elif (
                    record.review_dispatch_key == target_dispatch_key
                    and record.review_dispatch_state in {ReviewDispatchState.CLAIMED.value, ReviewDispatchState.UNKNOWN.value}
                ):
                    last_attempt = _parse_iso(record.review_dispatch_last_attempt_at)
                    now = datetime.now(UTC)
                    elapsed = (now - last_attempt).total_seconds() if last_attempt else float("inf")

                    if elapsed < REVIEW_DISPATCH_AMBIGUITY_GRACE_SECONDS:
                        record.status = PackageStatus.REVIEW
                        return

                    if record.review_dispatch_trigger_attempts < MAX_REVIEW_DISPATCH_TRIGGER_ATTEMPTS:
                        record.review_dispatch_trigger_attempts += 1
                        record.review_dispatch_last_attempt_at = utc_now()
                        record.status = PackageStatus.REVIEW
                        record.last_progress_at = utc_now()

                        current_records = self.store.load()
                        current_records[work_key(milestone.id, package.id)] = record
                        self.store.save(current_records, self.store.metadata())

                        try:
                            self.ao.trigger_review(record.session_id or "", required_reviewer)
                            record.review_dispatch_state = ReviewDispatchState.ACTIVE.value
                            self.store.event(
                                "REVIEW_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                                workKey=work_key(milestone.id, package.id), provider=required_reviewer, aoSessionId=record.session_id, pr=pr.number,
                                attempt=record.review_attempts, headSha=pr.head_sha, reviewContext=str(context_path),
                                contextDigest=expected_context_digest,
                            )
                        except Exception as error:
                            record.review_dispatch_state = ReviewDispatchState.UNKNOWN.value
                            record.last_error = f"AO review trigger retry failed: {error}"
                            self.store.event(
                                "REVIEW_TRIGGER_FAILED", milestoneId=milestone.id, workPackageId=package.id,
                                workKey=work_key(milestone.id, package.id), provider=required_reviewer, aoSessionId=record.session_id, pr=pr.number,
                                attempt=record.review_attempts, headSha=pr.head_sha, error=str(error),
                            )
                        return
                    else:
                        record.review_dispatch_state = ReviewDispatchState.FAILED.value
                        self._block(
                            milestone.id,
                            package.id,
                            record,
                            f"review dispatch trigger recovery exhausted: {record.last_error or 'AO trigger failed'}",
                            work_key(milestone.id, package.id),
                        )
                        return
                else:
                    if record.review_terminal_rejection_sha is not None:
                        if record.review_correction_authorized_from_sha == record.review_terminal_rejection_sha:
                            record.review_terminal_rejection_sha = None
                        else:
                            self._block(
                                milestone.id,
                                package.id,
                                record,
                                f"machine review budget exhausted: review terminal rejection recorded at {record.review_terminal_rejection_sha}",
                                work_key(milestone.id, package.id),
                            )
                            return

                    record.review_dispatch_key = target_dispatch_key
                    record.review_dispatch_state = ReviewDispatchState.CLAIMED.value
                    record.review_dispatch_pr = pr.number
                    record.review_dispatch_sha = pr.head_sha
                    record.review_dispatch_reviewer = required_reviewer
                    record.review_dispatch_context_digest = expected_context_digest
                    record.review_dispatch_requested_at = utc_now()
                    record.review_dispatch_trigger_attempts = 1
                    record.review_dispatch_last_attempt_at = utc_now()
                    record.review_attempts += 1
                    record.review_dispatch_attempt = record.review_attempts
                    record.status = PackageStatus.REVIEW
                    record.last_progress_at = utc_now()

                    current_records = self.store.load()
                    current_records[work_key(milestone.id, package.id)] = record
                    self.store.save(current_records, self.store.metadata())

                    try:
                        self.ao.trigger_review(record.session_id or "", required_reviewer)
                        record.review_dispatch_state = ReviewDispatchState.ACTIVE.value
                        self.store.event(
                            "REVIEW_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                            workKey=work_key(milestone.id, package.id), provider=required_reviewer, aoSessionId=record.session_id, pr=pr.number,
                            attempt=record.review_attempts, headSha=pr.head_sha, reviewContext=str(context_path),
                            contextDigest=expected_context_digest,
                        )
                    except Exception as error:
                        record.review_dispatch_state = ReviewDispatchState.UNKNOWN.value
                        record.last_error = f"AO review trigger failed: {error}"
                        self.store.event(
                            "REVIEW_TRIGGER_FAILED", milestoneId=milestone.id, workPackageId=package.id,
                            workKey=work_key(milestone.id, package.id), provider=required_reviewer, aoSessionId=record.session_id, pr=pr.number,
                            attempt=record.review_attempts, headSha=pr.head_sha, error=str(error),
                        )
                    return

        violations = protected_path_violations(pr.files, self.config.protected_paths, package)
        if violations:
            self._block(milestone.id, package.id, record, f"unauthorized protected-path changes: {', '.join(violations)}", work_key(milestone.id, package.id))
            return
        if pr.mergeable.upper() == "CONFLICTING" or pr.merge_state.upper() in {"DIRTY", "BEHIND"}:
            integration_state = "CONFLICTING" if pr.mergeable.upper() == "CONFLICTING" else pr.merge_state.upper()
            token = f"MERGE:{pr.head_sha}:{integration_state}"
            if record.session_id and record.last_error != token:
                if record.integration_corrections_used >= self.config.max_integration_corrections:
                    self._escalate_replan(
                        milestone,
                        package,
                        work_key(milestone.id, package.id),
                        record,
                        "repeated material integration conflict exhausted merge-update correction budget",
                    )
                    return
                self.ao.send(
                    record.session_id,
                    f"PR #{pr.number} at {pr.head_sha} is {integration_state} relative to "
                    f"{self.config.integration_branch}. Merge that exact target into your branch, resolve any "
                    "ordinary conflict from committed authority, rerun focused checks, and normal push. Do not amend, rebase, or force-push.",
                )
                record.integration_corrections_used += 1
                record.integration_correction_authorized_for_head = pr.head_sha
                record.last_error = token
                record.last_progress_at = utc_now()
                self.store.event(
                    "MERGE_UPDATE_STARTED",
                    milestoneId=milestone.id,
                    workPackageId=package.id,
                    workKey=work_key(milestone.id, package.id),
                    provider=record.provider,
                    aoSessionId=record.session_id,
                    pr=pr.number,
                    attempt=record.integration_corrections_used,
                    headSha=pr.head_sha,
                    domain="integration",
                    integrationCorrectionsUsed=record.integration_corrections_used,
                )
            record.status = PackageStatus.PR_WAITING
            return
        if not pr.head_sha or pr.mergeable.upper() != "MERGEABLE" or pr.merge_state.upper() in {"UNKNOWN", "DIRTY", "BEHIND"}:
            record.status = PackageStatus.PR_WAITING
            record.last_error = f"PR not mergeable: {pr.mergeable}/{pr.merge_state}"
            return

        self.github.merge(pr)
        record.status = PackageStatus.COMPLETED
        record.ao_status = "merged"
        record.ao_activity = "merged"
        record.updated_at = utc_now()
        record.last_progress_at = utc_now()
        if record.session_id:
            try:
                self.ao.kill(record.session_id)
            except Exception:
                pass
        if record.issue_number:
            self.github.close_issue(record.issue_number, f"Automatically integrated by the factory at reviewed head `{pr.head_sha}`.")
        self.store.event(
            "PR_MERGED", milestoneId=milestone.id, workPackageId=package.id, workKey=work_key(milestone.id, package.id),
            provider=record.provider, aoSessionId=record.session_id, pr=pr.number, headSha=pr.head_sha,
        )
        self.store.event("WORK_PACKAGE_COMPLETED", milestoneId=milestone.id, workPackageId=package.id, workKey=work_key(milestone.id, package.id))

    def _block(
        self, milestone_id: str, package_id: str, record: PackageRecord, reason: str, key: str | None = None
    ) -> None:
        record.status = PackageStatus.BLOCKED
        record.blocked_reason = reason
        record.last_error = reason
        self.store.event("CIRCUIT_BREAKER_OPENED", milestoneId=milestone_id, workPackageId=package_id, workKey=key, reason=reason)
        self._notify("FATAL", f"{package_id}: {reason}")

    def _escalate_replan(
        self, milestone: Milestone, package: Any, key: str, record: PackageRecord, reason: str
    ) -> None:
        if record.replan_attempted:
            self._block(milestone.id, package.id, record, "replan already attempted; refusing escalation loop", key)
            return
        record.replan_attempted = True
        from .reasoning import ReasoningRunner

        reasoning = self.reasoner or ReasoningRunner(self.root, self.config, self.store, self.github.runner)
        self.store.event("REPLAN_STARTED", milestoneId=milestone.id, workPackageId=package.id, workKey=key, reason=reason)
        try:
            result = reasoning.replan(milestone, package, reason)
        except Exception as error:
            self._block(milestone.id, package.id, record, f"Codex replan unavailable or budget exhausted: {error}", key)
            return
        if result.get("status") == "ARCHITECTURE_CONTRADICTION":
            try:
                result = reasoning.emergency(milestone, package, str(result.get("reason") or reason))
            except Exception as error:
                self._block(milestone.id, package.id, record, f"Codex emergency unavailable or budget exhausted: {error}", key)
                return
        if result.get("status") != "REPLANNED":
            self._block(milestone.id, package.id, record, "Codex escalation did not produce a safe deterministic plan", key)
            return
        record.status = PackageStatus.BLOCKED
        record.blocked_reason = "superseded by bounded Codex replan"
        record.last_error = reason
        self.store.event("REPLAN_COMPLETED", milestoneId=milestone.id, workPackageId=package.id, workKey=key)

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
        # Before convergence reasoning: gate on synchronized integration head
        ready, l_head, r_head = self._sync_and_verify_integration_head(milestone.id)
        if not ready:
            return

        current_head = l_head or ""

        # If integration head has moved since previous convergence or previous block, clear stale state
        last_head = metadata.get("convergedHeadSha") or metadata.get("lastBlockedHeadSha")
        if last_head and current_head and last_head != current_head:
            metadata["milestoneConverged"] = False
            metadata["convergedMilestoneId"] = None
            metadata["convergedHeadSha"] = None
            metadata["convergedContextDigest"] = None
            metadata["transitionStage"] = None
            metadata["targetMilestoneId"] = None
            metadata["convergenceBlocked"] = False
            metadata["convergencePasses"] = 0
            metadata["convergenceReplanAttempted"] = False
            metadata.pop("migrationConvergenceDone", None)
            metadata.pop("migrationConvergenceAttempted", None)
            metadata.pop("migrationConvergenceClaimed", None)
            metadata.pop("lastBlockedHeadSha", None)
            metadata.pop("validatedPlan", None)
            metadata.pop("plannerRejectionReason", None)
            self.store.save(records, metadata)

        if metadata.get("finalAuditConverged") is True:
            return

        if (
            metadata.get("convergenceBlocked") is True
            or metadata.get("transitionStage") == TransitionStage.TRANSITION_BLOCKED.value
        ):
            return

        from .reasoning import (
            ConvergenceOutputRejectedError,
            ReasoningBudgetExhaustedError,
            ReasoningContextUnavailableError,
            ReasoningRunner,
            write_remediation,
        )

        # Check existing convergence evidence
        if metadata.get("milestoneConverged") is True or metadata.get("transitionStage") in {
            TransitionStage.CONVERGED.value,
            TransitionStage.PLANNER_PRIMARY_CLAIMED.value,
            TransitionStage.PLANNER_PRIMARY_FAILED.value,
            TransitionStage.PLANNER_FALLBACK_CLAIMED.value,
            TransitionStage.NEXT_MILESTONE_VALIDATED.value,
            TransitionStage.NEXT_MILESTONE_INSTALLED.value,
        }:
            converged_head = metadata.get("convergedHeadSha")
            converged_ms = metadata.get("convergedMilestoneId")
            if converged_ms == milestone.id and converged_head == current_head and converged_head:
                self._advance_or_audit(milestone, records, metadata)
                return

        passes = int(metadata.get("convergencePasses", 0))
        if passes >= self.config.max_convergence_passes:
            self._replan_convergence(milestone, metadata)
            return

        reasoning = self.reasoner or ReasoningRunner(self.root, self.config, self.store, self.github.runner)

        usage = reasoning._usage()
        milestone_usage = usage.get("milestones", {}).get(milestone.id, {})
        codex_conv_calls = int(milestone_usage.get("codexCallsByRole", {}).get("convergence", 0))
        max_conv_calls = self.config.codex_routes["convergence"].max_calls_per_milestone

        result = None
        if codex_conv_calls >= max_conv_calls:
            if not metadata.get("migrationConvergenceDone"):
                try:
                    result = reasoning.converge_fallback(milestone)
                    metadata["migrationConvergenceDone"] = True
                except Exception as error:
                    metadata["migrationConvergenceDone"] = True
                    self._block_factory(milestone.id, metadata, f"Transition migration convergence recovery failed: {error}")
                    return
            else:
                self._block_factory(milestone.id, metadata, "Codex convergence call budget exhausted")
                return
        else:
            self.store.event("CONVERGENCE_STARTED", milestoneId=milestone.id, attempt=passes + 1)
            try:
                result = reasoning.converge(milestone)
            except ReasoningBudgetExhaustedError as error:
                self._block_factory(milestone.id, metadata, str(error))
                return
            except ConvergenceOutputRejectedError as error:
                self.store.event(
                    "CONVERGENCE_OUTPUT_REJECTED",
                    milestoneId=milestone.id,
                    attempt=passes + 1,
                    reason=str(error),
                    failureClass=error.failure_class,
                    workPackageId=error.gap_id,
                )
                raise RuntimeError(f"Convergence output rejected: {error}")
            except ReasoningContextUnavailableError as error:
                self.store.event(
                    "REASONING_CONTEXT_UNAVAILABLE",
                    milestoneId=milestone.id,
                    attempt=passes + 1,
                    reason=str(error),
                )
                raise RuntimeError(f"Convergence context unavailable: {error}")

        metadata["convergencePasses"] = passes + 1
        if result["status"] == "CONVERGED":
            metadata["milestoneConverged"] = True
            metadata["convergedMilestoneId"] = milestone.id
            metadata["convergedHeadSha"] = result.get("headSha") or l_head
            metadata["convergedContextDigest"] = result.get("contextDigest")
            metadata["transitionStage"] = TransitionStage.CONVERGED.value
            self.store.event(
                "MILESTONE_CONVERGED",
                milestoneId=milestone.id,
                attempt=passes + 1,
                headSha=metadata["convergedHeadSha"],
                contextDigest=metadata["convergedContextDigest"],
            )
            self._notify("INFO", f"Milestone {milestone.id} converged")
            # DURABLE SAVE BEFORE ADVANCE / PLANNING
            self.store.save(records, metadata)
            self._advance_or_audit(milestone, records, metadata)
            return

        write_remediation(self.config, milestone, result["gaps"])
        metadata["milestoneConverged"] = False
        self.store.save(records, metadata)
        for gap in result["gaps"]:
            self.store.event(
                "CONVERGENCE_GAP_FOUND", milestoneId=milestone.id,
                workPackageId=gap["id"], workKey=work_key(milestone.id, gap["id"]), attempt=passes + 1,
            )

    def _replan_convergence(self, milestone: Milestone, metadata: dict[str, Any]) -> None:
        if metadata.get("convergenceReplanAttempted"):
            self._block_factory(milestone.id, metadata, "convergence replan already attempted; refusing escalation loop")
            return
        metadata["convergenceReplanAttempted"] = True
        from .reasoning import ReasoningRunner

        reasoning = self.reasoner or ReasoningRunner(self.root, self.config, self.store, self.github.runner)
        failed = milestone.packages[-1]
        reason = "repeated convergence gaps indicate a decomposition or architecture-level mismatch"
        self.store.event("REPLAN_STARTED", milestoneId=milestone.id, workPackageId=failed.id, workKey=work_key(milestone.id, failed.id), reason=reason)
        try:
            result = reasoning.replan(milestone, failed, reason)
        except Exception as error:
            self._block_factory(milestone.id, metadata, f"Codex convergence replan unavailable or budget exhausted: {error}")
            return
        if result.get("status") == "ARCHITECTURE_CONTRADICTION":
            try:
                result = reasoning.emergency(milestone, failed, str(result.get("reason") or reason))
            except Exception as error:
                self._block_factory(milestone.id, metadata, f"Codex emergency unavailable or budget exhausted: {error}")
                return
        if result.get("status") != "REPLANNED":
            self._block_factory(milestone.id, metadata, "Codex convergence escalation did not produce a deterministic plan")
            return
        metadata["convergencePasses"] = 0
        metadata["milestoneConverged"] = False
        self.store.event("REPLAN_COMPLETED", milestoneId=milestone.id, reason=reason)

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
        from .reasoning import (
            ConvergenceOutputRejectedError,
            PlannerOutputRejectedError,
            ReasoningBudgetExhaustedError,
            ReasoningContextUnavailableError,
            ReasoningRunner,
            audit_remediation,
            write_remediation,
            _write_planning_bundle,
        )

        reasoning = self.reasoner or ReasoningRunner(self.root, self.config, self.store, self.github.runner)
        if index + 1 < len(roadmap):
            target = roadmap[index + 1]
            metadata["targetMilestoneId"] = target["id"]
            stage = metadata.get("transitionStage") or TransitionStage.CONVERGED.value

            # Stage 1: CONVERGED -> PLANNER_PRIMARY
            if stage == TransitionStage.CONVERGED.value:
                usage = reasoning._usage()
                planner_calls = int(usage.get("milestones", {}).get(milestone.id, {}).get("codexCallsByRole", {}).get("planner", 0))
                max_planner_calls = self.config.codex_routes["planner"].max_calls_per_milestone

                if planner_calls >= max_planner_calls:
                    stage = TransitionStage.PLANNER_PRIMARY_FAILED.value
                    metadata["transitionStage"] = stage
                    metadata["plannerRejectionReason"] = "Primary Codex planner budget consumed / previously failed"
                    self.store.save(records, metadata)
                else:
                    stage = TransitionStage.PLANNER_PRIMARY_CLAIMED.value
                    metadata["transitionStage"] = stage
                    self.store.save(records, metadata)
                    try:
                        plan_data = reasoning.plan_milestone_primary(milestone, target)
                        stage = TransitionStage.NEXT_MILESTONE_VALIDATED.value
                        metadata["transitionStage"] = stage
                        metadata["validatedPlan"] = plan_data
                        self.store.save(records, metadata)
                    except Exception as error:
                        stage = TransitionStage.PLANNER_PRIMARY_FAILED.value
                        metadata["transitionStage"] = stage
                        metadata["plannerRejectionReason"] = str(error)
                        self.store.save(records, metadata)
                        self.store.event(
                            "PLANNER_OUTPUT_REJECTED",
                            milestoneId=milestone.id,
                            targetMilestoneId=target["id"],
                            reason=str(error),
                        )

            # Stage 2: PLANNER_PRIMARY_CLAIMED (recovering from crash during primary claim)
            if stage == TransitionStage.PLANNER_PRIMARY_CLAIMED.value:
                stage = TransitionStage.PLANNER_PRIMARY_FAILED.value
                metadata["transitionStage"] = stage
                metadata["plannerRejectionReason"] = metadata.get("plannerRejectionReason") or "Primary planner interrupted"
                self.store.save(records, metadata)

            # Stage 3: PLANNER_PRIMARY_FAILED / PLANNER_FALLBACK_CLAIMED -> PLANNER_FALLBACK
            if stage in {TransitionStage.PLANNER_PRIMARY_FAILED.value, TransitionStage.PLANNER_FALLBACK_CLAIMED.value}:
                stage = TransitionStage.PLANNER_FALLBACK_CLAIMED.value
                metadata["transitionStage"] = stage
                self.store.save(records, metadata)
                try:
                    rejection_reason = metadata.get("plannerRejectionReason", "Previous plan failed validation")
                    plan_data = reasoning.plan_milestone_fallback(milestone, target, rejection_reason)
                    stage = TransitionStage.NEXT_MILESTONE_VALIDATED.value
                    metadata["transitionStage"] = stage
                    metadata["validatedPlan"] = plan_data
                    self.store.save(records, metadata)
                except Exception as error:
                    stage = TransitionStage.TRANSITION_BLOCKED.value
                    metadata["transitionStage"] = stage
                    metadata["lastTickFailure"] = f"Planner fallback failed: {error}"
                    self.store.save(records, metadata)
                    self._block_factory(milestone.id, metadata, f"Planner fallback failed: {error}")
                    return

            # Stage 4: PLANNER_FALLBACK_CLAIMED (recovering from crash during fallback claim)
            if stage == TransitionStage.PLANNER_FALLBACK_CLAIMED.value:
                stage = TransitionStage.TRANSITION_BLOCKED.value
                metadata["transitionStage"] = stage
                metadata["lastTickFailure"] = "Planner fallback interrupted"
                self.store.save(records, metadata)
                self._block_factory(milestone.id, metadata, "Planner fallback interrupted")
                return

            # Stage 5: NEXT_MILESTONE_VALIDATED -> atomic installation & archive
            if stage == TransitionStage.NEXT_MILESTONE_VALIDATED.value:
                plan_data = metadata.get("validatedPlan")
                if not plan_data:
                    next_path = self.config.state_dir / "next-milestone.json"
                    if next_path.exists():
                        plan_data = json.loads(next_path.read_text(encoding="utf-8"))
                planned = Milestone.from_dict(plan_data)

                # 1. Archive previous milestone if not already archived
                archive_dir = self.config.state_dir / "archive"
                archive_file = archive_dir / f"{milestone.id}.json"
                if not archive_file.exists():
                    self.store.archive(milestone.id, records, metadata)

                # 2. Write active-milestone.json atomically
                active_path = self.config.state_dir / "active-milestone.json"
                temporary = active_path.with_suffix(".json.tmp")
                temporary.write_text(json.dumps(plan_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                temporary.chmod(0o640)
                temporary.replace(active_path)

                # 3. Write planning bundle
                _write_planning_bundle(self.config.state_dir, planned)

                # 4. Clean up transition metadata and install next milestone
                metadata["nextMilestoneId"] = planned.id
                metadata["milestoneId"] = planned.id
                metadata["previousMilestoneId"] = milestone.id
                metadata["transitionStage"] = TransitionStage.NEXT_MILESTONE_INSTALLED.value
                metadata["milestoneConverged"] = False
                metadata["convergencePasses"] = 0
                metadata["milestoneStartedAt"] = utc_now()
                metadata.pop("validatedPlan", None)
                metadata.pop("plannerRejectionReason", None)
                metadata.pop("targetMilestoneId", None)
                metadata.pop("convergedMilestoneId", None)
                metadata.pop("convergedHeadSha", None)
                metadata.pop("convergedContextDigest", None)
                metadata.pop("migrationConvergenceClaimed", None)
                metadata.pop("migrationConvergenceAttempted", None)

                # 5. Emit MILESTONE_PLANNED event
                self.store.event("MILESTONE_PLANNED", milestoneId=planned.id, reason=f"after {milestone.id}")
                self.store.save({}, metadata)
                return

            if stage == TransitionStage.NEXT_MILESTONE_INSTALLED.value:
                return

            if stage == TransitionStage.TRANSITION_BLOCKED.value:
                self._block_factory(milestone.id, metadata, metadata.get("lastTickFailure") or "Milestone transition blocked")
                return

            return

        output = self.config.state_dir / "final-audit.json"
        cycles = int(metadata.get("finalAuditCycles", 0))
        if cycles >= self.config.max_final_audit_cycles:
            self._block_factory(
                milestone.id,
                metadata,
                f"final audit cycle budget exhausted after {cycles} NOT_CONVERGED result(s)",
            )
            return
        cycle = cycles + 1
        self.store.event("FINAL_AUDIT_STARTED", milestoneId=milestone.id, cycle=cycle)
        try:
            value = reasoning.final_audit(output)
            metadata["finalAuditCycles"] = cycle
            if value.get("status") == "CONVERGED":
                metadata["finalAuditConverged"] = True
                self.store.event("FACTORY_CONVERGED", milestoneId=milestone.id)
                self._notify("INFO", "ChainSieve final product audit converged")
                return
            package = audit_remediation(milestone, value, self.root)
            write_remediation(self.config, milestone, [package])
            metadata["finalAuditConverged"] = False
            metadata["milestoneConverged"] = False
            self.store.event(
                "CONVERGENCE_GAP_FOUND",
                milestoneId=milestone.id,
                workPackageId=package["id"],
                workKey=work_key(milestone.id, package["id"]),
                reason="final audit",
                cycle=cycle,
            )
        except ConvergenceOutputRejectedError as error:
            self.store.event(
                "FINAL_AUDIT_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                cycle=cycle,
                reason=str(error),
                failureClass=error.failure_class,
            )
            raise RuntimeError(f"Final audit output rejected: {error}")
        except ReasoningContextUnavailableError as error:
            self.store.event(
                "REASONING_CONTEXT_UNAVAILABLE",
                milestoneId=milestone.id,
                cycle=cycle,
                reason=str(error),
            )
            raise RuntimeError(f"Final audit context unavailable: {error}")

    def _block_factory(self, milestone_id: str, metadata: dict[str, Any], reason: str) -> None:
        metadata["convergenceBlocked"] = True
        metadata["lastTickFailure"] = reason
        metadata["consecutiveTickFailures"] = 0
        if self.runner and hasattr(self.runner, "run"):
            try:
                local_res = self.runner.run(["git", "rev-parse", "HEAD"], check=False)
                if local_res and getattr(local_res, "returncode", 1) == 0 and (getattr(local_res, "stdout", "") or "").strip():
                    metadata["lastBlockedHeadSha"] = local_res.stdout.strip().lower()
            except Exception:
                pass
        self.store.event("FATAL_BLOCKER", milestoneId=milestone_id, reason=reason)
        self._notify("FATAL", reason)
        self.store.save(self.store.load(), metadata)


def _apply_session(record: PackageRecord, session: Session) -> None:
    record.session_id = session.id
    record.provider = session.harness or record.provider
    record.ao_status = session.status
    record.ao_activity = session.activity


def _progress_fingerprint(
    session: Session | None,
    pr: PullRequest | None,
    record: PackageRecord | None = None,
) -> str:
    import json

    return json.dumps(
        {
            "session": None if session is None else {
                "id": session.id,
                "status": session.status,
                "activity": session.activity,
                "lastActivityAt": session.last_activity_at,
            },
            "pr": None if pr is None else {
                "number": pr.number,
                "head": pr.head_sha,
                "updatedAt": pr.updated_at,
                "checks": pr.checks,
                "state": pr.state,
                "mergeable": pr.mergeable,
            },
            "record": None if record is None else {
                "ci_status": record.ci_status,
                "correction_attempts": (
                    record.ci_corrections_used + record.liveness_remediations_used + record.integration_corrections_used
                ),
                "ci_corrections_used": record.ci_corrections_used,
                "ci_correction_authorized_from_sha": record.ci_correction_authorized_from_sha,
                "liveness_remediations_used": record.liveness_remediations_used,
                "session_restore_attempts": record.session_restore_attempts,
                "integration_corrections_used": record.integration_corrections_used,
                "ci_infra_retries_used": record.ci_infra_retries_used,
                "review_attempts": record.review_attempts,
                "review_corrections_used": record.review_corrections_used,
                "review_sha": record.review_sha,
                "review_verdict": record.review_verdict,
            },
        },
        sort_keys=True,
        default=str,
    )


def _latest_iso(*values: Any) -> str | None:
    best_dt: datetime | None = None
    best_str: str | None = None
    for v in values:
        if not v:
            continue
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            if best_dt is None or dt > best_dt:
                best_dt = dt
                best_str = str(v)
        except (ValueError, TypeError):
            continue
    return best_str


def _note_progress(record: PackageRecord, fingerprint: str, observed_at: str | None = None) -> None:
    if record.progress_fingerprint == fingerprint:
        return
    record.progress_fingerprint = fingerprint
    candidate = observed_at or utc_now()
    if not record.last_progress_at:
        record.last_progress_at = candidate
    else:
        record.last_progress_at = _latest_iso(record.last_progress_at, candidate) or candidate


def _session_package_status(record: PackageRecord, session: Session, config: FactoryConfig) -> PackageStatus:
    status = session.status.lower()
    activity = session.activity.lower()
    if status in TERMINAL_SESSION_STATES or activity == "exited":
        return PackageStatus.FAILED
    if status in {"needs_input", "waiting_input", "blocked"} or activity in {"needs_input", "waiting_input", "blocked"}:
        return PackageStatus.WAITING_INPUT
    progress_at = _latest_iso(session.last_activity_at, record.last_progress_at, record.started_at)
    if status in {"starting", "spawning", "provisioning", "pending"}:
        return PackageStatus.STUCK if progress_at and _expired(progress_at, config.max_starting_seconds) else PackageStatus.STARTING
    if status == "no_signal":
        return PackageStatus.STUCK
    if progress_at and _expired(progress_at, config.max_idle_seconds):
        return PackageStatus.STUCK
    if status in {"idle"} or activity == "idle":
        return PackageStatus.IDLE
    return PackageStatus.ACTIVE


def _is_descendant(repo: Path | None, base_sha: str | None, head_sha: str | None) -> bool:
    if not repo or not base_sha or not head_sha or base_sha == head_sha:
        return True
    try:
        import subprocess
        result = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", base_sha, head_sha],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except Exception:
        return True


def _apply_pr(record: PackageRecord, pr: PullRequest, root: Path | None = None) -> None:
    record.pr_number = pr.number
    record.pr_url = pr.url
    record.pr_state = pr.state
    record.branch = pr.branch
    if record.head_sha and pr.head_sha and record.head_sha != pr.head_sha:
        if root and not _is_descendant(root, record.head_sha, pr.head_sha):
            record.status = PackageStatus.BLOCKED
            record.blocked_reason = (
                f"non-fast-forward PR head history rewrite detected ({record.head_sha[:8]} -> {pr.head_sha[:8]}); "
                "preserving work"
            )
            record.last_error = record.blocked_reason
            return
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


def _worktree_for_branch(root: Path, branch: str) -> Path | None:
    import subprocess

    result = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=root, text=True, capture_output=True, check=False)
    lines = result.stdout.splitlines()
    current_worktree: Path | None = None
    for line in lines:
        if line.startswith("worktree "):
            current_worktree = Path(line.removeprefix("worktree ").strip())
        elif line.startswith("branch ") and current_worktree:
            ref = line.removeprefix("branch ").strip()
            if ref in {f"refs/heads/{branch}", branch}:
                return current_worktree
        elif not line.strip():
            current_worktree = None
    return None


def _safe_alternate_retry(
    root: Path,
    integration_branch: str,
    branch: str,
    session: Session,
    pr: PullRequest | None,
    remote_branch_exists: bool,
) -> tuple[bool, str]:
    if pr is not None:
        return False, "an open PR contains durable or ambiguous work"
    if remote_branch_exists:
        return False, "a remote implementation branch exists without a correlated PR"
    workspace = Path(session.workspace_path) if session.workspace_path else None
    if not workspace or not workspace.exists():
        found = _worktree_for_branch(root, branch)
        if found and found.exists():
            workspace = found
    if workspace and workspace.exists():
        return _clean_without_commits(workspace, "HEAD", integration_branch)
    local_branch = _git_ref_exists(root, branch)
    if local_branch:
        return _clean_without_commits(root, branch, integration_branch)
    return True, "no PR, remote branch, local branch, or surviving workspace"


def _clean_without_commits(repo: Path, head: str, integration_branch: str) -> tuple[bool, str]:
    import subprocess

    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"],
        text=True,
        capture_output=True,
        check=False,
    )
    if status.returncode != 0:
        return False, "workspace state cannot be inspected deterministically"
    if status.stdout.strip():
        return False, "workspace has uncommitted changes"
    for base in (f"origin/{integration_branch}", integration_branch):
        if not _git_ref_exists(repo, base):
            continue
        count = subprocess.run(
            ["git", "-C", str(repo), "rev-list", "--count", f"{base}..{head}"],
            text=True,
            capture_output=True,
            check=False,
        )
        if count.returncode == 0:
            if count.stdout.strip() == "0":
                return True, f"clean workspace with no commits beyond {base}"
            return False, f"workspace has {count.stdout.strip()} durable commit(s) beyond {base}"
    return False, "integration base is unavailable for commit comparison"


def _git_ref_exists(repo: Path, ref: str) -> bool:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", ref],
        capture_output=True,
        check=False,
    ).returncode == 0


def _worktree_count(root: Path) -> int:
    import subprocess

    result = subprocess.run(["git", "worktree", "list", "--porcelain"], cwd=root, text=True, capture_output=True, check=False)
    return sum(1 for line in result.stdout.splitlines() if line.startswith("worktree "))


def _local_worktree_has_branch(root: Path, branch: str) -> bool:
    return _worktree_for_branch(root, branch) is not None


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


def _retry_delay(poll_seconds: int, consecutive_failures: int) -> int:
    return min(300, max(1, poll_seconds) * (2 ** min(max(0, consecutive_failures - 1), 4)))


def _is_github_auth_blocker(error: Exception) -> bool:
    detail = str(error).lower()
    return any(marker in detail for marker in (
        "bad credentials", "http 401", "status 401", "requires authentication", "gh auth login",
    ))


def _codex_usage(state_dir: Path) -> dict[str, Any]:
    empty = {
        "total": 0,
        "plannerCalls": 0,
        "replanCalls": 0,
        "finalAuditCalls": 0,
        "emergencyCalls": 0,
    }
    path = state_dir / "usage.json"
    if not path.exists():
        return empty
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        by_role = value.get("codexCallsByRole", {})
        return {
            "total": int(value.get("codexCalls", sum(int(item) for item in by_role.values()))),
            "plannerCalls": int(by_role.get("planner", 0)),
            "replanCalls": int(by_role.get("replan", 0)),
            "finalAuditCalls": int(by_role.get("final_audit", 0)),
            "emergencyCalls": int(by_role.get("emergency", 0)),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return empty


def _reasoning_provider_status(config: FactoryConfig, state_dir: Path) -> dict[str, Any]:
    operations: dict[str, Any] = {}
    path = state_dir / "usage.json"
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw.get("reasoningOperations"), dict):
                operations = raw["reasoningOperations"]
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    unavailable_until = int(operations.get("codexUnavailableUntilEpoch", 0) or 0)
    now = int(datetime.now(UTC).timestamp())
    return {
        "preferredProvider": "codex",
        "actualLastProvider": operations.get("actualLastReasoningProvider"),
        "codexAvailable": unavailable_until <= now if unavailable_until else bool(operations.get("codexAvailable", True)),
        "codexCooldownUntilEpoch": unavailable_until or None,
        "codexAttempts": int(operations.get("codexAttempts", 0)),
        "codexDefaultModelRetries": int(operations.get("codexDefaultModelRetries", 0)),
        "museFallbackAttempts": int(operations.get("museFallbackAttempts", 0)),
        "museFallbackSuccesses": int(operations.get("museFallbackSuccesses", 0)),
        "muse": {
            "modelMode": "explicit" if config.muse_explicit_model else "cli-default",
            "requestedPreference": config.muse_model,
            "effectiveModel": config.muse_explicit_model or "CLI configured default",
        },
        "agy": {
            "modelMode": "explicit" if config.agy_explicit_model else "cli-default",
            "requestedPreference": config.agy_model,
            "effectiveModel": config.agy_explicit_model or "CLI configured default",
        },
        "codexRoles": {
            role: {
                "modelMode": route.model_mode,
                "preferredModel": route.model,
                "effectiveModel": route.explicit_model or "CLI configured default",
                "reasoningEffort": route.reasoning_effort,
            }
            for role, route in config.codex_routes.items()
        },
    }


def _roadmap(root: Path) -> list[dict[str, Any]]:
    value = json.loads((root / "specs" / "factory" / "roadmap.json").read_text(encoding="utf-8"))
    milestones = value.get("milestones", [])
    ids = [str(item.get("id", "")) for item in milestones]
    if not milestones or len(ids) != len(set(ids)) or any(not item for item in ids):
        raise RuntimeError("invalid or duplicate committed roadmap milestone IDs")
    return milestones
