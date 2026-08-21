from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Sequence


class ReviewMode(StrEnum):
    FULL_BASELINE = "FULL_BASELINE"
    CLOSURE_VERIFY = "CLOSURE_VERIFY"
    FINAL_CONFIRMATION = "FINAL_CONFIRMATION"


class FindingStatus(StrEnum):
    OPEN = "OPEN"
    RESOLVED = "RESOLVED"
    REGRESSION = "REGRESSION"
    FOLLOW_UP = "FOLLOW_UP"


class FindingSeverity(StrEnum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    INFORMATIONAL = "INFORMATIONAL"


class LateFindingCategory(StrEnum):
    CORRECTION_REGRESSION = "CORRECTION_REGRESSION"
    CRITICAL_LATE_BLOCKER = "CRITICAL_LATE_BLOCKER"
    NON_BLOCKING_FOLLOW_UP = "NON_BLOCKING_FOLLOW_UP"


STOPWORDS = {
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "being", "have",
    "has", "had", "do", "does", "did", "not", "but", "if", "that", "this",
    "it", "as", "into", "also", "issue", "issues", "problem", "problems",
    "fix", "fixes", "fixed", "fixing", "handle", "handles", "handled", "handling",
    "error", "errors", "bug", "bugs", "defect", "defects", "ensure", "ensures",
    "when", "where", "should", "must", "could", "would",
}

REQ_PATTERN = re.compile(r" ([A-Z]{2,5}-[A-Z0-9]+-[0-9]{3,4}|AC-[0-9]{3,4}) ")


def normalize_tokens(text: str) -> list[str]:
    cleaned = re.sub(r"\bline\s+\d+\b", " ", text.lower())
    cleaned = re.sub(r"\b\d+\b", " ", cleaned)
    cleaned = re.sub(r"[^a-zA-Z0-9_\-\.]", " ", cleaned)
    tokens = [t.strip("._-") for t in cleaned.split() if len(t.strip("._-")) > 1]
    return [t for t in tokens if t not in STOPWORDS]


def generate_finding_fingerprint(
    requirement_id: str | None,
    file_or_component: str | None,
    summary: str,
    category: str = "CORRECTNESS",
) -> str:
    """Generate a semantic, deterministic fingerprint for deduplication.

    The fingerprint is invariant under minor wording differences and whitespace.
    """
    req = (requirement_id or "").strip().upper()
    comp = (file_or_component or "general").strip().lower()
    comp_base = comp.split("/")[-1] if "/" in comp else comp

    tokens = normalize_tokens(summary)
    sorted_tokens = sorted(set(tokens))
    key_str = f"{req}|{comp_base}|{category.upper()}|{' '.join(sorted_tokens)}"
    digest = hashlib.sha256(key_str.encode("utf-8")).hexdigest()[:12]
    prefix = req if req else category[:4].upper()
    return f"FND-{prefix}-{digest}"


@dataclass
class ReviewFinding:
    fingerprint: str
    requirement_id: str | None = None
    severity: str = FindingSeverity.MEDIUM.value
    category: str = "CORRECTNESS"
    file_or_component: str = "general"
    normalized_summary: str = ""
    blocking: bool = True
    status: str = FindingStatus.OPEN.value
    first_seen_head: str = ""
    last_verified_head: str | None = None
    source_review_run_id: str | None = None
    introduced_by_head_or_delta: str | None = None
    resolution_evidence: str | None = None
    critical_justification: str | None = None
    reopened_reason: str | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ReviewFinding":
        fields = cls.__dataclass_fields__
        cleaned = {k: v for k, v in value.items() if k in fields}
        return cls(**cleaned)

    def to_dict(self) -> dict[str, Any]:
        return {
            "fingerprint": self.fingerprint,
            "requirement_id": self.requirement_id,
            "severity": self.severity,
            "category": self.category,
            "file_or_component": self.file_or_component,
            "normalized_summary": self.normalized_summary,
            "blocking": self.blocking,
            "status": self.status,
            "first_seen_head": self.first_seen_head,
            "last_verified_head": self.last_verified_head,
            "source_review_run_id": self.source_review_run_id,
            "introduced_by_head_or_delta": self.introduced_by_head_or_delta,
            "resolution_evidence": self.resolution_evidence,
            "critical_justification": self.critical_justification,
            "reopened_reason": self.reopened_reason,
        }


def is_critical_late_blocker(
    finding_text: str,
    severity: str,
    explicit_category: str | None = None,
) -> bool:
    """Evaluate if a late finding qualifies as CRITICAL_LATE_BLOCKER (§14)."""
    if explicit_category == LateFindingCategory.CRITICAL_LATE_BLOCKER.value:
        return True
    if severity.upper() == FindingSeverity.CRITICAL.value:
        return True
    text_lower = finding_text.lower()
    critical_indicators = (
        "security vulnerability",
        "data corruption",
        "irreversible data loss",
        "data loss",
        "fail-open",
        "fail open",
        "broken public api contract",
        "broken durable persistence contract",
        "direct violation of authoritative acceptance criterion",
    )
    return any(indicator in text_lower for indicator in critical_indicators)


def is_non_blocking_follow_up(
    finding_text: str,
    severity: str = "MEDIUM",
) -> bool:
    """Check if finding is non-blocking follow-up/suggestion."""
    if str(severity).upper() in {FindingSeverity.LOW.value, FindingSeverity.INFORMATIONAL.value} or str(finding_text).upper() in {FindingSeverity.LOW.value, FindingSeverity.INFORMATIONAL.value}:
        return True
    text_lower = f"{finding_text} {severity}".lower()
    follow_up_indicators = (
        "nit:", "nitpick", "optional", "consider", "could improve",
        "style", "code style", "naming", "refactor", "refactoring",
        "theoretical hardening", "future extension", "optional documentation",
        "planned conformance", "planned per requirements", "cleanup",
    )
    return any(indicator in text_lower for indicator in follow_up_indicators)


def extract_raw_findings_from_text(body: str) -> list[dict[str, Any]]:
    """Extract individual finding chunks from markdown review text."""
    findings: list[dict[str, Any]] = []
    if not body:
        return findings

    lines = body.splitlines()
    current_finding: list[str] = []
    current_file = "general"
    current_req = None
    current_sev = "MEDIUM"

    for line in lines:
        stripped = line.strip()
        req_match = REQ_PATTERN.search(stripped)
        if req_match:
            current_req = req_match.group(1)

        file_match = re.search(r"[']", stripped)
        if file_match:
            current_file = file_match.group(1)

        if any(w in stripped.upper() for w in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL")):
            for s in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"):
                if s in stripped.upper():
                    current_sev = s
                    break

        bullet_match = re.match(r"^(?:[\d]+\.|\*|-)\s+(.*)$", stripped)
        if bullet_match:
            content = bullet_match.group(1).strip()
            if not any(content.lower().startswith(p) for p in ("what was reviewed", "what was checked", "diff ", "authority:", "alignment vs")):
                if current_finding:
                    full_text = " ".join(current_finding)
                    if len(full_text) > 15:
                        findings.append({
                            "summary": full_text,
                            "file": current_file,
                            "requirement_id": current_req,
                            "severity": current_sev,
                        })
                    current_finding = []
                current_finding.append(content)
        elif current_finding and stripped and not stripped.startswith("#"):
            current_finding.append(stripped)

    if current_finding:
        full_text = " ".join(current_finding)
        if len(full_text) > 15 and not any(full_text.lower().startswith(p) for p in ("what was reviewed", "diff ")):
            findings.append({
                "summary": full_text,
                "file": current_file,
                "requirement_id": current_req,
                "severity": current_sev,
            })

    return findings


def match_finding_fingerprint(
    candidate_summary: str,
    candidate_file: str,
    candidate_req: str | None,
    frozen_findings: Sequence[ReviewFinding],
) -> ReviewFinding | None:
    """Find matching frozen finding by exact fingerprint or high semantic overlap."""
    cand_fp = generate_finding_fingerprint(candidate_req, candidate_file, candidate_summary)
    for f in frozen_findings:
        if f.fingerprint == cand_fp:
            return f

    cand_tokens = set(normalize_tokens(candidate_summary))
    if not cand_tokens:
        return None

    best_match: ReviewFinding | None = None
    best_score = 0.0
    for f in frozen_findings:
        target_tokens = set(normalize_tokens(f.normalized_summary))
        if not target_tokens:
            continue
        intersection = len(cand_tokens & target_tokens)
        union = len(cand_tokens | target_tokens)
        score = intersection / union if union > 0 else 0.0
        if score > 0.35 and score > best_score:
            best_score = score
            best_match = f

    return best_match


def parse_and_reconcile_review(
    body: str,
    payload: dict[str, Any] | None,
    target_sha: str,
    run_id: str | None,
    review_mode: str,
    frozen_findings: list[ReviewFinding] | None = None,
    raw_verdict: str | None = None,
) -> tuple[list[ReviewFinding], list[str]]:

    """Parse review results and update/freeze blocker ledger.

    Returns:
      (reconciled_findings_list, blocking_reasons)
    """
    frozen = list(frozen_findings or [])
    disposition_map: dict[str, str] = {}
    evidence_map: dict[str, str] = {}
    new_findings: list[ReviewFinding] = []
    blocking_reasons: list[str] = []

    # 1. Parse structured payload if available
    if payload:
        raw_dispositions = (
            (payload.get("dispositions") or [])
            + (payload.get("closureDispositions") or [])
            + [f for f in (payload.get("findings") or []) if isinstance(f, dict) and "fingerprint" in f]
        )
        for d in raw_dispositions:
            if isinstance(d, dict):
                fp = str(d.get("fingerprint") or d.get("id") or "").strip()
                status = str(d.get("status") or d.get("disposition") or "").upper().strip()
                ev = str(d.get("evidence") or d.get("reason") or "").strip()
                if fp:
                    disposition_map[fp] = status
                    if ev:
                        evidence_map[fp] = ev

        if review_mode == ReviewMode.FULL_BASELINE.value:
            raw_blocking = (payload.get("blockingFindings") or []) + (payload.get("findings") or [])
            for b in raw_blocking:
                if isinstance(b, dict) and ("issue" in b or "summary" in b):
                    summary = str(b.get("issue") or b.get("summary") or b.get("description") or "").strip()
                    file_name = str(b.get("file") or b.get("component") or "general").strip()
                    req = str(b.get("requirement_id") or b.get("requirementId") or "").strip() or None
                    sev = str(b.get("severity") or "HIGH").upper().strip()
                    fp = str(b.get("fingerprint") or "").strip() or generate_finding_fingerprint(req, file_name, summary)
                    is_fol = is_non_blocking_follow_up(summary, sev)
                    new_findings.append(ReviewFinding(
                        fingerprint=fp,
                        requirement_id=req,
                        severity=sev,
                        category="CORRECTNESS",
                        file_or_component=file_name,
                        normalized_summary=summary,
                        blocking=not is_fol,
                        status=FindingStatus.FOLLOW_UP.value if is_fol else FindingStatus.OPEN.value,
                        first_seen_head=target_sha,
                        last_verified_head=target_sha,
                        source_review_run_id=run_id,
                    ))

    # 2. Parse textual review body if needed
    body_text = body or ""
    finding_blocks = re.findall(r"FINDING\s+([A-Z0-9_\-]+)\s*\n\s*(RESOLVED|OPEN)(?:\s*\n\s*evidence:\s*([^\n]+))?", body_text, re.IGNORECASE)
    for fp, status, ev in finding_blocks:
        fp_clean = fp.strip()
        disposition_map[fp_clean] = status.upper().strip()
        if ev:
            evidence_map[fp_clean] = ev.strip()

    extracted = [] if (payload and ("findings" in payload or "blockingFindings" in payload)) else extract_raw_findings_from_text(body_text)

    # 3. Apply mode-specific rules
    if review_mode == ReviewMode.FULL_BASELINE.value:
        ledger: list[ReviewFinding] = []
        seen_fps: set[str] = set()

        for item in extracted:
            summary = item["summary"]
            file_name = item["file"]
            req = item["requirement_id"]
            sev = item["severity"]
            fp = generate_finding_fingerprint(req, file_name, summary)
            if fp in seen_fps:
                continue
            seen_fps.add(fp)

            is_follow_up = is_non_blocking_follow_up(summary, sev)
            status = FindingStatus.FOLLOW_UP.value if is_follow_up else FindingStatus.OPEN.value
            blocking = not is_follow_up

            ledger.append(ReviewFinding(
                fingerprint=fp,
                requirement_id=req,
                severity=sev,
                category="CORRECTNESS",
                file_or_component=file_name,
                normalized_summary=summary,
                blocking=blocking,
                status=status,
                first_seen_head=target_sha,
                last_verified_head=target_sha,
                source_review_run_id=run_id,
            ))
            if blocking:
                blocking_reasons.append(f"{file_name}: {summary}")

        for nf in new_findings:
            if nf.fingerprint not in seen_fps:
                seen_fps.add(nf.fingerprint)
                ledger.append(nf)
                if nf.blocking:
                    blocking_reasons.append(f"{nf.file_or_component}: {nf.normalized_summary}")

        return ledger, blocking_reasons

    # In CLOSURE_VERIFY or FINAL_CONFIRMATION mode:
    # Blocker ledger is frozen.
    updated_ledger: list[ReviewFinding] = []
    
    body_lower = body_text.lower()
    raw_v_lower = (raw_verdict or "").lower().strip()
    is_general_pass = (
        raw_v_lower in {"approved", "pass"}
        or (payload and payload.get("verdict") in {"approved", "pass"})
        or any(p in body_lower for p in ("verdict: pass", "verdict: approved", "all blockers resolved", "all baseline blockers", "approved", "passes current head"))
    )


    for f in frozen:
        f_copy = ReviewFinding.from_dict(f.to_dict())
        if f.fingerprint in disposition_map:
            new_status = disposition_map[f.fingerprint]
            f_copy.status = new_status
            f_copy.last_verified_head = target_sha
            if f.fingerprint in evidence_map:
                f_copy.resolution_evidence = evidence_map[f.fingerprint]
        elif is_general_pass and f.status == FindingStatus.OPEN.value:
            f_copy.status = FindingStatus.RESOLVED.value
            f_copy.last_verified_head = target_sha
            f_copy.resolution_evidence = "Verified resolved in closure pass"
        else:
            matched_item = None
            for item in extracted:
                if match_finding_fingerprint(item["summary"], item["file"], item["requirement_id"], [f]):
                    matched_item = item
                    break
            if matched_item:
                f_copy.status = FindingStatus.OPEN.value
                f_copy.last_verified_head = target_sha
            elif f_copy.status == FindingStatus.OPEN.value and is_general_pass:
                f_copy.status = FindingStatus.RESOLVED.value
                f_copy.last_verified_head = target_sha

        if f_copy.blocking and f_copy.status in {FindingStatus.OPEN.value, FindingStatus.REGRESSION.value}:
            blocking_reasons.append(f"{f_copy.file_or_component}: {f_copy.normalized_summary}")
        updated_ledger.append(f_copy)

    # Now evaluate new findings discovered late during closure
    existing_fps = {f.fingerprint for f in updated_ledger}
    late_candidates: list[dict[str, Any]] = list(extracted)
    if payload and isinstance(payload.get("findings"), list):
        for raw in payload["findings"]:
            if isinstance(raw, dict) and "fingerprint" not in raw and ("issue" in raw or "summary" in raw):
                late_candidates.append({
                    "summary": str(raw.get("issue") or raw.get("summary") or ""),
                    "file": str(raw.get("file") or raw.get("component") or "general"),
                    "requirement_id": str(raw.get("requirementId") or raw.get("requirement_id") or "") or None,
                    "severity": str(raw.get("severity") or "MEDIUM").upper(),
                    "category": str(raw.get("category") or "CORRECTNESS"),
                })

    for item in late_candidates:
        summary = item["summary"]
        file_name = item["file"]
        req = item["requirement_id"]
        sev = item["severity"]
        matched = match_finding_fingerprint(summary, file_name, req, updated_ledger)
        if matched:
            continue

        fp = generate_finding_fingerprint(req, file_name, summary)
        if fp in existing_fps:
            continue
        existing_fps.add(fp)

        # Classify late finding (§14)
        is_regression = any(w in summary.lower() for w in ("regression", "introduced by", "broke", "broken by"))
        is_critical = is_critical_late_blocker(summary, sev)
        is_follow_up = is_non_blocking_follow_up(summary, sev)

        if is_regression:
            status = FindingStatus.REGRESSION.value
            blocking = True
            blocking_reasons.append(f"REGRESSION ({file_name}): {summary}")
        elif is_critical and not is_follow_up:
            status = FindingStatus.OPEN.value
            blocking = True
            blocking_reasons.append(f"CRITICAL LATE BLOCKER ({file_name}): {summary}")
        else:
            # Non-blocking follow up! (§14)
            status = FindingStatus.FOLLOW_UP.value
            blocking = False

        updated_ledger.append(ReviewFinding(
            fingerprint=fp,
            requirement_id=req,
            severity=sev,
            category="REGRESSION" if is_regression else ("SECURITY" if is_critical else "FOLLOW_UP"),
            file_or_component=file_name,
            normalized_summary=summary,
            blocking=blocking,
            status=status,
            first_seen_head=target_sha,
            last_verified_head=target_sha,
            source_review_run_id=run_id,
            critical_justification="Critical security/data integrity violation" if (is_critical and not is_regression) else None,
        ))

    return updated_ledger, blocking_reasons


def detect_material_scope_change(
    current_package: Any,
    baseline_context: dict[str, Any] | None,
) -> bool:
    """Detect if implementation authority has materially shifted (§16)."""
    if not baseline_context:
        return False
    baseline_reqs = set(baseline_context.get("requirementIds", []))
    current_reqs = set(current_package.requirement_ids)
    if not current_reqs.issubset(baseline_reqs) and len(current_reqs - baseline_reqs) > 0:
        return True

    base_obj = str(baseline_context.get("objective", "")).strip()
    curr_obj = str(current_package.objective).strip()
    if base_obj and curr_obj and base_obj != curr_obj:
        return True

    return False
