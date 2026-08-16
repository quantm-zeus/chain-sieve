from __future__ import annotations

import json
import hashlib
import os
import re
import time
from pathlib import Path
from typing import Any

from .commands import CommandResult, CommandRunner
from .config import FactoryConfig
from .models import Milestone, PackageRecord, PackageStatus, WorkPackage, work_key
from .store import StateStore


MUSE_ENV: tuple[str, ...] = ()
CODEX_ENV: tuple[str, ...] = ()
TRANSIENT_RETRIES = 2

NORMATIVE_ID = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3,4}$")

FORBIDDEN_OBJECTIVE_PATTERNS = (
    re.compile(r"\bread[- ]access\b", re.IGNORECASE),
    re.compile(r"\brestore\b.*\baccess\b", re.IGNORECASE),
    re.compile(r"\b(?:cannot|unable to|failed to)\s+(?:read|access|find)\b", re.IGNORECASE),
    re.compile(r"\baudit\b.*\b(?:sources?|constitution|infrastructure|artifacts?|files?)\b", re.IGNORECASE),
    re.compile(r"\bperform\b.*\b(?:convergence\s+audit|audit)\b", re.IGNORECASE),
    re.compile(r"\baudit\s+the\s+audit\b", re.IGNORECASE),
    re.compile(r"\bfactory\b.*\b(?:infrastructure|migration|repair|control|controller)\b", re.IGNORECASE),
    re.compile(r"\bcontrol[- ]plane\b", re.IGNORECASE),
    re.compile(r"\bsandbox\b", re.IGNORECASE),
    re.compile(r"\breasoning\b.*\b(?:model|plumbing|wrapper|schema|transport)\b", re.IGNORECASE),
    re.compile(r"\breasoner\b", re.IGNORECASE),
    re.compile(r"\bprovider\b.*\b(?:auth|credential|login|token|access)\b", re.IGNORECASE),
    re.compile(r"\bremediation\s+package\b", re.IGNORECASE),
    re.compile(r"\bduplicate\b.*\b(?:package|id)\b", re.IGNORECASE),
    re.compile(r"\btooling\b.*\b(?:failure|error|access|read)\b", re.IGNORECASE),
    re.compile(r"\b(?:runtime\s+planning|planning\s+directory)\b", re.IGNORECASE),
)


class ReasoningInfrastructureError(RuntimeError):
    """Base exception for reasoning/control-plane infrastructure problems."""
    pass


class ReasoningContextUnavailableError(ReasoningInfrastructureError):
    """Raised when a required convergence/reasoning context source cannot be read."""
    pass


class ConvergenceOutputRejectedError(RuntimeError):
    """Raised when convergence output fails deterministic PRODUCT_GAP acceptance validation."""
    def __init__(self, message: str, failure_class: str = "INVALID_PRODUCT_GAP", gap_id: str | None = None) -> None:
        super().__init__(message)
        self.failure_class = failure_class
        self.gap_id = gap_id


def authoritative_requirement_definitions(root: Path) -> dict[str, dict[str, Any]]:
    definitions: dict[str, dict[str, Any]] = {}
    spec_dir = root / "docs" / "spec"
    if not spec_dir.exists():
        raise ReasoningContextUnavailableError(f"spec directory missing at {spec_dir}")
    manifests = list(sorted(spec_dir.glob("*.requirements.json")))
    if not manifests:
        raise ReasoningContextUnavailableError(f"no requirement manifests found in {spec_dir}")
    artifact_directory = root / "artifacts" / "spec"
    if artifact_directory.exists():
        manifests.extend(sorted(artifact_directory.glob("*.requirements.json")))
    for path in manifests:
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as error:
            raise ReasoningContextUnavailableError(f"unable to read requirement manifest {path}: {error}")
        try:
            value = json.loads(content)
        except Exception as error:
            raise ReasoningContextUnavailableError(f"unable to parse requirement manifest {path} as JSON: {error}")
        if not isinstance(value, dict):
            raise ReasoningContextUnavailableError(f"requirement manifest {path} is not a JSON object")
        for family in ("requirements", "acceptanceCriteria", "invariants", "adrs"):
            for item in value.get(family, []):
                if isinstance(item, dict) and item.get("id"):
                    identifier = item["id"]
                    if isinstance(identifier, str) and NORMATIVE_ID.fullmatch(identifier):
                        definitions[identifier] = item
    if not definitions:
        raise ReasoningContextUnavailableError("authoritative requirement manifests contain no normative definitions")
    return definitions


def authoritative_requirement_ids(root: Path) -> frozenset[str]:
    identifiers: set[str] = set()
    spec_dir = root / "docs" / "spec"
    if not spec_dir.exists():
        raise ReasoningContextUnavailableError(f"spec directory missing at {spec_dir}")
    manifests = list(sorted(spec_dir.glob("*.requirements.json")))
    if not manifests:
        raise ReasoningContextUnavailableError(f"no requirement manifests found in {spec_dir}")
    artifact_directory = root / "artifacts" / "spec"
    if artifact_directory.exists():
        manifests.extend(sorted(artifact_directory.glob("*.requirements.json")))
    for path in manifests:
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as error:
            raise ReasoningContextUnavailableError(f"unable to read requirement manifest {path}: {error}")
        try:
            value = json.loads(content)
        except Exception as error:
            raise ReasoningContextUnavailableError(f"unable to parse requirement manifest {path} as JSON: {error}")
        if not isinstance(value, dict):
            raise ReasoningContextUnavailableError(f"requirement manifest {path} is not a JSON object")
        for family in ("requirements", "acceptanceCriteria", "invariants", "adrs"):
            for item in value.get(family, []):
                identifier = item.get("id") if isinstance(item, dict) else None
                if isinstance(identifier, str) and NORMATIVE_ID.fullmatch(identifier):
                    identifiers.add(identifier)
    if not identifiers:
        raise ReasoningContextUnavailableError("authoritative requirement manifests contain no normative IDs")
    return frozenset(identifiers)


