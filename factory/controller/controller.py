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
from .github import GitHub, ci_state
from .models import FactoryStatus, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, work_key
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
        reasoner: Any | None = None,
    ) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.github = github
        self.ao = ao
        self.reasoner = reasoner

    def sync_issues(self, milestone: Milestone) -> dict[str, Any]:
        issues = self.github.issues()
        created: list[int] = []
        for package in milestone.packages:
            key = work_key(milestone.id, package.id)
            if key in issues:
                continue
            issue = self.github.create_issue(
                key,
                f"[{milestone.id}/{package.id}] {package.objective[:120]}",
                issue_body(milestone, package),
            )
            issues[key] = issue
            created.append(issue.number)
            self.store.event("WORK_PACKAGE_PLANNED", milestoneId=milestone.id, workPackageId=package.id, workKey=key, issue=issue.number)
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

            if len(open_prs) > 1 or len(sessions) > 1:
                record.status = PackageStatus.BLOCKED
                record.blocked_reason = "ambiguous duplicate PR/session state; preserving existing work"
            elif merged:
                selected = sorted(merged, key=lambda item: item.number)[-1]
                _apply_pr(record, selected)
                record.status = PackageStatus.COMPLETED
                record.blocked_reason = None
                completed.add(key)
            elif open_prs:
                selected = open_prs[0]
                _apply_pr(record, selected)
                record.started_at = record.started_at or selected.updated_at or utc_now()
                if sessions:
                    _apply_session(record, sessions[0])
                    _note_progress(record, _progress_fingerprint(sessions[0], selected), sessions[0].last_activity_at or selected.updated_at)
                else:
                    _note_progress(record, _progress_fingerprint(None, selected), selected.updated_at)
                record.status = PackageStatus.PR_WAITING
            elif sessions:
                _apply_session(record, sessions[0])
                record.branch = f"factory/{key}"
                _note_progress(record, _progress_fingerprint(sessions[0], None), sessions[0].last_activity_at)
                record.status = _session_package_status(record, sessions[0], self.config)
            elif record.task_attempts > 0 and record.session_id and any(item.id == record.session_id for item in terminal):
                # Preserve and recover the exact AO session. Never create a
                # second worktree when a terminated one may contain work.
                selected = next(item for item in terminal if item.id == record.session_id)
                _apply_session(record, selected)
                _note_progress(record, _progress_fingerprint(selected, None), selected.last_activity_at)
                record.status = PackageStatus.FAILED
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
        if _expired(metadata["milestoneStartedAt"], self.config.max_milestone_wall_clock_seconds):
            for key, record in records.items():
                if record.status != PackageStatus.COMPLETED:
                    package_id = key.removeprefix(f"{milestone.id}--")
                    self._block(milestone.id, package_id, record, "milestone wall-clock budget exhausted", key)
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
            if record.started_at and record.status not in {PackageStatus.COMPLETED, PackageStatus.BLOCKED} and _expired(
                record.started_at, self.config.max_task_wall_clock_seconds
            ):
                if session and session.status.lower() not in TERMINAL_SESSION_STATES:
                    self.ao.kill(session.id)
                self._block(milestone.id, package.id, record, "task wall-clock budget exhausted; existing work preserved", key)
                continue
            if record.status in {
                PackageStatus.STARTING,
                PackageStatus.ACTIVE,
                PackageStatus.IDLE,
                PackageStatus.WAITING_INPUT,
                PackageStatus.STUCK,
                PackageStatus.FAILED,
            } and session:
                if session.status.lower() in TERMINAL_SESSION_STATES:
                    self._handle_terminated(milestone, package, key, record, session, pr)
                else:
                    self._handle_activity(milestone, package, key, record, session, pr)
            elif record.status == PackageStatus.PR_WAITING and pr:
                if session and session.status.lower() in TERMINAL_SESSION_STATES:
                    self._handle_terminated(milestone, package, key, record, session, pr)
                elif any(records[work_key(milestone.id, dependency)].status != PackageStatus.COMPLETED for dependency in package.dependencies):
                    record.last_error = "dependency integration condition no longer holds"
                else:
                    self._handle_pr(milestone, package, record, pr)

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
            provider = _provider_for_attempt(package.preferred_provider, record.task_attempts)
            session_id = self.ao.spawn(
                key,
                record.issue_number,
                provider,
                worker_prompt(self.root, milestone, package, self.config.integration_branch),
                self.config.agy_model if provider == "agy" else None,
            )
            record.session_id = session_id
            record.provider = provider
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
                workKey=key, provider=provider, aoSessionId=session_id, attempt=record.task_attempts,
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
        heartbeat = self.store.heartbeat_state()
        heartbeat_age = _elapsed_seconds(heartbeat.get("controllerHeartbeatAt"))
        stale_after = self.config.max_tick_duration_seconds + (2 * self.config.poll_seconds)
        if not heartbeat or heartbeat.get("active") is not True:
            liveness = "STOPPED_UNKNOWN"
        elif heartbeat_age is None or heartbeat_age > stale_after:
            liveness = "STALE"
        else:
            liveness = "ACTIVE"
        if counts[PackageStatus.BLOCKED.value] or counts[PackageStatus.FAILED.value] or counts[PackageStatus.STUCK.value]:
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
            "usage": {
                "workerStarts": sum(record.task_attempts for record in records.values()),
                "corrections": sum(record.correction_attempts for record in records.values()),
                "reviews": sum(record.review_attempts for record in records.values()),
                "codex": codex_usage,
                "codexPlannerCalls": codex_usage["plannerCalls"],
                "codexReplanCalls": codex_usage["replanCalls"],
                "codexFinalAuditCalls": codex_usage["finalAuditCalls"],
                "codexEmergencyCalls": codex_usage["emergencyCalls"],
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
        activity = session.activity.lower()
        waiting = record.status == PackageStatus.WAITING_INPUT or activity in {"waiting_input", "blocked", "needs_input"}
        stuck = record.status == PackageStatus.STUCK
        if not waiting and not stuck:
            return
        if record.correction_attempts < self.config.max_correction_attempts:
            reason = "stopped making meaningful progress" if stuck else "is waiting for input"
            self.ao.send(
                session.id,
                f"You {reason}. Continue in FULL AUTONOMOUS MODE. Do not wait for owner input. Resolve ordinary ambiguity from committed authority and evidence. If a tool permission prompt caused this state, exit it and continue with the preconfigured non-interactive permission mode.",
            )
            record.correction_attempts += 1
            self.store.event(
                "CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                workKey=key, provider=record.provider, aoSessionId=session.id, attempt=record.correction_attempts,
            )
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
        if record.correction_attempts < self.config.max_correction_attempts:
            self.ao.restore(session.id)
            record.correction_attempts += 1
            record.started_at = utc_now()
            self.store.event(
                "WORKER_RESTORED", milestoneId=milestone.id, workPackageId=package.id,
                workKey=key, provider=record.provider, aoSessionId=session.id, attempt=record.correction_attempts,
            )
            return
        self._retry_or_replan(
            milestone,
            package,
            key,
            record,
            session,
            pr,
            "AO session terminated after bounded restore",
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
        remote_branch = self.github.branch_exists(f"factory/{key}")
        safe, evidence = _safe_alternate_retry(
            self.root, self.config.integration_branch, f"factory/{key}", session, pr, remote_branch
        )
        if safe:
            freed = self.ao.kill(session.id)
            if not freed and session.workspace_path and Path(session.workspace_path).exists():
                self._escalate_replan(milestone, package, key, record, f"{failure}; AO refused to clean a supposedly clean worktree")
                return
            if record.task_attempts < self.config.max_task_attempts:
                previous_provider = record.provider
                record.status = PackageStatus.READY
                record.session_id = None
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
        self._escalate_replan(
            milestone,
            package,
            key,
            record,
            f"{failure}; alternate-provider retry is unsafe; preserved work: {evidence}",
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
                    self._block(milestone.id, package.id, record, f"CI correction budget exhausted: {ci_reason}", work_key(milestone.id, package.id))
                    return
                self.ao.send(
                    record.session_id,
                    f"Required CI is not green for PR #{pr.number} at {pr.head_sha}: {ci_reason}. Inspect the check logs, implement the smallest authoritative fix, verify it, and push a new commit without asking for input.",
                )
                record.correction_attempts += 1
                record.last_error = token
                self.store.event(
                    "CI_CORRECTION_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                    workKey=work_key(milestone.id, package.id), provider=record.provider, aoSessionId=record.session_id, pr=pr.number,
                    attempt=record.correction_attempts, headSha=pr.head_sha,
                )
            return

        if review_required(package):
            if not record.session_id:
                self._block(milestone.id, package.id, record, "review-required PR has no correlated AO session", work_key(milestone.id, package.id))
                return
            context_path = self.store.write_review_context(milestone.id, package, pr.head_sha)
            context = json.loads(context_path.read_text(encoding="utf-8"))
            expected_context_digest = str(context["contextDigest"])
            reviews = self.ao.reviews(record.session_id or "")
            required_reviewer = reviewer_for(record.provider or package.preferred_provider)
            review_ok, review_reason, reviewer, verdict = review_gate(
                reviews, pr.head_sha, required_reviewer, expected_context_digest,
            )
            record.review_sha = pr.head_sha if reviewer else None
            record.review_verdict = verdict
            if not review_ok:
                if reviewer is None and record.review_attempts < self.config.max_review_cycles:
                    selected = required_reviewer
                    self.ao.trigger_review(record.session_id or "", selected)
                    record.review_attempts += 1
                    record.status = PackageStatus.REVIEW
                    self.store.event(
                        "REVIEW_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                        workKey=work_key(milestone.id, package.id), provider=selected, aoSessionId=record.session_id, pr=pr.number,
                        attempt=record.review_attempts, headSha=pr.head_sha, reviewContext=str(context_path),
                        contextDigest=expected_context_digest,
                    )
                elif reviewer is not None and verdict in {"approved", "pass"}:
                    self._block(
                        milestone.id,
                        package.id,
                        record,
                        f"approved machine review failed semantic authority proof: {review_reason}",
                        work_key(milestone.id, package.id),
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
                            workKey=work_key(milestone.id, package.id), provider=record.provider, reviewer=reviewer, aoSessionId=record.session_id,
                            pr=pr.number, attempt=record.review_attempts, headSha=pr.head_sha,
                        )
                elif record.review_attempts >= self.config.max_review_cycles and verdict not in {"approved", "pass"}:
                    self._block(milestone.id, package.id, record, f"machine review budget exhausted: {review_reason}", work_key(milestone.id, package.id))
                else:
                    record.status = PackageStatus.REVIEW
                return

        violations = protected_path_violations(pr.files, self.config.protected_paths, package)
        if violations:
            self._block(milestone.id, package.id, record, f"unauthorized protected-path changes: {', '.join(violations)}", work_key(milestone.id, package.id))
            return
        if pr.mergeable.upper() == "CONFLICTING" or pr.merge_state.upper() in {"DIRTY", "BEHIND"}:
            integration_state = "CONFLICTING" if pr.mergeable.upper() == "CONFLICTING" else pr.merge_state.upper()
            token = f"MERGE:{pr.head_sha}:{integration_state}"
            if record.session_id and record.last_error != token:
                if record.correction_attempts >= self.config.max_correction_attempts:
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
                    f"{self.config.integration_branch}. Rebase or merge that exact target into your branch, resolve any "
                    "ordinary conflict from committed authority, rerun focused checks, and push the updated head. Do not invoke Codex.",
                )
                record.correction_attempts += 1
                record.last_error = token
                self.store.event(
                    "MERGE_UPDATE_STARTED", milestoneId=milestone.id, workPackageId=package.id,
                    workKey=work_key(milestone.id, package.id), provider=record.provider, aoSessionId=record.session_id, pr=pr.number,
                    attempt=record.correction_attempts, headSha=pr.head_sha,
                )
            record.status = PackageStatus.PR_WAITING
            return
        if not pr.head_sha or pr.mergeable.upper() != "MERGEABLE" or pr.merge_state.upper() in {"UNKNOWN", "DIRTY", "BEHIND"}:
            record.status = PackageStatus.PR_WAITING
            record.last_error = f"PR not mergeable: {pr.mergeable}/{pr.merge_state}"
            return

        self.github.merge(pr)
        record.status = PackageStatus.COMPLETED
        record.updated_at = utc_now()
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
        if metadata.get("convergenceBlocked") is True or metadata.get("finalAuditConverged") is True:
            return
        if metadata.get("milestoneConverged") is True:
            self._advance_or_audit(milestone, records, metadata)
            return
        passes = int(metadata.get("convergencePasses", 0))
        if passes >= self.config.max_convergence_passes:
            self._replan_convergence(milestone, metadata)
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
        from .reasoning import ReasoningRunner, audit_remediation, write_remediation

        reasoning = self.reasoner or ReasoningRunner(self.root, self.config, self.store, self.github.runner)
        if index + 1 < len(roadmap):
            target = roadmap[index + 1]
            self.store.archive(milestone.id, records, metadata)
            value = reasoning.plan_milestone(milestone, target)
            metadata["nextMilestoneId"] = value["id"]
            self.store.event("MILESTONE_PLANNED", milestoneId=value["id"], reason=f"after {milestone.id}")
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
        value = reasoning.final_audit(output)
        metadata["finalAuditCycles"] = cycle
        if value.get("status") == "CONVERGED":
            metadata["finalAuditConverged"] = True
            self.store.event("FACTORY_CONVERGED", milestoneId=milestone.id)
            self._notify("INFO", "ChainSieve final product audit converged")
            return
        package = audit_remediation(milestone, value)
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

    def _block_factory(self, milestone_id: str, metadata: dict[str, Any], reason: str) -> None:
        metadata["convergenceBlocked"] = True
        metadata["lastTickFailure"] = reason
        self.store.event("FATAL_BLOCKER", milestoneId=milestone_id, reason=reason)
        self._notify("FATAL", reason)


def _apply_session(record: PackageRecord, session: Session) -> None:
    record.session_id = session.id
    record.provider = session.harness or record.provider
    record.ao_status = session.status
    record.ao_activity = session.activity


def _progress_fingerprint(session: Session | None, pr: PullRequest | None) -> str:
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
            },
        },
        sort_keys=True,
        default=str,
    )


