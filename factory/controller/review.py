"""Review — BASELINE / VERIFY only (§20-21), STALE semantics (§22)."""
from __future__ import annotations

from typing import Any

from .domain import ReviewEvidence


def is_stale_review(evidence: ReviewEvidence, current_head: str, current_scope: str, current_digest: str) -> bool:
    return (
        evidence.targetHead.lower() != current_head.lower()
        or evidence.reviewScopeId != current_scope
        or evidence.contextDigest != current_digest
    )


def validate_review(evidence: dict[str, Any]) -> ReviewEvidence | None:
    """Strict schema validation — malformed => None (zero effect, INV-06)."""
    try:
        auth = evidence.get("authority", {})
        workId = str(auth["workId"])
        pr = int(auth["pr"])
        targetHead = str(auth["targetHead"])
        reviewer = str(auth["reviewer"])
        impl = str(auth["implementationProvider"])
        mode = str(auth["mode"])
        scope = str(auth["reviewScopeId"])
        digest = str(auth["contextDigest"])
        verdict = str(evidence["verdict"])
        if mode not in ("BASELINE", "VERIFY"):
            return None
        if verdict not in ("PASS", "CHANGES_REQUESTED"):
            return None
        if len(targetHead) != 40 or any(c not in "0123456789abcdefABCDEF" for c in targetHead):
            return None
        return ReviewEvidence(
            workId=workId,
            pr=pr,
            targetHead=targetHead.lower(),
            reviewer=reviewer,
            implementationProvider=impl,
            mode=mode,
            reviewScopeId=scope,
            contextDigest=digest,
            verdict=verdict,
            blockingFindings=tuple(evidence.get("blockingFindings", ())),
            dispositions=tuple(evidence.get("dispositions", ())),
            schemaVersion=int(evidence.get("schemaVersion", 1)),
        )
    except Exception:
        return None  # malformed => zero product effect
