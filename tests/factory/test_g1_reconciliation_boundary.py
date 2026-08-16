from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from factory.controller.commands import CommandResult, CommandRunner
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage, work_key
from factory.controller.reasoning import (
    ConvergenceOutputRejectedError,
    ReasoningContextUnavailableError,
    ReasoningRunner,
    _format_reasoning_prompt,
    _validate_requirement_ids,
    audit_remediation,
    authoritative_requirement_ids,
    build_reasoning_context,
    is_product_roadmap_milestone,
    preflight_convergence_context,
    reconcile_durable_state,
)
from factory.controller.store import StateStore
from test_controller import config as test_config, key as make_key, milestone as make_milestone, package as make_package


class G1ReconciliationAndPlanningBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = test_config(self.root)
        self.store = StateStore(self.config.state_dir)
        self.store.prepare()

        # Set up repository structure with constitution, prompts, schemas, spec manifests, roadmap
        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nTest constitution.", encoding="utf-8")
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts" / "convergence.md").write_text("Audit convergence.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "final-audit.md").write_text("Audit final.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "planner.md").write_text("Plan next milestone.", encoding="utf-8")
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text("{}", encoding="utf-8")
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text("{}", encoding="utf-8")
        (self.root / "factory" / "schemas" / "milestone-plan.schema.json").write_text("{}", encoding="utf-8")

        (self.root / "specs" / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "specs" / "factory" / "roadmap.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "milestones": [
                    {"id": "g0-contract-foundation", "objective": "G0 objective"},
                    {"id": "g1-deterministic-signal-execution", "objective": "G1 objective"},
                ],
            }),
            encoding="utf-8",
        )

        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "description": "Canonical identity"},
                    {"id": "FR-DATA-004", "description": "Online/offline feature consistency"},
                    {"id": "FR-SIG-001", "description": "Versioned Feature Registry"},
                    {"id": "FR-SIG-002", "description": "Candidate funnel"},
                    {"id": "FR-TRD-001", "description": "Trade event normalization"},
                    {"id": "FR-TRACE-002", "description": "Traceability"},
                    {"id": "FR-EVAL-019", "description": "Evaluation baseline"},
                ],
                "acceptanceCriteria": [
                    {"id": "AC-040", "description": "Outcome profiles"},
                    {"id": "AC-136", "description": "Feature robustness"},
                    {"id": "AC-230", "description": "Pool adapter contracts"},
                    {"id": "AC-240", "description": "Candidate denominator"},
                    {"id": "AC-267", "description": "Decision traceability"},
                ],
                "invariants": [
                    {"id": "INV-001", "description": "Deterministic execution"},
                ],
            }),
            encoding="utf-8",
        )

        # Committed static plan is G0
        self.g0_pkg = make_package("g0-domain-contracts")
        self.g0_pkg["requirementIds"] = ["FR-DATA-001"]
        self.config.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.plan_path.write_text(
            json.dumps({"id": "g0-contract-foundation", "objective": "G0", "workPackages": [self.g0_pkg]}),
            encoding="utf-8",
        )

        # Active milestone on disk is G1
        self.g1_pkg100 = {
            "id": "deterministic-snapshots-features",
            "objective": "Snapshots and features",
            "acceptance": ["stable output"],
            "dependencies": [],
            "parallelizable": True,
            "preferredProvider": "muse",
            "risk": "MEDIUM",
            "requirementIds": ["FR-DATA-004", "FR-SIG-001", "AC-136"],
            "authorizedProtectedPaths": [],
        }
        self.g1_milestone_dict = {
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 execution",
            "schemaVersion": 1,
            "workPackages": [self.g1_pkg100],
        }
        (self.config.state_dir / "active-milestone.json").write_text(
            json.dumps(self.g1_milestone_dict, indent=2),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_1_committed_g0_plus_active_g1_reconciliation_preserves_g1_records_and_session(self) -> None:
        """TEST 1: Committed static plan = G0, runtime active = G1. G1 ACTIVE worker with live session survives reconciliation."""
        g1_ms = self.config.load_milestone()
        self.assertEqual(g1_ms.id, "g1-deterministic-signal-execution")

        key_g0 = make_key("g0-domain-contracts", "g0-contract-foundation")
        key_g1 = make_key("deterministic-snapshots-features", "g1-deterministic-signal-execution")

        # G0 completed historical record, G1 active worker record
        initial_records = {
            key_g0: PackageRecord(status=PackageStatus.COMPLETE, issue_number=85),
            key_g1: PackageRecord(
                status=PackageStatus.ACTIVE,
                session_id="chainsieve-76",
                issue_number=100,
                provider="muse",
                branch=f"factory/{key_g1}",
            ),
        }
        self.store.save(initial_records)

        mock_ao = MagicMock()
        reconciled_records, reconciled_meta = reconcile_durable_state(
            self.store, g1_ms, self.root, mock_ao
        )

        # G1 record remains present and ACTIVE
        self.assertIn(key_g1, reconciled_records)
        self.assertEqual(reconciled_records[key_g1].status, PackageStatus.ACTIVE)
        self.assertEqual(reconciled_records[key_g1].session_id, "chainsieve-76")

        # AO kill was NOT called on G1 session
        mock_ao.kill.assert_not_called()

        # Historical G0 record is preserved
        self.assertIn(key_g0, reconciled_records)
        self.assertEqual(reconciled_records[key_g0].status, PackageStatus.COMPLETE)

        # Events do not list G1 key in syntheticRemoved
        events = self.store.history(10)
        for ev in events:
            if ev.get("type") == "STATE_RECONCILED":
                removed = ev.get("syntheticRemoved", [])
                self.assertNotIn(key_g1, removed)

    def test_2_all_g1_statuses_survive_reconciliation(self) -> None:
        """TEST 2: Legitimate current-milestone records survive across all non-complete statuses."""
        g1_ms = self.config.load_milestone()
        key_g1 = make_key("deterministic-snapshots-features", "g1-deterministic-signal-execution")

        statuses_to_test = [
            PackageStatus.PLANNED,
            PackageStatus.READY,
            PackageStatus.STARTING,
            PackageStatus.ACTIVE,
            PackageStatus.IDLE,
            PackageStatus.WAITING_INPUT,
            PackageStatus.PR_WAITING,
            PackageStatus.CI,
            PackageStatus.REVIEW,
            PackageStatus.BLOCKED,
            PackageStatus.FAILED,
            PackageStatus.STUCK,
        ]

        mock_ao = MagicMock()
        for status in statuses_to_test:
            with self.subTest(status=status):
                self.store.save({
                    key_g1: PackageRecord(
                        status=status,
                        session_id="chainsieve-active-session",
                        issue_number=100,
                    )
                })
                reconciled_records, _ = reconcile_durable_state(
                    self.store, g1_ms, self.root, mock_ao
                )
                self.assertIn(key_g1, reconciled_records)
                self.assertEqual(reconciled_records[key_g1].status, status)
                self.assertEqual(reconciled_records[key_g1].session_id, "chainsieve-active-session")
                mock_ao.kill.assert_not_called()

    def test_3_stale_historical_record_survives_non_destructively(self) -> None:
        """TEST 3: Historical completed records outside current milestone survive reconciliation."""
        g1_ms = self.config.load_milestone()
        key_hist = make_key("historical-package", "g0-contract-foundation")

        self.store.save({
            key_hist: PackageRecord(status=PackageStatus.COMPLETE, issue_number=80),
        })

        mock_ao = MagicMock()
        reconciled_records, _ = reconcile_durable_state(
            self.store, g1_ms, self.root, mock_ao
        )
        self.assertIn(key_hist, reconciled_records)
        self.assertEqual(reconciled_records[key_hist].status, PackageStatus.COMPLETE)
        mock_ao.kill.assert_not_called()

    def test_4_actual_invalid_remediation_handled_and_idempotent(self) -> None:
        """TEST 4: Deterministically proven invalid synthetic remediation is purged, while legitimate records survive."""
        g1_ms = self.config.load_milestone()
        key_legit = make_key("deterministic-snapshots-features", "g1-deterministic-signal-execution")
        key_synth = make_key("g1-deterministic-signal-execution-convergence-evidence", "g1-deterministic-signal-execution")

        self.store.save({
            key_legit: PackageRecord(status=PackageStatus.ACTIVE, issue_number=100, session_id="chainsieve-legit"),
            key_synth: PackageRecord(status=PackageStatus.ACTIVE, issue_number=999, session_id="chainsieve-bad"),
        })

        (self.config.state_dir / "remediation-plan.json").write_text(
            json.dumps({
                "milestoneId": "g1-deterministic-signal-execution",
                "workPackages": [
                    {"id": "g1-deterministic-signal-execution-convergence-evidence", "objective": "Restore read-access to constitution"}
                ],
            }),
            encoding="utf-8",
        )

        mock_ao = MagicMock()
        reconciled_records, _ = reconcile_durable_state(
            self.store, g1_ms, self.root, mock_ao
        )

        # Legitimate package survives
        self.assertIn(key_legit, reconciled_records)
        self.assertEqual(reconciled_records[key_legit].session_id, "chainsieve-legit")

        # Invalid synthetic package removed and session killed
        self.assertNotIn(key_synth, reconciled_records)
        mock_ao.kill.assert_called_with("chainsieve-bad")

        # Second run is idempotent and does not mutate healthy state
        mock_ao.reset_mock()
        reconciled_records2, _ = reconcile_durable_state(
            self.store, g1_ms, self.root, mock_ao
        )
        self.assertIn(key_legit, reconciled_records2)
        mock_ao.kill.assert_not_called()

    def test_5_state_migration_idempotency(self) -> None:
        """TEST 5: State migration runs once, sets version marker, and is idempotent on repeat."""
        key_legit = make_key("deterministic-snapshots-features", "g1-deterministic-signal-execution")
        key_old98 = make_key("g0-contract-foundation-convergence-evidence", "g0-contract-foundation")

        self.store.save({
            key_legit: PackageRecord(status=PackageStatus.ACTIVE, issue_number=100),
            key_old98: PackageRecord(status=PackageStatus.ACTIVE, issue_number=98, session_id="sess-98"),
        })

        g1_ms = self.config.load_milestone()
        mock_ao = MagicMock()

        # Run 1: cleans up historical issue 98
        records1, meta1 = reconcile_durable_state(self.store, g1_ms, self.root, mock_ao)
        self.assertIn(key_legit, records1)
        self.assertNotIn(key_old98, records1)
        self.assertEqual(meta1.get("stateMigrationVersion"), 1)
        mock_ao.kill.assert_called_with("sess-98")

        # Run 2: no-op, perfectly idempotent
        mock_ao.reset_mock()
        records2, meta2 = reconcile_durable_state(self.store, g1_ms, self.root, mock_ao)
        self.assertIn(key_legit, records2)
        self.assertEqual(meta2.get("stateMigrationVersion"), 1)
        mock_ao.kill.assert_not_called()

    def test_6_planner_validation_rejects_empty_ids_on_product_package(self) -> None:
        """TEST 6: Normal product package with zero requirement IDs is rejected by planner validation."""
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 objective",
            "workPackages": [
                {
                    "id": "empty-req-package",
                    "objective": "Test package",
                    "acceptance": ["test passes"],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": [],
                }
            ],
        })
        with self.assertRaisesRegex(RuntimeError, "must specify non-empty normative requirement IDs"):
            _validate_requirement_ids(self.root, ms)

    def test_7_planner_validation_rejects_unknown_and_malformed_and_duplicate_ids(self) -> None:
        """TEST 7: Unknown, malformed, or duplicate requirement IDs on product packages are rejected."""
        # Unknown ID
        ms_unknown = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 objective",
            "workPackages": [
                {
                    "id": "pkg-a",
                    "objective": "Test package",
                    "acceptance": ["test passes"],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": ["FR-UNKNOWN-999"],
                }
            ],
        })
        with self.assertRaisesRegex(RuntimeError, "unknown normative requirement ID"):
            _validate_requirement_ids(self.root, ms_unknown)

        # Malformed ID
        ms_malformed = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 objective",
            "workPackages": [
                {
                    "id": "pkg-b",
                    "objective": "Test package",
                    "acceptance": ["test passes"],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": ["not-a-valid-req-id"],
                }
            ],
        })
        with self.assertRaisesRegex(RuntimeError, "unknown normative requirement ID"):
            _validate_requirement_ids(self.root, ms_malformed)

        # Duplicate ID rejected at model ingestion
        with self.assertRaisesRegex(ValueError, "duplicate requirementIds"):
            Milestone.from_dict({
                "id": "g1-deterministic-signal-execution",
                "objective": "G1 objective",
                "workPackages": [
                    {
                        "id": "pkg-c",
                        "objective": "Test package",
                        "acceptance": ["test passes"],
                        "dependencies": [],
                        "parallelizable": True,
                        "preferredProvider": "muse",
                        "risk": "MEDIUM",
                        "requirementIds": ["FR-DATA-004", "FR-DATA-004"],
                    }
                ],
            })

    def test_8_planner_validation_accepts_valid_authoritative_ids(self) -> None:
        """TEST 8: Valid authoritative requirement IDs on product packages are accepted."""
        ms_valid = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 objective",
            "workPackages": [
                {
                    "id": "pkg-valid",
                    "objective": "Snapshots",
                    "acceptance": ["test passes"],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": ["FR-DATA-004", "AC-136"],
                }
            ],
        })
        # Should not raise
        _validate_requirement_ids(self.root, ms_valid)

    def test_9_canary_milestone_with_empty_requirement_ids_allowed(self) -> None:
        """TEST 9: Factory live canary packages intentionally without product IDs are permitted."""
        ms_canary = Milestone.from_dict({
            "id": "factory-live-canary-20260813",
            "objective": "Canary execution",
            "workPackages": [
                {
                    "id": "canary-muse",
                    "objective": "Canary task",
                    "acceptance": ["canary passes"],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": [],
                }
            ],
        })
        self.assertFalse(is_product_roadmap_milestone(self.root, ms_canary.id))
        # Should not raise
        _validate_requirement_ids(self.root, ms_canary)

    def test_10_reasoning_context_preflight_fail_closed_on_invalid_git_sha(self) -> None:
        """TEST 10: Preflight context correctly and independently exercises all four SHA branches (runner + subprocess)."""
        ms = self.config.load_milestone()
        valid_sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

        # Case 1: Runner returns non-zero git result
        mock_runner_fail = MagicMock()
        mock_runner_fail.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "", "git error", 1)
        with self.assertRaises(ReasoningContextUnavailableError):
            preflight_convergence_context(self.root, self.config, ms, self.store, mock_runner_fail)

        # Case 2: Runner returns success + all-zero SHA
        mock_runner_zero = MagicMock()
        mock_runner_zero.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "0" * 40, "", 0)
        with self.assertRaises(ReasoningContextUnavailableError):
            preflight_convergence_context(self.root, self.config, ms, self.store, mock_runner_zero)

        # Case 3: Runner returns success + malformed/short SHA
        mock_runner_short = MagicMock()
        mock_runner_short.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "abc123", "", 0)
        with self.assertRaises(ReasoningContextUnavailableError):
            preflight_convergence_context(self.root, self.config, ms, self.store, mock_runner_short)

        # Case 4: Runner returns success + valid 40-character hex SHA
        mock_runner_valid = MagicMock()
        mock_runner_valid.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), valid_sha, "", 0)
        ctx_runner = preflight_convergence_context(self.root, self.config, ms, self.store, mock_runner_valid)
        self.assertEqual(ctx_runner["headSha"], valid_sha)

        # Subprocess path (runner is None)
        # Subprocess Case 1: Non-zero exit code
        with patch("subprocess.run", return_value=MagicMock(returncode=1, stdout="", stderr="error")):
            with self.assertRaises(ReasoningContextUnavailableError):
                preflight_convergence_context(self.root, self.config, ms, self.store, None)

        # Subprocess Case 2: Success + all-zero SHA
        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="0" * 40, stderr="")):
            with self.assertRaises(ReasoningContextUnavailableError):
                preflight_convergence_context(self.root, self.config, ms, self.store, None)

        # Subprocess Case 3: Success + malformed SHA
        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="not-a-valid-sha", stderr="")):
            with self.assertRaises(ReasoningContextUnavailableError):
                preflight_convergence_context(self.root, self.config, ms, self.store, None)

        # Subprocess Case 4: Success + valid 40-character hex SHA
        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout=valid_sha, stderr="")):
            ctx_sub = preflight_convergence_context(self.root, self.config, ms, self.store, None)
            self.assertEqual(ctx_sub["headSha"], valid_sha)

    def test_11_reasoning_context_preflight_records_sha256_sources_and_valid_sha(self) -> None:
        """TEST 11: Preflight context captures SHA-256 digests for all constitution/manifest/planning inputs."""
        ms = self.config.load_milestone()
        valid_sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout=valid_sha, stderr="")):
            ctx = preflight_convergence_context(self.root, self.config, ms, self.store)

        self.assertEqual(ctx["headSha"], valid_sha)
        self.assertIn("sources", ctx)
        self.assertIn("factory/constitution.md", ctx["sources"])
        self.assertIn("docs/spec/product.requirements.json", ctx["sources"])
        self.assertEqual(len(ctx["sources"]["factory/constitution.md"]), 64)

    def test_12_final_audit_preflight_fail_closed_without_plan_mutation(self) -> None:
        """TEST 12: Final audit uses deterministic preflight and fails closed on missing context without product plan mutation."""
        # Unlink constitution
        (self.root / "factory" / "constitution.md").unlink()

        mock_runner = MagicMock()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        output_path = self.config.state_dir / "final-audit.json"
        with self.assertRaises(ReasoningContextUnavailableError):
            runner.final_audit(output_path)

        # Verify no remediation plan written
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())

    def test_13_reconciliation_preserves_legitimate_package_with_convergence_evidence_in_name(self) -> None:
        """TEST 13: Legitimate package whose ID happens to contain 'convergence-evidence' is NOT deleted by reconciliation."""
        g1_ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 with legitimate evidence package",
            "workPackages": [
                {
                    "id": "signal-convergence-evidence",
                    "objective": "Compute deterministic convergence evidence metrics for materialized signals.",
                    "acceptance": ["Metrics match expected byte outputs under FR-SIG-001."],
                    "dependencies": [],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": ["FR-SIG-001", "AC-136"],
                }
            ],
        })
        key_legit = make_key("signal-convergence-evidence", "g1-deterministic-signal-execution")
        self.store.save({
            key_legit: PackageRecord(status=PackageStatus.ACTIVE, issue_number=110, session_id="chainsieve-legit-ev"),
        }, {"stateMigrationVersion": 1})

        mock_ao = MagicMock()
        reconciled_records, _ = reconcile_durable_state(self.store, g1_ms, self.root, mock_ao)
        self.assertIn(key_legit, reconciled_records)
        self.assertEqual(reconciled_records[key_legit].session_id, "chainsieve-legit-ev")
        mock_ao.kill.assert_not_called()

    def test_14_final_audit_fail_closed_on_requirement_traceability(self) -> None:
        """TEST 14: Final audit remediation strictly enforces authoritative requirement traceability."""
        ms = self.config.load_milestone()

        # 1. Valid finding with authoritative requirement IDs -> accepted
        valid_audit = {
            "status": "NOT_CONVERGED",
            "blocking_gaps": [
                "Feature calculation inconsistency under FR-DATA-004 and AC-136 across unordered inputs"
            ],
        }
        pkg = audit_remediation(ms, valid_audit, self.root)
        self.assertIn("FR-DATA-004", pkg["requirementIds"])
        self.assertIn("AC-136", pkg["requirementIds"])
        self.assertGreater(len(pkg["requirementIds"]), 0)

        # 2. Product-sounding finding with zero requirement IDs -> rejected
        no_req_audit = {
            "status": "NOT_CONVERGED",
            "blocking_gaps": [
                "Signal materialization needs refactoring of internal helper functions"
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm_no_req:
            audit_remediation(ms, no_req_audit, self.root)
        self.assertEqual(cm_no_req.exception.failure_class, "MISSING_REQUIREMENT_EVIDENCE")

        # 3. Explicit unknown requirement ID -> rejected
        unknown_audit = {
            "status": "NOT_CONVERGED",
            "requirementIds": ["FR-UNKNOWN-9999"],
            "blocking_gaps": ["Unmapped deficiency"],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm_unk:
            audit_remediation(ms, unknown_audit, self.root)
        self.assertEqual(cm_unk.exception.failure_class, "UNKNOWN_REQUIREMENT_ID")

        # 4. Pure tooling findings -> rejected
        tooling_audit = {
            "status": "NOT_CONVERGED",
            "blocking_gaps": [
                "Tooling read-access error when inspecting /tmp directory",
                "Cannot read factory infrastructure configuration",
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm_tool:
            audit_remediation(ms, tooling_audit, self.root)
        self.assertEqual(cm_tool.exception.failure_class, "TOOLING_REMEDIATION_REJECTED")

        # 5. Mixed tooling + valid product finding -> only valid product finding retained
        mixed_audit = {
            "status": "NOT_CONVERGED",
            "blocking_gaps": [
                "Tooling read-access failed on temporary log file",
                "Feature computation consistency bug under FR-DATA-004",
            ],
        }
        mixed_pkg = audit_remediation(ms, mixed_audit, self.root)
        self.assertEqual(mixed_pkg["requirementIds"], ["FR-DATA-004"])
        self.assertEqual(len(mixed_pkg["acceptance"]), 1)
        self.assertIn("FR-DATA-004", mixed_pkg["acceptance"][0])

    def test_15_controller_owned_context_builder_and_digest(self) -> None:
        """TEST 15: Context builder constructs self-contained audit payload with deterministic contextDigest."""
        ms = self.config.load_milestone()
        valid_sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), valid_sha, "", 0)

        ctx = build_reasoning_context(self.root, self.config, ms, self.store, mock_runner, role="convergence")

        # Check all structured fields
        self.assertEqual(ctx["milestoneId"], ms.id)
        self.assertEqual(ctx["headSha"], valid_sha)
        self.assertIn("contextDigest", ctx)
        self.assertEqual(len(ctx["contextDigest"]), 64)
        self.assertIn("planningBundle", ctx)
        self.assertIn("spec", ctx["planningBundle"])
        self.assertIn("plan", ctx["planningBundle"])
        self.assertIn("tasks", ctx["planningBundle"])
        self.assertIn("scopedRequirementDefinitions", ctx)
        self.assertIn("packagePlan", ctx)
        self.assertIn("dependencyDag", ctx)

        # Verify prompt formatter embeds the planning texts and digests
        base_prompt = "Perform audit."
        formatted = _format_reasoning_prompt(base_prompt, ctx, ms, role="convergence")
        self.assertIn(ctx["contextDigest"], formatted)
        self.assertIn(valid_sha, formatted)
        self.assertIn(ctx["planningBundle"]["spec"], formatted)

    def test_16_issue_sync_idempotent_no_unnecessary_mutation(self) -> None:
        """TEST 16: Issue sync does not issue unnecessary mutations when titles and bodies are exact, and updates in-place when metadata changes."""
        ms = self.config.load_milestone()
        from factory.controller.controller import issue_body

        existing_issues = {}
        for i, pkg in enumerate(ms.packages, start=100):
            key = work_key(ms.id, pkg.id)
            title = f"[{ms.id}/{pkg.id}] {pkg.objective[:120]}"
            body = f"<!-- chainsieve-work-package:{key} -->\n\n{issue_body(ms, pkg).rstrip()}\n"
            existing_issues[key] = Issue(
                number=i,
                state="OPEN",
                body=body,
                url=f"https://github.com/repo/issues/{i}",
                author="quantm-zeus",
                title=title,
            )

        mock_github = MagicMock()
        mock_github.issues.return_value = dict(existing_issues)

        controller = FactoryController(self.root, self.config, self.store, mock_github, MagicMock())
        result = controller.sync_issues(ms)

        # 1. Exact match -> 0 created, 0 updated
        self.assertEqual(result["created"], [])
        self.assertEqual(result["updated"], [])
        mock_github.create_issue.assert_not_called()
        mock_github.update_issue.assert_not_called()

        # 2. Changed requirement body -> updates in-place
        first_pkg = ms.packages[0]
        first_key = work_key(ms.id, first_pkg.id)
        # Simulate an outdated issue body on GitHub
        existing_issues[first_key] = Issue(
            number=100,
            state="OPEN",
            body=f"<!-- chainsieve-work-package:{first_key} -->\n\nOutdated body\n",
            url="https://github.com/repo/issues/100",
            author="quantm-zeus",
            title=f"[{ms.id}/{first_pkg.id}] {first_pkg.objective[:120]}",
        )
        mock_github.issues.return_value = dict(existing_issues)
        result2 = controller.sync_issues(ms)
        self.assertEqual(result2["created"], [])
        self.assertEqual(result2["updated"], [100])
        mock_github.update_issue.assert_called_once()
        mock_github.create_issue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
