from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .commands import CommandError, CommandResult, CommandRunner
from .models import Issue, PullRequest
from .token_source import GitHubAppTokenSource


WORK_PACKAGE_MARKER = re.compile(r"<!-- chainsieve-work-package:([a-z0-9-]+--[a-z0-9-]+) -->")
GH_ENV = ("GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR")


class GitHub:
    def __init__(
        self,
        runner: CommandRunner,
        repo: str,
        integration_actors: tuple[str, ...],
        worker_actors: tuple[str, ...],
        integration_branch: str,
        token_source: GitHubAppTokenSource | None = None,
    ) -> None:
        self.runner = runner
        self.repo = repo
        self.integration_actors = set(integration_actors)
        self.worker_actors = set(worker_actors)
        self.integration_branch = integration_branch
        self.token_source = token_source

    def _run(self, argv: list[str], **kwargs: Any):
        if self.token_source is None:
            return self.runner.run(argv, allowed_env=GH_ENV, **kwargs)
        for attempt in range(2):
            try:
                result = self.runner.run(
                    argv,
                    allowed_env=("GH_HOST", "GH_CONFIG_DIR"),
                    additions={"GH_TOKEN": self.token_source.token()},
                    **kwargs,
                )
            except CommandError as error:
                if attempt or not _auth_failure(error):
                    raise
                self.token_source.invalidate()
                continue
            if result.returncode != 0 and _auth_result(result):
                if attempt:
                    return result
                self.token_source.invalidate()
                continue
            return result
        raise AssertionError("unreachable")

    def _json(self, argv: list[str], **kwargs: Any) -> Any:
        result = self._run(argv, **kwargs)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"command returned invalid JSON: {' '.join(argv[:3])}") from error

    def issues(self) -> dict[str, Issue]:
        raw = self._json(
            [
                "gh", "issue", "list", "--repo", self.repo, "--state", "all", "--limit", "500",
                "--json", "number,state,body,url,author",
            ],
        )
        result: dict[str, Issue] = {}
        for value in raw:
            body = value.get("body") or ""
            author = (value.get("author") or {}).get("login", "")
            marker = WORK_PACKAGE_MARKER.search(body)
            if not marker or author not in self.integration_actors:
                continue
            package_id = marker.group(1)
            issue = Issue(int(value["number"]), str(value["state"]), body, str(value["url"]), author)
            previous = result.get(package_id)
            if previous and previous.number != issue.number:
                raise RuntimeError(f"duplicate trusted issues for work package {package_id}")
            result[package_id] = issue
        return result

    def create_issue(self, package_id: str, title: str, body: str) -> Issue:
        self._assert_integration_identity()
        payload = f"<!-- chainsieve-work-package:{package_id} -->\n\n{body.rstrip()}\n"
        url = self._run(
            ["gh", "issue", "create", "--repo", self.repo, "--title", title, "--body-file", "-"],
            input_text=payload,
        ).stdout.strip()
        number = int(url.rstrip("/").rsplit("/", 1)[1])
        value = self._json(
            ["gh", "issue", "view", str(number), "--repo", self.repo, "--json", "number,state,body,url,author"]
        )
        actor = str((value.get("author") or {}).get("login", ""))
        if actor not in self.integration_actors:
            raise RuntimeError(f"created issue #{number} has unexpected author {actor!r}")
        marker = WORK_PACKAGE_MARKER.search(str(value.get("body") or ""))
        if marker is None or marker.group(1) != package_id:
            raise RuntimeError(f"created issue #{number} does not retain exact work marker {package_id!r}")
        return Issue(number, str(value["state"]), str(value.get("body") or ""), str(value["url"]), actor)

    def close_issue(self, number: int, reason: str) -> None:
        self._run(
            ["gh", "issue", "close", str(number), "--repo", self.repo, "--comment", reason],
        )

    def prs(self) -> dict[str, list[PullRequest]]:
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
            if author not in self.worker_actors:
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
        self._assert_integration_identity()
        if pr.base_branch != self.integration_branch:
            raise RuntimeError(
                f"refusing to merge PR #{pr.number}: base {pr.base_branch!r} is not configured target {self.integration_branch!r}"
            )
        if pr.author not in self.worker_actors:
            raise RuntimeError(f"refusing to merge PR #{pr.number}: author {pr.author!r} is not a configured worker")
        self._run(
            [
                "gh", "pr", "merge", str(pr.number), "--repo", self.repo, "--squash",
                "--match-head-commit", pr.head_sha,
            ],
            timeout=180,
        )

    def approve(self, pr: PullRequest) -> None:
        self._assert_integration_identity()
        if pr.author in self.integration_actors:
            raise RuntimeError("integration actor must not be the PR author")
        reviews = self._json(
            ["gh", "api", f"repos/{self.repo}/pulls/{pr.number}/reviews"],
        )
        if any(
            str((review.get("user") or {}).get("login", "")) in self.integration_actors
            and str(review.get("state", "")).upper() == "APPROVED"
            and str(review.get("commit_id", "")) == pr.head_sha
            for review in reviews
        ):
            return
        self._run(
            [
                "gh", "pr", "review", str(pr.number), "--repo", self.repo, "--approve",
                "--body", f"Factory gates passed for exact head {pr.head_sha}.",
            ],
            timeout=120,
        )
        reviews = self._json(["gh", "api", f"repos/{self.repo}/pulls/{pr.number}/reviews"])
        if not any(
            str((review.get("user") or {}).get("login", "")) in self.integration_actors
            and str(review.get("state", "")).upper() == "APPROVED"
            and str(review.get("commit_id", "")) == pr.head_sha
            for review in reviews
        ):
            raise RuntimeError(f"approval for PR #{pr.number} was not authored by the configured integration actor at exact head")

    def auth_scopes(self) -> tuple[str, ...]:
        result = self._run(["gh", "auth", "status"], check=False)
        text = result.stdout + result.stderr
        match = re.search(r"Token scopes: '([^']*)'", text)
        return tuple(item.strip() for item in match.group(1).split(",")) if match else ()

    def credential_evidence(self) -> tuple[bool, str]:
        if self.token_source is None:
            return False, "renewable GitHub App token source is not configured"
        repository = self._json(["gh", "api", f"repos/{self.repo}"])
        if str(repository.get("full_name", "")).lower() != self.repo.lower():
            return False, f"installation cannot access {self.repo}"
        actor = self.token_source.app_actor()
        if actor not in self.integration_actors:
            return False, f"GitHub App actor {actor!r} is not configured as an integration actor"
        return True, f"installation repository access and app actor {actor} verified"

    def _assert_integration_identity(self) -> None:
        if self.token_source is None:
            return
        actor = self.token_source.app_actor()
        if actor not in self.integration_actors:
            raise RuntimeError(f"configured GitHub App actor {actor!r} is not an integration actor")


def _auth_failure(error: CommandError) -> bool:
    return _auth_result(error.result)


def _auth_result(result: CommandResult) -> bool:
    text = f"{result.stdout}\n{result.stderr}".lower()
    return any(value in text for value in (
        "bad credentials", "http 401", "status 401", "http 403", "status 403", "requires authentication"
    ))


def ci_gate(pr: PullRequest, required_checks: tuple[str, ...]) -> tuple[bool, str]:
    state, reason = ci_state(pr, required_checks)
    return state == "PASS", reason


def ci_state(pr: PullRequest, required_checks: tuple[str, ...]) -> tuple[str, str]:
    by_name: dict[str, str] = {}
    for check in pr.checks:
        name = str(check.get("name") or check.get("context") or "")
        status = str(check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        if name:
            by_name[name] = status
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


def dump_evidence(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
