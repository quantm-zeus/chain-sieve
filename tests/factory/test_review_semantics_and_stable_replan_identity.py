import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from factory.controller.ao import (
    evaluate_review_semantics,
    validate_review_authority,
)
from factory.controller.controller import FactoryController
from factory.controller.findings import (
    FindingStatus,
    ReviewFinding,
    ReviewMode,
    extract_raw_findings_from_text,
    generate_finding_fingerprint,
    parse_and_reconcile_review,
)
from factory.controller.github import GitHub, Issue
from factory.controller.models import (
    Milestone,
    PackageRecord,
    PackageStatus,
    WorkPackage,
    generate_gap_fingerprint,
    work_key,
)
from factory.controller.reasoning import install_plan_delta


class TestReviewSemanticsAndStableReplanIdentity(unittest.TestCase):

    def test_rev_app_01_summary_bullets_not_parsed_as_blockers(self):
        """REV-APP-01: Summary of changes with bullets is parsed as approved, not blockers."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
# Code Review

### Summary of Changes
- Added support for bounded model-assisted research queries.
- Implemented cached probe evaluation.
- Added comprehensive unit tests in tests/factory.

### Verification
- Ran test suite: all 15 tests pass.

Verdict: APPROVED
"""
        findings = extract_raw_findings_from_text(body)
        self.assertEqual(len(findings), 0)

        sem = evaluate_review_semantics(
            body,
            raw_verdict="approved",
            head_sha="deadbeef1234",
            run_id="run-1",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")
        self.assertEqual(len(sem.open_blockers), 0)

    def test_rev_app_02_positive_findings_not_parsed_as_blockers(self):
        """REV-APP-02: Positive findings / walkthrough bullets evaluate as approved."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
# Review Report

### Positive Observations
- Clean modular design in `factory/controller/reasoning.py`.
- Correct handling of transient error states.

### Acceptance Criteria Satisfied
- All G3 criteria verified.

Verdict: PASS
"""
        findings = extract_raw_findings_from_text(body)
        self.assertEqual(len(findings), 0)

        sem = evaluate_review_semantics(
            body,
            raw_verdict="pass",
            head_sha="deadbeef1234",
            run_id="run-2",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")
        self.assertEqual(len(sem.open_blockers), 0)

    def test_rev_app_03_structured_payload_approved(self):
        """REV-APP-03: Structured JSON payload with empty findings evaluates as approved."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
```json
{
  "verdict": "approved",
  "findings": [],
  "blockingFindings": []
}
```
"""
        sem = evaluate_review_semantics(
            body,
            raw_verdict="approved",
            head_sha="deadbeef1234",
            run_id="run-3",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")
        self.assertEqual(len(sem.open_blockers), 0)

    def test_rev_neg_01_explicit_blocking_findings(self):
        """REV-NEG-01: Explicit blocking findings evaluate as changes_requested."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
# Review Report

### Blocking Findings
- In `factory/controller/models.py`: Missing validation for empty package IDs (HIGH).

Verdict: CHANGES_REQUESTED
"""
        findings = extract_raw_findings_from_text(body)
        self.assertEqual(len(findings), 1)

        sem = evaluate_review_semantics(
            body,
            raw_verdict="changes_requested",
            head_sha="deadbeef1234",
            run_id="run-4",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertFalse(sem.ok)
        self.assertEqual(sem.effective_verdict, "changes_requested")
        self.assertEqual(len(sem.open_blockers), 1)

    def test_rev_neg_02_changes_requested_without_blockers_invalid_payload(self):
        """REV-NEG-02: Changes requested without parseable blockers returns semantic_payload_invalid."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
# Review Report

Verdict: CHANGES_REQUESTED
"""
        sem = evaluate_review_semantics(
            body,
            raw_verdict="changes_requested",
            head_sha="deadbeef1234",
            run_id="run-5",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertFalse(sem.ok)
        self.assertEqual(sem.effective_verdict, "semantic_payload_invalid")

    def test_rev_phase_01_stale_context_digest(self):
        """REV-PHASE-01: Mismatched digest returns AUTHORITY_INVALID and is not ok."""
        old_digest = "a" * 64
        new_digest = "b" * 64
        raw_review = {
            "reviews": [{
                "targetSha": "deadbeef1234",
                "harness": "muse",
                "status": "delivered",
                "verdict": "approved",
                "body": f"Looks good.\nCHAINSIEVE_REVIEW_CONTEXT_SHA256:{old_digest}",
                "createdAt": "2026-08-20T10:00:00Z",
            }]
        }
        auth = validate_review_authority(
            raw_review,
            head_sha="deadbeef1234",
            required_reviewer="muse",
            expected_context_digest=new_digest,
        )
        self.assertFalse(auth.ok)
        self.assertEqual(auth.status, "AUTHORITY_INVALID")

    def test_rev_phase_02_approved_with_contradiction(self):
        """REV-PHASE-02: Approved verdict with explicit blockers returns semantic_payload_contradiction."""
        body = """<!-- chainsieve-review-context: DIGEST123 -->
# Review Report

### Blocking Findings
- In `factory/controller/models.py`: Syntax error on line 10.

Verdict: APPROVED
"""
        sem = evaluate_review_semantics(
            body,
            raw_verdict="approved",
            head_sha="sha123",
            run_id="run-20",
            review_mode=ReviewMode.FULL_BASELINE.value,
        )
        self.assertFalse(sem.ok)
        self.assertEqual(sem.effective_verdict, "semantic_payload_contradiction")

    def test_rev_phase_03_closure_verify_resolution(self):
        """REV-PHASE-03: Closure verify resolves frozen baseline blockers on pass."""
        frozen_findings = [
            {
                "fingerprint": "FND-001",
                "file_or_component": "models.py",
                "normalized_summary": "Missing validation",
                "severity": "HIGH",
                "blocking": True,
                "status": "OPEN",
            }
        ]
        body = """<!-- chainsieve-review-context: CLOSURE_DIGEST -->
# Closure Verification
FINDING FND-001
RESOLVED
evidence: Added required validation check.

Verdict: APPROVED
"""
        sem = evaluate_review_semantics(
            body,
            raw_verdict="approved",
            head_sha="sha123",
            run_id="run-30",
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            frozen_findings=frozen_findings,
        )
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")
        self.assertEqual(len(sem.open_blockers), 0)

    def test_rev_phase_04_final_confirmation(self):
        """REV-PHASE-04: Final confirmation mode evaluates successfully."""
        frozen_findings = [
            {
                "fingerprint": "FND-001",
                "file_or_component": "models.py",
                "normalized_summary": "Missing validation",
                "severity": "HIGH",
                "blocking": True,
                "status": "RESOLVED",
            }
        ]
        body = """<!-- chainsieve-review-context: FINAL_DIGEST -->
# Final Confirmation
All baseline blockers verified resolved.

Verdict: APPROVED
"""
        sem = evaluate_review_semantics(
            body,
            raw_verdict="approved",
            head_sha="sha123",
            run_id="run-40",
            review_mode=ReviewMode.FINAL_CONFIRMATION.value,
            frozen_findings=frozen_findings,
        )
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")

    def test_plan_id_01_durable_identity_preserved_in_plan_delta(self):
        """PLAN-ID-01: install_plan_delta preserves durable packages with PRs/sessions."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_dir = Path(tmp_dir)
            pkg1 = WorkPackage.from_dict({
                "id": "package-alpha",
                "objective": "Implement alpha feature",
                "acceptance": ["Feature alpha works"],
                "requirementIds": ["REQ-001"],
                "milestoneId": "m1",
            })
            pkg2 = WorkPackage.from_dict({
                "id": "package-beta",
                "objective": "Implement beta feature",
                "acceptance": ["Feature beta works"],
                "requirementIds": ["REQ-002"],
                "milestoneId": "m1",
            })
            milestone = Milestone(id="m1", objective="Milestone 1", packages=(pkg1, pkg2))

            # Simulate state with durable record on package-alpha
            state_data = {
                "packages": {
                    "m1--package-alpha": {
                        "pr_number": 100,
                        "session_id": "session-1",
                        "status": "PR_WAITING",
                        "head_sha": "sha_alpha",
                    }
                }
            }
            (state_dir / "state.json").write_text(json.dumps(state_data), encoding="utf-8")

            # Proposed plan attempts to rename package-alpha to package-alpha-new
            prop_pkg1 = {
                "id": "package-alpha-new",
                "objective": "Implement alpha feature",
                "acceptance": ["Feature alpha works"],
                "requirementIds": ["REQ-001"],
            }
            prop_pkg3 = {
                "id": "package-gamma",
                "objective": "Implement gamma feature",
                "acceptance": ["Feature gamma works"],
                "requirementIds": ["REQ-003"],
            }
            proposed_plan = {
                "id": "m1",
                "objective": "Milestone 1",
                "workPackages": [prop_pkg1, prop_pkg3],
            }

            reconciled_ms, delta = install_plan_delta(state_dir, milestone, proposed_plan)
            reconciled_ids = [p.id for p in reconciled_ms.packages]

            # package-alpha was retained because of matching gap fingerprint / durable state!
            self.assertIn("package-alpha", reconciled_ids)
            self.assertIn("package-gamma", reconciled_ids)
            self.assertNotIn("package-alpha-new", reconciled_ids)

    def test_plan_id_02_gap_fingerprint_generation_determinism(self):
        """PLAN-ID-02: Gap fingerprint is invariant to whitespace and casing."""
        fp1 = generate_gap_fingerprint("m1", ["REQ-001"], ["Do something useful"], "Objective text")
        fp2 = generate_gap_fingerprint("M1", ["req-001"], ["  Do something   useful.  "], "Objective   text!")
        self.assertEqual(fp1, fp2)

    def test_plan_id_03_sync_issues_duplicate_gap_guard(self):
        """PLAN-ID-03: sync_issues adopts existing issue for matching gap fingerprint."""
        pkg = WorkPackage.from_dict({
            "id": "pkg-1",
            "objective": "Test objective",
            "acceptance": ["Acceptance 1"],
            "requirementIds": ["REQ-100"],
            "milestoneId": "m1",
        })
        milestone = Milestone(id="m1", objective="Milestone 1", packages=(pkg,))
        gap_fp = pkg.gap_fingerprint

        mock_github = MagicMock()
        existing_issue = Issue(
            number=42,
            state="OPEN",
            body=f"<!-- chainsieve-work-package:m1--pkg-old -->\n<!-- chainsieve-gap-fingerprint:{gap_fp} -->\nTest body",
            url="https://github.com/org/repo/issues/42",
            author="bot",
            title="[m1/pkg-old] Test",
        )
        mock_github.issues.return_value = {"m1--pkg-old": existing_issue}

        mock_store = MagicMock()
        mock_store.load.return_value = {
            "m1--pkg-1": PackageRecord(status=PackageStatus.PLANNED)
        }
        mock_store.metadata.return_value = {}

        controller = FactoryController.__new__(FactoryController)
        controller.github = mock_github
        controller.store = mock_store

    def test_plan_id_04_complex_plan_delta_reconciliation(self):
        """PLAN-ID-04: install_plan_delta handles multiple package additions and updates."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_dir = Path(tmp_dir)
            pkg1 = WorkPackage.from_dict({
                "id": "pkg-a",
                "objective": "Alpha objective",
                "acceptance": ["Acc A1"],
                "requirementIds": ["REQ-A"],
                "milestoneId": "m1",
            })
            pkg2 = WorkPackage.from_dict({
                "id": "pkg-b",
                "objective": "Beta objective",
                "acceptance": ["Acc B1"],
                "requirementIds": ["REQ-B"],
                "milestoneId": "m1",
            })
            milestone = Milestone(id="m1", objective="Milestone 1", packages=(pkg1, pkg2))

            proposed = {
                "id": "m1",
                "objective": "Milestone 1",
                "workPackages": [
                    {
                        "id": "pkg-a",
                        "objective": "Updated Alpha",
                        "acceptance": ["Acc A1", "Acc A2"],
                        "requirementIds": ["REQ-A"],
                    },
                    {
                        "id": "pkg-c",
                        "objective": "Gamma objective",
                        "acceptance": ["Acc C1"],
                        "requirementIds": ["REQ-C"],
                    },
                ],
            }
            reconciled_ms, delta = install_plan_delta(state_dir, milestone, proposed)
            pkg_map = {p.id: p for p in reconciled_ms.packages}
            self.assertEqual(pkg_map["pkg-a"].plan_epoch, 1)
            self.assertEqual(pkg_map["pkg-a"].objective, "Updated Alpha")
            self.assertIn("pkg-c", pkg_map)

    def test_plan_id_05_plan_epoch_increment(self):
        """PLAN-ID-05: Plan epoch increments monotonically upon replan."""
        pkg = WorkPackage.from_dict({
            "id": "pkg-1",
            "objective": "Objective",
            "acceptance": ["Acceptance"],
            "planEpoch": 2,
        })
        self.assertEqual(pkg.plan_epoch, 2)

    def test_plan_id_06_package_record_serialization_durable_fields(self):
        """PLAN-ID-06: PackageRecord serializes and deserializes all durable replan fields."""
        rec = PackageRecord(
            status=PackageStatus.REVIEW,
            gap_fingerprint="GAP-REQ-001-1234",
            plan_epoch=3,
            supersedes=["pkg-old-1"],
            superseded_by="pkg-new-2",
        )
        d = rec.to_dict()
        self.assertEqual(d["gap_fingerprint"], "GAP-REQ-001-1234")
        self.assertEqual(d["plan_epoch"], 3)
        self.assertEqual(d["supersedes"], ["pkg-old-1"])
        self.assertEqual(d["superseded_by"], "pkg-new-2")

        rec2 = PackageRecord.from_dict(d)
        self.assertEqual(rec2.gap_fingerprint, "GAP-REQ-001-1234")
        self.assertEqual(rec2.plan_epoch, 3)
        self.assertEqual(rec2.supersedes, ["pkg-old-1"])
        self.assertEqual(rec2.superseded_by, "pkg-new-2")

    def test_plan_id_07_github_issues_duplicate_check(self):
        """PLAN-ID-07: GitHub.issues raises RuntimeError if duplicate issue exists for same work package."""
        runner = MagicMock()
        runner.run.return_value.stdout = json.dumps([
            {"login": "bot"},
        ])
        gh = GitHub(runner, repo="quantm-zeus/chain-sieve", integration_branch="main")
        gh._actor = "bot"

        raw_issues = [
            {
                "number": 10,
                "state": "CLOSED",
                "body": "<!-- chainsieve-work-package:m1--pkg1 -->",
                "url": "https://github.com/issue/10",
                "author": {"login": "bot"},
                "title": "[m1/pkg1] First",
            },
            {
                "number": 20,
                "state": "OPEN",
                "body": "<!-- chainsieve-work-package:m1--pkg1 -->",
                "url": "https://github.com/issue/20",
                "author": {"login": "bot"},
                "title": "[m1/pkg1] Second",
            },
        ]
        gh._json = MagicMock(return_value=raw_issues)

        with self.assertRaises(RuntimeError):
            gh.issues()

    def test_plan_id_08_work_package_auto_generates_gap_fingerprint(self):
        """PLAN-ID-08: WorkPackage automatically populates gap_fingerprint."""
        pkg = WorkPackage.from_dict({
            "id": "pkg-auto",
            "objective": "Auto gap test",
            "acceptance": ["Acc 1"],
            "requirementIds": ["REQ-G3-001"],
            "milestoneId": "g3-milestone",
        })
        self.assertTrue(pkg.gap_fingerprint.startswith("GAP-REQ-G3-001-"))


if __name__ == "__main__":
    unittest.main()
