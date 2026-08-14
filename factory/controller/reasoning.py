from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from typing import Any

from .commands import CommandRunner
from .config import FactoryConfig
from .models import Milestone, WorkPackage
from .store import StateStore


MUSE_ENV = ("META_API_KEY", "MUSE_AUTH_PATH", "XDG_CONFIG_HOME")
CODEX_ENV = ("OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_HOME")


class ReasoningRunner:
    def __init__(self, root: Path, config: FactoryConfig, store: StateStore, runner: CommandRunner) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.runner = runner

    def converge(self, milestone: Milestone) -> dict[str, Any]:
        prompt = (self.root / "factory" / "prompts" / "convergence.md").read_text(encoding="utf-8")
        prompt += f"""

Current milestone: {milestone.id}
Committed Spec Kit artifacts: {self.root / 'specs'}
Runtime rolling Spec Kit artifacts: {self.config.state_dir / 'planning' / milestone.id}
Current work-package plan: {self.config.state_dir / 'active-milestone.json'} (when present), otherwise {self.config.plan_path}

Return one JSON object only with `status` equal to `CONVERGED` or `GAPS`, and `gaps` containing zero to eight complete
work-package objects matching factory/schemas/work-package.schema.json. Every gap ID must be deterministic and not reuse
an existing ID. Do not modify files.
"""
        result = self.runner.run(
            [
                "muse", "exec", "--trust-workspace", "--disable-approval", "--disable-write", "--disable-shell",
                "--user-input-auto-resolve", "--json", "--max-model-steps", "60", prompt,
            ],
            allowed_env=MUSE_ENV,
            additions={"MUSE_NO_AUTO_UPDATE": "1"},
            timeout=self.config.max_task_wall_clock_seconds,
        )
        text = _muse_final_text(result.stdout)
        value = _extract_json(text)
        if value.get("status") not in {"CONVERGED", "GAPS"}:
            raise RuntimeError("invalid convergence status")
        gaps = [WorkPackage.from_dict(item) for item in value.get("gaps", [])]
        existing = {item.id for item in milestone.packages}
        duplicate = existing & {item.id for item in gaps}
        if duplicate:
            raise RuntimeError(f"convergence returned duplicate IDs: {sorted(duplicate)}")
        if value["status"] == "CONVERGED" and gaps:
            raise RuntimeError("CONVERGED result contains gaps")
        if value["status"] == "GAPS" and not gaps:
            raise RuntimeError("GAPS result contains no work packages")
        value["gaps"] = [_package_dict(item) for item in gaps]
        return value

    def final_audit(self, output_path: Path) -> dict[str, Any]:
        milestone = self.config.load_milestone()
        prompt = (self.root / "factory" / "prompts" / "final-audit.md").read_text(encoding="utf-8")
        schema = self.root / "factory" / "schemas" / "final-audit.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._invoke_codex("final_audit", milestone.id, prompt, schema, output_path)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def plan_milestone(self, current: Milestone, target: dict[str, Any]) -> dict[str, Any]:
        active_path = self.config.state_dir / "active-milestone.json"
        if active_path.exists():
            existing = json.loads(active_path.read_text(encoding="utf-8"))
            if existing.get("id") == target["id"]:
                Milestone.from_dict(existing)
                return existing
        prompt = (self.root / "factory" / "prompts" / "planner.md").read_text(encoding="utf-8")
        prompt += f"""

The completed and converged milestone is `{current.id}`.
Plan exactly the next roadmap milestone:
  id: `{target['id']}`
  objective: {target['objective']}

Return only a milestone-plan JSON object. Use exact normative requirement IDs found in committed authority. Do not plan any
later milestone, edit files, or include work that belongs to the autonomous factory migration itself.
"""
        output_path = self.config.state_dir / "next-milestone.json"
        schema = self.root / "factory" / "schemas" / "milestone-plan.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._invoke_codex("planner", current.id, prompt, schema, output_path)
        value = json.loads(output_path.read_text(encoding="utf-8"))
        planned = Milestone.from_dict(value)
        if planned.id != target["id"]:
            raise RuntimeError(f"planner returned {planned.id!r}, expected {target['id']!r}")
        _validate_requirement_ids(self.root, planned)
        temporary = active_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.chmod(0o640)
        temporary.replace(active_path)
        _write_planning_bundle(self.config.state_dir, planned)
        return value

    def replan(self, milestone: Milestone, failed: WorkPackage, evidence: str) -> dict[str, Any]:
        prompt = f"""You are the bounded ChainSieve deadlock replanner.

Milestone `{milestone.id}` has exhausted safe implementation-provider handling for work package `{failed.id}`.
Evidence: {evidence}

Return a schema-valid result. Use ARCHITECTURE_CONTRADICTION only for a genuine contradiction in authoritative product
requirements that cannot be resolved by decomposition. Otherwise return REPLANNED with a complete deterministic plan for
the same milestone. Do not reuse failed package ID `{failed.id}`. Do not authorize immutable control-plane paths. Do not
modify files.
"""
        return self._escalation_plan("replan", milestone, failed, prompt)

    def emergency(self, milestone: Milestone, failed: WorkPackage, contradiction: str) -> dict[str, Any]:
        prompt = f"""Resolve this exceptional architecture contradiction for ChainSieve milestone `{milestone.id}`:
{contradiction}

Return REPLANNED with a complete deterministic plan for the same milestone, or ARCHITECTURE_CONTRADICTION if authoritative
requirements remain irreconcilable. Do not reuse failed package ID `{failed.id}`. Never weaken product authority or
authorize immutable factory/control-plane paths. Do not modify files.
"""
        return self._escalation_plan("emergency", milestone, failed, prompt)

    def _escalation_plan(
        self, role: str, milestone: Milestone, failed: WorkPackage, prompt: str
    ) -> dict[str, Any]:
        output_path = self.config.state_dir / f"{role}-plan.json"
        schema = self.root / "factory" / "schemas" / "replan.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._invoke_codex(role, milestone.id, prompt, schema, output_path)
        value = json.loads(output_path.read_text(encoding="utf-8"))
        if value.get("status") == "ARCHITECTURE_CONTRADICTION":
            return value
        if value.get("status") != "REPLANNED" or not isinstance(value.get("plan"), dict):
            raise RuntimeError(f"Codex {role} returned no deterministic plan")
        planned = Milestone.from_dict(value["plan"])
        if planned.id != milestone.id:
            raise RuntimeError(f"Codex {role} changed milestone identity")
        if failed.id in {item.id for item in planned.packages}:
            raise RuntimeError(f"Codex {role} reused exhausted work-package ID {failed.id!r}")
        _validate_requirement_ids(self.root, planned)
        active_path = self.config.state_dir / "active-milestone.json"
        temporary = active_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(value["plan"], indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.chmod(0o640)
        temporary.replace(active_path)
        _write_planning_bundle(self.config.state_dir, planned)
        return value

    def _codex_budget(self, milestone_id: str, role: str) -> tuple[dict[str, Any], int]:
        usage = self._usage()
        milestone_usage = usage.setdefault("milestones", {}).setdefault(milestone_id, {})
        by_role = milestone_usage.setdefault("codexCallsByRole", {})
        return usage, int(by_role.get(role, 0))

    def _record_codex_call(self, usage: dict[str, Any], milestone_id: str, role: str, calls: int) -> None:
        milestone = usage.setdefault("milestones", {}).setdefault(milestone_id, {})
        milestone.setdefault("codexCallsByRole", {})[role] = calls
        totals = {
            name: sum(
                int(value.get("codexCallsByRole", {}).get(name, 0))
                for value in usage["milestones"].values()
            )
            for name in self.config.codex_routes
        }
        usage["codexCallsByRole"] = totals
        usage["codexCalls"] = sum(totals.values())

    def _invoke_codex(
        self,
        role: str,
        milestone_id: str,
        prompt: str,
        schema: Path,
        output_path: Path,
    ) -> None:
        route = self.config.codex_routes[role]
        usage, calls = self._codex_budget(milestone_id, role)
        if calls >= route.max_calls_per_milestone:
            raise RuntimeError(f"Codex {role} call budget exhausted")
        self._record_codex_call(usage, milestone_id, role, calls + 1)
        self._save_usage(usage)
        self.store.event(
            "CODEX_CALL_STARTED",
            milestoneId=milestone_id,
            role=role,
            model=route.model,
            reasoningEffort=route.reasoning_effort,
            attempt=calls + 1,
        )
        self.runner.run(
            [
                "codex", "--ask-for-approval", "never", "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
                "--model", route.model,
                "-c", f'model_reasoning_effort="{route.reasoning_effort}"',
                "--output-schema", str(schema), "--output-last-message", str(output_path), "-",
            ],
            allowed_env=CODEX_ENV,
            input_text=prompt,
            timeout=self.config.max_task_wall_clock_seconds,
        )

    def _usage(self) -> dict[str, Any]:
        path = self.config.state_dir / "usage.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def _save_usage(self, value: dict[str, Any]) -> None:
        path = self.config.state_dir / "usage.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_remediation(config: FactoryConfig, milestone: Milestone, gaps: list[dict[str, Any]]) -> None:
    path = config.state_dir / "remediation-plan.json"
    existing: list[dict[str, Any]] = []
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        if raw.get("milestoneId") == milestone.id:
            existing = list(raw.get("workPackages", []))
    by_id = {item["id"]: item for item in existing}
    for item in gaps:
        by_id.setdefault(item["id"], item)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schemaVersion": 1, "milestoneId": milestone.id, "workPackages": list(by_id.values())}, indent=2) + "\n",
        encoding="utf-8",
    )


