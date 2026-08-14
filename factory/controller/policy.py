from __future__ import annotations

import fnmatch

from .models import WorkPackage


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
