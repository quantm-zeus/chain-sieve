from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .commands import CommandError, CommandRunner
from .models import Issue, PullRequest


WORK_PACKAGE_MARKER = re.compile(r"<!-- chainsieve-work-package:([a-z0-9-]+--[a-z0-9-]+) -->")
GH_ENV = ("GH_HOST", "GH_CONFIG_DIR")


class GitHub:
    def __init__(
        self,
        runner: CommandRunner,
        repo: str,
        integration_branch: str,
    ) -> None:
        self.runner = runner
        self.repo = repo
        self.integration_branch = integration_branch
        self._actor: str | None = None

    def _run(self, argv: list[str], **kwargs: Any):
        return self.runner.run(argv, allowed_env=GH_ENV, **kwargs)

    def _json(self, argv: list[str], **kwargs: Any) -> Any:
        result = self._run(argv, **kwargs)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"command returned invalid JSON: {' '.join(argv[:3])}") from error

    def current_actor(self) -> str:
        if self._actor is None:
            value = self._json(["gh", "api", "user"])
            actor = str(value.get("login", "")).strip()
            if not actor:
                raise RuntimeError("authenticated GitHub user has no login")
            self._actor = actor
        return self._actor

    def issues(self) -> dict[str, Issue]:
        expected_actor = self.current_actor()
        raw = self._json(
            [
                "gh", "issue", "list", "--repo", self.repo, "--state", "all", "--limit", "500",
                "--json", "number,state,title,body,url,author",
            ],
        )
        result: dict[str, Issue] = {}
        for value in raw:
            body = value.get("body") or ""
            author = (value.get("author") or {}).get("login", "")
            marker = WORK_PACKAGE_MARKER.search(body)
            if not marker or author != expected_actor:
                continue
            package_id = marker.group(1)
            issue = Issue(
                int(value["number"]),
                str(value["state"]),
                body,
                str(value["url"]),
                author,
                title=str(value.get("title") or ""),
            )
            previous = result.get(package_id)
            if previous and previous.number != issue.number:
                raise RuntimeError(f"duplicate trusted issues for work package {package_id}")
            result[package_id] = issue
        return result

    def create_issue(self, package_id: str, title: str, body: str) -> Issue:
        payload = f"<!-- chainsieve-work-package:{package_id} -->\n\n{body.rstrip()}\n"
        url = self._run(
            ["gh", "issue", "create", "--repo", self.repo, "--title", title, "--body-file", "-"],
            input_text=payload,
        ).stdout.strip()
        number = int(url.rstrip("/").rsplit("/", 1)[1])
        value = self._json(
            ["gh", "issue", "view", str(number), "--repo", self.repo, "--json", "number,state,title,body,url,author"]
        )
        actor = str((value.get("author") or {}).get("login", ""))
        if actor != self.current_actor():
            raise RuntimeError(f"created issue #{number} has unexpected author {actor!r}")
        marker = WORK_PACKAGE_MARKER.search(str(value.get("body") or ""))
        if marker is None or marker.group(1) != package_id:
            raise RuntimeError(f"created issue #{number} does not retain exact work marker {package_id!r}")
        return Issue(
            number,
            str(value["state"]),
            str(value.get("body") or ""),
            str(value["url"]),
            actor,
            title=str(value.get("title") or ""),
        )

    def update_issue(self, number: int, title: str, body: str) -> None:
        payload = body.rstrip() + "\n"
        self._run(
            ["gh", "issue", "edit", str(number), "--repo", self.repo, "--title", title, "--body-file", "-"],
            input_text=payload,
        )

    def close_issue(self, number: int, reason: str) -> None:
        self._run(
            ["gh", "issue", "close", str(number), "--repo", self.repo, "--comment", reason],
        )

    def prs(self) -> dict[str, list[PullRequest]]:
        expected_actor = self.current_actor()
        raw = self._json(
            [
                "gh", "pr", "list", "--repo", self.repo, "--state", "all", "--limit", "500",
                "--json", "number,state,headRefName,headRefOid,baseRefName,url,author,mergeable,mergeStateStatus,statusCheckRollup,files,mergedAt,updatedAt",
            ],
        )
        result: dict[str, list[PullRequest]] = {}
        for value in raw:
            branch = str(value.get("headRefName", ""))
            if not branch.startswith("factory/"):
                continue
            author = str((value.get("author") or {}).get("login", ""))
            if author != expected_actor:
                continue
            if str(value.get("baseRefName", "")) != self.integration_branch:
                continue
            package_id = branch.removeprefix("factory/")
            result.setdefault(package_id, []).append(
                PullRequest(
                    number=int(value["number"]),
                    state=str(value["state"]),
                    branch=branch,
                    head_sha=str(value.get("headRefOid", "")),
                    url=str(value["url"]),
                    mergeable=str(value.get("mergeable", "UNKNOWN")),
                    merge_state=str(value.get("mergeStateStatus", "UNKNOWN")),
                    checks=tuple(value.get("statusCheckRollup") or []),
                    files=tuple(item["path"] for item in value.get("files") or []),
                    merged_at=value.get("mergedAt"),
                    base_branch=str(value.get("baseRefName", "")),
                    author=author,
                    updated_at=value.get("updatedAt"),
                )
            )
        return result

    def branch_exists(self, branch: str) -> bool:
        result = self._run(
            ["gh", "api", f"repos/{self.repo}/git/ref/heads/{branch}"],
            check=False,
        )
        if result.returncode == 0:
            return True
        detail = f"{result.stdout}\n{result.stderr}".lower()
        if "http 404" in detail or "status 404" in detail or "not found" in detail:
            return False
        raise CommandError(result)

    def merge(self, pr: PullRequest) -> None:
        if pr.base_branch != self.integration_branch:
            raise RuntimeError(
                f"refusing to merge PR #{pr.number}: base {pr.base_branch!r} is not configured target {self.integration_branch!r}"
            )
        if pr.author != self.current_actor():
            raise RuntimeError(f"refusing to merge PR #{pr.number}: author {pr.author!r} is not the authenticated factory user")
        self._run(
            [
                "gh", "pr", "merge", str(pr.number), "--repo", self.repo, "--squash",
                "--match-head-commit", pr.head_sha,
            ],
            timeout=180,
        )

    def auth_scopes(self) -> tuple[str, ...]:
        result = self._run(["gh", "auth", "status"], check=False)
        text = result.stdout + result.stderr
        match = re.search(r"Token scopes: '([^']*)'", text)
        return tuple(item.strip() for item in match.group(1).split(",")) if match else ()

    def credential_evidence(self) -> tuple[bool, str]:
        auth = self._run(["gh", "auth", "status"], check=False)
        if auth.returncode != 0:
            return False, "gh auth status failed for the deployment user"
        repository = self._json(["gh", "api", f"repos/{self.repo}"])
        if str(repository.get("full_name", "")).lower() != self.repo.lower():
            return False, f"authenticated user cannot access {self.repo}"
        actor = self.current_actor()
        return True, f"gh CLI user {actor} can access {self.repo}"

    def rerun_failed_jobs(self, run_id: int | str) -> None:
        self._run(["gh", "run", "rerun", str(run_id), "--failed", "--repo", self.repo], timeout=180)

    def get_run_jobs(self, run_id: int | str) -> list[dict[str, Any]]:
        raw = self._json(["gh", "api", f"repos/{self.repo}/actions/runs/{run_id}/jobs"])
        return list(raw.get("jobs", []))


