from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from factory.controller.commands import CommandResult
from factory.controller.config import CodexRoute, FactoryConfig
from factory.controller.models import Milestone, PackageRecord, PackageStatus, work_key
from factory.controller.reasoning import (
    ReasoningContextUnavailableError,
    ReasoningRunner,
    _format_reasoning_prompt,
    build_reasoning_context,
)
from factory.controller.store import StateStore


def make_package(pkg_id: str, req_ids: list[str] | None = None) -> dict:
    return {
        "id": pkg_id,
        "objective": f"Objective for {pkg_id}",
        "acceptance": [f"Acceptance for {pkg_id}"],
        "dependencies": [],
        "parallelizable": True,
        "preferredProvider": "agy",
        "risk": "LOW",
        "requirementIds": req_ids or ["FR-DATA-001"],
        "authorizedProtectedPaths": [],
    }


def make_test_config(root: Path, state_dir: Path) -> FactoryConfig:
    return FactoryConfig(
        repo="quantm-zeus/chain-sieve",
        project_id="chainsieve",
        default_branch="main",
        max_active_workers=3,
        max_task_attempts=2,
        max_correction_attempts=2,
        max_review_cycles=2,
        max_final_audit_cycles=3,
        max_convergence_passes=3,
        max_task_wall_clock_seconds=600,
        max_milestone_wall_clock_seconds=3600,
        max_idle_seconds=60,
        max_starting_seconds=30,
        max_tick_duration_seconds=30,
        disk_min_free_gib=0,
        memory_min_free_mib=0,
        max_worktrees=10,
        required_checks=("CI",),
        protected_paths=("factory/**", "docs/spec/**"),
        integration_branch="main",
        state_dir=state_dir,
        plan_path=state_dir / "active-milestone.json",
        poll_seconds=1,
        convergence_enabled=True,
        notification_command=(),
        codex_routes={
            role: CodexRoute("gpt-test", "medium", 3 if role in {"final_audit", "convergence"} else 1)
            for role in ("planner", "replan", "final_audit", "emergency", "convergence")
        },
        agy_model="gemini-test",
    )


class ExecutionEvidenceFailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nAuthoritative rules.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "convergence.md").write_text("Base prompt", encoding="utf-8")
        (self.root / "factory" / "prompts" / "final-audit.md").write_text("Audit prompt", encoding="utf-8")
        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text(
            json.dumps({"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}),
            encoding="utf-8",
        )
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text(
            json.dumps({"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}),
            encoding="utf-8",
        )

        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Deterministic ingestion"},
                    {"id": "FR-SIG-001", "title": "Signal Engine", "description": "Signal generation"},
                ]
            }),
            encoding="utf-8",
        )

        self.state_dir = self.root / ".factory"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(self.state_dir)
        self.store.prepare()
        self.config = make_test_config(self.root, self.state_dir)

        self.valid_head = "1" * 40
        self.runner = MagicMock()
        self.runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), self.valid_head, "", 0)

        self.raw_ms = {
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [make_package("pkg-a", ["FR-DATA-001"]), make_package("pkg-b", ["FR-SIG-001"])],
        }
        self.ms = Milestone.from_dict(self.raw_ms)
        self.config.plan_path.write_text(
            json.dumps(self.raw_ms, indent=2),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _read_events(self) -> list[dict]:
        events_file = self.state_dir / "events.jsonl"
        if not events_file.exists():
            return []
        return [json.loads(line) for line in events_file.read_text(encoding="utf-8").strip().split("\n") if line]

    def test_d1_state_parse_failure(self) -> None:
        """TEST D1 — STATE PARSE FAILURE: Malformed state.json fails closed with EXECUTION_EVIDENCE_UNAVAILABLE."""
        state_file = self.state_dir / "state.json"
        state_file.write_text("{ corrupt json ...", encoding="utf-8")

        with self.assertRaises(ReasoningContextUnavailableError) as cm:
            build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="convergence")
        self.assertIn("unable to load durable execution state", str(cm.exception))

        events = self._read_events()
        rejection_events = [
            e for e in events
            if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "EXECUTION_EVIDENCE_UNAVAILABLE"
        ]
        self.assertEqual(len(rejection_events), 1)
        self.assertEqual(rejection_events[0]["milestoneId"], self.ms.id)
        self.assertEqual(rejection_events[0]["role"], "convergence")

    def test_d2_state_read_failure(self) -> None:
        """TEST D2 — STATE READ FAILURE: StateStore.load() exception fails closed with EXECUTION_EVIDENCE_UNAVAILABLE."""
        with patch.object(self.store, "load", side_effect=PermissionError("Permission denied")):
            with self.assertRaises(ReasoningContextUnavailableError) as cm:
                build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="final_audit")
            self.assertIn("unable to load durable execution state: Permission denied", str(cm.exception))

        events = self._read_events()
        rejection_events = [
            e for e in events
            if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "EXECUTION_EVIDENCE_UNAVAILABLE"
        ]
        self.assertEqual(len(rejection_events), 1)
        self.assertEqual(rejection_events[0]["milestoneId"], self.ms.id)
        self.assertEqual(rejection_events[0]["role"], "final_audit")

    def test_d3_missing_state(self) -> None:
        """TEST D3 — MISSING STATE: Absent durable state fails closed, does not fabricate synthetic PackageRecord(PLANNED)."""
        # Ensure state.json is absent
        state_file = self.state_dir / "state.json"
        if state_file.exists():
            state_file.unlink()

        with self.assertRaises(ReasoningContextUnavailableError) as cm:
            build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="convergence")
        self.assertIn("missing durable package execution record", str(cm.exception))

        events = self._read_events()
        rejection_events = [
            e for e in events
            if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "EXECUTION_EVIDENCE_UNAVAILABLE"
        ]
        self.assertEqual(len(rejection_events), 1)
        self.assertEqual(rejection_events[0]["workKey"], work_key(self.ms.id, "pkg-a"))
        self.assertEqual(rejection_events[0]["packageId"], "pkg-a")

    def test_d4_one_package_record_missing(self) -> None:
        """TEST D4 — ONE PACKAGE RECORD MISSING: Having record for pkg-a but missing pkg-b fails closed identifying pkg-b."""
        key_a = work_key(self.ms.id, "pkg-a")
        key_b = work_key(self.ms.id, "pkg-b")
        rec_a = PackageRecord(status=PackageStatus.COMPLETED, provider="agy", head_sha="a" * 40, ci_status="PASS")
        self.store.save({key_a: rec_a}, {})

        with self.assertRaises(ReasoningContextUnavailableError) as cm:
            build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="convergence")
        self.assertIn(f"missing durable package execution record for work key '{key_b}' (package 'pkg-b')", str(cm.exception))

        events = self._read_events()
        rejection_events = [
            e for e in events
            if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "EXECUTION_EVIDENCE_UNAVAILABLE"
        ]
        self.assertEqual(len(rejection_events), 1)
        self.assertEqual(rejection_events[0]["workKey"], key_b)
        self.assertEqual(rejection_events[0]["packageId"], "pkg-b")

    def test_d5_valid_state(self) -> None:
        """TEST D5 — VALID STATE: Complete valid records for all milestone packages build execution evidence successfully."""
        key_a = work_key(self.ms.id, "pkg-a")
        key_b = work_key(self.ms.id, "pkg-b")
        rec_a = PackageRecord(
            status=PackageStatus.COMPLETED,
            provider="agy",
            issue_number=101,
            pr_number=111,
            pr_state="MERGED",
            head_sha="a" * 40,
            ci_status="PASS",
            review_verdict="approved",
            review_sha="a" * 40,
        )
        rec_b = PackageRecord(
            status=PackageStatus.COMPLETED,
            provider="muse",
            issue_number=102,
            pr_number=112,
            pr_state="MERGED",
            head_sha="b" * 40,
            ci_status="PASS",
            review_verdict="approved",
            review_sha="b" * 40,
        )
        self.store.save({key_a: rec_a, key_b: rec_b}, {})

        ctx = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="convergence")
        self.assertEqual(len(ctx["executionEvidence"]), 2)
        ev_a = next(item for item in ctx["executionEvidence"] if item["packageId"] == "pkg-a")
        self.assertEqual(ev_a["provider"], "agy")
        self.assertEqual(ev_a["issueNumber"], 101)
        self.assertEqual(ev_a["reviewerProvider"], "muse")

        prompt = _format_reasoning_prompt("Base prompt", ctx, self.ms, role="convergence")
        self.assertIn("### Verified Execution Evidence:", prompt)
        self.assertIn("Package: `pkg-a`", prompt)
        self.assertIn("Package: `pkg-b`", prompt)
        self.assertIn("Reviewer Provider: muse", prompt)

    def test_d6_extra_historical_record(self) -> None:
        """TEST D6 — EXTRA HISTORICAL RECORD: Unrelated historical records outside active milestone do not cause rejection."""
        key_a = work_key(self.ms.id, "pkg-a")
        key_b = work_key(self.ms.id, "pkg-b")
        key_hist = work_key("g0-contract-foundation", "old-pkg")
        rec_a = PackageRecord(status=PackageStatus.COMPLETED, provider="agy", head_sha="a" * 40, ci_status="PASS")
        rec_b = PackageRecord(status=PackageStatus.COMPLETED, provider="muse", head_sha="b" * 40, ci_status="PASS")
        rec_hist = PackageRecord(status=PackageStatus.COMPLETED, provider="agy", head_sha="c" * 40, ci_status="PASS")
        self.store.save({key_a: rec_a, key_b: rec_b, key_hist: rec_hist}, {})

        ctx = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner, role="convergence")
        self.assertEqual(len(ctx["executionEvidence"]), 2)
        package_ids = {item["packageId"] for item in ctx["executionEvidence"]}
        self.assertEqual(package_ids, {"pkg-a", "pkg-b"})

    def test_zero_mutation_proof_on_missing_execution_evidence(self) -> None:
        """ZERO-MUTATION PROOF: ReasoningRunner fails closed without calling provider, writing artifacts, or mutating plan."""
        # state.json is absent
        state_file = self.state_dir / "state.json"
        if state_file.exists():
            state_file.unlink()

        plan_before = self.config.plan_path.read_text(encoding="utf-8")
        reasoning = ReasoningRunner(self.root, self.config, self.store, self.runner)

        with patch.object(reasoning, "_invoke_codex") as mock_invoke:
            # Exercise converge
            with self.assertRaises(ReasoningContextUnavailableError):
                reasoning.converge(self.ms)
            mock_invoke.assert_not_called()

            # Exercise final_audit
            out_path = self.state_dir / "final-audit.json"
            with self.assertRaises(ReasoningContextUnavailableError):
                reasoning.final_audit(out_path)
            mock_invoke.assert_not_called()

        # Zero artifacts produced
        self.assertFalse((self.state_dir / "remediation-plan.json").exists())
        self.assertFalse((self.state_dir / "convergence-result.json").exists())
        self.assertFalse((self.state_dir / "final-audit.json").exists())

        # Zero plan mutation
        plan_after = self.config.plan_path.read_text(encoding="utf-8")
        self.assertEqual(plan_before, plan_after)


if __name__ == "__main__":
    unittest.main()
