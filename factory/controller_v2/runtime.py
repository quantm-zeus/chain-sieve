"""Runtime entrypoint — tick loop, status, doctor. Single binary factory run."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .store import Store
from .collector import Collector
from .reducer import reduce_state
from .executor import Executor
from .domain import WorkItem
from .adapters.github import GitHubAdapter
from .adapters.ao import AOAdapter
from .adapters.git import GitAdapter

def tick_once(store: Store, collector: Collector, executor: Executor, required_checks: tuple[str,...]=(), review_scope: str|None=None, review_digest: str|None=None) -> dict[str,Any]:
    # load work items
    rows = store.conn.execute("SELECT workId, gapKey, status, issue_number, branch, pr_number, session_id, head_sha, strategyEpoch FROM work_items").fetchall()
    work_items = []
    for r in rows:
        try:
            from .domain import WorkStatus
            wi = WorkItem(workId=r[0], gapKey=r[1], status=WorkStatus(r[2]), issue_number=r[3], branch=r[4], pr_number=r[5], session_id=r[6], head_sha=r[7], strategyEpoch=r[8])
            work_items.append(wi)
        except Exception:
            continue
    obs = collector.collect(work_items, required_checks)
    results = []
    for wi in work_items:
        try:
            state_version = 0
            # fetch version from commands count maybe
            cnt = store.conn.execute("SELECT count(*) FROM commands WHERE workId=?", (wi.workId,)).fetchone()
            state_version = int(cnt[0]) if cnt else 0
            next_wi, cmds = reduce_state(wi, obs, required_checks=required_checks, review_scope=review_scope, review_digest=review_digest, state_version=state_version)
            # persist next state if changed
            if next_wi != wi:
                store.insert_work_item({"workId": next_wi.workId, "gapKey": next_wi.gapKey, "strategyEpoch": next_wi.strategyEpoch, "status": next_wi.status.value, "issue_number": next_wi.issue_number, "branch": next_wi.branch, "pr_number": next_wi.pr_number, "session_id": next_wi.session_id, "head_sha": next_wi.head_sha, "updated_at": obs.clock.iso})
            for cmd in cmds:
                receipt = executor.execute(cmd)
                results.append({"workId": wi.workId, "command": cmd.commandType.value if hasattr(cmd.commandType,"value") else str(cmd.commandType), "receipt": receipt.status})
        except Exception as e:
            results.append({"workId": wi.workId, "error": str(e)})
    return {"observed_at": obs.clock.iso, "work_items": len(work_items), "results": results, "prs": len(obs.prs), "ci": len(obs.ci)}

def status(store: Store) -> dict[str,Any]:
    rows = store.conn.execute("SELECT status, count(*) FROM work_items GROUP BY status").fetchall()
    return {"by_status": {r[0]: r[1] for r in rows}, "commands": store.conn.execute("SELECT count(*) FROM commands").fetchone()[0], "receipts": store.conn.execute("SELECT count(*) FROM command_receipts").fetchone()[0]}

def doctor(github: GitHubAdapter, ao: AOAdapter, git: GitAdapter, store: Store) -> dict[str,Any]:
    checks = {}
    try:
        actor = github.current_actor()
        checks["github_auth"] = {"ok": True, "actor": actor}
    except Exception as e:
        checks["github_auth"] = {"ok": False, "error": str(e)}
    try:
        head = git.current_head("main")
        checks["git_head"] = {"ok": bool(head), "head": head}
    except Exception as e:
        checks["git_head"] = {"ok": False, "error": str(e)}
    try:
        sess = ao.list_sessions()
        checks["ao"] = {"ok": True, "sessions": len(sess)}
    except Exception as e:
        checks["ao"] = {"ok": False, "error": str(e)}
    try:
        store.conn.execute("SELECT 1")
        checks["store"] = {"ok": True}
    except Exception as e:
        checks["store"] = {"ok": False, "error": str(e)}
    ok = all(v.get("ok") for v in checks.values())
    return {"ok": ok, "checks": checks}

def run_loop(repo: str = "quantm-zeus/chain-sieve", state_path: str | Path | None = None, interval: int = 60) -> None:
    sp = Path(state_path) if state_path else Path.home() / ".local/state/chainsieve-factory-v2/state.db"
    store = Store(sp)
    github = GitHubAdapter(repo)
    ao = AOAdapter()
    git = GitAdapter(".")
    collector = Collector(github, ao, git)
    executor = Executor(store, {"CREATE_ISSUE": github.handle, "MERGE_PR": github.handle, "START_WORKER": ao.handle, "TRIGGER_REVIEW": ao.handle})
    while True:
        try:
            res = tick_once(store, collector, executor)
            print(f"tick {res['observed_at']} items={res['work_items']} cmds={len(res['results'])}")
        except Exception as e:
            print(f"tick error: {e}")
        time.sleep(interval)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", nargs="?", default="tick")
    parser.add_argument("--repo", default="quantm-zeus/chain-sieve")
    args = parser.parse_args()
    if args.cmd == "tick":
        run_loop(repo=args.repo, interval=10)
    elif args.cmd == "tick-once":
        sp = Path.home() / ".local/state/chainsieve-factory-v2/state.db"
        store = Store(sp)
        github = GitHubAdapter(args.repo)
        ao = AOAdapter()
        git = GitAdapter(".")
        collector = Collector(github, ao, git)
        executor = Executor(store, {"CREATE_ISSUE": github.handle, "MERGE_PR": github.handle, "START_WORKER": ao.handle, "TRIGGER_REVIEW": ao.handle})
        print(tick_once(store, collector, executor))
    elif args.cmd == "status":
        sp = Path.home() / ".local/state/chainsieve-factory-v2/state.db"
        store = Store(sp)
        print(status(store))
    elif args.cmd == "doctor":
        sp = Path.home() / ".local/state/chainsieve-factory-v2/state.db"
        store = Store(sp)
        github = GitHubAdapter(args.repo)
        ao = AOAdapter()
        git = GitAdapter(".")
        print(doctor(github, ao, git, store))