def audit_remediation(milestone: Milestone, audit: dict[str, Any]) -> dict[str, Any]:
    categories = (
        "blocking_gaps", "requirements_missing", "architecture_conflicts", "test_gaps",
        "runtime_failures", "security_gaps", "operational_gaps",
    )
    findings = [f"{category}: {item}" for category in categories for item in audit.get(category, [])]
    if not findings:
        raise RuntimeError("NOT_CONVERGED final audit contains no remediation findings")
    digest = hashlib.sha256(json.dumps(audit, sort_keys=True).encode()).hexdigest()[:10]
    return {
        "id": f"final-audit-remediation-{digest}",
        "objective": "Resolve every blocking gap from the independent final docs-to-product audit.",
        "acceptance": findings,
        "dependencies": [item.id for item in milestone.packages],
        "parallelizable": False,
        "preferredProvider": "muse",
        "risk": "CRITICAL",
        "requirementIds": [],
        "authorizedProtectedPaths": [],
    }


def _muse_final_text(output: str) -> str:
    final = ""
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get("payload_type") == "run.terminal.completed":
            final = str(value.get("payload", {}).get("text", ""))
    if not final:
        raise RuntimeError("Muse did not emit a completed final response")
    return final


def _extract_json(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("model response contains no JSON object")
    return json.loads(text[start : end + 1])


def _package_dict(package: WorkPackage) -> dict[str, Any]:
    return {
        "id": package.id,
        "objective": package.objective,
        "acceptance": list(package.acceptance),
        "dependencies": list(package.dependencies),
        "parallelizable": package.parallelizable,
        "preferredProvider": package.preferred_provider,
        "risk": package.risk,
        "requirementIds": list(package.requirement_ids),
        "authorizedProtectedPaths": list(package.authorized_protected_paths),
    }


def _validate_requirement_ids(root: Path, milestone: Milestone) -> None:
    authoritative = authoritative_requirement_ids(root)
    unknown = sorted({rid for package in milestone.packages for rid in package.requirement_ids if rid not in authoritative})
    if unknown:
        raise RuntimeError(f"planner returned unknown normative requirement IDs: {unknown}")


NORMATIVE_ID = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3,4}$")


