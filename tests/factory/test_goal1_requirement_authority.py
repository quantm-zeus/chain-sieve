from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from factory.controller.commands import CommandResult
from factory.controller.config import FactoryConfig
from factory.controller.models import Milestone, PackageStatus, WorkPackage
from factory.controller.reasoning import (
    ReasoningContextUnavailableError,
    authoritative_requirement_definitions,
    authoritative_requirement_ids,
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
    from factory.controller.config import CodexRoute
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


class Goal1RequirementAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nAuthoritative rules.", encoding="utf-8")
        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
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

        state_dir = self.root / ".factory"
        state_dir.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(state_dir)
        self.config = make_test_config(self.root, state_dir)

        self.valid_head = "a" * 40
        self.runner = MagicMock()
        self.runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), self.valid_head, "", 0)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_r1_valid_exact_set_equality(self) -> None:
        """R1: Valid exact set equality: raw IDs == scoped IDs == definition IDs."""
        pkg1 = make_package("pkg-1", ["FR-DATA-001", "AC-101"])
        pkg2 = make_package("pkg-2", ["FR-SIG-001"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg1, pkg2],
        })

        ctx = build_reasoning_context(self.root, self.config, ms, self.store, self.runner)
        raw_ids = [rid for p in ms.packages for rid in p.requirement_ids]
        scoped_ids = ctx["scopedRequirementIds"]
        def_ids = [d["id"] for d in ctx["scopedRequirementDefinitions"]]

        self.assertEqual(set(raw_ids), set(scoped_ids))
        self.assertEqual(set(scoped_ids), set(def_ids))
        self.assertEqual(set(scoped_ids), {"FR-DATA-001", "AC-101", "FR-SIG-001"})

    def test_r2_unknown_requirement_id_fails_closed(self) -> None:
        """R2: Unknown requirement ID in active package fails closed with UNKNOWN_REQUIREMENT_ID and zero mutation."""
        pkg = make_package("pkg-1", ["FR-DATA-001", "FR-NONEXISTENT-999"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg],
        })

        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

        events = self.store.history(10)
        rejection_events = [e for e in events if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "UNKNOWN_REQUIREMENT_ID"]
        self.assertEqual(len(rejection_events), 1)
        self.assertEqual(rejection_events[0]["requirementId"], "FR-NONEXISTENT-999")
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())

    def test_r3_missing_semantic_definition_fails_closed(self) -> None:
        """R3: Requirement ID in authoritative set without semantic definition in manifests fails closed."""
        # Create manifest with an ID in raw text or manifest without proper definition
        pkg = make_package("pkg-1", ["FR-SEC-001"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg],
        })

        # Overwrite manifest removing FR-SEC-001 definition
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Ingestion"},
                ]
            }),
            encoding="utf-8",
        )

        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

        events = self.store.history(10)
        rejection_events = [e for e in events if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE"]
        self.assertGreater(len(rejection_events), 0)

    def test_r4_malformed_manifest_fails_closed_no_swallowed_exceptions(self) -> None:
        """R4: Malformed manifest file fails closed without swallowing exceptions."""
        (self.root / "docs" / "spec" / "broken.requirements.json").write_text("{ broken json", encoding="utf-8")

        with self.assertRaises(ReasoningContextUnavailableError):
            authoritative_requirement_definitions(self.root)

        with self.assertRaises(ReasoningContextUnavailableError):
            authoritative_requirement_ids(self.root)

        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [make_package("pkg-1")],
        })
        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

    def test_r5_malformed_requirement_id_fails_closed(self) -> None:
        """R5: Malformed requirement ID syntax in active package fails closed with MALFORMED_REQUIREMENT_ID."""
        pkg = make_package("pkg-1", ["not-a-valid-normative-id"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg],
        })

        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

        events = self.store.history(10)
        rejection_events = [e for e in events if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "MALFORMED_REQUIREMENT_ID"]
        self.assertEqual(len(rejection_events), 1)

    def test_r6_zero_mutation_path_on_context_rejection(self) -> None:
        """R6: Zero product mutation or remediation artifact creation when reasoning context fails."""
        pkg = make_package("pkg-1", ["FR-UNKNOWN-1234"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg],
        })

        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

        # Verify no remediation plan created
        self.assertFalse((self.config.state_dir / "remediation-plan.json").exists())
        # Verify no active records mutated
        self.assertEqual(len(self.store.load()), 0)

    def test_r7_duplicate_requirement_ids_fail_closed(self) -> None:
        """R7: Duplicate requirement IDs across packages fail closed with DUPLICATE_REQUIREMENT_ID."""
        pkg1 = make_package("pkg-1", ["FR-DATA-001"])
        pkg2 = make_package("pkg-2", ["FR-DATA-001"])
        ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [pkg1, pkg2],
        })

        with self.assertRaises(ReasoningContextUnavailableError):
            build_reasoning_context(self.root, self.config, ms, self.store, self.runner)

        events = self.store.history(10)
        dup_events = [e for e in events if e.get("type") == "REASONING_CONTEXT_UNAVAILABLE" and e.get("failureClass") == "DUPLICATE_REQUIREMENT_ID"]
        self.assertEqual(len(dup_events), 1)


if __name__ == "__main__":
    unittest.main()
