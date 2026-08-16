from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
import sys
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
    _validate_json_schema,
    audit_remediation,
    authoritative_requirement_ids,
    build_reasoning_context,
    reconcile_durable_state,
    validate_product_gaps,
    write_remediation,
)
from factory.controller.store import StateStore
from test_controller import config as test_config, milestone as make_milestone, package as make_package


class FinalReasoningClosureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = test_config(self.root)
        self.store = StateStore(self.config.state_dir)
        self.store.prepare()

        # Set up standard repo directories
        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)

        # Write constitution with test sentinel
        self.constitution_sentinel = "TEST_CONSTITUTION_SENTINEL_92817"
        (self.root / "factory" / "constitution.md").write_text(
            f"# Factory Constitution\n{self.constitution_sentinel}\nAll workers and auditors must adhere to strict requirements.",
            encoding="utf-8",
        )

        # Copy prompts & schemas from real repo files
        real_repo = Path(__file__).resolve().parents[2]
        (self.root / "factory" / "prompts" / "convergence.md").write_text(
            (real_repo / "factory" / "prompts" / "convergence.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (self.root / "factory" / "prompts" / "final-audit.md").write_text(
            (real_repo / "factory" / "prompts" / "final-audit.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text(
            (real_repo / "factory" / "schemas" / "convergence.schema.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text(
            (real_repo / "factory" / "schemas" / "final-audit.schema.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (self.root / "factory" / "schemas" / "work-package.schema.json").write_text(
            (real_repo / "factory" / "schemas" / "work-package.schema.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )

        # Write authoritative requirements
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Deterministic ingestion", "acceptanceCriteria": ["AC-101"]},
                    {"id": "FR-SIG-001", "title": "Signal Engine", "description": "Signal generation", "acceptanceCriteria": ["AC-102"]},
                    {"id": "FR-SEC-001", "title": "Security Sandbox", "description": "Isolated execution", "acceptanceCriteria": ["AC-103"]},
                ],
                "acceptanceCriteria": [
                    {"id": "AC-101", "description": "All events ingested in timestamp order"},
                    {"id": "AC-102", "description": "Signals emitted deterministically"},
                    {"id": "AC-103", "description": "No filesystem breakout"},
                ],
            }),
            encoding="utf-8",
        )

        # Write initial roadmap milestone
        self.config.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.pkg1 = make_package("data-pipeline-core")
        self.pkg1["requirementIds"] = ["FR-DATA-001", "AC-101"]
        self.config.plan_path.write_text(
            json.dumps({"id": "g1-deterministic-signal-execution", "objective": "Converge G1", "workPackages": [self.pkg1]}),
            encoding="utf-8",
        )

        self.valid_head = "1" * 40

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _mock_runner(self, head_sha: str = "1" * 40) -> MagicMock:
        runner = MagicMock()
        runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), head_sha, "", 0)
        return runner

    # =========================================================================
    # 1. CONSTITUTION LITERAL EMBEDDING & PROMPT AUDIT CONTEXT
    # =========================================================================

    def test_1_constitution_literal_embedding_in_context_and_prompts(self) -> None:
        """Verify literal constitution text is loaded in context and reaches exact convergence & final-audit prompts."""
        ms = self.config.load_milestone()
        runner = self._mock_runner(self.valid_head)
        ctx = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")

        # In structured context snapshot
        self.assertIn("constitution", ctx)
        self.assertIn(self.constitution_sentinel, ctx["constitution"])

        # In rendered convergence prompt
        conv_base = (self.root / "factory" / "prompts" / "convergence.md").read_text(encoding="utf-8")
        conv_prompt = _format_reasoning_prompt(conv_base, ctx, ms, role="convergence")
        self.assertIn(self.constitution_sentinel, conv_prompt)
        self.assertIn("### Factory Constitution:", conv_prompt)
        self.assertIn(f"Integration HEAD Git Commit: `{self.valid_head}`", conv_prompt)
        self.assertIn(f"Audit Context Digest: `{ctx['contextDigest']}`", conv_prompt)

        # In rendered final-audit prompt
        audit_base = (self.root / "factory" / "prompts" / "final-audit.md").read_text(encoding="utf-8")
        audit_prompt = _format_reasoning_prompt(audit_base, ctx, ms, role="final_audit")
        self.assertIn(self.constitution_sentinel, audit_prompt)
        self.assertIn("### Factory Constitution:", audit_prompt)

        # Prompts must NOT instruct the model to independently read local filesystem files
        self.assertNotIn("Read `factory/constitution.md`", conv_base)
        self.assertNotIn("Read `factory/constitution.md`", audit_base)

    # =========================================================================
    # 2. CONTEXT DIGEST SENSITIVITY & DETERMINISM
    # =========================================================================

    def test_2_context_digest_determinism_and_sensitivity(self) -> None:
        """Verify context digest is deterministic for identical inputs and sensitive to all semantic changes."""
        ms = self.config.load_milestone()
        runner = self._mock_runner(self.valid_head)

        # Baseline digest
        ctx1 = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")
        ctx2 = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")
        self.assertEqual(ctx1["contextDigest"], ctx2["contextDigest"], "Identical inputs must yield identical digest")

        # 1. Constitution mutation -> changes digest
        (self.root / "factory" / "constitution.md").write_text("Modified constitution text", encoding="utf-8")
        ctx_const = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")
        self.assertNotEqual(ctx1["contextDigest"], ctx_const["contextDigest"], "Constitution change must change digest")

        # Reset constitution
        (self.root / "factory" / "constitution.md").write_text(
            f"# Factory Constitution\n{self.constitution_sentinel}", encoding="utf-8"
        )

        # 2. Requirement definition mutation -> changes digest
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Mutated Pipeline", "description": "Altered description", "acceptanceCriteria": ["AC-101"]},
                    {"id": "FR-SIG-001", "title": "Signal Engine", "description": "Signal generation", "acceptanceCriteria": ["AC-102"]},
                    {"id": "FR-SEC-001", "title": "Security Sandbox", "description": "Isolated execution", "acceptanceCriteria": ["AC-103"]},
                ],
                "acceptanceCriteria": [
                    {"id": "AC-101", "description": "All events ingested in timestamp order"},
                    {"id": "AC-102", "description": "Signals emitted deterministically"},
                    {"id": "AC-103", "description": "No filesystem breakout"},
                ],
            }),
            encoding="utf-8",
        )
        ctx_req = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")
        self.assertNotEqual(ctx1["contextDigest"], ctx_req["contextDigest"], "Requirement definition change must change digest")

        # Reset requirement definition
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Deterministic ingestion", "acceptanceCriteria": ["AC-101"]},
                    {"id": "FR-SIG-001", "title": "Signal Engine", "description": "Signal generation", "acceptanceCriteria": ["AC-102"]},
                    {"id": "FR-SEC-001", "title": "Security Sandbox", "description": "Isolated execution", "acceptanceCriteria": ["AC-103"]},
                ],
                "acceptanceCriteria": [
                    {"id": "AC-101", "description": "All events ingested in timestamp order"},
                    {"id": "AC-102", "description": "Signals emitted deterministically"},
                    {"id": "AC-103", "description": "No filesystem breakout"},
                ],
            }),
            encoding="utf-8",
        )

        # 3. Planning artifact mutation -> changes digest
        planning_spec = self.config.state_dir / "planning" / ms.id / "spec.md"
        planning_spec.write_text("Mutated spec artifact content", encoding="utf-8")
        ctx_plan = build_reasoning_context(self.root, self.config, ms, self.store, runner, role="convergence")
        self.assertNotEqual(ctx1["contextDigest"], ctx_plan["contextDigest"], "Planning bundle change must change digest")

        # 4. HEAD change -> changes digest
        runner_b = self._mock_runner("2" * 40)
        ctx_head = build_reasoning_context(self.root, self.config, ms, self.store, runner_b, role="convergence")
        self.assertNotEqual(ctx1["contextDigest"], ctx_head["contextDigest"], "HEAD SHA change must change digest")

    # =========================================================================
    # 3. FINAL AUDIT SCHEMA & TRACEABILITY (CASES A THROUGH K)
    # =========================================================================

    def test_3_case_a_valid_structured_final_audit_accepted(self) -> None:
        """CASE A: NOT_CONVERGED with structured finding and valid authoritative requirement IDs is accepted."""
        ms = self.config.load_milestone()
        valid_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Data pipeline does not validate duplicate sequence tokens",
                    "requirementIds": ["FR-DATA-001", "AC-101"],
                    "evidence": "Ingestion unit tests lack sequence deduplication verification",
                }
            ],
        }
        # Verify schema validates
        schema = json.loads((self.root / "factory" / "schemas" / "final-audit.schema.json").read_text(encoding="utf-8"))
        _validate_json_schema(valid_audit, schema)

        pkg = audit_remediation(ms, valid_audit, self.root)
        self.assertIn("FR-DATA-001", pkg["requirementIds"])
        self.assertIn("AC-101", pkg["requirementIds"])
        self.assertGreater(len(pkg["requirementIds"]), 0)
        self.assertEqual(pkg["authorizedProtectedPaths"], [])

    def test_3_case_b_empty_requirement_ids_rejected(self) -> None:
        """CASE B: Finding with empty requirementIds on product roadmap milestone is rejected with MISSING_REQUIREMENT_EVIDENCE."""
        ms = self.config.load_milestone()
        empty_req_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Internal helper function refactor needed",
                    "requirementIds": [],
                    "evidence": "Code style review",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, empty_req_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "MISSING_REQUIREMENT_EVIDENCE")

    def test_3_case_c_unknown_requirement_id_rejected(self) -> None:
        """CASE C: Finding with unknown requirement ID is rejected with UNKNOWN_REQUIREMENT_ID."""
        ms = self.config.load_milestone()
        unknown_id_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Missing unmapped feature",
                    "requirementIds": ["FR-UNKNOWN-9999"],
                    "evidence": "Audit observation",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, unknown_id_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "UNKNOWN_REQUIREMENT_ID")

    def test_3_case_d_malformed_requirement_id_rejected(self) -> None:
        """CASE D: Finding with malformed requirement ID syntax is rejected with MALFORMED_OUTPUT."""
        ms = self.config.load_milestone()
        malformed_id_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Missing feature",
                    "requirementIds": ["not_a_valid_normative_id"],
                    "evidence": "Audit observation",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, malformed_id_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "MALFORMED_OUTPUT")

    def test_3_case_e_pure_tooling_finding_rejected(self) -> None:
        """CASE E: NOT_CONVERGED with pure tooling / read access finding is rejected with TOOLING_REMEDIATION_REJECTED."""
        ms = self.config.load_milestone()
        tooling_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "TOOLING_GAP",
                    "summary": "Cannot read repository /tmp directory during model inspection",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Permission denied on sandbox path",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, tooling_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "TOOLING_REMEDIATION_REJECTED")

    def test_3_case_f_mixed_tooling_and_product_findings(self) -> None:
        """CASE F: Mixed tooling and valid product findings: tooling finding is filtered, product finding accepted."""
        ms = self.config.load_milestone()
        mixed_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "TOOLING_GAP",
                    "summary": "Tooling read-access error when inspecting /var/log",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Read access error",
                },
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Signal engine missing edge case handling",
                    "requirementIds": ["FR-SIG-001"],
                    "evidence": "Missing test assertion under FR-SIG-001",
                },
            ],
        }
        pkg = audit_remediation(ms, mixed_audit, self.root)
        self.assertEqual(pkg["requirementIds"], ["FR-SIG-001"])
        self.assertEqual(len(pkg["acceptance"]), 1)
        self.assertIn("Signal engine missing edge case handling", pkg["acceptance"][0])

    def test_3_case_g_valid_plus_unknown_id_in_same_finding_rejected(self) -> None:
        """CASE G: Finding containing both a valid ID and an unknown ID fails closed (not silently accepted)."""
        ms = self.config.load_milestone()
        mixed_ids_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Mixed requirement ID validity",
                    "requirementIds": ["FR-DATA-001", "FR-NONEXISTENT-888"],
                    "evidence": "Mixed evidence",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, mixed_ids_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "UNKNOWN_REQUIREMENT_ID")

    def test_3_case_h_not_converged_with_no_valid_product_findings_rejected(self) -> None:
        """CASE H: NOT_CONVERGED audit where all findings are tooling failures is rejected."""
        ms = self.config.load_milestone()
        all_tooling_audit = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "TOOLING_GAP",
                    "summary": "Cannot read factory configuration",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Environment error",
                },
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Restore read access to the repository",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Read access failure",
                },
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, all_tooling_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "TOOLING_REMEDIATION_REJECTED")

    def test_3_case_i_converged_with_findings_rejected(self) -> None:
        """CASE I: CONVERGED audit with non-empty findings is rejected with INCONSISTENT_OUTPUT."""
        ms = self.config.load_milestone()
        inconsistent_audit = {
            "status": "CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Residual gap exists despite converged status",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Contradiction",
                }
            ],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, inconsistent_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "INCONSISTENT_OUTPUT")

    def test_3_case_j_not_converged_with_empty_findings_rejected(self) -> None:
        """CASE J: NOT_CONVERGED audit with empty findings list is rejected with EMPTY_FINDINGS."""
        ms = self.config.load_milestone()
        empty_findings_audit = {
            "status": "NOT_CONVERGED",
            "findings": [],
        }
        with self.assertRaises(ConvergenceOutputRejectedError) as cm:
            audit_remediation(ms, empty_findings_audit, self.root)
        self.assertEqual(cm.exception.failure_class, "EMPTY_FINDINGS")

    def test_3_case_k_schema_validation_rejects_invalid_json(self) -> None:
        """CASE K: Invalid JSON structure is rejected during schema validation."""
        schema = json.loads((self.root / "factory" / "schemas" / "final-audit.schema.json").read_text(encoding="utf-8"))

        # Missing required 'findings' property
        with self.assertRaises(RuntimeError):
            _validate_json_schema({"status": "CONVERGED"}, schema)

        # Invalid category enum
        invalid_finding = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "INVALID_CATEGORY_NAME",
                    "summary": "Summary",
                    "requirementIds": ["FR-DATA-001"],
                    "evidence": "Evidence",
                }
            ],
        }
        with self.assertRaises(RuntimeError):
            _validate_json_schema(invalid_finding, schema)

    # =========================================================================
    # 4. STALE REASONING & INTEGRATION HEAD ADVANCEMENT
    # =========================================================================

    def test_4_stale_reasoning_head_advancement_fails_closed(self) -> None:
        """Verify that when integration HEAD advances during reasoning, result is rejected with STALE_INTEGRATION_HEAD."""
        ms = self.config.load_milestone()
        runner = self._mock_runner(self.valid_head)
        reasoning = ReasoningRunner(self.root, self.config, self.store, runner)

        # Mock codex invocation that succeeds, but during which HEAD advances
        def invoke_with_head_advance(role, mid, prompt, schema, out_path):
            out_path.write_text(json.dumps({"status": "CONVERGED", "gaps": []}), encoding="utf-8")
            # HEAD moves from 1111... to 2222...
            runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "2" * 40, "", 0)

        with patch.object(reasoning, "_invoke_codex", side_effect=invoke_with_head_advance):
            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                reasoning.converge(ms)
            self.assertEqual(cm.exception.failure_class, "STALE_INTEGRATION_HEAD")

        # Verify durable event emitted
        events = self.store.history(10)
        stale_events = [e for e in events if e.get("type") == "CONVERGENCE_OUTPUT_REJECTED" and e.get("failureClass") == "STALE_INTEGRATION_HEAD"]
        self.assertEqual(len(stale_events), 1)
        self.assertEqual(stale_events[0]["headSha"], self.valid_head)

    # =========================================================================
    # 5. DURABLE REJECTION EVENTS & ZERO MUTATION
    # =========================================================================

    def test_5_final_audit_rejection_emits_durable_event_and_zero_mutation(self) -> None:
        """Verify rejected final audit emits FINAL_AUDIT_OUTPUT_REJECTED with exact metadata and causes zero mutation."""
        ms = self.config.load_milestone()
        runner = self._mock_runner(self.valid_head)
        reasoning = ReasoningRunner(self.root, self.config, self.store, runner)
        output_path = self.config.state_dir / "final-audit.json"

        # Mock codex output with unknown requirement ID
        rejected_output = {
            "status": "NOT_CONVERGED",
            "findings": [
                {
                    "category": "PRODUCT_GAP",
                    "summary": "Unknown requirement gap",
                    "requirementIds": ["FR-NONEXISTENT-999"],
                    "evidence": "Some evidence",
                }
            ],
        }

        with patch.object(reasoning, "_invoke_codex", side_effect=lambda r, m, p, s, out: out.write_text(json.dumps(rejected_output), encoding="utf-8")):
            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                reasoning.final_audit(output_path)
            self.assertEqual(cm.exception.failure_class, "UNKNOWN_REQUIREMENT_ID")

        # Verify durable rejection event
        events = self.store.history(10)
        rejection_events = [e for e in events if e.get("type") == "FINAL_AUDIT_OUTPUT_REJECTED"]
        self.assertEqual(len(rejection_events), 1)
        event = rejection_events[0]
        self.assertEqual(event["milestoneId"], ms.id)
        self.assertEqual(event["failureClass"], "UNKNOWN_REQUIREMENT_ID")
        self.assertEqual(event["headSha"], self.valid_head)
        self.assertIn("contextDigest", event)

        # Verify zero mutation
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())

    # =========================================================================
    # 6. GIT HEAD FAIL-CLOSED DETERMINISM
    # =========================================================================

    def test_6_git_head_failures_fail_closed(self) -> None:
        """Verify all-zeros, malformed, non-zero returncode, and empty git HEAD fail closed."""
        ms = self.config.load_milestone()

        # 1. Non-zero exit code
        runner_fail = MagicMock()
        runner_fail.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "", "fatal: not a git repo", 128)
        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, runner_fail)

        # 2. All zeros SHA
        runner_zeros = MagicMock()
        runner_zeros.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "0" * 40, "", 0)
        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, runner_zeros)

        # 3. Short / malformed SHA
        runner_short = MagicMock()
        runner_short.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "abc123", "", 0)
        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, runner_short)

        # 4. Valid 40-char SHA succeeds
        runner_valid = MagicMock()
        runner_valid.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "a" * 40, "", 0)
        ctx = build_reasoning_context(self.root, self.config, ms, self.store, runner_valid)
        self.assertEqual(ctx["headSha"], "a" * 40)

    # =========================================================================
    # 7. GENERIC RECONCILIATION PRESERVES LEGITIMATE PACKAGES
    # =========================================================================

    def test_7_reconciliation_preserves_legitimate_g1_packages_and_completed_records(self) -> None:
        """Verify legitimate G1 packages and historical completed records are preserved across reconciliation."""
        key_g1 = work_key("g1-deterministic-signal-execution", "data-pipeline-core")
        records = {
            key_g1: PackageRecord(status=PackageStatus.COMPLETE, issue_number=100, pr_number=106, head_sha="a" * 40),
        }
        self.store.save(records, {"stateMigrationVersion": 1})

        reconciled_records, _ = reconcile_durable_state(self.store, self.config.plan_path, self.root)
        self.assertIn(key_g1, reconciled_records)
        self.assertEqual(reconciled_records[key_g1].status, PackageStatus.COMPLETE)
        self.assertEqual(reconciled_records[key_g1].pr_number, 106)


if __name__ == "__main__":
    unittest.main()
