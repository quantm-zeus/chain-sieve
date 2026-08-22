"""Git adapter — workspace/head/branch operations. Single owner for git mutations."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

class GitAdapter:
    def __init__(self, repo_root: str | Path = ".") -> None:
        self.root = Path(repo_root)

    def _run(self, argv: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(argv, cwd=str(self.root), capture_output=True, text=True, check=False)

    def current_head(self, branch: str = "main") -> str | None:
        r = self._run(["git","rev-parse",branch])
        if r.returncode==0:
            sha = r.stdout.strip()
            if len(sha)==40 and all(c in "0123456789abcdef" for c in sha.lower()):
                return sha.lower()
        return None

    def branch_exists(self, branch: str) -> bool:
        r = self._run(["git","rev-parse","--verify",f"refs/heads/{branch}"])
        if r.returncode==0:
            return True
        # check remote
        r2 = self._run(["git","ls-remote","--heads","origin",branch])
        return bool(r2.stdout.strip())

    def ensure_branch(self, branch: str, base: str = "origin/main") -> str:
        if self.branch_exists(branch):
            return branch
        # create from base
        self._run(["git","fetch","origin", base.split("/")[-1] if "/" in base else base])
        r = self._run(["git","branch",branch,base])
        if r.returncode!=0:
            raise RuntimeError(f"create branch {branch} failed: {r.stderr}")
        return branch

    def head_for_branch(self, branch: str) -> str | None:
        r = self._run(["git","rev-parse",branch])
        if r.returncode==0:
            return r.stdout.strip().lower()
        r2 = self._run(["git","ls-remote","origin",branch])
        if r2.stdout.strip():
            return r2.stdout.split()[0].lower()
        return None

    def is_ancestor(self, ancestor: str, descendant: str) -> bool:
        r = self._run(["git","merge-base","--is-ancestor",ancestor,descendant])
        return r.returncode==0

    def diff_protected_paths(self, base: str, head: str, protected: tuple[str,...]) -> list[str]:
        if not protected:
            return []
        r = self._run(["git","diff","--name-only",f"{base}..{head}"])
        if r.returncode!=0:
            return []
        changed = r.stdout.splitlines()
        violated = [f for f in changed if any(f.startswith(p.rstrip("/")+"/") or f==p or f.startswith(p) for p in protected)]
        return violated
