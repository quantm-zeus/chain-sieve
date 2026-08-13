from __future__ import annotations

import json
import os
import shutil
import stat
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from .commands import CommandRunner
from .config import FactoryConfig
from .github import GitHub
from .token_source import GitHubAppTokenSource


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

    expected_python = os.environ.get("CHAINSIEVE_FACTORY_EXPECTED_PYTHON")
    actual_python = str(Path(sys.executable).resolve())
    supported_python = sys.version_info[:2] == (3, 12)
    exact_python = not expected_python or Path(expected_python).resolve() == Path(sys.executable).resolve()
    if expected_python:
        python_status = "PASS" if supported_python and exact_python else "FAIL"
    else:
        python_status = "PASS" if supported_python else "WARN"
    add(
        "Python production runtime",
        python_status,
        f"{actual_python} Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}; expected {expected_python or 'not asserted outside systemd'}",
    )
    runtime_lock = root / "factory" / "requirements.lock"
    locked = [
        line for line in runtime_lock.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ] if runtime_lock.exists() else ["missing"]
    add(
        "Python dependency lock",
        "PASS" if not locked else "FAIL",
        "no third-party runtime dependencies" if not locked else "lock is missing or contains unexpected entries",
    )

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
    add(
        "Antigravity waiting-input telemetry",
        "WARN",
        "AO v0.12.3 exposes Agy active/idle/exit hooks but no native waiting-input detector; controller stuck timeout fails closed",
    )

    token_source = None
    try:
        token_source = GitHubAppTokenSource.from_environment()
        github = GitHub(
            runner,
            config.repo,
            config.integration_actors,
            config.worker_actors,
            config.integration_branch,
            token_source,
        )
        credential_ok, credential_detail = github.credential_evidence()
    except Exception as error:
        credential_ok, credential_detail = False, str(error)
    add("renewable GitHub App authentication", "PASS" if credential_ok else "FAIL", credential_detail)
    static_token_present = bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or os.environ.get("AO_GITHUB_TOKEN"))
    add(
        "no static installation token",
        "FAIL" if static_token_present else "PASS",
        "remove GH_TOKEN/GITHUB_TOKEN/AO_GITHUB_TOKEN from production service environment" if static_token_present else "no static token environment variable",
    )
    if token_source is not None:
        try:
            key_mode = stat.S_IMODE(token_source.private_key_path.stat().st_mode)
            key_ok = key_mode & 0o077 == 0
            key_detail = f"{token_source.private_key_path} mode {key_mode:04o}"
        except OSError as error:
            key_ok, key_detail = False, str(error)
        add("GitHub App private key", "PASS" if key_ok else "FAIL", key_detail)
    actor_domains_ok = bool(config.integration_actors and config.worker_actors) and not (
        set(config.integration_actors) & set(config.worker_actors)
    )
    add(
        "GitHub actor privilege domains",
        "PASS" if actor_domains_ok else "FAIL",
        f"integration={','.join(config.integration_actors)} worker={','.join(config.worker_actors)}",
    )

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
    worker_env = Path(os.environ.get("CHAINSIEVE_AO_ENV", "/etc/chainsieve/ao.env"))
    if worker_env.exists():
        mode = stat.S_IMODE(worker_env.stat().st_mode)
        add("worker secret file", "PASS" if mode & 0o077 == 0 else "FAIL", f"{worker_env} mode {mode:04o}")
    else:
        add("worker secret file", "WARN", f"{worker_env} is not installed")

    dashboard_bind = os.environ.get("AO_HOST", "127.0.0.1")
    add("dashboard bind", "PASS" if dashboard_bind in {"127.0.0.1", "localhost", "::1"} else "FAIL", dashboard_bind)

    resources = shutil.disk_usage(root)
    free_gib = resources.free / 1024**3
    add("disk capacity", "PASS" if free_gib >= config.disk_min_free_gib else "FAIL", f"{free_gib:.1f} GiB free")

    for check in filesystem_contract_checks(root, config.state_dir, config.plan_path):
        add(check.name, check.status, check.detail)

    add("branch policy", "WARN", "verify required checks and protected main using deployment/factory/configure-github.sh")
    add("integration target", "PASS", config.integration_branch)
    add("notification routing", "PASS" if config.notification_command else "WARN", "configured" if config.notification_command else "no notifier configured")
    add("systemd", "PASS" if shutil.which("systemctl") else "WARN", "available" if shutil.which("systemctl") else "not available in this environment")
    return checks


def filesystem_contract_checks(root: Path, state_dir: Path, plan_path: Path) -> list[Check]:
    checks: list[Check] = []
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        state_writable = os.access(state_dir, os.W_OK)
    except OSError:
        state_writable = False
    checks.append(Check("writable factory state", "PASS" if state_writable else "FAIL", str(state_dir)))
    repo_readable = os.access(root, os.R_OK | os.X_OK)
    checks.append(Check("readable committed repository", "PASS" if repo_readable else "FAIL", str(root)))
    plan_readable = plan_path.is_file() and os.access(plan_path, os.R_OK)
    checks.append(Check("readable committed plan", "PASS" if plan_readable else "FAIL", str(plan_path)))
    repo_writable = os.access(root, os.W_OK)
    checks.append(
        Check(
            "read-only committed repository",
            "WARN" if repo_writable else "PASS",
            "writable in this environment" if repo_writable else "controller identity cannot write repository root",
        )
    )
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
