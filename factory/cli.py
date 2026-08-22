from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path

# V2 canonical controller
try:
    from .controller.collector import Collector
    from .controller.store import Store
    from .controller.runtime import tick_once, status as v2_status, doctor as v2_doctor
    from .controller.executor import Executor
    from .controller.adapters.github import GitHubAdapter
    from .controller.adapters.ao import AOAdapter
    from .controller.adapters.git import GitAdapter
    HAS_V2 = True
except Exception as e:
    HAS_V2 = False
    _v2_import_error = e

# V1 fallback removed — V2 is sole canonical (factory/controller), no V1 runtime imports

def root_path() -> Path:
    return Path(__file__).resolve().parents[1]

def v2_build():
    import os
    repo = os.environ.get("GITHUB_REPOSITORY", "quantm-zeus/chain-sieve")
    # State dir: prefer CHAINSIEVE_FACTORY_STATE_DIR env, else V2 default
    sp = Path(os.environ.get("CHAINSIEVE_FACTORY_STATE_DIR", str(Path.home() / ".local/state/chainsieve-factory-v2/state.db")))
    # If still pointing to V1 path, migrate to V2
    if "chainsieve-factory-v2" not in str(sp) and "chainsieve-factory" in str(sp):
        # warn but use V2
        sp = Path.home() / ".local/state/chainsieve-factory-v2/state.db"
    store = Store(sp)
    github = GitHubAdapter(repo)
    ao = AOAdapter()
    git = GitAdapter(".")
    collector = Collector(github, ao, git)
    executor = Executor(store, {"CREATE_ISSUE": github.handle, "MERGE_PR": github.handle, "START_WORKER": ao.handle, "TRIGGER_REVIEW": ao.handle})
    return store, collector, executor, github, ao, git

def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="chainsieve-factory")
    commands = result.add_subparsers(dest="command", required=True)
    # V2 commands
    run_p = commands.add_parser("run")
    run_p.add_argument("--once", action="store_true")
    status = commands.add_parser("status")
    status.add_argument("--json", action="store_true")
    doctor = commands.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    commands.add_parser("tick")
    commands.add_parser("tick-once")
    # Legacy compatibility (no-op after V2 promotion)
    commands.add_parser("history").add_argument("--limit", type=int, default=50)
    commands.add_parser("sync-issues")
    commands.add_parser("reconcile")
    commands.add_parser("converge")
    commands.add_parser("final-audit")
    for name in ("start","stop","restart"):
        commands.add_parser(name)
    commands.add_parser("upstream-check")
    return result

def main(argv=None) -> int:
    args = parser().parse_args(argv)
    # Prefer V2 for run/status/doctor/tick
    if args.command in ("run","status","doctor","tick","tick-once"):
        if not HAS_V2:
            print(f"V2 controller not available: {_v2_import_error}", file=sys.stderr)
            return 1
        store, collector, executor, github, ao, git = v2_build()
        if args.command == "status":
            val = v2_status(store)
            print(json.dumps(val, indent=2))
            return 0
        if args.command == "doctor":
            val = v2_doctor(github, ao, git, store)
            # compatible json
            print(json.dumps(val, indent=2))
            return 0 if val.get("ok") else 1
        if args.command in ("tick","tick-once","run"):
            # run once or loop
            if args.command == "tick" or (args.command=="run" and not getattr(args, "once", False)):
                # loop for run without --once
                import time
                while True:
                    res = tick_once(store, collector, executor)
                    print(json.dumps(res))
                    if args.command == "tick-once" or getattr(args, "once", False):
                        break
                    time.sleep(15)
                return 0
            else:
                res = tick_once(store, collector, executor)
                print(json.dumps(res, indent=2))
                return 0
    # Legacy V1 commands removed — V2 canonical only, legacy commands not supported
    if args.command in ("history","sync-issues","reconcile","converge","final-audit"):
        print(f"legacy command {args.command} removed — use V2 run/status/doctor", file=sys.stderr)
        return 2
    print(f"unknown command {args.command}", file=sys.stderr)
    return 2
