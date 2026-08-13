#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


factory_dir = Path(__file__).resolve().parents[1]
lock = json.loads((factory_dir / "upstream-lock.json").read_text(encoding="utf-8"))


def latest(repo: str) -> str:
    if shutil.which("gh"):
        result = subprocess.run(
            ["gh", "api", f"repos/{repo}/releases/latest", "--jq", ".tag_name"],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "chainsieve-factory-upstream-check"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)["tag_name"]


checks = []
unavailable = False
for name, pinned, repo in (
    ("Agent Orchestrator", lock["agentOrchestrator"]["tag"], "Untrivial-ai/agent-orchestrator"),
    ("Spec Kit", lock["specKit"]["tag"], "github/spec-kit"),
):
    try:
        available = latest(repo)
    except (OSError, KeyError, urllib.error.URLError, json.JSONDecodeError) as error:
        unavailable = True
        print(f"UNAVAILABLE\t{name}\tpinned={pinned}\terror={str(error)[:200]}")
        continue
    checks.append((name, pinned, available))
for name, pinned, available in checks:
    marker = "CURRENT" if pinned == available else "UPDATE_AVAILABLE"
    print(f"{marker}\t{name}\tpinned={pinned}\tlatest={available}")

print("Read-only check only. Upgrade between milestones and rerun smoke/chaos validation.")
raise SystemExit(2 if unavailable else 0)