def build_reasoning_context(
    root: Path,
    config: FactoryConfig,
    milestone: Milestone,
    store: StateStore,
    runner: CommandRunner | None = None,
    role: str = "convergence",
) -> dict[str, Any]:
    sources_manifest: dict[str, str] = {}

    constitution = root / "factory" / "constitution.md"
    if not constitution.exists() or not constitution.is_file():
        reason = f"constitution missing or unreadable at {constitution}"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)
    try:
        constitution_bytes = constitution.read_bytes()
        constitution_text = constitution_bytes.decode("utf-8")
        sources_manifest["factory/constitution.md"] = hashlib.sha256(constitution_bytes).hexdigest()
    except Exception as error:
        reason = f"unable to read constitution: {error}"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)

    spec_dir = root / "docs" / "spec"
    if not spec_dir.exists() or not list(spec_dir.glob("*.requirements.json")):
        reason = f"authoritative requirement manifests missing or unreadable in {spec_dir}"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)

    for req_file in sorted(spec_dir.glob("*.requirements.json")):
        try:
            rel = str(req_file.relative_to(root))
            sources_manifest[rel] = hashlib.sha256(req_file.read_bytes()).hexdigest()
        except Exception as error:
            reason = f"unable to read requirement manifest {req_file}: {error}"
            store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
            raise ReasoningContextUnavailableError(reason)

    prd_doc = root / "docs" / "spec" / "crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md"
    if prd_doc.exists():
        try:
            sources_manifest["docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md"] = hashlib.sha256(prd_doc.read_bytes()).hexdigest()
        except Exception as error:
            reason = f"unable to read PRD document {prd_doc}: {error}"
            store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
            raise ReasoningContextUnavailableError(reason)

    try:
        authoritative_ids = authoritative_requirement_ids(root)
        authoritative_defs = authoritative_requirement_definitions(root)
    except Exception as error:
        reason = f"unable to load authoritative requirement IDs: {error}"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)

    # Ensure rolling Spec Kit planning bundle is present on disk
    try:
        _write_planning_bundle(config.state_dir, milestone)
    except Exception as error:
        reason = f"unable to write planning bundle to state dir: {error}"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)

    planning_dir = config.state_dir / "planning" / milestone.id
    planning_bundle_texts: dict[str, str] = {}
    for name in ("spec.md", "plan.md", "tasks.md"):
        bundle_file = planning_dir / name
        if not bundle_file.exists() or not os.access(bundle_file, os.R_OK):
            reason = f"planning bundle artifact missing or unreadable: {bundle_file}"
            store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
            raise ReasoningContextUnavailableError(reason)
        try:
            bundle_bytes = bundle_file.read_bytes()
            planning_bundle_texts[name.removesuffix(".md")] = bundle_bytes.decode("utf-8")
            rel_bundle = str(bundle_file.relative_to(config.state_dir))
            sources_manifest[f".factory/{rel_bundle}"] = hashlib.sha256(bundle_bytes).hexdigest()
        except Exception as error:
            reason = f"unable to read planning bundle {bundle_file}: {error}"
            store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
            raise ReasoningContextUnavailableError(reason)

    head_sha: str | None = None
    try:
        if runner is not None:
            res = runner.run(["git", "rev-parse", "HEAD"], check=False)
            if res.returncode == 0:
                candidate = (res.stdout or "").strip()
                if len(candidate) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", candidate) and candidate != "0" * 40:
                    head_sha = candidate.lower()
        else:
            import subprocess
            res = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=False)
            if res.returncode == 0:
                candidate = (res.stdout or "").strip()
                if len(candidate) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", candidate) and candidate != "0" * 40:
                    head_sha = candidate.lower()
    except Exception:
        pass

    if not head_sha:
        reason = "unable to resolve valid git HEAD commit SHA"
        store.event("REASONING_CONTEXT_UNAVAILABLE", milestoneId=milestone.id, role=role, reason=reason)
        raise ReasoningContextUnavailableError(reason)

    raw_package_reqs: list[str] = [rid for pkg in milestone.packages for rid in pkg.requirement_ids]
    if milestone.packages:
        for rid in raw_package_reqs:
            if not isinstance(rid, str) or not NORMATIVE_ID.fullmatch(rid):
                reason = f"active milestone {milestone.id} contains malformed requirement ID: {rid!r}"
                store.event(
                    "REASONING_CONTEXT_UNAVAILABLE",
                    milestoneId=milestone.id,
                    role=role,
                    reason=reason,
                    failureClass="MALFORMED_REQUIREMENT_ID",
                    requirementId=str(rid),
                )
                raise ReasoningContextUnavailableError(reason)
            if rid not in authoritative_ids:
                reason = f"active milestone {milestone.id} contains unknown requirement ID not in committed authority: {rid}"
                store.event(
                    "REASONING_CONTEXT_UNAVAILABLE",
                    milestoneId=milestone.id,
                    role=role,
                    reason=reason,
                    failureClass="UNKNOWN_REQUIREMENT_ID",
                    requirementId=rid,
                )
                raise ReasoningContextUnavailableError(reason)
            if rid not in authoritative_defs:
                reason = f"active milestone {milestone.id} requirement ID {rid} has no semantic definition in manifests"
                store.event(
                    "REASONING_CONTEXT_UNAVAILABLE",
                    milestoneId=milestone.id,
                    role=role,
                    reason=reason,
                    failureClass="MISSING_REQUIREMENT_DEFINITION",
                    requirementId=rid,
                )
                raise ReasoningContextUnavailableError(reason)

        if len(raw_package_reqs) != len(set(raw_package_reqs)):
            seen = set()
            duplicates = []
            for rid in raw_package_reqs:
                if rid in seen and rid not in duplicates:
                    duplicates.append(rid)
                seen.add(rid)
            reason = f"active milestone {milestone.id} contains duplicate requirement IDs in packages: {duplicates}"
            store.event(
                "REASONING_CONTEXT_UNAVAILABLE",
                milestoneId=milestone.id,
                role=role,
                reason=reason,
                failureClass="DUPLICATE_REQUIREMENT_ID",
                requirementId=duplicates[0] if duplicates else "",
            )
            raise ReasoningContextUnavailableError(reason)

        milestone_reqs = sorted(raw_package_reqs)
        scoped_defs = [authoritative_defs[rid] for rid in milestone_reqs]
        if (
            set(raw_package_reqs) != set(milestone_reqs)
            or set(milestone_reqs) != {d.get("id") for d in scoped_defs}
            or len(milestone_reqs) != len(scoped_defs)
        ):
            reason = f"active milestone {milestone.id} requirement ID set mismatch: raw={set(raw_package_reqs)} scoped={set(milestone_reqs)} defs={{d.get('id') for d in scoped_defs}}"
            store.event(
                "REASONING_CONTEXT_UNAVAILABLE",
                milestoneId=milestone.id,
                role=role,
                reason=reason,
                failureClass="REQUIREMENT_SET_MISMATCH",
            )
            raise ReasoningContextUnavailableError(reason)
    else:
        milestone_reqs = []
        scoped_defs = []

    package_plan = [_package_dict(pkg) for pkg in milestone.packages]
    dependency_dag = {pkg.id: list(pkg.dependencies) for pkg in milestone.packages}

    requires_evidence = is_product_roadmap_milestone(root, milestone.id) and role in {"convergence", "final_audit"}

    try:
        all_records = store.load()
    except Exception as error:
        if requires_evidence:
            reason = f"unable to load durable execution state: {error}"
            store.event(
                "REASONING_CONTEXT_UNAVAILABLE",
                milestoneId=milestone.id,
                role=role,
                reason=reason,
                failureClass="EXECUTION_EVIDENCE_UNAVAILABLE",
            )
            raise ReasoningContextUnavailableError(reason)
        all_records = {}

    execution_evidence: list[dict[str, Any]] = []
    completed_records: dict[str, Any] = {}

    for pkg in milestone.packages:
        key = work_key(milestone.id, pkg.id)
        if key not in all_records:
            if requires_evidence:
                reason = f"missing durable package execution record for work key {key!r} (package {pkg.id!r})"
                store.event(
                    "REASONING_CONTEXT_UNAVAILABLE",
                    milestoneId=milestone.id,
                    role=role,
                    reason=reason,
                    failureClass="EXECUTION_EVIDENCE_UNAVAILABLE",
                    workKey=key,
                    packageId=pkg.id,
                )
                raise ReasoningContextUnavailableError(reason)
            rec = PackageRecord()
        else:
            rec = all_records[key]

        review_context_digest = None
        if rec.head_sha:
            review_file = config.state_dir / "reviews" / key / f"{rec.head_sha}.json"
            if review_file.exists():
                try:
                    rdata = json.loads(review_file.read_text(encoding="utf-8"))
                    review_context_digest = rdata.get("contextDigest")
                except Exception:
                    pass

        reviewer_provider = None
        if rec.provider in {"agy", "muse"}:
            reviewer_provider = "muse" if rec.provider == "agy" else "agy"

        pkg_ev = {
            "workKey": key,
            "packageId": pkg.id,
            "status": rec.status.value,
            "provider": rec.provider,
            "issueNumber": rec.issue_number,
            "prNumber": rec.pr_number,
            "prState": rec.pr_state,
            "headSha": rec.head_sha,
            "ciStatus": rec.ci_status,
            "reviewVerdict": rec.review_verdict,
            "reviewSha": rec.review_sha,
            "reviewerProvider": reviewer_provider,
            "reviewContextDigest": review_context_digest,
            "lastError": rec.last_error,
        }
        execution_evidence.append(pkg_ev)

        completed_records[key] = {
            "status": rec.status.value,
            "issue_number": rec.issue_number,
            "head_sha": rec.head_sha,
            "ci_status": rec.ci_status,
            "pr_number": rec.pr_number,
            "pr_state": rec.pr_state,
            "review_verdict": rec.review_verdict,
        }

    context_snapshot: dict[str, Any] = {
        "milestoneId": milestone.id,
        "milestoneObjective": milestone.objective,
        "headSha": head_sha,
        "role": role,
        "constitution": constitution_text,
        "scopedRequirementIds": milestone_reqs,
        "authoritativeRequirementCount": len(authoritative_ids),
        "scopedRequirementDefinitions": scoped_defs,
        "packagePlan": package_plan,
        "dependencyDag": dependency_dag,
        "executionEvidence": execution_evidence,
        "completedPackageRecords": completed_records,
        "planningBundle": planning_bundle_texts,
        "sources": sources_manifest,
    }

    canonical_repr = json.dumps(context_snapshot, sort_keys=True, separators=(",", ":"))
    context_digest = hashlib.sha256(canonical_repr.encode("utf-8")).hexdigest()
    context_snapshot["contextDigest"] = context_digest

    return context_snapshot