def authoritative_requirement_ids(root: Path) -> frozenset[str]:
    identifiers: set[str] = set()
    manifests = list(sorted((root / "docs" / "spec").glob("*.requirements.json")))
    artifact_directory = root / "artifacts" / "spec"
    if artifact_directory.exists():
        manifests.extend(sorted(artifact_directory.glob("*.requirements.json")))
    for path in manifests:
        value = json.loads(path.read_text(encoding="utf-8"))
        for family in ("requirements", "acceptanceCriteria", "invariants", "adrs"):
            for item in value.get(family, []):
                identifier = item.get("id") if isinstance(item, dict) else None
                if isinstance(identifier, str) and NORMATIVE_ID.fullmatch(identifier):
                    identifiers.add(identifier)
    if not identifiers:
        raise RuntimeError("authoritative requirement manifests contain no normative IDs")
    return frozenset(identifiers)


def _write_planning_bundle(state_dir: Path, milestone: Milestone) -> None:
    directory = state_dir / "planning" / milestone.id
    directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    requirements = sorted({item for package in milestone.packages for item in package.requirement_ids})
    spec = [
        f"# {milestone.id} specification",
        "",
        "Generated from the committed rolling roadmap by the schema-constrained scarce planner.",
        "The authoritative PRD and normative indexes remain superior authority.",
        "",
        "## Objective",
        "",
        milestone.objective,
        "",
        "## Normative requirement IDs",
        "",
        *(f"- `{item}`" for item in requirements),
    ]
    plan = [f"# {milestone.id} plan", "", "## Outcome DAG", ""]
    tasks = [f"# {milestone.id} tasks", ""]
    for package in milestone.packages:
        dependencies = ", ".join(package.dependencies) or "none"
        plan.extend([
            f"- `{package.id}` ({package.preferred_provider}, {package.risk}; dependencies: {dependencies}) — {package.objective}",
        ])
        tasks.append(f"- [ ] `{package.id}` — {package.objective}")
        tasks.extend(f"  - [ ] {criterion}" for criterion in package.acceptance)
    for name, lines in (("spec.md", spec), ("plan.md", plan), ("tasks.md", tasks)):
        path = directory / name
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        path.chmod(0o640)
