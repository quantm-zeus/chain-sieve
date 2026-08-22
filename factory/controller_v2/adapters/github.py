"""GitHub adapter — single owner for CREATE_ISSUE, MERGE_PR. Reconciles via observe-before-retry."""
from __future__ import annotations

import json
import re
import subprocess
from typing import Any

from ..commands import Command

WORK_MARKER = re.compile(r"<!-- chainsieve-v2-work:([A-Za-z0-9_\-]+) -->")
GAP_MARKER = re.compile(r"<!-- chainsieve-v2-gap:([A-Za-z0-9_\-]+) -->")

class GitHubAdapter:
    """Real GitHub adapter using gh CLI. Only this module may mutate Issues/PRs for V2."""

    def __init__(self, repo: str, integration_branch: str = "main") -> None:
        self.repo = repo
        self.integration_branch = integration_branch
        self._actor: str | None = None

    def _run(self, argv: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(argv, input=input_text, capture_output=True, text=True, check=False)

    def _json(self, argv: list[str]) -> Any:
        r = self._run(argv)
        if r.returncode != 0:
            raise RuntimeError(f"gh failed: {' '.join(argv)}: {r.stderr.strip()}")
        return json.loads(r.stdout)

    def current_actor(self) -> str:
        if self._actor is None:
            v = self._json(["gh", "api", "user"])
            a = str(v.get("login","")).strip()
            if not a:
                raise RuntimeError("no gh login")
            self._actor = a
        return self._actor

    # --- observation --- 
    def list_issues(self) -> list[dict[str, Any]]:
        return self._json(["gh","issue","list","--repo",self.repo,"--state","all","--limit","500","--json","number,state,title,body,url,author"])

    def list_prs(self) -> list[dict[str, Any]]:
        return self._json(["gh","pr","list","--repo",self.repo,"--state","all","--limit","500","--json","number,state,headRefName,headRefOid,baseRefName,url,author,mergeable,mergeStateStatus,statusCheckRollup"])

    def find_issue_by_work(self, workId: str, gapKey: str) -> dict[str, Any] | None:
        for it in self.list_issues():
            body = it.get("body") or ""
            if f"<!-- chainsieve-v2-work:{workId} -->" in body or f"<!-- chainsieve-v2-gap:{gapKey} -->" in body:
                return it
            # fallback: title contains workId
            if workId in (it.get("title") or ""):
                return it
        return None

    def find_issue_by_gap(self, gapKey: str) -> dict[str, Any] | None:
        for it in self.list_issues():
            body = it.get("body") or ""
            if f"<!-- chainsieve-v2-gap:{gapKey} -->" in body:
                return it
        return None

    def find_pr_by_work(self, workId: str, pr_number: int | None = None) -> dict[str, Any] | None:
        for pr in self.list_prs():
            if pr_number is not None and int(pr.get("number", -1)) == pr_number:
                return pr
            branch = pr.get("headRefName","")
            if workId.replace("WORK-","") in branch or workId in branch:
                return pr
        return None

    # --- mutations with observe-before-retry ---
    def create_issue_idempotent(self, workId: str, gapKey: str, title: str, body: str) -> dict[str, Any]:
        # reconcile first
        existing = self.find_issue_by_work(workId, gapKey)
        if existing:
            return existing
        existing_gap = self.find_issue_by_gap(gapKey)
        if existing_gap:
            return existing_gap
        marker_body = f"<!-- chainsieve-v2-work:{workId} -->\n<!-- chainsieve-v2-gap:{gapKey} -->\n{body.rstrip()}\n"
        r = self._run(["gh","issue","create","--repo",self.repo,"--title",title,"--body-file","-"], input_text=marker_body)
        if r.returncode != 0:
            # race: maybe created concurrently, re-observe
            recheck = self.find_issue_by_work(workId, gapKey)
            if recheck:
                return recheck
            raise RuntimeError(f"create issue failed: {r.stderr}")
        url = r.stdout.strip()
        num = int(url.rstrip("/").rsplit("/",1)[-1])
        return self._json(["gh","issue","view",str(num),"--repo",self.repo,"--json","number,state,title,body,url,author"])

    def merge_pr_idempotent(self, pr_number: int, head_sha: str) -> dict[str, Any] | None:
        pr = self._json(["gh","pr","view",str(pr_number),"--repo",self.repo,"--json","number,state,headRefOid,mergeable,baseRefName,author"])
        if str(pr.get("state")).lower() == "merged":
            return pr
        cur_head = str(pr.get("headRefOid","")).lower()
        if cur_head != head_sha.lower():
            raise RuntimeError(f"head mismatch: pr {pr_number} head {cur_head} != expected {head_sha}")
        # verify still open and mergeable
        r = self._run(["gh","pr","merge",str(pr_number),"--repo",self.repo,"--squash","--match-head-commit",head_sha])
        if r.returncode != 0:
            # re-observe if merged by concurrent controller
            pr2 = self._json(["gh","pr","view",str(pr_number),"--repo",self.repo,"--json","number,state,headRefOid"])
            if str(pr2.get("state")).lower() == "merged":
                return pr2
            raise RuntimeError(f"merge failed: {r.stderr}")
        return self._json(["gh","pr","view",str(pr_number),"--repo",self.repo,"--json","number,state,headRefOid"])

    def branch_exists(self, branch: str) -> bool:
        r = self._run(["gh","api",f"repos/{self.repo}/git/ref/heads/{branch}"])
        if r.returncode == 0:
            return True
        if "404" in r.stdout or "404" in r.stderr or "not found" in r.stdout.lower():
            return False
        raise RuntimeError(f"branch check failed: {r.stderr}")

    # executor hook
    def handle(self, cmd: Command) -> dict[str, Any]:
        typ = cmd.commandType.value if hasattr(cmd.commandType,"value") else str(cmd.commandType)
        payload = cmd.payload
        if typ == "CREATE_ISSUE":
            gapKey = payload.get("gapKey") or payload.get("gap_key") or ""
            workId = cmd.workId
            title = payload.get("title") or f"[factory-v2] {gapKey}"
            body = payload.get("body") or f"Gap {gapKey} work {workId}"
            res = self.create_issue_idempotent(workId, gapKey, title, body)
            return {"issue": res.get("number"), "url": res.get("url")}
        if typ == "MERGE_PR":
            pr = int(payload.get("pr") or payload.get("pr_number") or 0)
            head = str(payload.get("head") or payload.get("head_sha") or "")
            res = self.merge_pr_idempotent(pr, head)
            return {"merged": True, "pr": pr}
        raise RuntimeError(f"unsupported command for github adapter: {typ}")