def preflight_convergence_context(
    root: Path,
    config: FactoryConfig,
    milestone: Milestone,
    store: StateStore,
    runner: CommandRunner | None = None,
) -> dict[str, Any]:
    return build_reasoning_context(root, config, milestone, store, runner=runner, role="convergence")


def validate_product_gaps(
    root: Path,
    milestone: Milestone,
    gaps: list[dict[str, Any]],
    completed_package_ids: set[str] | None = None,
) -> list[WorkPackage]:
    completed_ids = set(completed_package_ids or {pkg.id for pkg in milestone.packages})
    authoritative_ids = authoritative_requirement_ids(root)
    validated_packages: list[WorkPackage] = []
    seen_gap_ids: set[str] = set()

    for raw in gaps:
        gap_id = raw.get("id")
        if not gap_id or not isinstance(gap_id, str):
            raise ConvergenceOutputRejectedError("gap missing required string 'id'", failure_class="MALFORMED_OUTPUT")
        if not re.match(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", gap_id):
            raise ConvergenceOutputRejectedError(
                f"gap id {gap_id!r} is not a valid kebab-case identifier", failure_class="INVALID_ID_FORMAT", gap_id=gap_id
            )
        if gap_id in seen_gap_ids:
            raise ConvergenceOutputRejectedError(
                f"duplicate gap ID {gap_id!r} in convergence output", failure_class="DUPLICATE_GAP_ID", gap_id=gap_id
            )
        seen_gap_ids.add(gap_id)
        if gap_id in completed_ids:
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} duplicates already completed package", failure_class="DUPLICATE_COMPLETED_OUTCOME", gap_id=gap_id
            )

        classification = raw.get("classification", "PRODUCT_GAP")
        if classification != "PRODUCT_GAP":
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} has invalid classification {classification!r}; only PRODUCT_GAP is accepted",
                failure_class="INVALID_CLASSIFICATION",
                gap_id=gap_id,
            )

        objective = str(raw.get("objective", "")).strip()
        if not objective:
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} has empty objective", failure_class="EMPTY_OBJECTIVE", gap_id=gap_id
            )

        acceptance = raw.get("acceptance", [])
        if not isinstance(acceptance, list) or not acceptance:
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} has empty or non-list acceptance criteria", failure_class="EMPTY_ACCEPTANCE", gap_id=gap_id
            )

        all_text = [objective, *[str(c) for c in acceptance]]
        for pattern in FORBIDDEN_OBJECTIVE_PATTERNS:
            for text in all_text:
                if pattern.search(text):
                    raise ConvergenceOutputRejectedError(
                        f"gap {gap_id!r} contains forbidden tooling/infrastructure pattern {pattern.pattern!r} in: {text!r}",
                        failure_class="TOOLING_REMEDIATION_REJECTED",
                        gap_id=gap_id,
                    )

        req_ids = raw.get("requirementIds", [])
        if not isinstance(req_ids, list):
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} requirementIds must be a list", failure_class="MALFORMED_OUTPUT", gap_id=gap_id
            )

        if not req_ids:
            extracted = [
                token for text in all_text
                for token in re.findall(r"[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3,4}", text)
                if token in authoritative_ids
            ]
            if not extracted:
                raise ConvergenceOutputRejectedError(
                    f"gap {gap_id!r} has empty requirementIds and no validated authoritative invariant in objective/acceptance",
                    failure_class="MISSING_REQUIREMENT_EVIDENCE",
                    gap_id=gap_id,
                )
            raw["requirementIds"] = sorted(set(extracted))
        else:
            unknown = [rid for rid in req_ids if rid not in authoritative_ids]
            if unknown:
                raise ConvergenceOutputRejectedError(
                    f"gap {gap_id!r} contains unknown requirement IDs: {unknown}",
                    failure_class="UNKNOWN_REQUIREMENT_ID",
                    gap_id=gap_id,
                )

        protected = raw.get("authorizedProtectedPaths", [])
        if not isinstance(protected, list):
            raise ConvergenceOutputRejectedError(
                f"gap {gap_id!r} authorizedProtectedPaths must be a list", failure_class="MALFORMED_OUTPUT", gap_id=gap_id
            )
        for path_str in protected:
            if any(path_str.startswith(cp) for cp in ("factory/", ".agents/", ".github/", "tools/", "specs/factory/")):
                raise ConvergenceOutputRejectedError(
                    f"gap {gap_id!r} authorizes forbidden control-plane path: {path_str!r}",
                    failure_class="CONTROL_PLANE_PATH_REJECTED",
                    gap_id=gap_id,
                )

        validated_packages.append(WorkPackage.from_dict(raw))

    return validated_packages


