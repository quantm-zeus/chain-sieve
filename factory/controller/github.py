from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .commands import CommandRunner
from .models import Issue, PullRequest


WORK_PACKAGE_MARKER = re.compile(r"<!-- chainsieve-work-package:([a-z0-9-]+) -->")
GH_ENV = ("GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR")


class GitHub:
    def __init__(
        self,
        runner: CommandRunner,
        repo: str,
        integration_actors: tuple[str, ...],
        worker_actors: tuple[str, ...],
        integration_branch: str,
    ) -> None:
        self.runner = runner
        self.repo = repo
        self.integration_actors = set(integration_actors)
        self.worker_actors = set(worker_actors)
        self.integration_branch = integration_branch

    def issues(self) -> dict[str, Issue]:
        raw = self.runner.json(
            [
                "gh", "issue", "list", "--repo", self.repo, "--state", "all", "--limit", "500",
                "--json", "number,state,body,url,author",
            ],
            allowed_env=GH_ENV,
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
        actor = self.current_actor()
        if actor not in self.integration_actors:
            raise RuntimeError(f"authenticated GitHub actor {actor!r} is not in integrationActors")
        payload = f"<!-- chainsieve-work-package:{package_id} -->\n\n{body.rstrip()}\n"
        url = self.runner.run(
            ["gh", "issue", "create", "--repo", self.repo, "--title", title, "--body-file", "-"],
            allowed_env=GH_ENV,
            input_text=payload,
        ).stdout.strip()
        number = int(url.rstrip("/").rsplit("/", 1)[1])
        return Issue(number, "OPEN", payload, url, actor)

    def close_issue(self, number: int, reason: str) -> None:
        self.runner.run(
            ["gh", "issue", "close", str(number), "--repo", self.repo, "--comment", reason],
            allowed_env=GH_ENV,
        )

    def prs(self) -> dict[str, list[PullRequest]]:
        raw = self.runner.json(
            [
                "gh", "pr", "list", "--repo", self.repo, "--state", "all", "--limit", "500",
                "--json", "number,state,headRefName,headRefOid,baseRefName,url,author,mergeable,mergeStateStatus,statusCheckRollup,files,mergedAt,updatedAt",
            ],
            allowed_env=GH_ENV,
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
        result = self.runner.run(
            ["gh", "api", f"repos/{self.repo}/git/ref/heads/{branch}"],
            allowed_env=GH_ENV,
            check=False,
        )
        return result.returncode == 0

    def merge(self, pr: PullRequest) -> None:
        if pr.base_branch != self.integration_branch:
            raise RuntimeError(
                f"refusing to merge PR #{pr.number}: base {pr.base_branch!r} is not configured target {self.integration_branch!r}"
            )
        if pr.author not in self.worker_actors:
            raise RuntimeError(f"refusing to merge PR #{pr.number}: author {pr.author!r} is not a configured worker")
        self.runner.run(
            [
                "gh", "pr", "merge", str(pr.number), "--repo", self.repo, "--squash",
                "--match-head-commit", pr.head_sha,
            ],
            allowed_env=GH_ENV,
            timeout=180,
        )

    def approve(self, pr: PullRequest) -> None:
        actor = self.current_actor()
        if actor not in self.integration_actors:
            raise RuntimeError(f"authenticated GitHub actor {actor!r} is not in integrationActors")
        if actor == pr.author:
            raise RuntimeError("integration actor must not be the PR author")
        reviews = self.runner.json(
            ["gh", "api", f"repos/{self.repo}/pulls/{pr.number}/reviews"],
            allowed_env=GH_ENV,
        )
        if any(
            str((review.get("user") or {}).get("login", "")) == actor
            and str(review.get("state", "")).upper() == "APPROVED"
            and str(review.get("commit_id", "")) == pr.head_sha
            for review in reviews
        ):
            return
        self.runner.run(
            [
                "gh", "pr", "review", str(pr.number), "--repo", self.repo, "--approve",
                "--body", f"Factory gates passed for exact head {pr.head_sha}.",
            ],
            allowed_env=GH_ENV,
            timeout=120,
        )

    def current_actor(self) -> str:
        value = self.runner.json(["gh", "api", "user"], allowed_env=GH_ENV)
        return str(value["login"])

    def auth_scopes(self) -> tuple[str, ...]:
        result = self.runner.run(["gh", "auth", "status"], allowed_env=GH_ENV, check=False)
        text = result.stdout + result.stderr
        match = re.search(r"Token scopes: '([^']*)'", text)
        return tuple(item.strip() for item in match.group(1).split(",")) if match else ()


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
