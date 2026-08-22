"""AO adapter — single owner for START_WORKER, TRIGGER_REVIEW. Observe-before-retry."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from ..commands import Command

class AOAdapter:
    """Real AO adapter via ao CLI / filesystem. Observe-before-retry."""

    def __init__(self, state_dir: str | None = None) -> None:
        self.state_dir = Path(state_dir) if state_dir else Path.home() / ".local/state/agent-orchestrator"

    def _run(self, argv: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(argv, input=input_text, capture_output=True, text=True, check=False)

    def _ao_json(self, argv: list[str]) -> Any:
        r = self._run(argv)
        if r.returncode != 0:
            raise RuntimeError(f"ao failed {' '.join(argv)}: {r.stderr}")
        if r.stdout.strip():
            try:
                return json.loads(r.stdout)
            except Exception:
                return r.stdout
        return None

    # observations
    def list_sessions(self) -> list[dict[str, Any]]:
        # AO stores sessions under state_dir/projects/chainsieve or similar
        # Use ao CLI if available, else filesystem scan
        r = self._run(["ao","session","list","--json"])
        if r.returncode == 0 and r.stdout.strip():
            try:
                return json.loads(r.stdout)
            except Exception:
                pass
        # filesystem fallback: scan state_dir
        sessions = []
        for root in [self.state_dir / "worktrees/chainsieve", self.state_dir]:
            if root.exists():
                for p in root.glob("*"):
                    if p.is_dir():
                        sessions.append({"id": p.name, "path": str(p)})
        return sessions

    def find_session_by_work(self, workId: str, branch: str | None = None) -> dict[str, Any] | None:
        for s in self.list_sessions():
            sid = str(s.get("id") or s.get("session_id") or "")
            b = str(s.get("branch") or s.get("headRefName") or "")
            if workId in sid or (branch and branch in b):
                return s
            # check branch name contains gap
            if workId.replace("WORK-","") in sid:
                return s
        return None

    # mutations
    def start_worker_idempotent(self, workId: str, branch: str, issue_number: int | None = None) -> dict[str, Any]:
        existing = self.find_session_by_work(workId, branch)
        if existing:
            return {"session": existing.get("id"), "reused": True}
        # create via ao task create or session start — use ao CLI
        # Try: ao session start --branch <branch> --workId <workId>
        # Fallback to generic session create
        args = ["ao","session","create","--branch",branch,"--json"]
        if issue_number:
            args += ["--issue", str(issue_number)]
        r = self._run(args)
        if r.returncode != 0:
            # reconcile again
            recheck = self.find_session_by_work(workId, branch)
            if recheck:
                return {"session": recheck.get("id"), "reused": True}
            raise RuntimeError(f"start worker failed: {r.stderr}")
        try:
            j = json.loads(r.stdout) if r.stdout.strip() else {}
            return {"session": j.get("id") or j.get("session_id") or branch, "reused": False}
        except Exception:
            return {"session": branch, "reused": False}

    def trigger_review_idempotent(self, workId: str, pr_number: int, head_sha: str, mode: str, reviewScopeId: str, contextDigest: str) -> dict[str, Any]:
        # review is triggered via ao review command; observe existing reviews first
        # For V2, reviews are stored as JSON artifacts; we check if review for exact tuple exists
        # Use filesystem scan for existing review evidence
        # If exists and matches, reuse
        # else dispatch new review
        # Since AO review dispatch is async, we model idempotency via deterministic review request id
        review_key = f"{workId}|{head_sha.lower()}|{mode}|{reviewScopeId}|{contextDigest}"
        import hashlib
        review_id = hashlib.sha256(review_key.encode()).hexdigest()[:12]
        # Check existing reviews via ao CLI
        r = self._run(["ao","review","list","--pr",str(pr_number),"--json"])
        if r.returncode == 0 and r.stdout.strip():
            try:
                reviews = json.loads(r.stdout)
                for rv in reviews:
                    if str(rv.get("workId")) == workId and str(rv.get("targetHead","")).lower() == head_sha.lower() and rv.get("mode")==mode and rv.get("reviewScopeId")==reviewScopeId:
                        return {"review_id": review_id, "reused": True}
            except Exception:
                pass
        # dispatch
        args = ["ao","review","trigger","--pr",str(pr_number),"--head",head_sha,"--mode",mode,"--workId",workId]
        if reviewScopeId:
            args += ["--scope", reviewScopeId]
        r2 = self._run(args)
        if r2.returncode != 0:
            # reconcile
            r3 = self._run(["ao","review","list","--pr",str(pr_number),"--json"])
            if r3.returncode==0:
                try:
                    reviews=json.loads(r3.stdout)
                    for rv in reviews:
                        if str(rv.get("targetHead","")).lower()==head_sha.lower() and rv.get("mode")==mode:
                            return {"review_id": review_id, "reused": True}
                except Exception:
                    pass
            raise RuntimeError(f"trigger review failed: {r2.stderr}")
        return {"review_id": review_id, "reused": False}

    def handle(self, cmd: Command) -> dict[str, Any]:
        typ = cmd.commandType.value if hasattr(cmd.commandType,"value") else str(cmd.commandType)
        p = cmd.payload
        if typ == "START_WORKER":
            branch = str(p.get("branch") or f"work/{cmd.workId}")
            issue = p.get("issue_number") or p.get("issue")
            return self.start_worker_idempotent(cmd.workId, branch, issue)
        if typ == "TRIGGER_REVIEW":
            pr = int(p.get("pr") or p.get("pr_number") or 0)
            head = str(p.get("head") or p.get("head_sha") or p.get("targetHead") or "")
            mode = str(p.get("mode") or "BASELINE")
            scope = str(p.get("reviewScopeId") or p.get("scope") or "")
            digest = str(p.get("contextDigest") or p.get("digest") or "")
            return self.trigger_review_idempotent(cmd.workId, pr, head, mode, scope, digest)
        raise RuntimeError(f"unsupported AO command: {typ}")