def _format_reasoning_prompt(base_prompt: str, ctx: dict[str, Any], milestone: Milestone, role: str) -> str:
    completed_summary = "\n".join(
        f"- `{pkg.id}`: {pkg.objective} (Requirement IDs: {', '.join(pkg.requirement_ids) or 'none'})"
        for pkg in milestone.packages
    )
    scoped_reqs_str = ", ".join(ctx.get("scopedRequirementIds", [])) or "none"

    req_defs = ctx.get("scopedRequirementDefinitions", [])
    if req_defs:
        req_blocks = []
        for r in req_defs:
            title_or_desc = r.get("title") or r.get("description", "")
            block = f"#### {r.get('id')}: {title_or_desc}"
            if r.get("title") and r.get("description") and r.get("title") != r.get("description"):
                block += f"\nDescription: {r.get('description')}"
            if r.get("acceptanceCriteria"):
                block += "\nAcceptance Criteria:\n" + "\n".join(f"- {ac}" for ac in r.get("acceptanceCriteria", []))
            req_blocks.append(block)
        req_defs_str = "\n\n".join(req_blocks)
    else:
        req_defs_str = "None defined in manifests."

    ev_list = ctx.get("executionEvidence", [])
    if ev_list:
        ev_blocks = []
        for item in ev_list:
            issue_str = f"#{item['issueNumber']}" if item.get("issueNumber") else "none"
            pr_str = (
                f"#{item['prNumber']} (State: {item.get('prState') or 'none'}, Head SHA: {item.get('headSha') or 'none'})"
                if item.get("prNumber")
                else "none"
            )
            rev_str = (
                f"Verdict: {item.get('reviewVerdict') or 'none'}, "
                f"Reviewed Head SHA: {item.get('reviewSha') or 'none'}, "
                f"Reviewer Provider: {item.get('reviewerProvider') or 'none'}, "
                f"Context Digest: {item.get('reviewContextDigest') or 'none'}"
            )
            block = (
                f"- Package: `{item.get('packageId')}` (`{item.get('workKey')}`)\n"
                f"  - Status: `{item.get('status')}`\n"
                f"  - Implementation Provider: `{item.get('provider') or 'none'}`\n"
                f"  - Issue: {issue_str}\n"
                f"  - PR: {pr_str}\n"
                f"  - CI Status: `{item.get('ciStatus') or 'none'}`\n"
                f"  - Semantic Review: {rev_str}"
            )
            if item.get("lastError"):
                block += f"\n  - Last Error / Note: {item.get('lastError')}"
            ev_blocks.append(block)
        execution_evidence_str = "\n".join(ev_blocks)
    else:
        execution_evidence_str = "No execution records available."

    planning = ctx.get("planningBundle", {})
    spec_md = planning.get("spec", "")
    plan_md = planning.get("plan", "")
    tasks_md = planning.get("tasks", "")
    constitution_text = ctx.get("constitution", "")

    if role == "convergence":
        instructions = f"""Determine if the product implementation in the repository satisfies all authoritative requirements and acceptance criteria for milestone `{milestone.id}`.
- If all requirements and acceptance criteria are satisfied, return `status: "CONVERGED"` with `gaps: []`.
- If genuine missing PRODUCT functionality or tests remain, return `status: "GAPS"` with validated work-package objects.
- Every gap MUST specify at least one valid requirement ID from authoritative specs.
- CRITICAL HARD INVARIANT: Do NOT report tooling, sandbox, environment, file-access, or audit-infrastructure tasks as product gaps. Infrastructure failures are handled by the factory control plane and must never become product work."""
    else:
        instructions = f"""Determine if the product implementation in the repository satisfies all authoritative requirements and acceptance criteria for milestone `{milestone.id}`.
- If all requirements and acceptance criteria are satisfied, return `status: "CONVERGED"` with `findings: []`.
- If genuine missing PRODUCT functionality or tests remain, return `status: "NOT_CONVERGED"` with structured `findings`.
- Every finding MUST reference at least one valid requirement ID from the scoped definitions below.
- CRITICAL HARD INVARIANT: Do NOT report tooling, sandbox, environment, file-access, or audit-infrastructure tasks as product gaps. Infrastructure failures are handled by the factory control plane and must never become product work."""

    return f"""{base_prompt}

### Controller-Owned Audit Context:
Milestone ID: `{milestone.id}`
Milestone Objective: {milestone.objective}
Integration HEAD Git Commit: `{ctx.get('headSha')}`
Audit Context Digest: `{ctx.get('contextDigest')}`
Scoped Requirement IDs: {scoped_reqs_str}

### Factory Constitution:
```markdown
{constitution_text}
```

### Authoritative Normative Requirements Scoped for Milestone:
{req_defs_str}

### Work Package Plan & Dependencies:
{completed_summary}

### Verified Execution Evidence:
{execution_evidence_str}

### Spec Kit Planning Artifacts:
#### spec.md
```markdown
{spec_md}
```

#### plan.md
```markdown
{plan_md}
```

#### tasks.md
```markdown
{tasks_md}
```

### Instructions:
{instructions}
"""


