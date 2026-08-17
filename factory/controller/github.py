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
