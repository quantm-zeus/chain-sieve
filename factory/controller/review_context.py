from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Sequence


CONTEXT_SCHEMA_VERSION = 2
PROOF_PREFIX = "CHAINSIEVE_REVIEW_CONTEXT_SHA256:"
PROOF_PATTERN = re.compile(rf"(?<![A-Za-z0-9_]){PROOF_PREFIX}([0-9a-f]{{64}})(?![0-9a-f])")
TASK_HEAD_PATTERN = re.compile(r"\(head commit ([0-9a-f]{40}), run [^)]+\)")

AUTHORITY_FIELDS = (
    "workKey",
    "milestoneId",
    "workPackageId",
    "objective",
    "acceptance",
    "requirementIds",
    "authoritativeSources",
    "targetSha",
)

CLOSURE_AUTHORITY_FIELDS = (
    "reviewMode",
    "baselineId",
    "baselineHead",
    "baselineContextDigest",
    "frozenBlockerLedger",
    "prNumber",
    "implementationProvider",
    "reviewerProvider",
)


def canonical_context_digest(authority: dict[str, Any]) -> str:
    canonical: dict[str, Any] = {field: authority[field] for field in AUTHORITY_FIELDS if field in authority}
    if authority.get("reviewMode") and authority.get("reviewMode") != "FULL_BASELINE":
        for field in CLOSURE_AUTHORITY_FIELDS:
            if field in authority and authority[field] is not None:
                canonical[field] = authority[field]
    elif authority.get("baselineId") is not None:
        for field in CLOSURE_AUTHORITY_FIELDS:
            if field in authority and authority[field] is not None:
                canonical[field] = authority[field]

    encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_review_context(
    milestone_id: str,
    package: Any,
    head_sha: str,
    authoritative_sources: Sequence[str],
    *,
    review_mode: str = "FULL_BASELINE",
    baseline_id: str | None = None,
    baseline_head: str | None = None,
    baseline_context_digest: str | None = None,
    frozen_findings: Sequence[dict[str, Any]] | None = None,
    previous_reviewed_head: str | None = None,
    pr_number: int | None = None,
    implementation_provider: str | None = None,
    reviewer_provider: str | None = None,
) -> dict[str, Any]:
    pkg_id = package["id"] if isinstance(package, dict) else package.id
    obj = package["objective"] if isinstance(package, dict) else package.objective
    acc = package["acceptance"] if isinstance(package, dict) else package.acceptance
    reqs = package.get("requirementIds", []) if isinstance(package, dict) else package.requirement_ids

    authority: dict[str, Any] = {
        "workKey": f"{milestone_id}--{pkg_id}",
        "milestoneId": milestone_id,
        "workPackageId": pkg_id,
        "objective": obj,
        "acceptance": list(acc),
        "requirementIds": list(reqs),
        "authoritativeSources": list(authoritative_sources),
        "targetSha": head_sha.lower(),
    }

    if review_mode != "FULL_BASELINE" or baseline_id is not None:
        authority.update({
            "reviewMode": review_mode,
            "baselineId": baseline_id,
            "baselineHead": baseline_head.lower() if baseline_head else None,
            "baselineContextDigest": baseline_context_digest,
            "frozenBlockerLedger": [
                {
                    "fingerprint": f.get("fingerprint"),
                    "status": f.get("status"),
                    "severity": f.get("severity"),
                    "requirement_id": f.get("requirement_id"),
                    "file_or_component": f.get("file_or_component"),
                    "normalized_summary": f.get("normalized_summary"),
                }
                for f in (frozen_findings or [])
            ],
            "previousReviewedHead": previous_reviewed_head.lower() if previous_reviewed_head else None,
            "prNumber": pr_number,
            "implementationProvider": implementation_provider,
            "reviewerProvider": reviewer_provider,
        })
    else:
        authority["reviewMode"] = "FULL_BASELINE"

    base_digest = canonical_context_digest({k: authority[k] for k in AUTHORITY_FIELDS if k in authority})

    return {
        "schemaVersion": CONTEXT_SCHEMA_VERSION,
        **authority,
        "baseContextDigest": base_digest,
        "contextDigest": canonical_context_digest(authority),
    }


