from __future__ import annotations

import json
import hashlib
import re
import time
from pathlib import Path
from typing import Any

from .commands import CommandResult, CommandRunner
from .config import FactoryConfig
from .models import Milestone, WorkPackage
from .store import StateStore


MUSE_ENV: tuple[str, ...] = ()
CODEX_ENV: tuple[str, ...] = ()
TRANSIENT_RETRIES = 2


class ReasoningRunner:
    def __init__(self, root: Path, config: FactoryConfig, store: StateStore, runner: CommandRunner) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.runner = runner

    def converge(self, milestone: Milestone) -> dict[str, Any]:
        output_path = self.config.state_dir / "convergence-result.json"
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
        schema = self.root / "factory" / "schemas" / "convergence.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._invoke_codex("convergence", milestone.id, prompt, schema, output_path)
        value = json.loads(output_path.read_text(encoding="utf-8"))
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
        self.store.set_reasoning_operation(role=role, provider="codex", milestone_id=milestone_id)
        try:
            self._do_invoke_codex(role, milestone_id, prompt, schema, output_path)
        finally:
            self.store.set_reasoning_operation(role=None)

    def _do_invoke_codex(
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
        operational = usage.setdefault("reasoningOperations", {})
        operational["preferredProvider"] = "codex"
        self.store.event(
            "CODEX_CALL_STARTED",
            milestoneId=milestone_id,
            role=role,
            requestedPreference=route.model,
            modelMode=route.model_mode,
            reasoningEffort=route.reasoning_effort,
            attempt=calls + 1,
        )
        now = int(time.time())
        unavailable_until = int(operational.get("codexUnavailableUntilEpoch", 0) or 0)
        if unavailable_until > now:
            self.store.event(
                "CODEX_PROVIDER_UNAVAILABLE", milestoneId=milestone_id, role=role,
                reason="provider cooldown active", retryAfterEpoch=unavailable_until,
            )
            self._save_usage(usage)
            self._invoke_muse_fallback(role, milestone_id, prompt, schema, output_path, usage)
            return

        explicit_model = route.explicit_model
        transient_attempts = 0
        while True:
            operational["codexAttempts"] = int(operational.get("codexAttempts", 0)) + 1
            self._save_usage(usage)
            result = self._run_codex_attempt(route.reasoning_effort, explicit_model, prompt, schema, output_path)
            if result is None or result.returncode == 0:
                operational["actualLastReasoningProvider"] = "codex"
                operational["codexAvailable"] = True
                operational["codexUnavailableUntilEpoch"] = 0
                self._save_usage(usage)
                return
            category = _codex_failure_category(result)
            reason = _result_detail(result)
            if category == "model" and explicit_model:
                operational["codexDefaultModelRetries"] = int(operational.get("codexDefaultModelRetries", 0)) + 1
                self.store.event(
                    "CODEX_DEFAULT_MODEL_RETRY", milestoneId=milestone_id, role=role,
                    requestedPreference=route.model, reason=reason,
                )
                explicit_model = None
                continue
            if category == "transient" and transient_attempts < TRANSIENT_RETRIES:
                transient_attempts += 1
                self.store.event(
                    "CODEX_TRANSIENT_RETRY", milestoneId=milestone_id, role=role,
                    attempt=transient_attempts, reason=reason,
                )
                time.sleep(min(2 ** (transient_attempts - 1), 4))
                continue
            cooldown = 0 if category == "injected" else self.config.provider_cooldown_seconds
            operational["codexAvailable"] = False
            operational["codexUnavailableUntilEpoch"] = int(time.time()) + cooldown
            self.store.event(
                "CODEX_PROVIDER_UNAVAILABLE", milestoneId=milestone_id, role=role,
                reason=reason, failureClass=category, retryAfterSeconds=cooldown,
            )
            self._save_usage(usage)
            self._invoke_muse_fallback(role, milestone_id, prompt, schema, output_path, usage)
            return

    def _run_codex_attempt(
        self,
        reasoning_effort: str,
        explicit_model: str | None,
        prompt: str,
        schema: Path,
        output_path: Path,
    ) -> CommandResult | None:
        source_env = getattr(self.runner, "source_env", {})
        injection = source_env.get("CHAINSIEVE_CANARY_CODEX_FAILURE_ONCE") == "1"
        marker = self.config.state_dir / ".codex-canary-failure-consumed"
        if injection and not marker.exists():
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("injected\n", encoding="utf-8")
            return CommandResult(("codex", "exec"), "", "canary injected CODEX_PROVIDER_UNAVAILABLE", 77)
        output_path.unlink(missing_ok=True)
        argv = [
            "codex", "--ask-for-approval", "never", "exec", "--ephemeral", "--sandbox", "read-only",
        ]
        if explicit_model:
            argv.extend(("--model", explicit_model))
        argv.extend((
            "-c", f'model_reasoning_effort="{reasoning_effort}"',
            "--output-schema", str(schema), "--output-last-message", str(output_path), "-",
        ))
        return self.runner.run(
            argv,
            allowed_env=CODEX_ENV,
            input_text=prompt,
            timeout=self.config.reasoning_timeout_seconds,
            check=False,
        )

    def _invoke_muse_fallback(
        self,
        role: str,
        milestone_id: str,
        prompt: str,
        schema: Path,
        output_path: Path,
        usage: dict[str, Any],
    ) -> None:
        self.store.set_reasoning_operation(role=role, provider="muse", milestone_id=milestone_id)
        try:
            self._do_invoke_muse_fallback(role, milestone_id, prompt, schema, output_path, usage)
        finally:
            self.store.set_reasoning_operation(role=None)

    def _do_invoke_muse_fallback(
        self,
        role: str,
        milestone_id: str,
        prompt: str,
        schema: Path,
        output_path: Path,
        usage: dict[str, Any],
    ) -> None:
        operational = usage.setdefault("reasoningOperations", {})
        operational["museFallbackAttempts"] = int(operational.get("museFallbackAttempts", 0)) + 1
        self.store.event(
            "CODEX_FALLBACK_STARTED", milestoneId=milestone_id, role=role, provider="muse",
            requestedPreference=self.config.muse_model,
            modelMode="explicit" if self.config.muse_explicit_model else "cli-default",
        )
        schema_text = schema.read_text(encoding="utf-8")
        fallback_prompt = (
            f"{prompt}\n\nYou are a one-shot read-only fallback for the `{role}` logical reasoning call. "
            "Do not modify files, run implementation work, commit, push, open a PR, or merge. "
            "Return exactly one JSON object matching this schema:\n"
            f"{schema_text}"
        )
        argv = ["muse", "exec"]
        if self.config.muse_explicit_model:
            argv.extend(("--model", self.config.muse_explicit_model))
        argv.extend((
            "--trust-workspace", "--disable-approval", "--disable-write", "--disable-shell",
            "--user-input-auto-resolve", "--json", "--max-model-steps", "10", fallback_prompt,
        ))
        result = self.runner.run(
            argv,
            allowed_env=MUSE_ENV,
            additions={"MUSE_NO_AUTO_UPDATE": "1"},
            timeout=self.config.reasoning_timeout_seconds,
            check=False,
        )
        if result is not None and result.returncode == 0:
            try:
                value = _extract_json(_muse_final_text(result.stdout))
                _validate_json_schema(value, json.loads(schema_text))
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            except Exception as error:
                result = CommandResult(result.argv, result.stdout, f"fallback schema failure: {error}", 65)
        if result is None or result.returncode == 0:
            operational["museFallbackSuccesses"] = int(operational.get("museFallbackSuccesses", 0)) + 1
            operational["actualLastReasoningProvider"] = "muse"
            self._save_usage(usage)
            self.store.event("CODEX_FALLBACK_SUCCEEDED", milestoneId=milestone_id, role=role, provider="muse")
            return
        reason = _result_detail(result)
        operational["actualLastReasoningProvider"] = "none"
        operational["lastFallbackFailure"] = reason
        self._save_usage(usage)
        self.store.event("CODEX_FALLBACK_FAILED", milestoneId=milestone_id, role=role, provider="muse", reason=reason)
        raise RuntimeError(f"Codex unavailable and one-shot Muse fallback failed: {reason}")

    def _usage(self) -> dict[str, Any]:
        path = self.config.state_dir / "usage.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def _save_usage(self, value: dict[str, Any]) -> None:
        path = self.config.state_dir / "usage.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _result_detail(result: CommandResult) -> str:
    return (result.stderr or result.stdout or f"exit {result.returncode}").strip()[-2000:]


def _codex_failure_category(result: CommandResult) -> str:
    detail = _result_detail(result).lower()
    if "canary injected" in detail:
        return "injected"
    if any(marker in detail for marker in (
        "model not found", "model is not available", "unsupported model", "unknown model",
        "does not have access to model", "invalid model",
    )):
        return "model"
    if any(marker in detail for marker in (
        "authentication", "not logged in", "login required", "session expired", "unauthorized",
        "invalid credential", "invalid token", "entitlement", "quota", "usage limit", "insufficient_quota",
    )):
        return "provider"
    if any(marker in detail for marker in (
        "temporary failure", "temporarily unavailable", "timed out", "timeout", "connection reset",
        "connection refused", "dns", "name resolution", "rate limit", "429", "500", "502", "503", "504",
    )):
        return "transient"
    return "provider"


def _validate_json_schema(
    value: Any, schema: dict[str, Any], path: str = "$", root_schema: dict[str, Any] | None = None
) -> None:
    root_schema = root_schema or schema
    reference = schema.get("$ref")
    if isinstance(reference, str):
        if not reference.startswith("#/"):
            raise RuntimeError(f"{path} uses unsupported external schema reference")
        target: Any = root_schema
        for token in reference[2:].split("/"):
            target = target[token.replace("~1", "/").replace("~0", "~")]
        _validate_json_schema(value, target, path, root_schema)
        return
    for keyword, minimum in (("minLength", len(value) if isinstance(value, str) else None), ("minItems", len(value) if isinstance(value, list) else None)):
        if keyword in schema and minimum is not None and minimum < int(schema[keyword]):
            raise RuntimeError(f"{path} violates {keyword}")
    if isinstance(value, list) and "maxItems" in schema and len(value) > int(schema["maxItems"]):
        raise RuntimeError(f"{path} violates maxItems")
    if isinstance(value, list) and schema.get("uniqueItems") is True:
        canonical = [json.dumps(item, sort_keys=True) for item in value]
        if len(canonical) != len(set(canonical)):
            raise RuntimeError(f"{path} contains duplicate items")
    if isinstance(value, str) and isinstance(schema.get("pattern"), str) and not re.search(schema["pattern"], value):
        raise RuntimeError(f"{path} does not match the required pattern")
    for keyword in ("oneOf", "anyOf"):
        options = schema.get(keyword)
        if isinstance(options, list):
            matches = 0
            for option in options:
                try:
                    _validate_json_schema(value, option, path, root_schema)
                except RuntimeError:
                    continue
                matches += 1
            required = 1 if keyword == "oneOf" else 0
            if (keyword == "oneOf" and matches != required) or (keyword == "anyOf" and matches < 1):
                raise RuntimeError(f"{path} violates {keyword}")
    if isinstance(schema.get("allOf"), list):
        for option in schema["allOf"]:
            _validate_json_schema(value, option, path, root_schema)
    expected = schema.get("type")
    checks = {
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
        "string": lambda item: isinstance(item, str),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }
    expected_types = [expected] if isinstance(expected, str) else expected if isinstance(expected, list) else []
    if expected_types and not any(item in checks and checks[item](value) for item in expected_types):
        raise RuntimeError(f"{path} must be one of {expected_types}")
    if "enum" in schema and value not in schema["enum"]:
        raise RuntimeError(f"{path} is not an allowed enum value")
    if "const" in schema and value != schema["const"]:
        raise RuntimeError(f"{path} does not match the required constant")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise RuntimeError(f"{path} is missing required property {key!r}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                _validate_json_schema(item, properties[key], f"{path}.{key}", root_schema)
            elif schema.get("additionalProperties") is False:
                raise RuntimeError(f"{path} contains unexpected property {key!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                _validate_json_schema(item, schema["additionalProperties"], f"{path}.{key}", root_schema)
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            _validate_json_schema(item, schema["items"], f"{path}[{index}]", root_schema)


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
