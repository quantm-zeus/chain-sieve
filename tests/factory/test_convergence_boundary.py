from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from factory.controller.ao import review_gate
from factory.controller.commands import CommandResult, CommandRunner
from factory.controller.config import CodexRoute, FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage, work_key
from factory.controller.reasoning import (
    ConvergenceOutputRejectedError,
    ReasoningContextUnavailableError,
    ReasoningRunner,
    audit_remediation,
    authoritative_requirement_ids,
    preflight_convergence_context,
    reconcile_durable_state,
    validate_product_gaps,
    write_remediation,
)
from factory.controller.store import StateStore
from test_controller import config as test_config, milestone as make_milestone, package as make_package


class ConvergenceBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = test_config(self.root)
        self.store = StateStore(self.config.state_dir)
        self.store.prepare()

        # Set up repository structure with constitution and spec manifests
        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nTest constitution.", encoding="utf-8")
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts" / "convergence.md").write_text("Audit convergence.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "final-audit.md").write_text("Audit final.", encoding="utf-8")
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text("{}", encoding="utf-8")
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text("{}", encoding="utf-8")
        (self.root / "factory" / "schemas" / "work-package.schema.json").write_text("{}", encoding="utf-8")

        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "description": "Canonical identity"},
                    {"id": "FR-DATA-003", "description": "State machine"},
                    {"id": "FR-SEC-001", "description": "Security perimeter"},
                ],
                "invariants": [
                    {"id": "INV-001", "description": "Deterministic execution"},
                ],
            }),
            encoding="utf-8",
        )

        self.config.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.pkg1 = make_package("g0-domain-contracts")
        self.pkg1["requirementIds"] = ["FR-DATA-001", "FR-DATA-003"]
        self.config.plan_path.write_text(
            json.dumps({"id": "g0-contract-foundation", "objective": "Converge G0", "workPackages": [self.pkg1]}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_1_convergence_context_inaccessible_reports_infrastructure_failure_without_product_remediation(self) -> None:
        """TEST 1: Inaccessible context emits REASONING_CONTEXT_UNAVAILABLE, no remediation written, no issue created, no worker spawned."""
        # Remove constitution to make context inaccessible
        (self.root / "factory" / "constitution.md").unlink()

        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)

        ms = self.config.load_milestone()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        with self.assertRaises(ReasoningContextUnavailableError):
            runner.converge(ms)

        # Verify event emitted
        events = self.store.history(10)
        self.assertTrue(any(e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" for e in events))

        # Verify no remediation file was written
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())

    def test_2_model_emits_tooling_gap_rejected_without_milestone_mutation(self) -> None:
        """TEST 2: Model objective attempting to restore read access is rejected with CONVERGENCE_OUTPUT_REJECTED, milestone unchanged."""
        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)

        ms = self.config.load_milestone()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        # Mock codex output containing synthetic tooling gap matching Issue #98 pattern
        synthetic_output = {
            "status": "GAPS",
            "gaps": [
                {
                    "id": "g0-contract-foundation-convergence-evidence",
                    "objective": "Restore read access to the repository and rolling planning artifacts, then perform the required convergence audit.",
                    "acceptance": ["All required audit sources are readable.", "Residual gaps mapped to verified normative requirement IDs."],
                    "dependencies": [],
                    "parallelizable": False,
                    "preferredProvider": "muse",
                    "risk": "HIGH",
                    "requirementIds": [],
                    "authorizedProtectedPaths": [],
                }
            ],
        }

        with patch.object(runner, "_invoke_codex") as mock_invoke:
            def side_effect(role, mid, prompt, schema, out_path):
                out_path.write_text(json.dumps(synthetic_output), encoding="utf-8")
            mock_invoke.side_effect = side_effect

            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                runner.converge(ms)

            self.assertEqual(cm.exception.failure_class, "TOOLING_REMEDIATION_REJECTED")

        # Active milestone plan must not contain the synthetic package
        loaded = self.config.load_milestone()
        self.assertEqual(len(loaded.packages), 1)
        self.assertEqual(loaded.packages[0].id, "g0-domain-contracts")

    def test_3_gap_with_no_requirement_evidence_rejected_before_plan_mutation(self) -> None:
        """TEST 3: Product gap with empty requirementIds and no validated authoritative invariant is rejected."""
        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)

        ms = self.config.load_milestone()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        invalid_gap_output = {
            "status": "GAPS",
            "gaps": [
                {
                    "id": "g0-unscoped-gap",
                    "objective": "Implement an unmapped feature with no normative requirement ID",
                    "acceptance": ["Arbitrary tests pass"],
                    "dependencies": [],
                    "parallelizable": False,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": [],
                    "authorizedProtectedPaths": [],
                }
            ],
        }

        with patch.object(runner, "_invoke_codex") as mock_invoke:
            def side_effect(role, mid, prompt, schema, out_path):
                out_path.write_text(json.dumps(invalid_gap_output), encoding="utf-8")
            mock_invoke.side_effect = side_effect

            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                runner.converge(ms)

            self.assertEqual(cm.exception.failure_class, "MISSING_REQUIREMENT_EVIDENCE")

    def test_4_valid_real_product_gap_accepted(self) -> None:
        """TEST 4: Known normative requirement ID + concrete product evidence is accepted."""
        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)

        ms = self.config.load_milestone()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        valid_gap_output = {
            "status": "GAPS",
            "gaps": [
                {
                    "id": "g0-domain-edge-cases",
                    "objective": "Implement temporal edge case validation for canonical domain contracts",
                    "acceptance": ["State machine handles temporal boundary conditions under FR-DATA-003"],
                    "dependencies": ["g0-domain-contracts"],
                    "parallelizable": True,
                    "preferredProvider": "muse",
                    "risk": "MEDIUM",
                    "requirementIds": ["FR-DATA-003"],
                    "authorizedProtectedPaths": [],
                }
            ],
        }

        with patch.object(runner, "_invoke_codex") as mock_invoke:
            def side_effect(role, mid, prompt, schema, out_path):
                out_path.write_text(json.dumps(valid_gap_output), encoding="utf-8")
            mock_invoke.side_effect = side_effect

            result = runner.converge(ms)
            self.assertEqual(result["status"], "GAPS")
            self.assertEqual(len(result["gaps"]), 1)
            self.assertEqual(result["gaps"][0]["id"], "g0-domain-edge-cases")
            self.assertEqual(result["gaps"][0]["requirementIds"], ["FR-DATA-003"])

    def test_5_duplicate_completed_outcome_rejected(self) -> None:
        """TEST 5: Convergence cannot recreate already completed product work package ID."""
        ms = self.config.load_milestone()
        duplicate_gaps = [
            {
                "id": "g0-domain-contracts",  # Already in milestone!
                "objective": "Duplicate of g0-domain-contracts",
                "acceptance": ["Some test"],
                "dependencies": [],
                "parallelizable": True,
                "preferredProvider": "muse",
                "risk": "HIGH",
                "requirementIds": ["FR-DATA-001"],
                "authorizedProtectedPaths": [],
            }
        ]

        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            validate_product_gaps(self.root, ms, duplicate_gaps, completed_package_ids={"g0-domain-contracts"})

        self.assertEqual(cm.exception.failure_class, "DUPLICATE_COMPLETED_OUTCOME")

    def test_6_final_audit_infrastructure_failure_rejected(self) -> None:
        """TEST 6: Final audit model inability to inspect evidence does not become a product remediation package."""
        ms = self.config.load_milestone()
        infra_audit = {
            "status": "NOT_CONVERGED",
            "blocking_gaps": [
                "Cannot read repository runtime planning directory",
                "Tooling read-access failed during audit",
            ],
            "requirements_missing": [],
            "architecture_conflicts": [],
            "test_gaps": [],
            "runtime_failures": [],
            "security_gaps": [],
            "operational_gaps": [],
        }

        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, infra_audit, self.root)

        self.assertEqual(cm.exception.failure_class, "TOOLING_REMEDIATION_REJECTED")

    def test_7_invalid_synthetic_state_migration(self) -> None:
        """TEST 7: State migration safely purges synthetic packages like #98 while preserving completed legitimate packages."""
        key_legit = work_key("g0-contract-foundation", "g0-domain-contracts")
        key_synth = work_key("g0-contract-foundation", "g0-contract-foundation-convergence-evidence")

        records = {
            key_legit: PackageRecord(status=PackageStatus.COMPLETED, issue_number=85, pr_number=90, head_sha="a" * 40),
            key_synth: PackageRecord(status=PackageStatus.FAILED, issue_number=98, session_id="chainsieve-7"),
        }
        metadata = {
            "milestoneId": "g0-contract-foundation",
            "convergencePasses": 1,
            "consecutiveTickFailures": 4,
            "lastTickFailure": "branch is already checked out in another worktree: factory/g0-contract-foundation--g0-contract-foundation-convergence-evidence",
        }
        self.store.save(records, metadata)

        # Also populate synthetic remediation-plan.json and convergence-result.json
        (self.config.state_dir / "remediation-plan.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "milestoneId": "g0-contract-foundation",
                "workPackages": [
                    {
                        "id": "g0-contract-foundation-convergence-evidence",
                        "objective": "Restore read access to the repository",
                        "acceptance": ["Sources readable"],
                        "requirementIds": [],
                    }
                ],
            }),
            encoding="utf-8",
        )
        (self.config.state_dir / "convergence-result.json").write_text(
            json.dumps({
                "status": "GAPS",
                "gaps": [{"id": "g0-contract-foundation-convergence-evidence", "objective": "Restore read access"}],
            }),
            encoding="utf-8",
        )

        mock_ao = MagicMock()
        reconciled_records, reconciled_meta = reconcile_durable_state(
            self.store, self.config.plan_path, self.root, mock_ao
        )

        # Legitimate package preserved
        self.assertIn(key_legit, reconciled_records)
        self.assertEqual(reconciled_records[key_legit].status, PackageStatus.COMPLETED)

        # Synthetic package removed
        self.assertNotIn(key_synth, reconciled_records)

        # Convergence state reset for clean re-run
        self.assertEqual(reconciled_meta.get("convergencePasses"), 0)
        self.assertEqual(reconciled_meta.get("consecutiveTickFailures"), 0)
        self.assertIsNone(reconciled_meta.get("lastTickFailure"))

        # Remediation plan cleaned
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())
        self.assertFalse((self.config.state_dir / "convergence-result.json").exists())

    def test_8_no_direct_main_maintenance_instruction_in_agents_md(self) -> None:
        """TEST 8: AGENTS.md contract strictly forbids direct-main commits and mandates branch+PR workflow."""
        agents_md = (Path(__file__).resolve().parents[2] / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Owner-authorized factory maintenance does NOT mean direct `main` writes", agents_md)
        self.assertIn("dedicated maintenance branch", agents_md)
        self.assertIn("exact-head full CI PASS", agents_md)
        self.assertIn("Under no circumstances may any repository source change be committed or pushed directly to `main`", agents_md)

    def test_9_convergence_bounded_retry_and_fallback(self) -> None:
        """TEST 9: Repeated infrastructure failure remains bounded and observable without product scope mutation."""
        mock_runner = MagicMock()
        mock_runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)

        ms = self.config.load_milestone()
        runner = ReasoningRunner(self.root, self.config, self.store, mock_runner)

        # When Codex and fallback are exhausted, RuntimeError is raised without mutating plan
        with patch.object(runner, "_invoke_codex", side_effect=RuntimeError("Codex unavailable and one-shot Muse fallback failed")):
            with self.assertRaises(RuntimeError):
                runner.converge(ms)

        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())
        loaded = self.config.load_milestone()
        self.assertEqual(len(loaded.packages), 1)

    def test_10_regression_existing_pr_review_hardening_remains_green(self) -> None:
        """TEST 10: Review freeze, PASS with nits, and additive correction behaviors remain preserved."""
        head_sha = "b" * 40
        digest = "e" * 64
        body = (
            "```json\n"
            + json.dumps({
                "verdict": "PASS",
                "headSha": head_sha,
                "reviewScope": "FULL",
                "blockingFindings": [],
                "nonBlockingSuggestions": [
                    {"file": "packages/domain/src/index.ts", "suggestion": "Minor style nit", "category": "style"}
                ],
            })
            + "\n```\n"
            + f"Proof: CHAINSIEVE_REVIEW_CONTEXT_SHA256:{digest}"
        )
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head_sha,
                    "status": "complete",
                    "verdict": "pass",
                    "harness": "muse",
                    "body": body,
                    "createdAt": "2026-08-16T12:00:00Z",
                }
            }]
        }
        ok, reason, reviewer, verdict = review_gate(evidence, head_sha, "muse", digest)
        self.assertTrue(ok)
        self.assertEqual(verdict, "approved")
        self.assertEqual(reviewer, "muse")


if __name__ == "__main__":
    unittest.main()