def validate_review_context(value: Any, *, work_key: str, target_sha: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("review context must be a JSON object")
    required_base = {"schemaVersion", "contextDigest", *AUTHORITY_FIELDS}
    if not required_base.issubset(set(value)):
        raise ValueError("review context has missing or unexpected fields")
    if value.get("schemaVersion") != CONTEXT_SCHEMA_VERSION:
        raise ValueError("review context schema version is unsupported")
    scalar_fields = ("workKey", "milestoneId", "workPackageId", "objective", "targetSha", "contextDigest")
    if any(not isinstance(value.get(field), str) or not value[field] for field in scalar_fields):
        raise ValueError("review context has an invalid scalar field")
    for field in ("acceptance", "requirementIds", "authoritativeSources"):
        items = value.get(field)
        if not isinstance(items, list) or any(not isinstance(item, str) or not item for item in items):
            raise ValueError(f"review context has invalid {field}")
    if not value["acceptance"] or not value["authoritativeSources"]:
        raise ValueError("review context is missing acceptance or authoritative sources")
    if value["workKey"] != work_key:
        raise ValueError("review context workKey does not match the reviewer workspace")
    if value["workKey"] != f'{value["milestoneId"]}--{value["workPackageId"]}':
        raise ValueError("review context workKey is internally inconsistent")
    if value["targetSha"] != target_sha.lower():
        raise ValueError("review context targetSha does not match the AO review task")
    authority = {field: value[field] for field in AUTHORITY_FIELDS}
    for field in CLOSURE_AUTHORITY_FIELDS:
        if field in value and value[field] is not None:
            authority[field] = value[field]
    expected_digest = canonical_context_digest(authority)
    if value["contextDigest"] != expected_digest:
        raise ValueError("review context digest is invalid")
    return dict(value)


def proof_markers(body: str) -> tuple[str, ...]:
    return tuple(PROOF_PATTERN.findall(body or ""))


def resolve_task_context(task_file: Path, *, cwd: Path | None = None) -> dict[str, Any]:
    task_file = task_file.resolve(strict=True)
    ao_data_value = os.environ.get("AO_DATA_DIR", "").strip()
    if not ao_data_value:
        raise ValueError("AO_DATA_DIR is unavailable")
    prompt_root = (Path(ao_data_value).resolve() / "prompts").resolve()
    if not task_file.is_relative_to(prompt_root):
        raise ValueError("AO review task is outside the AO-owned prompt root")
    task = task_file.read_text(encoding="utf-8")
    heads = set(TASK_HEAD_PATTERN.findall(task))
    if len(heads) != 1:
        raise ValueError("AO review task must identify exactly one target head")
    target_sha = next(iter(heads))

    workspace = cwd or Path.cwd()
    branch = _git(workspace, "symbolic-ref", "--quiet", "--short", "HEAD")
    current_head = _git(workspace, "rev-parse", "--verify", "HEAD").lower()
    if not branch.startswith("factory/"):
        raise ValueError("reviewer workspace is not attached to a factory branch")
    work_key = branch.removeprefix("factory/")
    if current_head != target_sha:
        raise ValueError("reviewer workspace head does not match the AO review task")

    context_root_value = os.environ.get("CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR", "").strip()
    if not context_root_value:
        state_dir_value = os.environ.get("CHAINSIEVE_FACTORY_STATE_DIR", "").strip()
        if state_dir_value:
            context_root_value = str(Path(state_dir_value) / "reviews")
        else:
            raise ValueError("controller review-context root is unavailable")

    context_root = Path(context_root_value).resolve()
    if not context_root.is_dir():
        state_dir_value = os.environ.get("CHAINSIEVE_FACTORY_STATE_DIR", "").strip()
        if state_dir_value and (Path(state_dir_value) / "reviews").is_dir():
            context_root = (Path(state_dir_value) / "reviews").resolve()
        else:
            raise ValueError(f"controller review-context root is unavailable: {context_root}")

    context_path = (context_root / work_key / f"{target_sha}.json").resolve()
    if not context_path.is_file():
        raise ValueError(f"review context artifact is unavailable: {context_path}")
    if not context_path.is_relative_to(context_root):
        raise ValueError("resolved review context escaped the controller context root")
    value = validate_review_context(
        json.loads(context_path.read_text(encoding="utf-8")),
        work_key=work_key,
        target_sha=target_sha,
    )
    digest = value["contextDigest"]
    authority_map = {field: value[field] for field in AUTHORITY_FIELDS}
    for field in CLOSURE_AUTHORITY_FIELDS:
        if field in value and value[field] is not None:
            authority_map[field] = value[field]
    return {
        "schemaVersion": 1,
        "authority": authority_map,
        "contextDigest": digest,
        "proofMarker": f"{PROOF_PREFIX}{digest}",
    }


def _git(cwd: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=cwd, check=False, text=True, capture_output=True, timeout=15,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise ValueError(f"unable to resolve reviewer workspace git state: {result.stderr.strip()}")
    return result.stdout.strip()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resolve exact controller-owned ChainSieve semantic review authority")
    parser.add_argument("task_file", type=Path, help="absolute AO-owned review task.md path")
    args = parser.parse_args(argv)
    try:
        value = resolve_task_context(args.task_file)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        parser.exit(78, f"chainsieve-review-context: {error}\n")
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
