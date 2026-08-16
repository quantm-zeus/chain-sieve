from __future__ import annotations

import fnmatch
from typing import Any

from .models import PackageRecord, PackageStatus, WorkPackage


IMMUTABLE_CONTROL_PLANE_PATHS = (
    "factory/**",
    "factory/controller/**",
    "factory/deployment/**",
    "factory/config.json",
    "factory/constitution.md",
    "factory/prompts/**",
    "factory/schemas/**",
    "factory/requirements.lock",
    "factory/upstream-lock.json",
    "agent-orchestrator.yaml",
    ".github/**",
    ".specify/**",
    "specs/factory/**",
    "docs/spec/**",
    "artifacts/spec/**",
    "artifacts/conformance/**",
    "tests/harness/**",
    "tests/spec-mutation/**",
    "tools/task-verifier/**",
    "tools/architecture-verifier/**",
    "AGENTS.md",
    "SECURITY.md",
    "pyproject.toml",
    "docs/adr/**",
)

ELEVATED_PRODUCT_PATHS = (
    "package.json",
    "pnpm-lock.yaml",
    "migrations/**",
    "**/migrations/**",
    "prisma/**",
    "generated/**",
    "**/generated/**",
)


def protected_path_violations(
    changed_files: tuple[str, ...],
    protected_patterns: tuple[str, ...],
    package: WorkPackage,
) -> tuple[str, ...]:
    authorized = package.authorized_protected_paths
    violations: list[str] = []
    for path in changed_files:
        protected = any(_matches(path, pattern) for pattern in protected_patterns)
        immutable = any(_matches(path, pattern) for pattern in IMMUTABLE_CONTROL_PLANE_PATHS)
        allowed = not immutable and any(_matches(path, pattern) for pattern in authorized)
        if (protected or immutable) and not allowed:
            violations.append(path)
    return tuple(sorted(violations))


def validate_path_authority(package: WorkPackage) -> None:
    if not package.authorized_protected_paths:
        return
    if package.risk not in {"HIGH", "CRITICAL"}:
        raise ValueError(
            f"work package {package.id} must be HIGH or CRITICAL risk to authorize elevated protected paths"
        )
    for pattern in package.authorized_protected_paths:
        if _intersects_any(pattern, IMMUTABLE_CONTROL_PLANE_PATHS):
            raise ValueError(f"work package {package.id} cannot authorize immutable control-plane path {pattern!r}")
        if not _is_within_any(pattern, ELEVATED_PRODUCT_PATHS):
            raise ValueError(f"work package {package.id} has unsupported elevated path authorization {pattern!r}")


def _matches(path: str, pattern: str) -> bool:
    normalized = pattern.rstrip("/")
    return path == normalized or path.startswith(normalized + "/") or fnmatch.fnmatch(path, pattern)


def _fixed_prefix(pattern: str) -> str:
    wildcard = min((pattern.find(ch) for ch in "*[?" if ch in pattern), default=len(pattern))
    return pattern[:wildcard].rstrip("/")


def _intersects_any(candidate: str, authorities: tuple[str, ...]) -> bool:
    candidate_prefix = _fixed_prefix(candidate)
    if not candidate_prefix:
        return True
    return any(
        candidate_prefix == _fixed_prefix(authority)
        or candidate_prefix.startswith(_fixed_prefix(authority) + "/")
        or _fixed_prefix(authority).startswith(candidate_prefix + "/")
        for authority in authorities
    )


def _is_within_any(candidate: str, authorities: tuple[str, ...]) -> bool:
    prefix = _fixed_prefix(candidate)
    if not prefix:
        return False
    for authority in authorities:
        authority_prefix = _fixed_prefix(authority)
        if authority_prefix and (
            prefix == authority_prefix or prefix.startswith(authority_prefix + "/")
        ):
            return True
        if authority.startswith("**/"):
            suffix = _fixed_prefix(authority.removeprefix("**/"))
            if suffix and (prefix == suffix or f"/{suffix}/" in f"/{prefix}/"):
                return True
    return False


def reviewer_for(provider: str) -> str:
    if provider == "muse":
        return "agy"
    if provider == "agy":
        return "muse"
    raise ValueError(f"no cross-provider reviewer for {provider}")


def review_required(package: WorkPackage) -> bool:
    return package.risk in {"MEDIUM", "HIGH", "CRITICAL"}


def select_implementation_provider(
    package: WorkPackage,
    record: PackageRecord,
    records: dict[str, PackageRecord],
    config: Any,
    available_providers: set[str] | None = None,
) -> tuple[str, str]:
    """
    Select implementation provider according to priority:
    1. mandatory normative/provider capability constraint, if any
    2. durable existing work ownership (preserve provider for existing branch/session/record/PR)
    3. provider availability/cooldown
    4. task risk/capability compatibility
    5. deterministic configured weighting
    6. preferredProvider as tie-break/preference
    """
    available = set(available_providers) if available_providers is not None else {"agy", "muse"}

    # Priority 2: Durable existing work ownership
    if record.provider and record.provider in {"agy", "muse"}:
        if record.task_attempts > 0 and record.status in {PackageStatus.READY, PackageStatus.FAILED}:
            alt = "agy" if record.provider == "muse" else "muse"
            if alt in available:
                return alt, "alternate-provider-retry"
            if record.provider in available:
                return record.provider, "provider-cooldown-fallback"
        if record.provider in available:
            return record.provider, "durable-existing-work"
        for alt in ("agy", "muse"):
            if alt in available:
                return alt, "provider-cooldown-fallback"

    # Priority 5: Deterministic configured weighting for fresh eligible work
    weights = getattr(config, "implementation_weights", None) or {"agy": 2, "muse": 1}
    counts: dict[str, int] = {"agy": 0, "muse": 0}
    for r in records.values():
        if r.provider in counts:
            counts[r.provider] += 1

    candidates = [p for p in ("agy", "muse") if p in available]
    if not candidates:
        return package.preferred_provider, "default-fallback"
    if len(candidates) == 1:
        return candidates[0], "single-available-provider"

    score_agy = counts["agy"] / max(1, weights.get("agy", 2))
    score_muse = counts["muse"] / max(1, weights.get("muse", 1))

    if score_agy < score_muse and "agy" in available:
        return "agy", "weighted-balance"
    elif score_muse < score_agy and "muse" in available:
        return "muse", "weighted-balance"
    else:
        pref = package.preferred_provider if package.preferred_provider in candidates else candidates[0]
        return pref, "weighted-balance"
