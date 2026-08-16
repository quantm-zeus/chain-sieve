from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .commands import CommandRunner
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
                workspace_path=value.get("workspacePath"),
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

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        self._request("PUT", f"sessions/{session_id}/reviewer", {"harness": reviewer})
        try:
            self.runner.run(["ao", "review", "trigger", session_id], allowed_env=AO_ENV, timeout=120)
        except Exception as error:
            if "terminated" in str(error).lower():
                self.restore(session_id)
                self.runner.run(["ao", "review", "trigger", session_id], allowed_env=AO_ENV, timeout=120)
            else:
                raise

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


def review_gate(
    raw: dict[str, Any],
    head_sha: str,
    required_reviewer: str | None = None,
    expected_context_digest: str | None = None,
) -> tuple[bool, str, str | None, str | None]:
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
        return False, f"no machine review for current PR head{qualifier}", None, None
    latest = sorted(current, key=lambda item: str(item.get("createdAt", "")))[-1]
    status = str(latest.get("status", "")).lower()
    verdict = str(latest.get("verdict", "")).lower()
    reviewer = str(latest.get("harness", "")) or None
    # Pinned AO v0.12.3 serializes ReviewRunComplete as "complete" and
    # ReviewRunDelivered as "delivered". Retain "completed" for compatible
    # external/future evidence, but never require delivery: approved reviews
    # ordinarily remain complete because only change requests are auto-injected.
    if status not in {"complete", "completed", "delivered"}:
        return False, f"machine review is {status or 'pending'}", reviewer, verdict or None
    if verdict not in {"approved", "pass"}:
        return False, f"machine review verdict is {verdict or 'missing'}", reviewer, verdict or None
    if expected_context_digest is not None:
        markers = proof_markers(str(latest.get("body", "")))
        if len(markers) != 1:
            return False, "machine review is missing one exact semantic context digest", reviewer, verdict
        if markers[0] != expected_context_digest:
            return False, "machine review semantic context digest is stale or belongs to another work package", reviewer, verdict
    return True, "machine review passes current head", reviewer, verdict
