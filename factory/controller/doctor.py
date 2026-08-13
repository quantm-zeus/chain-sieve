from __future__ import annotations

import json
import os
import shutil
import stat
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from .commands import CommandRunner
from .config import FactoryConfig


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str


def run_doctor(root: Path, config: FactoryConfig, runner: CommandRunner) -> list[Check]:
    checks: list[Check] = []
    lock = json.loads((root / "factory" / "upstream-lock.json").read_text(encoding="utf-8"))
    providers = lock["localProviderBaselines"]

    def add(name: str, status: str, detail: str) -> None:
        checks.append(Check(name, status, detail))

    top = runner.run(["git", "rev-parse", "--show-toplevel"], check=False)
    add("repository", "PASS" if top.returncode == 0 and Path(top.stdout.strip()).resolve() == root.resolve() else "FAIL", top.stdout.strip() or top.stderr.strip())

    dirty = runner.run(["git", "status", "--porcelain"], check=False)
    add("control-plane checkout", "PASS" if dirty.returncode == 0 and not dirty.stdout.strip() else "WARN", "clean" if not dirty.stdout.strip() else "uncommitted changes present")

    _binary_check(add, runner, "git", ["git", "--version"], required=True)
    _binary_check(add, runner, "gh", ["gh", "--version"], required=True)
    _binary_check(add, runner, "node", ["node", "--version"], required=True)
    _binary_check(add, runner, "pnpm", ["pnpm", "--version"], required=True)
    _binary_check(add, runner, "tmux", ["tmux", "-V"], required=True)
    _binary_check(add, runner, "AO", ["ao", "version"], required=True, expected="0.12.3")
    _binary_check(add, runner, "Spec Kit", ["specify", "--version"], required=True, expected="0.16.2")
    _binary_check(add, runner, "Muse", ["muse", "--version"], required=True, expected=providers["muse"])
    _binary_check(add, runner, "Antigravity", ["agy", "--version"], required=True, expected=providers["agy"])
    _binary_check(add, runner, "Codex", ["codex", "--version"], required=True)

    muse_help = runner.run(["muse", "--help"], check=False)
    muse_exec_help = runner.run(["muse", "exec", "--help"], check=False)
    muse_text = muse_help.stdout + muse_help.stderr + muse_exec_help.stdout + muse_exec_help.stderr
    muse_flags = all(flag in muse_text for flag in ("--disable-approval", "--disable-write", "--disable-shell", "--user-input-auto-resolve", "--trust-workspace"))
    add("Muse headless permissions", "PASS" if muse_flags else "FAIL", "required non-interactive/reviewer flags available" if muse_flags else "required Muse flags missing")

    agy_help = runner.run(["agy", "--help"], check=False)
    agy_flags = all(flag in (agy_help.stdout + agy_help.stderr) for flag in ("--dangerously-skip-permissions", "--print", "--model"))
    add("Antigravity headless permissions", "PASS" if agy_flags else "FAIL", "required non-interactive flags available" if agy_flags else "required agy flags missing")

    gh_auth = runner.run(["gh", "auth", "status"], allowed_env=("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"), check=False)
    add("GitHub authentication", "PASS" if gh_auth.returncode == 0 else "FAIL", "authenticated" if gh_auth.returncode == 0 else "gh is not authenticated")
    actor_result = runner.run(["gh", "api", "user"], allowed_env=("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"), check=False)
    try:
        actor = json.loads(actor_result.stdout) if actor_result.returncode == 0 else {}
    except json.JSONDecodeError:
        actor = {}
    login = str(actor.get("login", ""))
    add("trusted integration actor", "PASS" if login in config.trusted_actors else "FAIL", login or "unknown")

    ao_status = runner.run(["ao", "status", "--json"], allowed_env=("AO_PORT", "AO_RUN_FILE", "AO_DATA_DIR"), check=False)
    add("AO daemon", "PASS" if ao_status.returncode == 0 else "WARN", "reachable" if ao_status.returncode == 0 else "not running")
    if ao_status.returncode == 0:
        inventory_result = runner.run(
            ["ao", "agent", "ls", "--refresh", "--json"],
            allowed_env=("AO_PORT", "AO_RUN_FILE", "AO_DATA_DIR"),
            check=False,
            timeout=120,
        )
        try:
            inventory = json.loads(inventory_result.stdout) if inventory_result.returncode == 0 else {}
        except json.JSONDecodeError:
            inventory = {}
        authorized = {str(item.get("id")) for item in inventory.get("authorized", [])}
        for provider in ("muse", "agy"):
            add(
                f"AO {provider} authorization",
                "PASS" if provider in authorized else "FAIL",
                "authorized" if provider in authorized else "not authorized in AO worker identity",
            )
    else:
        add("AO provider authorization", "WARN", "not checked while daemon is unavailable")

    service_env = Path(os.environ.get("CHAINSIEVE_FACTORY_ENV", "/etc/chainsieve/factory.env"))
    if service_env.exists():
        mode = stat.S_IMODE(service_env.stat().st_mode)
        add("service secret file", "PASS" if mode & 0o077 == 0 else "FAIL", f"{service_env} mode {mode:04o}")
    else:
        add("service secret file", "WARN", f"{service_env} is not installed")

    dashboard_bind = os.environ.get("AO_HOST", "127.0.0.1")
    add("dashboard bind", "PASS" if dashboard_bind in {"127.0.0.1", "localhost", "::1"} else "FAIL", dashboard_bind)

    resources = shutil.disk_usage(root)
    free_gib = resources.free / 1024**3
    add("disk capacity", "PASS" if free_gib >= config.disk_min_free_gib else "FAIL", f"{free_gib:.1f} GiB free")

    for path in (config.state_dir, config.plan_path.parent):
        try:
            path.mkdir(parents=True, exist_ok=True)
            writable = os.access(path, os.W_OK)
        except OSError:
            writable = False
        add(f"writable {path.name}", "PASS" if writable else "FAIL", str(path))

    add("branch policy", "WARN", "verify required checks and protected main using deployment/factory/configure-github.sh")
    add("notification routing", "PASS" if config.notification_command else "WARN", "configured" if config.notification_command else "no notifier configured")
    add("systemd", "PASS" if shutil.which("systemctl") else "WARN", "available" if shutil.which("systemctl") else "not available in this environment")
    return checks


def _binary_check(
    add: Callable[[str, str, str], None],
    runner: CommandRunner,
    name: str,
    argv: list[str],
    *,
    required: bool,
    expected: str | None = None,
) -> None:
    result = runner.run(argv, check=False)
    output = (result.stdout or result.stderr).strip().splitlines()
    detail = output[0] if output else "not found"
    ok = result.returncode == 0 and (expected is None or expected in detail)
    add(name, "PASS" if ok else ("FAIL" if required else "WARN"), detail)


def checks_json(checks: list[Check]) -> str:
    return json.dumps({"checks": [asdict(item) for item in checks]}, indent=2) + "\n"
