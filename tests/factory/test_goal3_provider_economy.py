from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from factory.controller.config import FactoryConfig
from factory.controller.models import Issue, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage, work_key
from factory.controller.policy import classify_work_package, reviewer_for, select_implementation_provider
from factory.controller.store import StateStore


def make_package(
    pkg_id: str,
    objective: str = "Standard package implementation",
    acceptance: list[str] | None = None,
    risk: str = "MEDIUM",
    preferred_provider: str = "agy",
    req_ids: list[str] | None = None,
) -> WorkPackage:
    return WorkPackage.from_dict({
        "id": pkg_id,
        "objective": objective,
        "acceptance": acceptance or ["Implement feature and add unit tests"],
        "dependencies": [],
        "parallelizable": True,
        "preferredProvider": preferred_provider,
        "risk": risk,
        "requirementIds": req_ids or ["FR-DATA-001"],
        "authorizedProtectedPaths": [],
    })


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


class Goal3ProviderEconomyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        state_dir = self.root / ".factory"
        state_dir.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(state_dir)
        self.config = make_test_config(self.root, state_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_p1_auxiliary_work_assigned_to_agy(self) -> None:
        """P1: Auxiliary / test-only work packages map to Agy implementation with Muse review."""
        pkg = make_package(
            "test-harness-fixtures",
            objective="Add test-only regression fixtures and schema conformance mocks",
            acceptance=["Unit test suite passes", "Regression fixture is verified"],
            risk="LOW",
        )
        self.assertEqual(classify_work_package(pkg), "AUXILIARY")

        rec = PackageRecord()
        provider, reason = select_implementation_provider(pkg, rec, {}, self.config)
        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "auxiliary-agy-preference")
        self.assertEqual(reviewer_for(provider), "muse")

    def test_p2_standard_distribution_2_to_1_agy_first(self) -> None:
        """P2: Standard fresh packages deterministically yield 2:1 Agy:Muse weighting, starting with Agy."""
        records: dict[str, PackageRecord] = {}
        history: list[str] = []

        for i in range(6):
            pkg = make_package(f"pkg-{i}")
            rec = PackageRecord()
            provider, reason = select_implementation_provider(pkg, rec, records, self.config)
            rec.provider = provider
            rec.initial_provider = provider
            rec.provider_selection = {"provider": provider, "reason": reason, "initialProvider": provider}
            records[work_key("m1", f"pkg-{i}")] = rec
            history.append(provider)

        self.assertEqual(history, ["agy", "muse", "agy", "agy", "muse", "agy"])
        self.assertEqual(history.count("agy"), 4)
        self.assertEqual(history.count("muse"), 2)

    def test_p3_provider_selection_determinism(self) -> None:
        """P3: Same durable history and package inputs produce identical selection and reason."""
        pkg = make_package("pkg-target")
        records = {
            work_key("m1", "pkg-0"): PackageRecord(provider="agy", initial_provider="agy"),
            work_key("m1", "pkg-1"): PackageRecord(provider="muse", initial_provider="muse"),
        }
        rec = PackageRecord()

        p1, r1 = select_implementation_provider(pkg, rec, records, self.config)
        p2, r2 = select_implementation_provider(pkg, rec, records, self.config)

        self.assertEqual(p1, p2)
        self.assertEqual(r1, r2)
        self.assertEqual(p1, "agy")
        self.assertEqual(r1, "weighted-balance")

    def test_p4_restart_stability(self) -> None:
        """P4: Controller restart preserving durable records continues the exact deterministic weighting."""
        records: dict[str, PackageRecord] = {
            work_key("m1", "pkg-0"): PackageRecord(provider="agy", initial_provider="agy"),
            work_key("m1", "pkg-1"): PackageRecord(provider="muse", initial_provider="muse"),
            work_key("m1", "pkg-2"): PackageRecord(provider="agy", initial_provider="agy"),
        }
        self.store.save(records, {})

        # Simulate fresh controller startup reading from durable store
        loaded_records = self.store.load()
        pkg3 = make_package("pkg-3")
        rec3 = PackageRecord()
        p3, r3 = select_implementation_provider(pkg3, rec3, loaded_records, self.config)

        self.assertEqual(p3, "agy")
        self.assertEqual(r3, "weighted-balance")

    def test_p5_active_muse_package_ownership_preserved(self) -> None:
        """P5: Existing active Muse package retains Muse ownership across controller ticks (no Agy rebalancing)."""
        pkg = make_package("pkg-muse")
        rec = PackageRecord(
            status=PackageStatus.ACTIVE,
            session_id="ao-session-muse-1",
            provider="muse",
            initial_provider="muse",
            task_attempts=1,
        )
        records = {work_key("m1", "pkg-muse"): rec}

        provider, reason = select_implementation_provider(pkg, rec, records, self.config)
        self.assertEqual(provider, "muse")
        self.assertEqual(reason, "durable-existing-work")

    def test_p6_active_agy_package_ownership_preserved(self) -> None:
        """P6: Existing active Agy package retains Agy ownership across controller ticks."""
        pkg = make_package("pkg-agy")
        rec = PackageRecord(
            status=PackageStatus.ACTIVE,
            session_id="ao-session-agy-1",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
        )
        records = {work_key("m1", "pkg-agy"): rec}

        provider, reason = select_implementation_provider(pkg, rec, records, self.config)
        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "durable-existing-work")

    def test_p7_open_pr_preserves_single_implementation_ownership(self) -> None:
        """P7: Package with open PR preserves implementation provider; never spawns second implementation provider."""
        pkg = make_package("pkg-pr")
        rec = PackageRecord(
            status=PackageStatus.PR_WAITING,
            provider="muse",
            initial_provider="muse",
            pr_number=110,
            head_sha="7" * 40,
            task_attempts=1,
        )
        records = {work_key("m1", "pkg-pr"): rec}

        provider, reason = select_implementation_provider(pkg, rec, records, self.config)
        self.assertEqual(provider, "muse")
        self.assertEqual(reason, "durable-existing-work")

    def test_p8_agy_implementation_maps_to_muse_reviewer(self) -> None:
        """P8: Agy implementation always requires Muse reviewer."""
        self.assertEqual(reviewer_for("agy"), "muse")

    def test_p9_muse_implementation_maps_to_agy_reviewer(self) -> None:
        """P9: Muse implementation always requires Agy reviewer."""
        self.assertEqual(reviewer_for("muse"), "agy")

    def test_p10_valid_fallback_on_qualifying_clean_failure(self) -> None:
        """P10: Fresh Agy failure triggers alternate-provider retry on Muse while preserving initial provider."""
        pkg = make_package("pkg-fail")
        rec = PackageRecord(
            status=PackageStatus.READY,
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            last_error="clean failure evidence",
        )
        records = {work_key("m1", "pkg-fail"): rec}

        provider, reason = select_implementation_provider(pkg, rec, records, self.config)
        self.assertEqual(provider, "muse")
        self.assertEqual(reason, "alternate-provider-retry")
        # Initial provider remains agy
        self.assertEqual(rec.initial_provider, "agy")

    def test_p11_retry_accounting_does_not_corrupt_fresh_counters(self) -> None:
        """P11: Alternate-provider retry on Muse does NOT consume or distort fresh 2:1 weighting counters."""
        # Pkg 0: fresh agy
        # Pkg 1: fresh agy -> failed -> retried on muse (initial_provider = "agy")
        records: dict[str, PackageRecord] = {
            work_key("m1", "pkg-0"): PackageRecord(provider="agy", initial_provider="agy", task_attempts=1),
            work_key("m1", "pkg-1"): PackageRecord(provider="muse", initial_provider="agy", task_attempts=2, replan_attempted=False),
        }

        # Pkg 2 arrives: fresh count should see 2 fresh agy allocations, 0 fresh muse allocations.
        # Score agy = 2/2 = 1.0, score muse = 0/1 = 0.0 -> next fresh should be MUSE!
        pkg2 = make_package("pkg-2")
        rec2 = PackageRecord()
        p2, r2 = select_implementation_provider(pkg2, rec2, records, self.config)

        self.assertEqual(p2, "muse")
        self.assertEqual(r2, "weighted-balance")

    def test_p12_auxiliary_muse_economy(self) -> None:
        """P12: Auxiliary test package goes to Agy even if weighted-balance score would favor Muse."""
        # If records currently have more Agy than Muse
        records: dict[str, PackageRecord] = {
            work_key("m1", "pkg-0"): PackageRecord(provider="agy", initial_provider="agy"),
            work_key("m1", "pkg-1"): PackageRecord(provider="agy", initial_provider="agy"),
        }
        aux_pkg = make_package(
            "evaluation-baseline",
            objective="Baseline metrics, test suite execution, and report fixture generation",
            acceptance=["Automated test report generation verified"],
            risk="LOW",
        )
        rec = PackageRecord()
        provider, reason = select_implementation_provider(aux_pkg, rec, records, self.config)

        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "auxiliary-agy-preference")

    def test_p13_no_mixed_implementation_pr(self) -> None:
        """P13: Strictly one implementation provider per package PR; no mixed co-implementers."""
        pkg = make_package("pkg-crit", risk="CRITICAL")
        rec = PackageRecord(
            status=PackageStatus.ACTIVE,
            provider="muse",
            initial_provider="muse",
            session_id="ao-muse-sess",
            branch="factory/m1--pkg-crit",
        )
        provider, reason = select_implementation_provider(pkg, rec, {work_key("m1", "pkg-crit"): rec}, self.config)
        self.assertEqual(provider, "muse")
        self.assertEqual(reviewer_for(provider), "agy")

    def test_p14_soft_planner_preferred_provider_boundary(self) -> None:
        """P14: Soft planner preferredProvider='muse' cannot override controller 2:1 weighting on STANDARD work."""
        pkg = make_package("standard-pkg", preferred_provider="muse", risk="LOW")
        self.assertEqual(classify_work_package(pkg), "STANDARD")

        rec = PackageRecord()
        # Empty history -> tie at 0.0 -> Agy first!
        provider, reason = select_implementation_provider(pkg, rec, {}, self.config)
        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "weighted-balance")


if __name__ == "__main__":
    unittest.main()
