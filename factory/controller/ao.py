from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .commands import CommandRunner
from .findings import (
    FindingSeverity,
    FindingStatus,
    ReviewFinding,
    ReviewMode,
    is_critical_late_blocker,
    is_non_blocking_follow_up,
    parse_and_reconcile_review,
)
from .models import Session
from .review_context import proof_markers


AO_ENV = ("AO_PORT", "AO_RUN_FILE", "AO_DATA_DIR", "AO_REQUEST_TIMEOUT", "AO_SHUTDOWN_TIMEOUT")


class AgentOrchestrator:
    def __init__(self, runner: CommandRunner, project_id: str) -> None:
        self.runner = runner
        self.project_id = project_id

    def status(self) -> dict[str, Any]:
        return self.runner.json(["ao", "status", "--json"], allowed_env=AO_ENV)

    def sessions(self) -> dict[str, list[Session]]:
        raw = self.runner.json(
            ["ao", "session", "ls", "--project", self.project_id, "--include-terminated", "--json"],
            allowed_env=AO_ENV,
        )
        result: dict[str, list[Session]] = {}
        for value in raw.get("data", raw.get("sessions", [])):
            issue_id = str(value.get("issueId") or "") or None
            if not issue_id:
                continue
            activity = value.get("activity") or {}
            status = "terminated" if value.get("isTerminated") else str(value.get("status", ""))
            session = Session(
                id=str(value["id"]),
                branch=str(value.get("branch", "")),
                harness=str(value.get("harness", "")),
                status=status,
                activity=str(activity.get("state") or value.get("activityState") or status),
                issue_id=issue_id,
                workspace_path=value.get("workspacePath") or value.get("workspace_path") or value.get("workspace"),
                last_activity_at=(
                    activity.get("lastActivityAt")
                    or value.get("lastActivityAt")
                    or value.get("updatedAt")
                ),
            )
            result.setdefault(issue_id, []).append(session)
        return result

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        argv = [
            "ao", "spawn", "--project", self.project_id, "--kind", "worker", "--mode", "tui",
            "--agent", provider, "--branch", f"factory/{package_id}", "--issue", str(issue_number),
            "--name", package_id[:20], "--prompt", prompt,
        ]
        output = self.runner.run(argv, allowed_env=AO_ENV, timeout=120).stdout
        parts = output.split()
        try:
            return parts[parts.index("session") + 1]
        except (ValueError, IndexError) as error:
            raise RuntimeError(f"unable to parse AO spawn result: {output.strip()}") from error

    def send(self, session_id: str, message: str) -> None:
        self.runner.run(
            ["ao", "send", "--session", session_id, "--message", message],
            allowed_env=AO_ENV,
            timeout=120,
        )

    def restore(self, session_id: str) -> None:
        self.runner.run(
            ["ao", "session", "restore", session_id, "--project", self.project_id],
            allowed_env=AO_ENV,
            timeout=120,
        )

    def kill(self, session_id: str) -> bool:
        result = self.runner.run(
            ["ao", "session", "kill", session_id, "--project", self.project_id],
            allowed_env=AO_ENV,
            timeout=120,
        )
        return "workspace preserved" not in result.stdout.lower()

    def cleanup(self) -> None:
        self.runner.run(
            ["ao", "session", "cleanup", "--project", self.project_id, "-y"],
            allowed_env=AO_ENV,
            timeout=120,
            check=False,
        )

    def trigger_review(self, session_id: str, reviewer: str, prompt: str | None = None) -> None:
        self._request("PUT", f"sessions/{session_id}/reviewer", {"harness": reviewer})
        try:
            self.runner.run(["ao", "review", "trigger", session_id], allowed_env=AO_ENV, timeout=120)
        except Exception as error:
            if "terminated" in str(error).lower():
                self.restore(session_id)
                self.runner.run(["ao", "review", "trigger", session_id], allowed_env=AO_ENV, timeout=120)
            else:
                raise
        if prompt:
            self._inject_review_prompt(session_id, prompt)

    def _inject_review_prompt(self, session_id: str, prompt: str) -> None:
        ao_data = Path(self.runner.source_env.get("AO_DATA_DIR", str(Path.home() / ".local" / "state" / "agent-orchestrator"))).resolve()
        session_prompts = ao_data / "prompts" / session_id / "reviewer"
        if not session_prompts.is_dir():
            return
        task_files = sorted(session_prompts.glob("**/task.md"), key=lambda p: p.stat().st_mtime)
        if task_files:
            latest_task = task_files[-1]
            content = latest_task.read_text(encoding="utf-8")
            if prompt.strip() not in content:
                latest_task.write_text(f"{content.rstrip()}\n\n---\n\n{prompt.strip()}\n", encoding="utf-8")


    def reviews(self, session_id: str) -> dict[str, Any]:
        return self.runner.json(["ao", "review", "ls", session_id, "--json"], allowed_env=AO_ENV)

    def _request(self, method: str, route: str, payload: dict[str, Any]) -> dict[str, Any]:
        run_file = Path(self.runner.source_env.get("AO_RUN_FILE", str(Path.home() / ".ao" / "running.json")))
        info = json.loads(run_file.read_text(encoding="utf-8"))
        request = urllib.request.Request(
            f"http://127.0.0.1:{int(info['port'])}/api/v1/{route}",
            method=method,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[-2000:]
            raise RuntimeError(f"AO API {method} {route} failed: {error.code}: {detail}") from error


from dataclasses import dataclass, field


@dataclass
class ReviewAuthorityResult:
    ok: bool
    status: str  # "VALID", "PENDING", "NO_REVIEW", "AUTHORITY_INVALID"
    reason: str
    reviewer: str | None = None
    run_id: str | None = None
    target_sha: str | None = None
    raw_verdict: str | None = None
    body: str = ""
    observed_markers: tuple[str, ...] = ()
    expected_digest: str | None = None
    matching_run: dict[str, Any] | None = None


@dataclass
class ReviewSemanticResult:
    ok: bool
    effective_verdict: str  # "approved", "changes_requested", "missing"
    reason: str
    reviewer: str | None = None
    updated_ledger: list[ReviewFinding] = field(default_factory=list)
    open_blockers: list[ReviewFinding] = field(default_factory=list)
    blocking_findings: list[dict[str, Any]] = field(default_factory=list)


def _parse_review_payload(body: str) -> dict[str, Any] | None:
    text = (body or "").strip()
    if not text:
        return None
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def validate_review_authority(
    raw: dict[str, Any],
    head_sha: str,
    required_reviewer: str | None = None,
    expected_context_digest: str | None = None,
) -> ReviewAuthorityResult:
    reviews = raw.get("reviews") or raw.get("data") or []
    runs: list[dict[str, Any]] = []
    for review in reviews:
        latest = review.get("latestRun") if isinstance(review, dict) else None
        runs.append(latest or review)
    current = [
        item for item in runs
        if item
        and item.get("targetSha") == head_sha
        and (required_reviewer is None or str(item.get("harness", "")) == required_reviewer)
    ]
    if not current:
        qualifier = f" by required {required_reviewer} reviewer" if required_reviewer else ""
        return ReviewAuthorityResult(
            ok=False,
            status="NO_REVIEW",
            reason=f"no machine review for current PR head{qualifier}",
            expected_digest=expected_context_digest,
        )

    latest = sorted(current, key=lambda item: str(item.get("createdAt", "")))[-1]
    status = str(latest.get("status", "")).lower()
    raw_verdict = str(latest.get("verdict", "")).lower()
    reviewer = str(latest.get("harness", "")) or None
    run_id = str(latest.get("id") or latest.get("reviewId") or "")
    body_str = str(latest.get("body", ""))

    if status not in {"complete", "completed", "delivered"}:
        return ReviewAuthorityResult(
            ok=False,
            status="PENDING",
            reason=f"machine review is {status or 'pending'}",
            reviewer=reviewer,
            run_id=run_id,
            target_sha=head_sha,
            raw_verdict=raw_verdict or None,
            body=body_str,
            expected_digest=expected_context_digest,
            matching_run=latest,
        )

    if raw_verdict in {"commented", "missing"}:
        return ReviewAuthorityResult(
            ok=False,
            status="COMMENTED",
            reason=f"machine review verdict is {raw_verdict or 'missing'}",
            reviewer=reviewer,
            run_id=run_id,
            target_sha=head_sha,
            raw_verdict=raw_verdict or None,
            body=body_str,
            expected_digest=expected_context_digest,
            matching_run=latest,
        )


    markers = proof_markers(body_str)
    if expected_context_digest is not None:
        if len(markers) != 1:
            return ReviewAuthorityResult(
                ok=False,
                status="AUTHORITY_INVALID",
                reason="machine review is missing one exact semantic context digest" if len(markers) == 0 else "machine review contains multiple semantic context digests",
                reviewer=reviewer,
                run_id=run_id,
                target_sha=head_sha,
                raw_verdict=raw_verdict or None,
                body=body_str,
                observed_markers=markers,
                expected_digest=expected_context_digest,
                matching_run=latest,
            )
        if markers[0] != expected_context_digest:
            return ReviewAuthorityResult(
                ok=False,
                status="AUTHORITY_INVALID",
                reason="machine review semantic context digest is stale or belongs to another work package",
                reviewer=reviewer,
                run_id=run_id,
                target_sha=head_sha,
                raw_verdict=raw_verdict or None,
                body=body_str,
                observed_markers=markers,
                expected_digest=expected_context_digest,
                matching_run=latest,
            )

    return ReviewAuthorityResult(
        ok=True,
        status="VALID",
        reason="machine review semantic authority verified",
        reviewer=reviewer,
        run_id=run_id,
        target_sha=head_sha,
        raw_verdict=raw_verdict or None,
        body=body_str,
        observed_markers=markers,
        expected_digest=expected_context_digest,
        matching_run=latest,
    )


def evaluate_review_semantics(
    body_str: str,
    raw_verdict: str | None,
    head_sha: str,
    run_id: str,
    review_mode: str = ReviewMode.FULL_BASELINE.value,
    frozen_findings: list[dict[str, Any]] | None = None,
    reviewer: str | None = None,
) -> ReviewSemanticResult:
    payload = _parse_review_payload(body_str)
    raw_v = (raw_verdict or "").lower()

    frozen_objs = [ReviewFinding.from_dict(f) for f in (frozen_findings or [])]
    updated_ledger, blocking_reasons = parse_and_reconcile_review(
        body_str,
        payload,
        head_sha,
        run_id,
        review_mode,
        frozen_objs,
        raw_verdict=raw_v,
    )


    open_blockers = [
        f for f in updated_ledger
        if f.blocking and f.status in {FindingStatus.OPEN.value, FindingStatus.REGRESSION.value}
    ]

    blocking_findings = []
    if payload:
        if "blockingFindings" in payload and isinstance(payload["blockingFindings"], list):
            blocking_findings = [f for f in payload["blockingFindings"] if isinstance(f, dict)]
        elif "findings" in payload and isinstance(payload["findings"], list):
            for finding in payload["findings"]:
                if isinstance(finding, dict):
                    severity = str(finding.get("severity", "")).upper()
                    issue_text = str(finding.get("issue", "")).lower()
                    if severity in {"HIGH", "CRITICAL", "MEDIUM"} or not any(
                        token in issue_text for token in ("nit", "optional", "consider", "style", "could improve", "cleanup")
                    ):
                        blocking_findings.append(finding)

    if review_mode in {ReviewMode.CLOSURE_VERIFY.value, ReviewMode.FINAL_CONFIRMATION.value} and frozen_findings is not None:
        if raw_v in {"commented", "missing"}:
            effective_verdict = raw_v or "missing"
        elif len(open_blockers) == 0 and (raw_v in {"approved", "pass"} or (payload and payload.get("verdict") in {"approved", "pass"})):
            effective_verdict = "approved"
        else:
            effective_verdict = "changes_requested"

    else:
        # Standard FULL_BASELINE mode
        if payload and "blockingFindings" in payload:
            if len(blocking_findings) == 0:
                effective_verdict = "approved"
            else:
                effective_verdict = "changes_requested"
        elif raw_v in {"approved", "pass"}:
            if len(blocking_findings) == 0 and len(open_blockers) == 0:
                effective_verdict = "approved"
            else:
                effective_verdict = "changes_requested"
        elif raw_v in {"changes_requested", "findings"}:
            if payload and "blockingFindings" in payload and len(blocking_findings) == 0:
                effective_verdict = "approved"
            else:
                effective_verdict = "changes_requested"
        else:
            effective_verdict = raw_v or "missing"

    if effective_verdict not in {"approved", "pass"}:
        if open_blockers:
            findings_summary = "; ".join(
                f"{f.file_or_component}: {f.normalized_summary}"
                for f in open_blockers[:3]
            )
            return ReviewSemanticResult(
                ok=False,
                effective_verdict="changes_requested",
                reason=f"machine review reported blocking findings: {findings_summary}",
                reviewer=reviewer,
                updated_ledger=updated_ledger,
                open_blockers=open_blockers,
                blocking_findings=blocking_findings,
            )
        return ReviewSemanticResult(
            ok=False,
            effective_verdict=effective_verdict or "missing",
            reason=f"machine review verdict is {effective_verdict or 'missing'}",
            reviewer=reviewer,
            updated_ledger=updated_ledger,
            open_blockers=open_blockers,
            blocking_findings=blocking_findings,
        )

    return ReviewSemanticResult(
        ok=True,
        effective_verdict="approved",
        reason="machine review passes current head",
        reviewer=reviewer,
        updated_ledger=updated_ledger,
        open_blockers=open_blockers,
        blocking_findings=blocking_findings,
    )


def review_gate(
    raw: dict[str, Any],
    head_sha: str,
    required_reviewer: str | None = None,
    expected_context_digest: str | None = None,
    review_mode: str = ReviewMode.FULL_BASELINE.value,
    frozen_findings: list[dict[str, Any]] | None = None,
) -> tuple[bool, str, str | None, str | None]:
    auth = validate_review_authority(
        raw,
        head_sha,
        required_reviewer=required_reviewer,
        expected_context_digest=expected_context_digest,
    )
    if not auth.ok:
        return False, auth.reason, auth.reviewer, auth.raw_verdict

    sem = evaluate_review_semantics(
        auth.body,
        auth.raw_verdict,
        head_sha,
        auth.run_id or "",
        review_mode=review_mode,
        frozen_findings=frozen_findings,
        reviewer=auth.reviewer,
    )
    return sem.ok, sem.reason, auth.reviewer, sem.effective_verdict

