from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from factory.controller.ao import review_gate
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import (
    Issue,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    Session,
    Snapshot,
    WorkPackage,
    work_key,
)
from factory.controller.policy import reviewer_for, select_implementation_provider
from factory.controller.review_context import PROOF_PREFIX, build_review_context
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package
from test_wall_clock_and_recovery import MockAO, MockGitHub


class ProviderBalancingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = config(self.temp_root)
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_1_durable_agy_work_stays_agy_owned_during_recovery(self) -> None:
        """
        1. durable Agy work stays Agy-owned during recovery
        """
        work = WorkPackage.from_dict(package("sec"))
        sec_key = key("sec")
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            provider="agy",
            session_id="chainsieve-2",
            issue_number=86,
            pr_number=92,
            head_sha="53f691a55f871feb85e4e0403dee7c319d090378",
        )
        records = {sec_key: record}

        provider, reason = select_implementation_provider(work, record, records, self.cfg)
        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "durable-existing-work")

    def test_2_durable_muse_work_stays_muse_owned_during_recovery(self) -> None:
        """
        2. durable Muse work stays Muse-owned during recovery
        """
        work = WorkPackage.from_dict(package("collector"))
        col_key = key("collector")
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            provider="muse",
            session_id="chainsieve-3",
            issue_number=87,
            pr_number=91,
            head_sha="c518aa14926b0842d21f6dfd5e045c8cbf2b9e21",
        )
        records = {col_key: record}

        provider, reason = select_implementation_provider(work, record, records, self.cfg)
        self.assertEqual(provider, "muse")
        self.assertEqual(reason, "durable-existing-work")

    def test_3_fresh_eligible_work_trends_deterministically_toward_2_to_1_weighting(self) -> None:
        """
        3. fresh eligible work trends deterministically toward configured 2:1 Agy/Muse weighting
        """
        records: dict[str, PackageRecord] = {}
        history: list[str] = []

        # Simulate 6 fresh tasks
        for i in range(6):
            pkg_id = f"task-{i}"
            work = WorkPackage.from_dict(package(pkg_id))
            rec = PackageRecord()
            provider, reason = select_implementation_provider(work, rec, records, self.cfg)
            rec.provider = provider
            records[key(pkg_id)] = rec
            history.append(provider)

        agy_count = history.count("agy")
        muse_count = history.count("muse")
        self.assertEqual((agy_count, muse_count), (4, 2))
        self.assertEqual(history, ["muse", "agy", "agy", "muse", "agy", "agy"])

    def test_4_no_billing_token_api_required(self) -> None:
        """
        4. no billing/token API is required
        """
        work = WorkPackage.from_dict(package("task-1"))
        record = PackageRecord()
        records = {
            key("t1"): PackageRecord(provider="agy"),
            key("t2"): PackageRecord(provider="muse"),
        }
        provider, reason = select_implementation_provider(work, record, records, self.cfg)
        self.assertIn(provider, {"agy", "muse"})
        self.assertIn(reason, {"weighted-balance", "preferred-provider"})

    def test_5_provider_unavailable_cooldown_safely_falls_back(self) -> None:
        """
        5. provider unavailable/cooldown can safely fall back under existing policy
        """
        work = WorkPackage.from_dict(package("task-1"))
        record = PackageRecord()
        records = {}

        # When Agy is unavailable/in cooldown, fallback to Muse
        provider, reason = select_implementation_provider(
            work, record, records, self.cfg, available_providers={"muse"}
        )
        self.assertEqual(provider, "muse")
        self.assertEqual(reason, "single-available-provider")

    def test_6_and_7_opposite_provider_review_mapping(self) -> None:
        """
        6. Agy implementation always maps to Muse semantic review
        7. Muse implementation always maps to Agy semantic review
        """
        self.assertEqual(reviewer_for("agy"), "muse")
        self.assertEqual(reviewer_for("muse"), "agy")
        with self.assertRaises(ValueError):
            reviewer_for("codex")

    def test_8_balancing_cannot_bypass_gates_and_merges(self) -> None:
        """
        8. balancing cannot bypass CI/review/exact-head/digest/controller merge
        """
        head = "a" * 40
        plan = milestone(package("sec"))
        sec_key = key("sec")
        issue = Issue(86, "OPEN", "", "url/86", "factory-bot")
        pr = PullRequest(
            92, "OPEN", f"factory/{sec_key}", head, "url/92", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),  # CI failure
        )
        snapshot = Snapshot(issues={sec_key: issue}, prs={sec_key: [pr]})

        ao = MockAO(sessions_by_issue={"86": []})
        github = MockGitHub(issues_dict={sec_key: issue}, prs_dict={sec_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        work = WorkPackage.from_dict(package("sec"))
        record = PackageRecord(session_id="ao-1", provider="agy", pr_number=92, head_sha=head)

        controller._handle_pr(plan, work, record, pr)
        self.assertEqual(github.merged, [])
        self.assertEqual(record.status, PackageStatus.CI_FIX)

    def test_9_balancing_does_not_create_duplicate_work_ownership(self) -> None:
        """
        9. balancing does not create duplicate work ownership
        """
        plan = milestone(package("tool"))
        tool_key = key("tool")
        issue = Issue(88, "OPEN", "", "url/88", "factory-bot")
        session = Session("ao-existing", f"factory/{tool_key}", "agy", "working", "working", "88")

        ao = MockAO(sessions_by_issue={"88": [session]})
        github = MockGitHub(issues_dict={tool_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("tool")]}), encoding="utf-8")
        records = controller.tick()

        self.assertEqual(records[tool_key].status, PackageStatus.ACTIVE)
        self.assertEqual(records[tool_key].session_id, "ao-existing")
        self.assertEqual(len(ao.spawns), 0)

    def test_10_selection_reason_is_deterministic_and_observable(self) -> None:
        """
        10. selection reason is deterministic and observable
        """
        work = WorkPackage.from_dict(package("tool"))
        rec_durable = PackageRecord(provider="agy")
        rec_fresh = PackageRecord()
        records = {key("prior"): PackageRecord(provider="muse")}

        p1, r1 = select_implementation_provider(work, rec_durable, records, self.cfg)
        self.assertEqual(p1, "agy")
        self.assertEqual(r1, "durable-existing-work")

        p2, r2 = select_implementation_provider(work, rec_fresh, records, self.cfg)
        self.assertEqual(p2, "agy")
        self.assertEqual(r2, "weighted-balance")


if __name__ == "__main__":
    unittest.main()
