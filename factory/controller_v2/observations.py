"""Observations — pure data, clock as observation (§9)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Clock:
    iso: str  # e.g. 2026-08-22T03:00:00Z


@dataclass(frozen=True)
class GitHead:
    branch: str
    sha: str | None  # 40-hex or None if missing


@dataclass(frozen=True)
class PROBS:
    pr: int
    head_sha: str
    state: str  # open | closed | merged
    mergeable: bool
    base_branch: str


@dataclass(frozen=True)
class CIObservation:
    pr: int
    head: str
    gate_set: tuple[str, ...]
    passed: bool
    classification: str  # PRODUCT | INFRASTRUCTURE | UNKNOWN
    has_evidence: bool


@dataclass(frozen=True)
class ReviewObservation:
    workId: str
    pr: int
    targetHead: str
    reviewer: str
    implementationProvider: str
    mode: str  # BASELINE | VERIFY
    reviewScopeId: str
    contextDigest: str
    verdict: str  # PASS | CHANGES_REQUESTED | UNKNOWN (malformed)
    blockingFindings: tuple[dict[str, Any], ...] = ()
    malformed: bool = False


@dataclass(frozen=True)
class WorkerObservation:
    workId: str
    session_id: str | None
    status: str  # running | terminated | crashed | restored
    activity: str | None = None


@dataclass(frozen=True)
class Observations:
    clock: Clock
    git_heads: tuple[GitHead, ...] = ()
    prs: tuple[PROBS, ...] = ()
    ci: tuple[CIObservation, ...] = ()
    reviews: tuple[ReviewObservation, ...] = ()
    workers: tuple[WorkerObservation, ...] = ()
