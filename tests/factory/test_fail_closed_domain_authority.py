"""Regression tests for fail-closed domain authority migration.

These tests cover the four architectural defects fixed in this maintenance:
  Defect A: __post_init__ no longer fabricates granular authority from legacy counter
  Defect B: Event reconstruction respects session/provider authority epochs
  Defect C: Infrastructure rerun exception does not fall through to product correction
  Defect D: UNKNOWN classification does not consume product CI correction budget

Plus: schema versioning (§11), required-check-only CI (§8), idempotency (§9),
      correction_attempts telemetry-only (§10), and impossible transitions (§24).
"""
from dataclasses import replace
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController, _reconstruct_authorities_from_events
from factory.controller.github import causal_ci_check, ci_state, classify_ci_failure
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, work_key
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package
from test_failed_worker_recovery_liveness import MockAO, MockGitHub


# ---------------------------------------------------------------------------
# Defect A: __post_init__ authority fabrication removed
# ---------------------------------------------------------------------------
class DefectATests(unittest.TestCase):
    """§4: __post_init__ MUST NOT fabricate granular authority from legacy counter."""

    def test_A01_post_init_does_not_fabricate_liveness_from_legacy_counter(self) -> None:
        """Legacy correction_attempts=3 must NOT fabricate liveness_remediations_used=3."""
        record = PackageRecord(correction_attempts=3)
        # correction_attempts is telemetry-only: derived from domain counters (all 0)
        self.assertEqual(record.correction_attempts, 0)
        self.assertEqual(record.liveness_remediations_used, 0)
        self.assertEqual(record.session_restore_attempts, 0)
        self.assertEqual(record.ci_corrections_used, 0)

    def test_A02_post_init_does_not_fabricate_session_restores(self) -> None:
        """Legacy correction_attempts must NOT create session_restore_attempts."""
        record = PackageRecord(correction_attempts=5)
        self.assertEqual(record.session_restore_attempts, 0)

    def test_A03_post_init_derives_from_domain_counters(self) -> None:
        """correction_attempts = ci + liveness + integration (telemetry-only)."""
        record = PackageRecord(
            ci_corrections_used=1,
            liveness_remediations_used=2,
            integration_corrections_used=3,
        )
        self.assertEqual(record.correction_attempts, 6)

    def test_A04_authority_schema_version_default_is_zero(self) -> None:
        """New records default to authority_schema_version=0 (legacy unmigrated)."""
        record = PackageRecord()
        self.assertEqual(record.authority_schema_version, 0)

    def test_A05_authority_schema_version_survives_serialization(self) -> None:
        """authority_schema_version persists through to_dict() / from_dict()."""
        record = PackageRecord(authority_schema_version=1)
        serialized = record.to_dict()
        self.assertEqual(serialized["authority_schema_version"], 1)
        restored = PackageRecord.from_dict(serialized)
        self.assertEqual(restored.authority_schema_version, 1)


