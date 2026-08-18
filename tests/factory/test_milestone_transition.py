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
from factory.controller.config import CodexRoute, FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import (
    FactoryStatus,
    Issue,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    Session,
    Snapshot,
    TransitionStage,
    WorkPackage,
    work_key,
)
from factory.controller.reasoning import (
    ConvergenceOutputRejectedError,
    PlannerOutputRejectedError,
    ReasoningBudgetExhaustedError,
    ReasoningContextUnavailableError,
    ReasoningRunner,
    _validate_requirement_ids,
    authoritative_requirement_ids,
    authoritative_requirement_definitions,
    build_planner_context,
    build_reasoning_context,
    is_product_roadmap_milestone,
)
from factory.controller.store import StateStore
from test_controller import FakeGitHub, FakeAO, config as test_config, milestone as make_milestone, package as make_package


class MilestoneTransitionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = test_config(self.root)
        self.store = StateStore(self.config.state_dir)
        self.store.prepare()

        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nTest constitution.", encoding="utf-8")
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts" / "convergence.md").write_text("Audit convergence.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "final-audit.md").write_text("Audit final.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "planner.md").write_text("Plan next milestone.", encoding="utf-8")
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)

        real_schema = Path(__file__).resolve().parents[2] / "factory" / "schemas" / "milestone-plan.schema.json"
        if real_schema.exists():
            (self.root / "factory" / "schemas" / "milestone-plan.schema.json").write_text(real_schema.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            (self.root / "factory" / "schemas" / "milestone-plan.schema.json").write_text("{}", encoding="utf-8")

        real_wp_schema = Path(__file__).resolve().parents[2] / "factory" / "schemas" / "work-package.schema.json"
        if real_wp_schema.exists():
            (self.root / "factory" / "schemas" / "work-package.schema.json").write_text(real_wp_schema.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            (self.root / "factory" / "schemas" / "work-package.schema.json").write_text("{}", encoding="utf-8")

        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text("{}", encoding="utf-8")
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text("{}", encoding="utf-8")

        (self.root / "specs" / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "specs" / "factory" / "product-map.md").write_text("# Product Map\nTest product map.", encoding="utf-8")
        (self.root / "specs" / "factory" / "roadmap.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "milestones": [
                    {"id": "g0-contract-foundation", "objective": "G0 objective"},
                    {"id": "g1-deterministic-signal-execution", "objective": "G1 objective"},
                    {"id": "g2-durable-operations", "objective": "G2 objective"},
                    {"id": "g3-model-assisted-research", "objective": "G3 objective"},
                ],
            }),
            encoding="utf-8",
        )

        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-SIG-001", "description": "Versioned Feature Registry", "dependencyGroup": "G1"},
                    {"id": "FR-SIG-002", "description": "Candidate funnel", "dependencyGroup": "G1"},
                    {"id": "FR-WF-001", "description": "Durable resumable workflow", "dependencyGroup": "G2"},
                    {"id": "FR-WF-002", "description": "Trigger inbox and at-least-once idempotency", "dependencyGroup": "G2"},
                    {"id": "FR-WF-003", "description": "Step checkpoint, lease, fencing, and retries", "dependencyGroup": "G2"},
                    {"id": "FR-WF-004", "description": "Schedule CRUD, validation, pause/resume", "dependencyGroup": "G2"},
                    {"id": "FR-WF-005", "description": "Schedule reconciliation", "dependencyGroup": "G2"},
                    {"id": "FR-WF-006", "description": "Transactional notification outbox", "dependencyGroup": "G2"},
                    {"id": "FR-WF-007", "description": "Dead-letter management", "dependencyGroup": "G2"},
                    {"id": "FR-ADM-001", "description": "Overview and incidents", "dependencyGroup": "G2"},
                    {"id": "FR-ALERT-001", "description": "Alert classification", "dependencyGroup": "G2"},
                ],
                "acceptanceCriteria": [
                    {"id": "AC-040", "description": "Outcome profiles"},
                    {"id": "AC-136", "description": "Feature robustness"},
                ],
                "invariants": [
                    {"id": "INV-001", "description": "Deterministic execution"},
                ],
            }),
            encoding="utf-8",
        )

        # Build G1 active milestone with 5 completed packages
        self.g1_packages = [
            make_package("candidate-funnel"),
            make_package("deterministic-snapshots-features"),
            make_package("evaluation-baseline"),
            make_package("pool-adapter-contracts"),
            make_package("signal-materialization"),
        ]
        for p in self.g1_packages:
            p["requirementIds"] = ["FR-SIG-001"]
        self.g1_milestone = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "G1 objective",
            "workPackages": self.g1_packages,
        })
        self.config.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.plan_path.write_text(
            json.dumps({"id": "g1-deterministic-signal-execution", "objective": "G1 objective", "workPackages": self.g1_packages}),
            encoding="utf-8",
        )

        self.records = {
            work_key("g1-deterministic-signal-execution", p["id"]): PackageRecord(status=PackageStatus.COMPLETED, provider="muse")
            for p in self.g1_packages
        }
        self.store.save(self.records, {"milestoneId": "g1-deterministic-signal-execution"})

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _make_controller(self, mock_runner: MagicMock) -> FactoryController:
        gh = FakeGitHub(Snapshot(
            issues={k: Issue(i + 1, "closed", "", "", "") for i, k in enumerate(self.records)},
            prs={k: [PullRequest(100 + i, "MERGED", f"factory/{k}", "f" * 40, "", "MERGEABLE", "clean", merged_at="2026-08-18T14:49:10Z")] for i, k in enumerate(self.records)},
            sessions={},
        ))
        gh.runner = mock_runner
        ao = FakeAO(Snapshot({}, {}, {}))
        return FactoryController(self.root, self.config, self.store, gh, ao)

    def test_mt1_stale_local_head(self) -> None:
        """MT1: Remote integration head advanced, local HEAD is old -> zero convergence calls, INTEGRATION_HEAD_NOT_READY emitted."""
        mock_runner = MagicMock()
        old_head = "1" * 40
        new_head = "2" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv and "origin/main" in argv:
                return CommandResult(argv, new_head, "", 0)
            if "rev-parse" in argv and "HEAD" in argv:
                return CommandResult(argv, old_head, "", 0)
            if "status" in argv:
                return CommandResult(argv, "M some_file.py", "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        controller.reasoner = reasoning

        records = controller.tick()

        reasoning.converge.assert_not_called()
        reasoning.plan_milestone.assert_not_called()

        events = self.store.history(50)
        not_ready = [e for e in events if e.get("type") == "INTEGRATION_HEAD_NOT_READY"]
        self.assertEqual(len(not_ready), 1)
        self.assertEqual(not_ready[0]["localHead"], old_head)
        self.assertEqual(not_ready[0]["remoteHead"], new_head)

    def test_mt2_head_catches_up(self) -> None:
        """MT2: Local HEAD becomes exact remote integration head -> exactly one convergence operation begins."""
        mock_runner = MagicMock()
        exact_head = "2" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}
        reasoning.plan_milestone_primary.return_value = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "pkg-a", "objective": "Obj A", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "pkg-b", "objective": "Obj B", "acceptance": ["Pass"], "dependencies": ["pkg-a"], "parallelizable": False, "preferredProvider": "muse", "risk": "MEDIUM", "requirementIds": ["FR-WF-002"], "authorizedProtectedPaths": []},
            ]
        }
        controller.reasoner = reasoning

        controller.tick()

        self.assertEqual(reasoning.converge.call_count, 1)

    def test_mt3_convergence_success_planner_throw(self) -> None:
        """MT3: Convergence returns CONVERGED, planner raises -> convergence success is durably saved, not called again on restart."""
        mock_runner = MagicMock()
        exact_head = "3" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}
        reasoning.plan_milestone_primary.side_effect = RuntimeError("planner network failure")
        reasoning.plan_milestone_fallback.side_effect = RuntimeError("fallback network failure")
        controller.reasoner = reasoning

        controller.tick()

        meta = self.store.metadata()
        self.assertTrue(meta.get("milestoneConverged"))
        self.assertEqual(meta.get("convergedHeadSha"), exact_head)
        self.assertEqual(meta.get("transitionStage"), TransitionStage.TRANSITION_BLOCKED.value)

        reasoning.converge.reset_mock()
        controller.tick()
        reasoning.converge.assert_not_called()

    def test_mt4_restart_after_converged(self) -> None:
        """MT4: Seed exact durable transitionStage=CONVERGED -> resume planner directly without convergence."""
        mock_runner = MagicMock()
        exact_head = "4" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": True,
            "convergedMilestoneId": "g1-deterministic-signal-execution",
            "convergedHeadSha": exact_head,
            "convergedContextDigest": "d" * 64,
            "transitionStage": TransitionStage.CONVERGED.value,
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "pkg-a", "objective": "Obj A", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "pkg-b", "objective": "Obj B", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "muse", "risk": "MEDIUM", "requirementIds": ["FR-WF-002"], "authorizedProtectedPaths": []},
            ]
        }
        reasoning.plan_milestone_primary.return_value = valid_g2
        controller.reasoner = reasoning

        controller.tick()

        reasoning.converge.assert_not_called()
        reasoning.plan_milestone_primary.assert_called_once()

    def test_mt5_head_changes_after_convergence(self) -> None:
        """MT5: Exact integration HEAD changes -> old convergence becomes stale, no planner uses stale evidence."""
        mock_runner = MagicMock()
        old_head = "5" * 40
        new_head = "6" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, new_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": True,
            "convergedMilestoneId": "g1-deterministic-signal-execution",
            "convergedHeadSha": old_head,
            "convergedContextDigest": "d" * 64,
            "transitionStage": TransitionStage.CONVERGED.value,
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {
            "status": "GAPS",
            "gaps": [{"id": "gap-1", "objective": "fix gap", "acceptance": ["pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "MEDIUM", "requirementIds": ["FR-SIG-001"], "authorizedProtectedPaths": []}]
        }
        controller.reasoner = reasoning

        controller.tick()

        reasoning.converge.assert_called_once()
        reasoning.plan_milestone_primary.assert_not_called()
        updated_meta = self.store.metadata()
        self.assertFalse(updated_meta.get("milestoneConverged"))

    def test_mt6_planner_empty_requirement_ids(self) -> None:
        """MT6: Codex returns package with requirementIds=[] -> rejected, no active G2 installed, validation reason durable."""
        mock_runner = MagicMock()
        exact_head = "6" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}

        reasoning.plan_milestone_primary.side_effect = PlannerOutputRejectedError("product roadmap package 'durable-workflow-state' in milestone 'g2-durable-operations' must specify non-empty normative requirement IDs")
        reasoning.plan_milestone_fallback.side_effect = PlannerOutputRejectedError("fallback failed")
        controller.reasoner = reasoning

        controller.tick()

        active_ms = self.config.load_milestone()
        self.assertEqual(active_ms.id, "g1-deterministic-signal-execution")

        meta = self.store.metadata()
        self.assertEqual(meta.get("transitionStage"), TransitionStage.TRANSITION_BLOCKED.value)

    def test_mt7_bounded_planner_fallback(self) -> None:
        """MT7: Primary Codex plan invalid, one Muse fallback returns valid plan -> Codex calls=1, Muse calls=1, G2 installed once."""
        mock_runner = MagicMock()
        exact_head = "7" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}

        reasoning.plan_milestone_primary.side_effect = PlannerOutputRejectedError("empty requirementIds")
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "durable-workflow-state", "objective": "State", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "durable-scheduling", "objective": "Sched", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": False, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-004"], "authorizedProtectedPaths": []},
            ]
        }
        reasoning.plan_milestone_fallback.return_value = valid_g2
        controller.reasoner = reasoning

        controller.tick()

        active_path = self.config.state_dir / "active-milestone.json"
        self.assertTrue(active_path.exists())
        installed = json.loads(active_path.read_text(encoding="utf-8"))
        self.assertEqual(installed["id"], "g2-durable-operations")

        events = self.store.history(50)
        planned_events = [e for e in events if e.get("type") == "MILESTONE_PLANNED"]
        self.assertEqual(len(planned_events), 1)
        self.assertEqual(planned_events[0]["milestoneId"], "g2-durable-operations")

    def test_mt8_planner_fallback_failure(self) -> None:
        """MT8: Codex invalid, Muse fallback invalid/fails -> transition BLOCKED, no repeated planner calls, no infinite loop."""
        mock_runner = MagicMock()
        exact_head = "8" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}
        reasoning.plan_milestone_primary.side_effect = PlannerOutputRejectedError("primary invalid")
        reasoning.plan_milestone_fallback.side_effect = PlannerOutputRejectedError("fallback invalid")
        controller.reasoner = reasoning

        controller.tick()
        meta = self.store.metadata()
        self.assertEqual(meta.get("transitionStage"), TransitionStage.TRANSITION_BLOCKED.value)
        self.assertTrue(meta.get("convergenceBlocked"))

        reasoning.converge.reset_mock()
        reasoning.plan_milestone_primary.reset_mock()
        reasoning.plan_milestone_fallback.reset_mock()

        controller.tick()
        reasoning.converge.assert_not_called()
        reasoning.plan_milestone_primary.assert_not_called()
        reasoning.plan_milestone_fallback.assert_not_called()
        self.assertEqual(controller.status()["status"], "BLOCKED")

    def test_mt9_budget_exhausted_is_terminal(self) -> None:
        """MT9: Seed exhausted convergence or planner state -> multiple ticks perform no provider calls, explicit BLOCKED status."""
        mock_runner = MagicMock()
        exact_head = "9" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        usage = {
            "milestones": {
                "g1-deterministic-signal-execution": {
                    "codexCallsByRole": {"convergence": 3, "planner": 1}
                }
            }
        }
        (self.config.state_dir / "usage.json").write_text(json.dumps(usage), encoding="utf-8")

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "migrationConvergenceAttempted": True,
            "convergenceBlocked": True,
            "transitionStage": TransitionStage.TRANSITION_BLOCKED.value,
            "lastTickFailure": "Codex convergence call budget exhausted",
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = usage
        controller.reasoner = reasoning

        for _ in range(5):
            controller.tick()

        reasoning.converge.assert_not_called()
        reasoning.converge_fallback.assert_not_called()
        reasoning.plan_milestone_primary.assert_not_called()
        reasoning.plan_milestone_fallback.assert_not_called()
        self.assertEqual(controller.status()["status"], "BLOCKED")

    def test_mt10_archive_ordering(self) -> None:
        """MT10: Planner fails -> G1 not archived. Planner validates -> archive exactly once, G2 install exactly once."""
        mock_runner = MagicMock()
        exact_head = "a" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect
        controller = self._make_controller(mock_runner)

        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        reasoning.converge.return_value = {"status": "CONVERGED", "headSha": exact_head, "contextDigest": "d" * 64}
        reasoning.plan_milestone_primary.side_effect = RuntimeError("planner crash")
        reasoning.plan_milestone_fallback.side_effect = RuntimeError("fallback crash")
        controller.reasoner = reasoning

        controller.tick()

        archive_file = self.config.state_dir / "archive" / "g1-deterministic-signal-execution.json"
        self.assertFalse(archive_file.exists())

        reasoning.plan_milestone_fallback.side_effect = None
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "pkg-a", "objective": "Obj A", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "pkg-b", "objective": "Obj B", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "muse", "risk": "MEDIUM", "requirementIds": ["FR-WF-002"], "authorizedProtectedPaths": []},
            ]
        }
        reasoning.plan_milestone_fallback.return_value = valid_g2

        meta = self.store.metadata()
        meta["convergenceBlocked"] = False
        meta["transitionStage"] = TransitionStage.PLANNER_PRIMARY_FAILED.value
        self.store.save(self.records, meta)

        controller.tick()

        self.assertTrue(archive_file.exists())
        active_ms = json.loads((self.config.state_dir / "active-milestone.json").read_text(encoding="utf-8"))
        self.assertEqual(active_ms["id"], "g2-durable-operations")

    def test_mt11_crash_during_next_plan_install(self) -> None:
        """MT11: Crash at each installation boundary -> restart completes deterministically without duplicate archive or duplicate planning calls."""
        mock_runner = MagicMock()
        exact_head = "b" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, exact_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "pkg-a", "objective": "Obj A", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "pkg-b", "objective": "Obj B", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "muse", "risk": "MEDIUM", "requirementIds": ["FR-WF-002"], "authorizedProtectedPaths": []},
            ]
        }

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": True,
            "convergedMilestoneId": "g1-deterministic-signal-execution",
            "convergedHeadSha": exact_head,
            "convergedContextDigest": "d" * 64,
            "transitionStage": TransitionStage.NEXT_MILESTONE_VALIDATED.value,
            "validatedPlan": valid_g2,
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = {}
        controller.reasoner = reasoning

        controller.tick()

        reasoning.plan_milestone_primary.assert_not_called()
        reasoning.plan_milestone_fallback.assert_not_called()
        archive_file = self.config.state_dir / "archive" / "g1-deterministic-signal-execution.json"
        self.assertTrue(archive_file.exists())
        active_ms = json.loads((self.config.state_dir / "active-milestone.json").read_text(encoding="utf-8"))
        self.assertEqual(active_ms["id"], "g2-durable-operations")

    def test_mt12_legacy_incident_migration(self) -> None:
        """MT12: Seed production-shaped legacy state on new maintenance HEAD -> one migration recovery convergence, no counter reset."""
        mock_runner = MagicMock()
        maintenance_head = "c" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, maintenance_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        usage = {
            "codexCalls": 9,
            "codexCallsByRole": {"convergence": 5, "planner": 2, "replan": 2},
            "milestones": {
                "g1-deterministic-signal-execution": {
                    "codexCallsByRole": {"convergence": 3, "planner": 1, "replan": 1}
                }
            }
        }
        (self.config.state_dir / "usage.json").write_text(json.dumps(usage), encoding="utf-8")

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": False,
            "consecutiveTickFailures": 9,
            "lastTickFailure": "Codex convergence call budget exhausted",
            "convergencePasses": 0,
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = usage
        reasoning.converge_fallback.return_value = {
            "status": "CONVERGED",
            "headSha": maintenance_head,
            "contextDigest": "d" * 64,
        }
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "durable-workflow-state", "objective": "State", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "durable-scheduling", "objective": "Sched", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": False, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-004"], "authorizedProtectedPaths": []},
            ]
        }
        reasoning.plan_milestone_fallback.return_value = valid_g2
        controller.reasoner = reasoning

        controller.tick()

        reasoning.converge_fallback.assert_called_once()
        reasoning.converge.assert_not_called()

        final_usage = json.loads((self.config.state_dir / "usage.json").read_text(encoding="utf-8"))
        self.assertEqual(final_usage["milestones"]["g1-deterministic-signal-execution"]["codexCallsByRole"]["convergence"], 3)
        self.assertEqual(final_usage["milestones"]["g1-deterministic-signal-execution"]["codexCallsByRole"]["planner"], 1)

    def test_mt13_legacy_planner_recovery(self) -> None:
        """MT13: After MT12 convergence succeeds -> no second Codex planner call, exactly one bounded Muse planner fallback, G2 installs."""
        mock_runner = MagicMock()
        maintenance_head = "d" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, maintenance_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        usage = {
            "milestones": {
                "g1-deterministic-signal-execution": {
                    "codexCallsByRole": {"convergence": 3, "planner": 1}
                }
            }
        }
        (self.config.state_dir / "usage.json").write_text(json.dumps(usage), encoding="utf-8")

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": True,
            "convergedMilestoneId": "g1-deterministic-signal-execution",
            "convergedHeadSha": maintenance_head,
            "convergedContextDigest": "d" * 64,
            "transitionStage": TransitionStage.CONVERGED.value,
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = usage
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "durable-workflow-state", "objective": "State", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001"], "authorizedProtectedPaths": []},
                {"id": "durable-scheduling", "objective": "Sched", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": False, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-004"], "authorizedProtectedPaths": []},
            ]
        }
        reasoning.plan_milestone_fallback.return_value = valid_g2
        controller.reasoner = reasoning

        controller.tick()

        reasoning.plan_milestone_primary.assert_not_called()
        reasoning.plan_milestone_fallback.assert_called_once()
        active_ms = json.loads((self.config.state_dir / "active-milestone.json").read_text(encoding="utf-8"))
        self.assertEqual(active_ms["id"], "g2-durable-operations")

    def test_mt14_migration_recovery_failure(self) -> None:
        """MT14: Recovery convergence or planner fallback fails -> explicit transition BLOCKED, zero retry loop."""
        mock_runner = MagicMock()
        maintenance_head = "e" * 40

        def run_side_effect(argv, **kwargs):
            if "rev-parse" in argv:
                return CommandResult(argv, maintenance_head, "", 0)
            return CommandResult(argv, "", "", 0)

        mock_runner.run.side_effect = run_side_effect

        usage = {
            "milestones": {
                "g1-deterministic-signal-execution": {
                    "codexCallsByRole": {"convergence": 3, "planner": 1}
                }
            }
        }
        (self.config.state_dir / "usage.json").write_text(json.dumps(usage), encoding="utf-8")

        meta = {
            "milestoneId": "g1-deterministic-signal-execution",
            "milestoneConverged": False,
            "lastTickFailure": "Codex convergence call budget exhausted",
        }
        self.store.save(self.records, meta)

        controller = self._make_controller(mock_runner)
        reasoning = MagicMock()
        reasoning._usage.return_value = usage
        reasoning.converge_fallback.side_effect = RuntimeError("Muse fallback process crashed")
        controller.reasoner = reasoning

        controller.tick()

        meta = self.store.metadata()
        self.assertTrue(meta.get("convergenceBlocked"))
        self.assertEqual(controller.status()["status"], "BLOCKED")

        reasoning.converge_fallback.reset_mock()
        controller.tick()
        reasoning.converge_fallback.assert_not_called()

    def test_mt15_valid_g2_requirements(self) -> None:
        """MT15: Every generated G2 package has >=1 exact normative requirement ID, all exist in committed authority, no malformed IDs."""
        valid_g2 = {
            "schemaVersion": 1,
            "id": "g2-durable-operations",
            "objective": "G2 objective",
            "workPackages": [
                {"id": "durable-workflow-state", "objective": "State", "acceptance": ["Pass"], "dependencies": [], "parallelizable": True, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-001", "FR-WF-002"], "authorizedProtectedPaths": []},
                {"id": "durable-scheduling", "objective": "Sched", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": False, "preferredProvider": "agy", "risk": "HIGH", "requirementIds": ["FR-WF-004"], "authorizedProtectedPaths": []},
                {"id": "operational-alerts", "objective": "Alerts", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": True, "preferredProvider": "muse", "risk": "HIGH", "requirementIds": ["FR-ALERT-001"], "authorizedProtectedPaths": []},
                {"id": "recovery-controls", "objective": "Recovery", "acceptance": ["Pass"], "dependencies": ["durable-workflow-state"], "parallelizable": False, "preferredProvider": "agy", "risk": "CRITICAL", "requirementIds": ["FR-WF-003", "FR-WF-007"], "authorizedProtectedPaths": []},
                {"id": "administrative-observability", "objective": "Admin", "acceptance": ["Pass"], "dependencies": ["durable-scheduling", "operational-alerts", "recovery-controls"], "parallelizable": False, "preferredProvider": "muse", "risk": "HIGH", "requirementIds": ["FR-ADM-001"], "authorizedProtectedPaths": []},
            ]
        }
        milestone = Milestone.from_dict(valid_g2)
        _validate_requirement_ids(self.root, milestone)

        for pkg in milestone.packages:
            self.assertGreaterEqual(len(pkg.requirement_ids), 1)
            for rid in pkg.requirement_ids:
                self.assertIn(rid, authoritative_requirement_ids(self.root))


if __name__ == "__main__":
    unittest.main()