def _note_progress(record: PackageRecord, fingerprint: str, observed_at: str | None = None) -> None:
    if record.progress_fingerprint == fingerprint:
        return
    record.progress_fingerprint = fingerprint
    record.last_progress_at = observed_at or utc_now()


def _session_package_status(record: PackageRecord, session: Session, config: FactoryConfig) -> PackageStatus:
    status = session.status.lower()
    activity = session.activity.lower()
    if status in TERMINAL_SESSION_STATES or activity == "exited":
        return PackageStatus.FAILED
    if status in {"needs_input", "waiting_input", "blocked"} or activity in {"needs_input", "waiting_input", "blocked"}:
        return PackageStatus.WAITING_INPUT
    progress_at = session.last_activity_at or record.last_progress_at or record.started_at
    if status in {"starting", "spawning", "provisioning", "pending"}:
        return PackageStatus.STUCK if progress_at and _expired(progress_at, config.max_starting_seconds) else PackageStatus.STARTING
    if status == "no_signal":
        return PackageStatus.STUCK
    if progress_at and _expired(progress_at, config.max_idle_seconds):
        return PackageStatus.STUCK
    if status in {"idle"} or activity == "idle":
        return PackageStatus.IDLE
    return PackageStatus.ACTIVE


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


def _retry_delay(poll_seconds: int, consecutive_failures: int) -> int:
    return min(300, max(1, poll_seconds) * (2 ** min(max(0, consecutive_failures - 1), 4)))


def _is_github_auth_blocker(error: Exception) -> bool:
    detail = str(error).lower()
    return any(marker in detail for marker in (
        "bad credentials", "http 401", "status 401", "requires authentication", "gh auth login",
    ))


def _codex_usage(state_dir: Path) -> dict[str, Any]:
    import json

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


def _roadmap(root: Path) -> list[dict[str, Any]]:
    import json

    value = json.loads((root / "specs" / "factory" / "roadmap.json").read_text(encoding="utf-8"))
    milestones = value.get("milestones", [])
    ids = [str(item.get("id", "")) for item in milestones]
    if not milestones or len(ids) != len(set(ids)) or any(not item for item in ids):
        raise RuntimeError("invalid or duplicate committed roadmap milestone IDs")
    return milestones