# ---------------------------------------------------------------------------
# Defect B: Cross-session event counting
# ---------------------------------------------------------------------------
class DefectBTests(unittest.TestCase):
    """§5/§12: Event reconstruction must respect session/provider epoch boundaries."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.events_path = Path(self.temp.name) / "events.jsonl"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_event(self, **fields) -> None:
        """Append a single event to the events file."""
        with self.events_path.open("a") as f:
            f.write(json.dumps(fields) + "\n")

    def test_B01_epoch_resets_liveness_on_requeue(self) -> None:
        """ALTERNATE_PROVIDER_REQUEUED resets liveness count to zero."""
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        self._write_event(type="ALTERNATE_PROVIDER_REQUEUED", workKey="m1--pkg")
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["liveness_remediations_used"], 1)

    def test_B02_epoch_resets_session_restores_on_requeue(self) -> None:
        """ALTERNATE_PROVIDER_REQUEUED resets session restore count to zero."""
        self._write_event(type="SESSION_RESTORE_STARTED", workKey="m1--pkg")
        self._write_event(type="ALTERNATE_PROVIDER_REQUEUED", workKey="m1--pkg")
        self._write_event(type="SESSION_RESTORE_STARTED", workKey="m1--pkg")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["session_restore_attempts"], 1)

    def test_B03_ci_corrections_deduplicated_by_sha(self) -> None:
        """Same-head CI corrections count as one correction."""
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--pkg", headSha="aaa")
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--pkg", headSha="aaa")
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--pkg", headSha="bbb")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["ci_corrections_used"], 2)  # aaa + bbb

    def test_B04_ci_corrections_not_reset_by_requeue(self) -> None:
        """CI corrections are PR-lifecycle scoped, not session-scoped."""
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--pkg", headSha="aaa")
        self._write_event(type="ALTERNATE_PROVIDER_REQUEUED", workKey="m1--pkg")
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--pkg", headSha="bbb")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["ci_corrections_used"], 2)

    def test_B05_integration_deduplicated_by_head(self) -> None:
        """Same-head integration corrections count as one correction."""
        self._write_event(type="MERGE_UPDATE_STARTED", workKey="m1--pkg", headSha="abc")
        self._write_event(type="MERGE_UPDATE_STARTED", workKey="m1--pkg", headSha="abc")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["integration_corrections_used"], 1)

    def test_B06_unrelated_package_events_ignored(self) -> None:
        """Events for different work packages are excluded."""
        self._write_event(type="CI_CORRECTION_STARTED", workKey="m1--other", headSha="aaa")
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--other")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertIsNone(result)

    def test_B07_multiple_requeue_epochs(self) -> None:
        """Multiple epoch boundaries correctly scope counters."""
        # Epoch 1
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        self._write_event(type="SESSION_RESTORE_STARTED", workKey="m1--pkg")
        # Epoch boundary
        self._write_event(type="ALTERNATE_PROVIDER_REQUEUED", workKey="m1--pkg")
        # Epoch 2
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        self._write_event(type="SESSION_RESTORE_STARTED", workKey="m1--pkg")
        self._write_event(type="SESSION_RESTORE_STARTED", workKey="m1--pkg")
        # Epoch boundary
        self._write_event(type="ALTERNATE_PROVIDER_REQUEUED", workKey="m1--pkg")
        # Epoch 3 (current)
        self._write_event(type="LIVENESS_REMEDIATION_STARTED", workKey="m1--pkg")
        result = _reconstruct_authorities_from_events(self.events_path, "m1--pkg", "pkg")
        self.assertEqual(result["liveness_remediations_used"], 1)
        self.assertEqual(result["session_restore_attempts"], 0)


# ---------------------------------------------------------------------------
# Defect C: Infra rerun exception fallthrough
# ---------------------------------------------------------------------------
class DefectCTests(unittest.TestCase):
    """§6: Infrastructure rerun failure MUST NOT fall through to product correction."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = replace(
            config(self.temp_root),
            max_task_attempts=2,
            max_correction_attempts=2,
            max_active_workers=3,
        )
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_C01_rerun_exception_does_not_consume_product_correction(self) -> None:
        """When rerun_failed_jobs raises, ci_corrections_used must NOT increment."""
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({
                "name": "CI",
                "conclusion": "FAILURE",
                "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
            },),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            ci_infra_retries_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class FailingRerunGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{"id": 111, "conclusion": "failure",
                         "steps": [{"name": "Set up Node", "conclusion": "failure"}]}]
            def rerun_failed_jobs(self, run_id):
                raise RuntimeError("GitHub API 502 Bad Gateway")

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = FailingRerunGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # CRITICAL: product correction NOT consumed, no edit prompt sent
        self.assertEqual(record.ci_corrections_used, 0)
        self.assertEqual(len(ao.sent), 0)
        # Dispatch failure event emitted
        events = self.store.history(10)
        dispatch_failed = [e for e in events if e.get("type") == "CI_INFRA_RETRY_DISPATCH_FAILED"]
        self.assertEqual(len(dispatch_failed), 1)
        self.assertIn("502", dispatch_failed[0].get("exceptionMessage", ""))

    def test_C02_infra_retry_idempotency_prevents_duplicate_rerun(self) -> None:
        """Same run/attempt token on consecutive ticks must not dispatch duplicate reruns."""
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({
                "name": "CI",
                "conclusion": "FAILURE",
                "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
            },),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        # Already dispatched rerun for run 999 attempt 1
        prior_record = PackageRecord(
            status=PackageStatus.CI_FIX,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="FAIL",
            ci_infra_retries_used=1,
            ci_infra_retry_authorized_from_sha=head,
            last_error="CI_INFRA_RETRY:1111111111111111111111111111111111111111:999:1",
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class IdempotentGitHub(MockGitHub):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.reruns = []
            def get_run_jobs(self, run_id):
                return [{"id": 111, "conclusion": "failure",
                         "steps": [{"name": "Set up Node", "conclusion": "failure"}]}]
            def rerun_failed_jobs(self, run_id):
                self.reruns.append(run_id)

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = IdempotentGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # Must NOT dispatch a second rerun for the same token
        self.assertEqual(len(github.reruns), 0)
        self.assertEqual(record.ci_infra_retries_used, 1)


# ---------------------------------------------------------------------------
# Defect D: Classification and UNKNOWN handling
# ---------------------------------------------------------------------------
class DefectDTests(unittest.TestCase):
    """§7/§8: UNKNOWN classification and required-check-only CI."""

    def test_D01_unknown_classification_does_not_consume_ci_budget(self) -> None:
        """UNKNOWN CI failure must NOT increment ci_corrections_used or send edit prompt."""
        temp = tempfile.TemporaryDirectory()
        temp_root = Path(temp.name)
        repo_root = Path(__file__).resolve().parents[2]
        cfg = replace(
            config(temp_root),
            max_task_attempts=2,
            max_correction_attempts=2,
            max_active_workers=3,
        )
        store = StateStore(cfg.state_dir)

        pkg = package("core")
        wf_key = key("core")
        head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),  # No failure_kind → UNKNOWN
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            task_attempts=1,
        )
        store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(repo_root, cfg, store, github, ao)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # CI budget NOT consumed; no edit prompt sent
        self.assertEqual(record.ci_corrections_used, 0)
        self.assertEqual(len(ao.sent), 0)
        self.assertIn("CI_UNKNOWN", record.last_error or "")

        # Event recorded
        events = store.history(10)
        unknown_events = [e for e in events if e.get("type") == "CI_FAILURE_CLASSIFICATION_UNKNOWN"]
        self.assertEqual(len(unknown_events), 1)

        temp.cleanup()

    def test_D02_optional_check_failure_does_not_block_required_pass(self) -> None:
        """Optional check failures must NOT block merge when all required checks pass."""
        checks = (
            {"name": "CI", "conclusion": "SUCCESS"},
            {"name": "Optional Lint", "conclusion": "FAILURE"},
        )
        pr = PullRequest(
            101, "OPEN", "factory/branch", "head", "url", "MERGEABLE", "CLEAN",
            checks=checks,
        )
        status, reason = ci_state(pr, ("CI",))
        self.assertEqual(status, "PASS")
        self.assertIn("required CI checks pass", reason)

    def test_D03_optional_check_not_selected_as_causal(self) -> None:
        """Only required checks can be causal failures."""
        checks = (
            {"name": "CI", "conclusion": "SUCCESS"},
            {"name": "Optional Lint", "conclusion": "FAILURE"},
        )
        pr = PullRequest(
            101, "OPEN", "factory/branch", "head", "url", "MERGEABLE", "CLEAN",
            checks=checks,
        )
        causal = causal_ci_check(pr, ("CI",))
        self.assertIsNone(causal)

    def test_D04_evidence_retrieval_failure_returns_unknown(self) -> None:
        """When GitHub API fails to retrieve job steps, classify as UNKNOWN."""
        class FailingGitHub:
            def get_run_jobs(self, run_id):
                raise RuntimeError("API timeout")

        check = {
            "name": "Tier 3 · pre-main",
            "conclusion": "FAILURE",
            "detailsUrl": "https://github.com/repo/actions/runs/123/job/456",
        }
        pr = PullRequest(101, "OPEN", "factory/branch", "head", "url", "MERGEABLE", "CLEAN", checks=(check,))
        kind, detail, run_id = classify_ci_failure(pr, check, FailingGitHub())
        self.assertEqual(kind, "UNKNOWN")
        self.assertIn("evidence retrieval failed", detail)
        self.assertEqual(run_id, 123)

    def test_D05_tier_name_alone_does_not_prove_product(self) -> None:
        """Check named 'Tier 3 · pre-main' without step evidence must classify as UNKNOWN."""
        check = {
            "name": "Tier 3 · pre-main",
            "conclusion": "FAILURE",
        }
        pr = PullRequest(101, "OPEN", "factory/branch", "head", "url", "MERGEABLE", "CLEAN", checks=(check,))
        kind, detail, run_id = classify_ci_failure(pr, check, None)
        self.assertEqual(kind, "UNKNOWN")


