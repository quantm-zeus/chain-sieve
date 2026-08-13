from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from .controller.ao import AgentOrchestrator
from .controller.commands import CommandRunner
from .controller.config import FactoryConfig
from .controller.controller import FactoryController
from .controller.doctor import checks_json, run_doctor
from .controller.github import GitHub
from .controller.models import work_key
from .controller.store import StateStore
from .controller.token_source import GitHubAppTokenSource


def root_path() -> Path:
    return Path(__file__).resolve().parents[1]


def build() -> tuple[FactoryController, FactoryConfig, StateStore, CommandRunner]:
    root = root_path()
    config_path = Path(os.environ.get("CHAINSIEVE_FACTORY_CONFIG", root / "factory" / "config.json"))
    config = FactoryConfig.load(root, config_path)
    store = StateStore(config.state_dir)
    runner = CommandRunner(root)
    github = GitHub(
        runner,
        config.repo,
        config.integration_actors,
        config.worker_actors,
        config.integration_branch,
        GitHubAppTokenSource.from_environment(),
    )
    ao = AgentOrchestrator(runner, config.project_id)
    return FactoryController(root, config, store, github, ao), config, store, runner


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="chainsieve-factory")
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("run").add_argument("--once", action="store_true")
    status = commands.add_parser("status")
    status.add_argument("--json", action="store_true")
    history = commands.add_parser("history")
    history.add_argument("--limit", type=int, default=50)
    history.add_argument("--json", action="store_true")
    doctor = commands.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    commands.add_parser("sync-issues")
    commands.add_parser("reconcile")
    commands.add_parser("converge")
    audit = commands.add_parser("final-audit")
    audit.add_argument("--output", default=".factory/final-audit.json")
    for name in ("start", "stop", "restart"):
        commands.add_parser(name)
    commands.add_parser("upstream-check")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    controller, config, store, runner = build()
    if args.command == "run":
        controller.run(once=args.once)
        return 0
    if args.command == "status":
        value = controller.status()
        print(json.dumps(value, indent=2) if args.json else _human_status(value))
        return 0
    if args.command == "history":
        events = store.history(args.limit)
        print(json.dumps(events, indent=2) if args.json else "\n".join(json.dumps(item, sort_keys=True) for item in events))
        return 0
    if args.command == "doctor":
        checks = run_doctor(root_path(), config, runner)
        print(checks_json(checks) if args.json else _human_doctor(checks), end="")
        return 1 if any(item.status == "FAIL" for item in checks) else 0
    if args.command == "sync-issues":
        with store.lock():
            value = controller.sync_issues(config.load_milestone())
        print(json.dumps(value, indent=2))
        return 0
    if args.command == "reconcile":
        with store.lock():
            records = controller.reconcile(config.load_milestone())
        print(json.dumps({key: value.to_dict() for key, value in records.items()}, indent=2))
        return 0
    if args.command == "converge":
        from .controller.reasoning import ReasoningRunner, write_remediation

        with store.lock():
            milestone = config.load_milestone()
            result = ReasoningRunner(root_path(), config, store, runner).converge(milestone)
            if result["status"] == "GAPS":
                write_remediation(config, milestone, result["gaps"])
        print(json.dumps(result, indent=2))
        return 0 if result["status"] == "CONVERGED" else 3
    if args.command == "final-audit":
        from .controller.reasoning import ReasoningRunner, audit_remediation, write_remediation

        output = Path(args.output)
        if not output.is_absolute():
            output = root_path() / output
        with store.lock():
            milestone = config.load_milestone()
            store.event("FINAL_AUDIT_STARTED", milestoneId=milestone.id)
            value = ReasoningRunner(root_path(), config, store, runner).final_audit(output)
            records = store.load()
            metadata = store.metadata()
            if value.get("status") == "CONVERGED":
                metadata["finalAuditConverged"] = True
                store.event("FACTORY_CONVERGED", milestoneId=milestone.id)
            else:
                package = audit_remediation(milestone, value)
                write_remediation(config, milestone, [package])
                metadata["finalAuditConverged"] = False
                metadata["milestoneConverged"] = False
                store.event(
                    "CONVERGENCE_GAP_FOUND",
                    milestoneId=milestone.id,
                    workPackageId=package["id"],
                    workKey=work_key(milestone.id, package["id"]),
                    reason="final audit",
                )
            store.save(records, metadata)
        print(json.dumps(value, indent=2))
        return 0 if value.get("status") == "CONVERGED" else 3
    if args.command in {"start", "stop", "restart"}:
        return subprocess.run(["systemctl", args.command, "chainsieve-factory.service"], check=False).returncode
    if args.command == "upstream-check":
        script = root_path() / "factory" / "deployment" / "upstream-check.py"
        return subprocess.run([sys.executable, str(script)], cwd=root_path(), check=False).returncode
    return 2


def _human_status(value: dict[str, object]) -> str:
    progress = value["progress"]
    packages = value["packages"]
    lines = [
        "CHAINSIEVE FACTORY",
        "",
        f"STATUS      {value['status']}",
        f"CONTROLLER  {value['controllerLiveness']['state']}",
        f"UPTIME      {_duration(value.get('uptimeSeconds'))}",
        f"MILESTONE   {value['milestone']}",
        f"PROGRESS    {progress['completed']} / {progress['total']} complete",
        "",
        "WORK PACKAGES",
    ]
    for package_id, record in packages.items():
        suffix = f" PR #{record['pr_number']}" if record.get("pr_number") else ""
        provider = record.get("provider") or "-"
        activity = record.get("ao_activity") or "-"
        lines.append(f"  {package_id:28} {provider:5} {record['status']:10} {activity:14}{suffix}")
    blocked = [(key, item["blocked_reason"]) for key, item in packages.items() if item.get("blocked_reason")]
    lines.extend(["", "BLOCKERS"])
    lines.extend(f"  {key}: {reason}" for key, reason in blocked) if blocked else lines.append("  none")
    return "\n".join(lines)


def _duration(seconds: object) -> str:
    if seconds is None:
        return "not running / unknown"
    total = int(seconds)
    days, remainder = divmod(total, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{days}d {hours}h {minutes}m {secs}s"


def _human_doctor(checks: list[object]) -> str:
    lines = ["CHAINSIEVE FACTORY DOCTOR", ""]
    lines.extend(f"{item.status:4}  {item.name:30} {item.detail}" for item in checks)
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
