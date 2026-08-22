"""Gap and work identity — never from LLM prose (§16)."""
from __future__ import annotations

import hashlib
import re


def canonical_gap_key(
    milestone_id: str,
    requirement_ids: list[str],
    acceptance_ids: list[str] | None = None,
    invariant_ids: list[str] | None = None,
    capability_id: str | None = None,
) -> str:
    """Stable gap identity from committed authority.

    Uses only milestone + requirement/acceptance/invariant/capability IDs.
    Identical inputs -> identical key. Paraphrasing prose cannot change it.
    """
    mid = (milestone_id or "").strip().upper()
    if not mid:
        raise ValueError("milestone_id required")
    reqs = sorted({str(r).strip().upper() for r in (requirement_ids or []) if str(r).strip()})
    if not reqs:
        raise ValueError("at least one requirement_id required")
    acc = sorted({str(a).strip().upper() for a in (acceptance_ids or []) if str(a).strip()})
    inv = sorted({str(i).strip().upper() for i in (invariant_ids or []) if str(i).strip()})
    cap = (capability_id or "").strip().upper()

    # Deterministic key — no prose hashing
    parts = [mid, ",".join(reqs), ",".join(acc), ",".join(inv), cap]
    raw = "|".join(parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"GAP-{reqs[0]}-{digest}"


def work_id_for_gap(gap_key: str, strategy_epoch: int = 0) -> str:
    """workId stable across replan; strategyEpoch distinguishes strategy."""
    base = gap_key.replace("GAP-", "WORK-")
    if strategy_epoch == 0:
        return base
    return f"{base}-S{strategy_epoch}"


# Helper for migration: assign gapKey once at planning (§16) and persist
def assign_persistent_gap_key(
    milestone_id: str,
    requirement_ids: list[str],
    generated_objective: str | None = None,  # ignored — never used for identity
    acceptance_ids: list[str] | None = None,
) -> str:
    _ = generated_objective  # explicitly ignored
    return canonical_gap_key(milestone_id, requirement_ids, acceptance_ids)