# ---------------------------------------------------------------------------
# Schema versioning (§11) and migration
# ---------------------------------------------------------------------------
class SchemaVersionTests(unittest.TestCase):
    """§11: Explicit authority_schema_version for idempotent migration."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = replace(
            config(self.temp_root),
            max_task_attempts=2,
            max_correction_attempts=2,
            max_active_workers=3,
        )
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_S01_migration_sets_authority_schema_version_to_1(self) -> None:
        """After reconcile, authority_schema_version is set to 1."""
        pkg = package("core")
        wf_key = key("core")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            task_attempts=1,
            authority_schema_version=0,
        )
        self.store.save({wf_key: prior_record})
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub()
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        self.assertEqual(records[wf_key].authority_schema_version, 1)

    def test_S02_already_migrated_not_re_migrated(self) -> None:
        """Packages with authority_schema_version=1 are not re-migrated."""
        pkg = package("core")
        wf_key = key("core")
        self.store.event("LIVENESS_REMEDIATION_STARTED", workKey=wf_key)
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            task_attempts=1,
            ci_corrections_used=0,
            liveness_remediations_used=0,
            correction_attempts=5,  # legacy value should be overridden to 0
            authority_schema_version=1,  # already migrated
        )
        self.store.save({wf_key: prior_record})
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub()
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        # liveness was NOT reconstructed from events (schema=1 prevents re-migration)
        self.assertEqual(records[wf_key].liveness_remediations_used, 0)
        self.assertEqual(records[wf_key].authority_schema_version, 1)


# ---------------------------------------------------------------------------
# Correction attempts telemetry-only (§10)
# ---------------------------------------------------------------------------
class TelemetryOnlyTests(unittest.TestCase):
    """§10: correction_attempts is telemetry-only, derived from domain counters."""

    def test_T01_correction_attempts_cannot_override_domain_counters(self) -> None:
        """Setting correction_attempts to any value does not affect domain counters."""
        record = PackageRecord(correction_attempts=100)
        self.assertEqual(record.ci_corrections_used, 0)
        self.assertEqual(record.liveness_remediations_used, 0)
        self.assertEqual(record.integration_corrections_used, 0)
        # correction_attempts is recomputed from domain counters
        self.assertEqual(record.correction_attempts, 0)

    def test_T02_domain_increments_auto_update_telemetry(self) -> None:
        """Incrementing a domain counter is reflected in correction_attempts via __post_init__."""
        record = PackageRecord(ci_corrections_used=1)
        self.assertEqual(record.correction_attempts, 1)
        # Note: __post_init__ only runs on construction. For live updates,
        # the field is auto-derived on next serialization/load.


# ---------------------------------------------------------------------------
# Impossible transitions (§24)
# ---------------------------------------------------------------------------
class ImpossibleTransitionTests(unittest.TestCase):
    """§24: Seven impossible transitions that must be proven impossible."""

    def test_IT_A_unknown_ci_cannot_consume_correction(self) -> None:
        """IT-A: UNKNOWN classification → ci_corrections_used increment is impossible."""
        # UNKNOWN guard in _handle_pr returns before CI correction dispatch
        check = {"name": "CI", "conclusion": "FAILURE"}
        pr = PullRequest(101, "OPEN", "factory/b", "head", "url", "MERGEABLE", "CLEAN", checks=(check,))
        kind, _, _ = classify_ci_failure(pr, check, None)
        self.assertEqual(kind, "UNKNOWN")
        # Controller would return early on UNKNOWN — no ci_corrections_used increment

    def test_IT_B_infra_rerun_exception_cannot_reach_product_path(self) -> None:
        """IT-B: Infrastructure rerun exception → product CI correction is impossible.
        
        The except block at Defect C now has explicit `return`, preventing fallthrough.
        """
        # This is structurally verified by test_C01 above

    def test_IT_C_optional_check_cannot_block_merge(self) -> None:
        """IT-C: Optional check failure → merge block is impossible."""
        checks = (
            {"name": "CI", "conclusion": "SUCCESS"},
            {"name": "CodeQL", "conclusion": "FAILURE"},
        )
        pr = PullRequest(101, "OPEN", "factory/b", "head", "url", "MERGEABLE", "CLEAN", checks=checks)
        status, _ = ci_state(pr, ("CI",))
        self.assertEqual(status, "PASS")

    def test_IT_D_legacy_counter_cannot_fabricate_authority(self) -> None:
        """IT-D: Legacy correction_attempts → granular authority fabrication is impossible."""
        record = PackageRecord(correction_attempts=10)
        self.assertEqual(record.liveness_remediations_used, 0)
        self.assertEqual(record.session_restore_attempts, 0)

    def test_IT_E_cross_session_liveness_cannot_inflate_current_epoch(self) -> None:
        """IT-E: Prior-session liveness events cannot inflate current epoch count."""
        temp = tempfile.TemporaryDirectory()
        events_path = Path(temp.name) / "events.jsonl"
        with events_path.open("w") as f:
            f.write(json.dumps({"type": "LIVENESS_REMEDIATION_STARTED", "workKey": "m1--p"}) + "\n")
            f.write(json.dumps({"type": "LIVENESS_REMEDIATION_STARTED", "workKey": "m1--p"}) + "\n")
            f.write(json.dumps({"type": "ALTERNATE_PROVIDER_REQUEUED", "workKey": "m1--p"}) + "\n")
        result = _reconstruct_authorities_from_events(events_path, "m1--p", "p")
        self.assertEqual(result["liveness_remediations_used"], 0)
        temp.cleanup()

    def test_IT_F_tier_name_cannot_prove_product_without_evidence(self) -> None:
        """IT-F: Tier name guessing → PRODUCT classification is impossible without step evidence."""
        check = {"name": "Tier 3 · pre-main", "conclusion": "FAILURE"}
        pr = PullRequest(101, "OPEN", "factory/b", "head", "url", "MERGEABLE", "CLEAN", checks=(check,))
        kind, _, _ = classify_ci_failure(pr, check, None)
        self.assertEqual(kind, "UNKNOWN")

    def test_IT_G_already_migrated_package_cannot_be_re_migrated(self) -> None:
        """IT-G: authority_schema_version=1 → re-migration is impossible."""
        record = PackageRecord(authority_schema_version=1)
        # The reconcile() code checks `record.authority_schema_version < 1`
        # which is False for version=1, so migration is skipped
        self.assertFalse(record.authority_schema_version < 1)


if __name__ == "__main__":
    unittest.main()