class ReasoningRunner:
    def __init__(self, root: Path, config: FactoryConfig, store: StateStore, runner: CommandRunner) -> None:
        self.root = root
        self.config = config
        self.store = store
        self.runner = runner

    def _get_head_sha(self) -> str | None:
        try:
            if self.runner is not None:
                res = self.runner.run(["git", "rev-parse", "HEAD"], check=False)
                if res.returncode == 0:
                    candidate = (res.stdout or "").strip()
                    if len(candidate) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", candidate) and candidate != "0" * 40:
                        return candidate.lower()
            else:
                import subprocess
                res = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True, check=False)
                if res.returncode == 0:
                    candidate = (res.stdout or "").strip()
                    if len(candidate) == 40 and re.fullmatch(r"[0-9a-fA-F]{40}", candidate) and candidate != "0" * 40:
                        return candidate.lower()
        except Exception:
            pass
        return None

    def converge(self, milestone: Milestone) -> dict[str, Any]:
        output_path = self.config.state_dir / "convergence-result.json"
        ctx = build_reasoning_context(self.root, self.config, milestone, self.store, self.runner, role="convergence")
        expected_head = ctx["headSha"]
        expected_digest = ctx["contextDigest"]

        base_prompt = (self.root / "factory" / "prompts" / "convergence.md").read_text(encoding="utf-8")
        prompt = _format_reasoning_prompt(base_prompt, ctx, milestone, role="convergence")

        schema = self.root / "factory" / "schemas" / "convergence.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self.store.event(
            "CONVERGENCE_STARTED",
            milestoneId=milestone.id,
            headSha=expected_head,
            contextDigest=expected_digest,
        )
        self._invoke_codex("convergence", milestone.id, prompt, schema, output_path)

        current_head = self._get_head_sha()
        if current_head != expected_head:
            reason = f"integration HEAD advanced during convergence from {expected_head} to {current_head}"
            self.store.event(
                "CONVERGENCE_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="STALE_INTEGRATION_HEAD",
                reason=reason,
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(reason, failure_class="STALE_INTEGRATION_HEAD")

        fresh_ctx = build_reasoning_context(self.root, self.config, milestone, self.store, self.runner, role="convergence")
        if fresh_ctx["contextDigest"] != expected_digest:
            reason = f"normative context changed during convergence: expected {expected_digest}, now {fresh_ctx['contextDigest']}"
            self.store.event(
                "CONVERGENCE_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="STALE_CONTEXT_DIGEST",
                reason=reason,
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(reason, failure_class="STALE_CONTEXT_DIGEST")

        value = json.loads(output_path.read_text(encoding="utf-8"))
        try:
            _validate_json_schema(value, json.loads(schema.read_text(encoding="utf-8")))
        except Exception as error:
            self.store.event(
                "CONVERGENCE_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="SCHEMA_VALIDATION_FAILED",
                reason=f"convergence output violates schema: {error}",
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(f"convergence output violates schema: {error}", failure_class="SCHEMA_VALIDATION_FAILED")

        value["contextDigest"] = expected_digest
        value["headSha"] = expected_head
        raw_gaps = value.get("gaps", [])
        if value.get("status") == "CONVERGED":
            if raw_gaps:
                self.store.event(
                    "CONVERGENCE_OUTPUT_REJECTED",
                    milestoneId=milestone.id,
                    failureClass="INCONSISTENT_OUTPUT",
                    reason="CONVERGED status cannot contain gaps",
                    headSha=expected_head,
                    contextDigest=expected_digest,
                )
                raise ConvergenceOutputRejectedError("CONVERGED status cannot contain gaps", failure_class="INCONSISTENT_OUTPUT")
            value["status"] = "CONVERGED"
            value["gaps"] = []
            output_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
            return value

        if not raw_gaps:
            self.store.event(
                "CONVERGENCE_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="EMPTY_FINDINGS",
                reason="GAPS status requires non-empty gaps",
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError("GAPS status requires non-empty gaps", failure_class="EMPTY_FINDINGS")

        try:
            validated = validate_product_gaps(self.root, milestone, raw_gaps)
        except ConvergenceOutputRejectedError as error:
            self.store.event(
                "CONVERGENCE_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass=error.failure_class,
                reason=str(error),
                workPackageId=error.gap_id,
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise

        value["status"] = "GAPS"
        value["gaps"] = [_package_dict(item) for item in validated]
        output_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        return value

    def final_audit(self, output_path: Path) -> dict[str, Any]:
        milestone = self.config.load_milestone()
        ctx = build_reasoning_context(self.root, self.config, milestone, self.store, self.runner, role="final_audit")
        expected_head = ctx["headSha"]
        expected_digest = ctx["contextDigest"]

        base_prompt = (self.root / "factory" / "prompts" / "final-audit.md").read_text(encoding="utf-8")
        prompt = _format_reasoning_prompt(base_prompt, ctx, milestone, role="final_audit")

        schema = self.root / "factory" / "schemas" / "final-audit.schema.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self.store.event(
            "FINAL_AUDIT_STARTED",
            milestoneId=milestone.id,
            headSha=expected_head,
            contextDigest=expected_digest,
        )
        self._invoke_codex("final_audit", milestone.id, prompt, schema, output_path)

        current_head = self._get_head_sha()
        if current_head != expected_head:
            reason = f"integration HEAD advanced during final audit from {expected_head} to {current_head}"
            self.store.event(
                "FINAL_AUDIT_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="STALE_INTEGRATION_HEAD",
                reason=reason,
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(reason, failure_class="STALE_INTEGRATION_HEAD")

        fresh_ctx = build_reasoning_context(self.root, self.config, milestone, self.store, self.runner, role="final_audit")
        if fresh_ctx["contextDigest"] != expected_digest:
            reason = f"normative context changed during final audit: expected {expected_digest}, now {fresh_ctx['contextDigest']}"
            self.store.event(
                "FINAL_AUDIT_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="STALE_CONTEXT_DIGEST",
                reason=reason,
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(reason, failure_class="STALE_CONTEXT_DIGEST")

        value = json.loads(output_path.read_text(encoding="utf-8"))
        try:
            _validate_json_schema(value, json.loads(schema.read_text(encoding="utf-8")))
        except Exception as error:
            self.store.event(
                "FINAL_AUDIT_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass="SCHEMA_VALIDATION_FAILED",
                reason=f"final audit output violates schema: {error}",
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise ConvergenceOutputRejectedError(f"final audit output violates schema: {error}", failure_class="SCHEMA_VALIDATION_FAILED")

        try:
            audit_remediation(milestone, value, self.root)
        except ConvergenceOutputRejectedError as error:
            self.store.event(
                "FINAL_AUDIT_OUTPUT_REJECTED",
                milestoneId=milestone.id,
                failureClass=error.failure_class,
                reason=str(error),
                headSha=expected_head,
                contextDigest=expected_digest,
            )
            raise

        value["contextDigest"] = expected_digest
        value["headSha"] = expected_head
        output_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        return value


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
    if not gaps:
        return
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


def audit_remediation(milestone: Milestone, audit: dict[str, Any], root: Path | None = None) -> dict[str, Any]:
    if root is None:
        raise ConvergenceOutputRejectedError(
            "root repository path is required for deterministic final audit requirement validation",
            failure_class="MISSING_REQUIREMENT_EVIDENCE",
        )

    if not isinstance(audit, dict):
        raise ConvergenceOutputRejectedError(
            "final audit output must be a JSON object",
            failure_class="MALFORMED_OUTPUT",
        )

    status = audit.get("status")
    if status not in {"CONVERGED", "NOT_CONVERGED"}:
        raise ConvergenceOutputRejectedError(
            f"invalid final audit status {status!r}; expected CONVERGED or NOT_CONVERGED",
            failure_class="MALFORMED_OUTPUT",
        )

    raw_findings = audit.get("findings")
    if raw_findings is None:
        categories = (
            "blocking_gaps", "requirements_missing", "architecture_conflicts", "test_gaps",
            "runtime_failures", "security_gaps", "operational_gaps",
        )
        legacy_findings = []
        for cat in categories:
            for item in audit.get(cat, []):
                extracted = re.findall(r"[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]{3,4}", str(item))
                reqs = list(audit.get("requirementIds", [])) + extracted
                legacy_findings.append({
                    "category": "PRODUCT_GAP",
                    "summary": str(item),
                    "requirementIds": reqs,
                    "evidence": str(item),
                })
        raw_findings = legacy_findings


    if not isinstance(raw_findings, list):
        raise ConvergenceOutputRejectedError(
            "final audit findings must be a list",
            failure_class="MALFORMED_OUTPUT",
        )

    if status == "CONVERGED":
        if raw_findings:
            raise ConvergenceOutputRejectedError(
                "CONVERGED final audit output cannot contain findings",
                failure_class="INCONSISTENT_OUTPUT",
            )
        return {"status": "CONVERGED", "findings": []}

    if not raw_findings:
        raise ConvergenceOutputRejectedError(
            "NOT_CONVERGED final audit contains no remediation findings",
            failure_class="EMPTY_FINDINGS",
        )

    try:
        authoritative_ids = authoritative_requirement_ids(root)
    except Exception as error:
        if is_product_roadmap_milestone(root, milestone.id):
            raise ConvergenceOutputRejectedError(
                f"unable to load authoritative requirement IDs: {error}",
                failure_class="MISSING_REQUIREMENT_EVIDENCE",
            )
        authoritative_ids = frozenset()

    is_product = is_product_roadmap_milestone(root, milestone.id)
    tooling_count = 0
    validated_product_findings: list[dict[str, Any]] = []

    for finding in raw_findings:
        if not isinstance(finding, dict):
            raise ConvergenceOutputRejectedError(
                "each finding must be a dictionary",
                failure_class="MALFORMED_OUTPUT",
            )
        cat = str(finding.get("category", "PRODUCT_GAP"))
        summary = str(finding.get("summary", "")).strip()
        evidence = str(finding.get("evidence", "")).strip()
        if not summary:
            raise ConvergenceOutputRejectedError(
                "finding summary cannot be empty",
                failure_class="EMPTY_OBJECTIVE",
            )

        is_tooling = cat == "TOOLING_GAP" or any(
            pattern.search(summary) or pattern.search(evidence) or pattern.search(cat)
            for pattern in FORBIDDEN_OBJECTIVE_PATTERNS
        )

        if is_tooling:
            tooling_count += 1
            continue

        req_ids = finding.get("requirementIds", [])
        if not isinstance(req_ids, list):
            raise ConvergenceOutputRejectedError(
                f"finding {summary!r} requirementIds must be a list",
                failure_class="MALFORMED_OUTPUT",
            )

        if is_product:
            if not req_ids:
                raise ConvergenceOutputRejectedError(
                    f"product finding {summary!r} has empty requirementIds",
                    failure_class="MISSING_REQUIREMENT_EVIDENCE",
                )
            for rid in req_ids:
                if not isinstance(rid, str) or not NORMATIVE_ID.fullmatch(rid):
                    raise ConvergenceOutputRejectedError(
                        f"finding {summary!r} contains malformed requirement ID: {rid!r}",
                        failure_class="MALFORMED_OUTPUT",
                    )
                if rid not in authoritative_ids:
                    raise ConvergenceOutputRejectedError(
                        f"finding {summary!r} contains unknown requirement ID: {rid!r}",
                        failure_class="UNKNOWN_REQUIREMENT_ID",
                    )
        else:
            for rid in req_ids:
                if not isinstance(rid, str) or not NORMATIVE_ID.fullmatch(rid):
                    raise ConvergenceOutputRejectedError(
                        f"finding {summary!r} contains malformed requirement ID: {rid!r}",
                        failure_class="MALFORMED_OUTPUT",
                    )

        validated_product_findings.append({
            "category": cat,
            "summary": summary,
            "evidence": evidence,
            "requirementIds": sorted(set(req_ids)),
        })

    if tooling_count > 0 and not validated_product_findings:
        raise ConvergenceOutputRejectedError(
            "final audit findings are pure tooling/read-access failures rather than product deficiencies",
            failure_class="TOOLING_REMEDIATION_REJECTED",
        )

    if not validated_product_findings:
        raise ConvergenceOutputRejectedError(
            "no valid product findings remain in NOT_CONVERGED audit",
            failure_class="EMPTY_FINDINGS",
        )

    all_valid_ids = sorted({rid for f in validated_product_findings for rid in f["requirementIds"]})
    if is_product and not all_valid_ids:
        raise ConvergenceOutputRejectedError(
            f"final audit findings contain zero validated authoritative requirement IDs for milestone {milestone.id}",
            failure_class="MISSING_REQUIREMENT_EVIDENCE",
        )

    acceptance_criteria = [
        f"{f['category']}: {f['summary']}" + (f" (Evidence: {f['evidence']})" if f["evidence"] and f["evidence"] != f["summary"] else "")
        for f in validated_product_findings
    ]

    canonical_audit = json.dumps(audit, sort_keys=True)
    digest = hashlib.sha256(canonical_audit.encode("utf-8")).hexdigest()[:10]

    package_dict: dict[str, Any] = {
        "id": f"final-audit-remediation-{digest}",
        "objective": "Resolve blocking product gaps from the independent final audit.",
        "acceptance": acceptance_criteria,
        "dependencies": [item.id for item in milestone.packages],
        "parallelizable": False,
        "preferredProvider": "muse",
        "risk": "CRITICAL",
        "requirementIds": all_valid_ids,
        "authorizedProtectedPaths": [],
    }
    return package_dict



def reconcile_durable_state(
    store: StateStore,
    milestone_or_plan: Milestone | Path,
    root: Path,
    ao: Any = None,
) -> tuple[dict[str, PackageRecord], dict[str, Any]]:
    records = store.load()
    metadata = store.metadata()
    cleaned = False

    if isinstance(milestone_or_plan, Milestone):
        active_milestone = milestone_or_plan
    elif isinstance(milestone_or_plan, Path):
        active_path = store.directory / "active-milestone.json"
        source = active_path if active_path.exists() else milestone_or_plan
        try:
            active_milestone = Milestone.from_dict(json.loads(source.read_text(encoding="utf-8")))
        except Exception:
            active_milestone = Milestone.from_dict(json.loads(milestone_or_plan.read_text(encoding="utf-8")))
    else:
        raise TypeError(f"expected Milestone or Path, got {type(milestone_or_plan)}")

    purged_remediation_keys: set[str] = set()
    remediation_path = store.directory / "remediation-plan.json"
    if remediation_path.exists():
        try:
            raw = json.loads(remediation_path.read_text(encoding="utf-8"))
            if raw.get("milestoneId") == active_milestone.id:
                pkgs = raw.get("workPackages", [])
                valid_pkgs = []
                for p in pkgs:
                    pid = p.get("id", "")
                    pkey = work_key(raw.get("milestoneId", ""), pid)
                    is_invalid = (
                        any(pat.search(p.get("objective", "")) for pat in FORBIDDEN_OBJECTIVE_PATTERNS)
                        or p.get("classification", "PRODUCT_GAP") != "PRODUCT_GAP"
                    )
                    if is_invalid:
                        purged_remediation_keys.add(pkey)
                        continue
                    valid_pkgs.append(p)
                if len(valid_pkgs) != len(pkgs):
                    cleaned = True
                    if not valid_pkgs:
                        remediation_path.unlink(missing_ok=True)
                    else:
                        raw["workPackages"] = valid_pkgs
                        remediation_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
        except Exception:
            pass

    conv_result_path = store.directory / "convergence-result.json"
    if conv_result_path.exists():
        try:
            craw = json.loads(conv_result_path.read_text(encoding="utf-8"))
            gaps = craw.get("gaps", [])
            if any(any(pat.search(g.get("objective", "")) for pat in FORBIDDEN_OBJECTIVE_PATTERNS) or g.get("classification", "PRODUCT_GAP") != "PRODUCT_GAP" for g in gaps):
                conv_result_path.unlink(missing_ok=True)
                cleaned = True
        except Exception:
            pass

    synthetic_keys: list[str] = []

    # One-time migration for historical incidents (Version 1: historical Issue #98 cleanup)
    migration_version = int(metadata.get("stateMigrationVersion", 0))
    if migration_version < 1:
        for key, record in list(records.items()):
            if record.issue_number == 98 or key == "g0-contract-foundation--g0-contract-foundation-convergence-evidence":
                synthetic_keys.append(key)
                if record.session_id and ao:
                    try:
                        ao.kill(record.session_id)
                    except Exception:
                        pass
                records.pop(key, None)
                cleaned = True
        metadata["stateMigrationVersion"] = 1
        cleaned = True

    # Generic durable reconciliation: remove ONLY records whose remediation was deterministically invalidated
    for key, record in list(records.items()):
        if key in purged_remediation_keys:
            synthetic_keys.append(key)
            if record.session_id and ao:
                try:
                    ao.kill(record.session_id)
                except Exception:
                    pass
            records.pop(key, None)
            cleaned = True

    if cleaned:
        metadata["convergencePasses"] = 0
        metadata["milestoneConverged"] = False
        metadata["consecutiveTickFailures"] = 0
        metadata["lastTickFailure"] = None
        store.save(records, metadata)
        store.event("STATE_RECONCILED", syntheticRemoved=synthetic_keys)

    return records, metadata


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


def is_product_roadmap_milestone(root: Path, milestone_id: str) -> bool:
    if milestone_id.startswith("factory-") or "canary" in milestone_id.lower() or milestone_id.startswith("test-") or milestone_id == "m1":
        return False
    roadmap_path = root / "specs" / "factory" / "roadmap.json"
    if roadmap_path.exists():
        try:
            raw = json.loads(roadmap_path.read_text(encoding="utf-8"))
            roadmap_ids = {item.get("id") for item in raw.get("milestones", []) if item.get("id")}
            if milestone_id in roadmap_ids:
                return True
        except Exception:
            pass
    return bool(re.match(r"^g[0-9]+(-[a-z0-9]+)*$", milestone_id))


def _validate_requirement_ids(root: Path, milestone: Milestone) -> None:
    authoritative = authoritative_requirement_ids(root)
    is_product = is_product_roadmap_milestone(root, milestone.id)
    for package in milestone.packages:
        if is_product and not package.requirement_ids:
            raise RuntimeError(
                f"product roadmap package {package.id!r} in milestone {milestone.id!r} must specify non-empty normative requirement IDs"
            )
        if len(package.requirement_ids) != len(set(package.requirement_ids)):
            raise RuntimeError(f"work package {package.id!r} contains duplicate requirement IDs: {package.requirement_ids}")
        for rid in package.requirement_ids:
            if not isinstance(rid, str) or not NORMATIVE_ID.fullmatch(rid) or rid not in authoritative:
                raise RuntimeError(f"work package {package.id!r} contains unknown normative requirement ID: {rid!r}")


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
