from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import Milestone


CODEX_ROLES = ("planner", "replan", "final_audit", "emergency", "convergence")


@dataclass(frozen=True)
class CodexRoute:
    model: str
    reasoning_effort: str
    max_calls_per_milestone: int
    explicit_model: str | None = None

    @property
    def model_mode(self) -> str:
        return "explicit" if self.explicit_model else "cli-default"


@dataclass(frozen=True)
class FactoryConfig:
    repo: str
    project_id: str
    default_branch: str
    max_active_workers: int
    max_task_attempts: int
    max_correction_attempts: int
    max_review_cycles: int
    max_final_audit_cycles: int
    max_convergence_passes: int
    max_task_wall_clock_seconds: int
    max_milestone_wall_clock_seconds: int
    max_idle_seconds: int
    max_starting_seconds: int
    max_tick_duration_seconds: int
    disk_min_free_gib: float
    memory_min_free_mib: int
    max_worktrees: int
    required_checks: tuple[str, ...]
    protected_paths: tuple[str, ...]
    integration_branch: str
    state_dir: Path
    plan_path: Path
    poll_seconds: int
    convergence_enabled: bool
    notification_command: tuple[str, ...]
    codex_routes: dict[str, CodexRoute]
    agy_model: str
    reasoning_timeout_seconds: int = 300
    muse_model: str = "muse-spark-1.2-contributor"
    muse_explicit_model: str | None = None
    agy_explicit_model: str | None = None
    provider_cooldown_seconds: int = 60
    implementation_weights: dict[str, int] = field(default_factory=lambda: {"agy": 2, "muse": 1})

    @classmethod
    def load(cls, root: Path, path: Path) -> "FactoryConfig":
        raw = json.loads(path.read_text(encoding="utf-8"))
        budgets = raw["budgets"]
        resources = raw["resources"]
        integration = raw["integration"]
        models = raw["models"]
        raw_weights = budgets.get("implementationWeights")
        if raw_weights is None:
            weights = {"agy": 2, "muse": 1}
        else:
            weights = {str(k).lower(): int(v) for k, v in raw_weights.items()}
        config = cls(
            repo=str(raw["repository"]),
            project_id=str(raw.get("aoProjectId", "chainsieve")),
            default_branch=str(raw.get("defaultBranch", "main")),
            max_active_workers=int(budgets["maxActiveWorkers"]),
            max_task_attempts=int(budgets["maxTaskAttempts"]),
            max_correction_attempts=int(budgets["maxCorrectionAttempts"]),
            max_review_cycles=int(budgets["maxReviewCycles"]),
            max_final_audit_cycles=int(budgets.get("maxFinalAuditCycles", 3)),
            max_convergence_passes=int(budgets["maxConvergencePasses"]),
            max_task_wall_clock_seconds=int(budgets["maxTaskWallClockSeconds"]),
            max_milestone_wall_clock_seconds=int(budgets["maxMilestoneWallClockSeconds"]),
            max_idle_seconds=int(budgets["maxIdleSeconds"]),
            max_starting_seconds=int(budgets["maxStartingSeconds"]),
            disk_min_free_gib=float(resources["diskMinFreeGiB"]),
            memory_min_free_mib=int(resources["memoryMinFreeMiB"]),
            max_worktrees=int(resources["maxWorktrees"]),
            required_checks=tuple(str(item) for item in integration["requiredChecks"]),
            protected_paths=tuple(str(item) for item in integration["protectedPaths"]),
            integration_branch=str(
                os.environ.get("CHAINSIEVE_INTEGRATION_BRANCH", integration.get("targetBranch", raw.get("defaultBranch", "main")))
            ),
            state_dir=_resolve(root, os.environ.get("CHAINSIEVE_FACTORY_STATE_DIR", raw.get("stateDirectory", ".factory"))),
            plan_path=_resolve(root, os.environ.get("CHAINSIEVE_FACTORY_PLAN", raw.get("planPath", "specs/factory/current-milestone.json"))),
            poll_seconds=int(raw.get("pollSeconds", 30)),
            convergence_enabled=bool(raw.get("convergenceEnabled", True)),
            notification_command=tuple(str(item) for item in raw.get("notificationCommand", [])),
            codex_routes={
                role: CodexRoute(
                    model=str(models["codex"][role]["model"]),
                    reasoning_effort=str(models["codex"][role]["reasoningEffort"]),
                    max_calls_per_milestone=int(models["codex"][role]["maxCallsPerMilestone"]),
                    explicit_model=os.environ.get(f"CHAINSIEVE_CODEX_{role.upper()}_MODEL") or None,
                )
                for role in CODEX_ROLES
            },
            muse_model=str(models["muse"]["model"]),
            muse_explicit_model=os.environ.get("CHAINSIEVE_MUSE_MODEL") or None,
            agy_model=str(models["agy"]["model"]),
            agy_explicit_model=os.environ.get("CHAINSIEVE_AGY_MODEL") or None,
            provider_cooldown_seconds=int(budgets.get("providerCooldownSeconds", 60)),
            max_tick_duration_seconds=int(budgets.get("maxTickDurationSeconds", 300)),
            reasoning_timeout_seconds=int(budgets.get("reasoningTimeoutSeconds", budgets.get("maxTickDurationSeconds", 300))),
            implementation_weights=weights,
        )
        config.validate()
        return config

    def validate(self) -> None:
        if self.max_active_workers < 1 or self.max_active_workers > 32:
            raise ValueError("maxActiveWorkers must be between 1 and 32")
        for name in (
            "max_task_attempts",
            "max_correction_attempts",
            "max_review_cycles",
            "max_final_audit_cycles",
            "max_convergence_passes",
        ):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative")
        if not self.required_checks:
            raise ValueError("at least one required CI check is required")
        if self.max_task_wall_clock_seconds <= 0 or self.max_milestone_wall_clock_seconds <= 0:
            raise ValueError("task and milestone wall-clock budgets must be positive")
        if self.max_idle_seconds <= 0 or self.max_starting_seconds <= 0:
            raise ValueError("idle and starting thresholds must be positive")
        if self.max_tick_duration_seconds <= 0:
            raise ValueError("maxTickDurationSeconds must be positive")
        if self.reasoning_timeout_seconds <= 0:
            raise ValueError("reasoningTimeoutSeconds must be positive")
        if self.provider_cooldown_seconds < 0 or self.provider_cooldown_seconds > 3600:
            raise ValueError("providerCooldownSeconds must be between 0 and 3600")
        if self.disk_min_free_gib < 0 or self.memory_min_free_mib < 0 or self.max_worktrees < 1:
            raise ValueError("resource gates must be non-negative and maxWorktrees positive")
        if not self.integration_branch or self.integration_branch.startswith("refs/"):
            raise ValueError("integration target branch must be a non-empty short branch name")
        if set(self.codex_routes) != set(CODEX_ROLES):
            raise ValueError(f"Codex routes must be exactly {CODEX_ROLES}")
        for role, route in self.codex_routes.items():
            if not route.model or route.reasoning_effort not in {"low", "medium", "high", "xhigh", "max", "ultra"}:
                raise ValueError(f"invalid Codex route for {role}")
            if route.explicit_model and route.explicit_model != route.model:
                raise ValueError(f"verified Codex model for {role} must match its requested preference")
            if route.max_calls_per_milestone < 0:
                raise ValueError(f"Codex call limit for {role} cannot be negative")
        if self.codex_routes["final_audit"].max_calls_per_milestone < self.max_final_audit_cycles:
            raise ValueError("final_audit Codex call limit must cover maxFinalAuditCycles")
        if self.max_convergence_passes > 0 and self.codex_routes["convergence"].max_calls_per_milestone < self.max_convergence_passes:
            raise ValueError("convergence Codex call limit must cover maxConvergencePasses")
        if not self.muse_model or not self.agy_model:
            raise ValueError("Muse and Agy model preferences must be non-empty")
        if self.muse_explicit_model and self.muse_explicit_model != self.muse_model:
            raise ValueError("verified Muse model must match its requested preference")
        if set(self.implementation_weights) != {"agy", "muse"}:
            raise ValueError("implementationWeights must configure exactly agy and muse")
        for provider, weight in self.implementation_weights.items():
            if weight <= 0:
                raise ValueError(f"implementation weight for {provider} must be positive")

    def load_milestone(self) -> Milestone:
        active_path = self.state_dir / "active-milestone.json"
        source = active_path if active_path.exists() else self.plan_path
        raw = json.loads(source.read_text(encoding="utf-8"))
        remediation_path = self.state_dir / "remediation-plan.json"
        if remediation_path.exists():
            remediation = json.loads(remediation_path.read_text(encoding="utf-8"))
            if remediation.get("milestoneId") == raw.get("id"):
                raw["workPackages"] = [*raw.get("workPackages", []), *remediation.get("workPackages", [])]
        return Milestone.from_dict(raw)


def _resolve(root: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path
