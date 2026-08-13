from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import Milestone


@dataclass(frozen=True)
class FactoryConfig:
    repo: str
    project_id: str
    default_branch: str
    max_active_workers: int
    max_task_attempts: int
    max_correction_attempts: int
    max_review_cycles: int
    max_convergence_passes: int
    max_codex_calls_per_milestone: int
    max_task_wall_clock_seconds: int
    max_milestone_wall_clock_seconds: int
    disk_min_free_gib: float
    memory_min_free_mib: int
    max_worktrees: int
    required_checks: tuple[str, ...]
    protected_paths: tuple[str, ...]
    trusted_actors: tuple[str, ...]
    state_dir: Path
    plan_path: Path
    poll_seconds: int
    notification_command: tuple[str, ...]
    codex_model: str
    codex_reasoning_effort: str
    agy_model: str

    @classmethod
    def load(cls, root: Path, path: Path) -> "FactoryConfig":
        raw = json.loads(path.read_text(encoding="utf-8"))
        budgets = raw["budgets"]
        resources = raw["resources"]
        integration = raw["integration"]
        models = raw["models"]
        config = cls(
            repo=str(raw["repository"]),
            project_id=str(raw.get("aoProjectId", "chainsieve")),
            default_branch=str(raw.get("defaultBranch", "main")),
            max_active_workers=int(budgets["maxActiveWorkers"]),
            max_task_attempts=int(budgets["maxTaskAttempts"]),
            max_correction_attempts=int(budgets["maxCorrectionAttempts"]),
            max_review_cycles=int(budgets["maxReviewCycles"]),
            max_convergence_passes=int(budgets["maxConvergencePasses"]),
            max_codex_calls_per_milestone=int(budgets["maxCodexCallsPerMilestone"]),
            max_task_wall_clock_seconds=int(budgets["maxTaskWallClockSeconds"]),
            max_milestone_wall_clock_seconds=int(budgets["maxMilestoneWallClockSeconds"]),
            disk_min_free_gib=float(resources["diskMinFreeGiB"]),
            memory_min_free_mib=int(resources["memoryMinFreeMiB"]),
            max_worktrees=int(resources["maxWorktrees"]),
            required_checks=tuple(str(item) for item in integration["requiredChecks"]),
            protected_paths=tuple(str(item) for item in integration["protectedPaths"]),
            trusted_actors=tuple(str(item) for item in integration["trustedActors"]),
            state_dir=_resolve(root, os.environ.get("CHAINSIEVE_FACTORY_STATE_DIR", raw.get("stateDirectory", ".factory"))),
            plan_path=_resolve(root, os.environ.get("CHAINSIEVE_FACTORY_PLAN", raw.get("planPath", "specs/factory/current-milestone.json"))),
            poll_seconds=int(raw.get("pollSeconds", 30)),
            notification_command=tuple(str(item) for item in raw.get("notificationCommand", [])),
            codex_model=str(models["codex"]["model"]),
            codex_reasoning_effort=str(models["codex"]["reasoningEffort"]),
            agy_model=str(models["agy"]["model"]),
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
            "max_convergence_passes",
            "max_codex_calls_per_milestone",
        ):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative")
        if not self.required_checks:
            raise ValueError("at least one required CI check is required")
        if not self.trusted_actors:
            raise ValueError("trustedActors cannot be empty")
        if self.max_task_wall_clock_seconds <= 0 or self.max_milestone_wall_clock_seconds <= 0:
            raise ValueError("task and milestone wall-clock budgets must be positive")
        if self.disk_min_free_gib < 0 or self.memory_min_free_mib < 0 or self.max_worktrees < 1:
            raise ValueError("resource gates must be non-negative and maxWorktrees positive")

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
