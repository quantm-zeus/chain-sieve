"""V2 CLI — status/doctor/tick wrappers over runtime."""
from __future__ import annotations
import argparse
from pathlib import Path
from .store import Store
from .adapters.github import GitHubAdapter
from .adapters.ao import AOAdapter
from .adapters.git import GitAdapter
from .runtime import tick_once, status, doctor
from .collector import Collector
from .executor import Executor

def main(argv=None):
    p = argparse.ArgumentParser(prog="factory-v2")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("doctor")
    sub.add_parser("tick-once")
    sub.add_parser("tick")
    args = p.parse_args(argv)
    # repo from env or default
    import os
    repo = os.environ.get("GITHUB_REPOSITORY", "quantm-zeus/chain-sieve")
    sp = Path(os.environ.get("CHAINSIEVE_STATE_DIR", str(Path.home() / ".local/state/chainsieve-factory-v2/state.db")))
    store = Store(sp)
    github = GitHubAdapter(repo)
    ao = AOAdapter()
    git = GitAdapter(".")
    if args.cmd == "status":
        s = status(store)
        print(s)
        return 0 if s else 0
    if args.cmd == "doctor":
        d = doctor(github, ao, git, store)
        print(d)
        return 0 if d.get("ok") else 1
    if args.cmd in ("tick-once","tick"):
        collector = Collector(github, ao, git)
        executor = Executor(store, {"CREATE_ISSUE": github.handle, "MERGE_PR": github.handle, "START_WORKER": ao.handle, "TRIGGER_REVIEW": ao.handle})
        res = tick_once(store, collector, executor)
        print(res)
        return 0
    return 1

if __name__ == "__main__":
    raise SystemExit(main())