class CIFailureKind(re.Enum if hasattr(re, "Enum") else str):
    PRODUCT = "PRODUCT"
    INFRASTRUCTURE = "INFRASTRUCTURE"
    UNKNOWN = "UNKNOWN"


def ci_gate(pr: PullRequest, required_checks: tuple[str, ...]) -> tuple[bool, str]:
    state, reason = ci_state(pr, required_checks)
    return state == "PASS", reason


def causal_ci_check(pr: PullRequest, required_checks: tuple[str, ...] = ()) -> dict[str, Any] | None:
    active_failures = [
        c for c in pr.checks
        if str(c.get("conclusion") or c.get("state") or c.get("status") or "").upper() in {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"}
    ]
    if active_failures:
        return active_failures[0]
    if required_checks:
        for c in pr.checks:
            name = str(c.get("name") or c.get("context") or "")
            if name in required_checks:
                status = str(c.get("conclusion") or c.get("state") or c.get("status") or "").upper()
                if status not in {"SUCCESS", "PASS", "", "EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"}:
                    return c
    return None


def ci_state(pr: PullRequest, required_checks: tuple[str, ...]) -> tuple[str, str]:
    by_name: dict[str, str] = {}
    for check in pr.checks:
        name = str(check.get("name") or check.get("context") or "")
        status = str(check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        if name:
            by_name[name] = status

    active_failures = [
        c for c in pr.checks
        if str(c.get("conclusion") or c.get("state") or c.get("status") or "").upper() in {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"}
    ]
    if active_failures:
        failing_names = [str(c.get("name") or c.get("context") or "") for c in active_failures]
        return "FAIL", f"checks not passing: {', '.join(failing_names)}"

    missing = [name for name in required_checks if name not in by_name]
    if missing:
        return "WAIT", f"missing required checks: {', '.join(missing)}"
    pending_values = {"", "EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"}
    pending = [name for name in required_checks if by_name[name] in pending_values]
    if pending:
        return "WAIT", f"checks still pending: {', '.join(pending)}"
    failed = [name for name in required_checks if by_name[name] not in {"SUCCESS", "PASS"}]
    if failed:
        return "FAIL", f"checks not passing: {', '.join(failed)}"
    return "PASS", "required CI checks pass"


INFRASTRUCTURE_STEP_PATTERNS = (
    "start minio",
    "start postgres",
    "set up job",
    "set up",
    "setup",
    "actions/checkout",
    "actions/setup-",
    "actions/setup_",
    "pnpm/action-setup",
    "run pnpm install",
    "pnpm install",
    "docker run",
    "docker exec",
    "install playwright",
)

PRODUCT_STEP_PATTERNS = (
    "test",
    "verify",
    "lint",
    "typecheck",
    "build",
    "scan",
    "spec",
    "harness",
    "mutation",
)


def classify_ci_failure(
    pr: PullRequest,
    causal_check: dict[str, Any] | None,
    github: GitHub | None = None,
) -> tuple[str, str, int | None]:
    if causal_check is None:
        return "UNKNOWN", "no causal check failure identified", None

    details_url = str(
        causal_check.get("detailsUrl")
        or causal_check.get("details_url")
        or causal_check.get("html_url")
        or causal_check.get("target_url")
        or ""
    )
    run_id: int | None = None
    job_id: int | None = None
    if details_url:
        match = re.search(r"/actions/runs/(\d+)(?:/job/(\d+))?", details_url)
        if match:
            run_id = int(match.group(1))
            if match.group(2):
                job_id = int(match.group(2))

    if "failure_kind" in causal_check:
        kind_str = str(causal_check["failure_kind"]).upper()
        if kind_str in {"PRODUCT", "INFRASTRUCTURE", "UNKNOWN"}:
            return kind_str, str(causal_check.get("failure_detail") or "explicit test metadata"), run_id

    if github is not None and run_id is not None:
        try:
            jobs = github.get_run_jobs(run_id)
            for job in jobs:
                if job_id and job.get("id") != job_id:
                    continue
                failed_steps = [s for s in job.get("steps", []) if str(s.get("conclusion", "")).lower() in {"failure", "timed_out", "cancelled"}]
                for step in failed_steps:
                    step_name = str(step.get("name", "")).lower()
                    for pattern in INFRASTRUCTURE_STEP_PATTERNS:
                        if pattern in step_name:
                            return (
                                "INFRASTRUCTURE",
                                f"setup step '{step.get('name')}' failed before product tests in job '{job.get('name')}'",
                                run_id,
                            )
                    for pattern in PRODUCT_STEP_PATTERNS:
                        if pattern in step_name:
                            return (
                                "PRODUCT",
                                f"verification step '{step.get('name')}' failed in job '{job.get('name')}'",
                                run_id,
                            )
        except Exception:
            pass

    check_name = str(causal_check.get("name") or causal_check.get("context") or "").lower()
    if any(pattern in check_name for pattern in ("canary", "tier 0", "tier 1", "tier 2", "tier 3", "control plane")):
        return "PRODUCT", f"causal failure in test check '{causal_check.get('name')}'", run_id

    return "UNKNOWN", f"unclassified check '{causal_check.get('name')}'", run_id


def dump_evidence(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
