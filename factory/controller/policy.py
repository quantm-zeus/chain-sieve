from __future__ import annotations

import fnmatch

from .models import WorkPackage


def protected_path_violations(
    changed_files: tuple[str, ...],
    protected_patterns: tuple[str, ...],
    package: WorkPackage,
) -> tuple[str, ...]:
    authorized = package.authorized_protected_paths
    violations: list[str] = []
    for path in changed_files:
        protected = any(_matches(path, pattern) for pattern in protected_patterns)
        allowed = any(_matches(path, pattern) for pattern in authorized)
        if protected and not allowed:
            violations.append(path)
    return tuple(sorted(violations))


def _matches(path: str, pattern: str) -> bool:
    normalized = pattern.rstrip("/")
    return path == normalized or path.startswith(normalized + "/") or fnmatch.fnmatch(path, pattern)


def reviewer_for(provider: str) -> str:
    if provider == "muse":
        return "agy"
    if provider == "agy":
        return "muse"
    raise ValueError(f"no cross-provider reviewer for {provider}")


def review_required(package: WorkPackage) -> bool:
    return package.risk in {"MEDIUM", "HIGH", "CRITICAL"}

