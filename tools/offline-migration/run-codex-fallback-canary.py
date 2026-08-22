#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from factory.controller.commands import CommandRunner
from factory.controller.config import FactoryConfig
from factory.controller.reasoning import ReasoningRunner
from factory.controller.store import StateStore


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    config = FactoryConfig.load(root, root / "factory" / "deployment" / "canary-config.json")
    store = StateStore(config.state_dir)
    store.prepare()
    marker = config.state_dir / ".codex-canary-failure-consumed"
    marker.unlink(missing_ok=True)
    before = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=root,
        check=True, text=True, capture_output=True,
    ).stdout
    schema = root / "factory" / "schemas" / "reasoning-canary.schema.json"
    prompt = "Return exactly this JSON object: {\"status\":\"PASS\",\"summary\":\"read-only reasoning canary\"}. Do not modify files."
    milestone = f"codex-fallback-canary-{int(time.time())}"
    output_dir = config.state_dir / "codex-fallback-canary" / milestone
    output_dir.mkdir(parents=True, exist_ok=True)

    ReasoningRunner(root, config, store, CommandRunner(root))._invoke_codex(
        "planner", milestone, prompt, schema, output_dir / "codex-normal.json",
    )
    injected_env = dict(os.environ)
    injected_env["CHAINSIEVE_CANARY_CODEX_FAILURE_ONCE"] = "1"
    ReasoningRunner(root, config, store, CommandRunner(root, injected_env))._invoke_codex(
        "planner", milestone, prompt, schema, output_dir / "muse-fallback.json",
    )
    ReasoningRunner(root, config, store, CommandRunner(root))._invoke_codex(
        "planner", milestone, prompt, schema, output_dir / "codex-recovered.json",
    )

    usage = json.loads((config.state_dir / "usage.json").read_text(encoding="utf-8"))
    logical_calls = int(usage["milestones"][milestone]["codexCallsByRole"]["planner"])
    operations = usage["reasoningOperations"]
    events = [item for item in store.history(200) if item.get("milestoneId") == milestone]
    after = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=root,
        check=True, text=True, capture_output=True,
    ).stdout
    assert logical_calls == 3
    assert operations["museFallbackSuccesses"] >= 1
    assert operations["actualLastReasoningProvider"] == "codex"
    assert any(item.get("type") == "CODEX_FALLBACK_SUCCEEDED" for item in events)
    assert before == after, "reasoning canary modified the product repository"
    print(json.dumps({
        "status": "PASS",
        "milestoneId": milestone,
        "logicalCalls": logical_calls,
        "injectedCallLogicalBudget": 1,
        "fallbackProvider": "muse",
        "nextIndependentProvider": "codex",
        "repositoryUnmodified": True,
        "events": [item.get("type") for item in events],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
