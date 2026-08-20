from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.controller.ao import review_gate
from factory.controller.commands import CommandResult, CommandRunner
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
from factory.controller.policy import reviewer_for
from factory.controller.review_context import PROOF_PREFIX, build_review_context
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package


class MockGitHub:
    def __init__(self, issues_dict: dict | None = None, prs_dict: dict | None = None) -> None:
        self.issues_dict = issues_dict or {}
        self.prs_dict = prs_dict or {}
        self.merged: list[PullRequest] = []
        self.closed: list[int] = []
        self.runner = object()

    def issues(self):
        return dict(self.issues_dict)

    def prs(self):
        return dict(self.prs_dict)

    def branch_exists(self, branch: str) -> bool:
        return False

    def create_issue(self, package_id: str, title: str, body: str):
        number = len(self.issues_dict) + 1
        issue = Issue(number, "OPEN", body, f"https://github.com/repo/issues/{number}", "factory-bot")
        self.issues_dict[package_id] = issue
        return issue

    def merge(self, pr: PullRequest) -> None:
        self.merged.append(pr)

    def close_issue(self, number: int, reason: str) -> None:
        self.closed.append(number)


class MockAO:
    def __init__(self, sessions_by_issue: dict | None = None, reviews_by_session: dict | None = None) -> None:
        self.sessions_by_issue = sessions_by_issue or {}
        self.reviews_by_session = reviews_by_session or {}
        self.killed: list[str] = []
        self.restored: list[str] = []
        self.sent: list[tuple[str, str]] = []
        self.triggered_reviews: list[tuple[str, str]] = []
        self.spawns: list[tuple] = []

    def sessions(self):
        return dict(self.sessions_by_issue)

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        session_id = f"ao-{len(self.spawns) + 1}"
        self.spawns.append((package_id, issue_number, provider, prompt, model))
        return session_id

    def kill(self, session_id: str) -> bool:
        self.killed.append(session_id)
        return True

    def restore(self, session_id: str) -> None:
        self.restored.append(session_id)

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        self.triggered_reviews.append((session_id, reviewer))

    def reviews(self, session_id: str) -> dict:
        return self.reviews_by_session.get(session_id, {"reviews": []})


class WallClockAndRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = config(self.temp_root)
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_1_productive_old_task_survives(self) -> None:
        """
        GIVEN: started_at older than maxTaskWallClockSeconds, recent meaningful progress
        THEN: session is not killed, package is not BLOCKED due only to age
        """
        plan = milestone(package("sec"))
        sec_key = key("sec")
        issue = Issue(86, "OPEN", "", "url/86", "factory-bot")

        # 10 hours ago started, but progress occurred 5 seconds ago
        ten_hours_ago = (datetime.now(UTC) - timedelta(hours=10)).isoformat()
        five_secs_ago = (datetime.now(UTC) - timedelta(seconds=5)).isoformat()

        session = Session("ao-sec", f"factory/{sec_key}", "agy", "working", "working", "86", last_activity_at=five_secs_ago)

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=86,
            session_id="ao-sec",
            provider="agy",
            started_at=ten_hours_ago,
            last_progress_at=five_secs_ago,
            task_attempts=1,
        )
        self.store.save({sec_key: prior_record})

        ao = MockAO(sessions_by_issue={"86": [session]})
        github = MockGitHub(issues_dict={sec_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("sec")]}), encoding="utf-8")
        records = controller.tick()

        record = records[sec_key]
        self.assertEqual(record.status, PackageStatus.ACTIVE)
        self.assertIsNone(record.blocked_reason)
        self.assertEqual(ao.killed, [])

    def test_2_progress_refresh(self) -> None:
        """
        GIVEN: old long-running package, new AO/commit/PR/CI/review activity
        THEN: progress fingerprint changes, last_progress_at advances, autonomous execution continues
        """
        plan = milestone(package("sec"))
        sec_key = key("sec")
        issue = Issue(86, "OPEN", "", "url/86", "factory-bot")

        five_hours_ago = (datetime.now(UTC) - timedelta(hours=5)).isoformat()
        session = Session("ao-sec", f"factory/{sec_key}", "agy", "working", "working", "86", last_activity_at=five_hours_ago)

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=86,
            session_id="ao-sec",
            provider="agy",
            started_at=five_hours_ago,
            last_progress_at=five_hours_ago,
            progress_fingerprint="old-fingerprint",
            task_attempts=1,
        )
        self.store.save({sec_key: prior_record})

        # New PR created with recent timestamp
        fresh_time = (datetime.now(UTC) - timedelta(seconds=5)).isoformat()
        pr = PullRequest(92, "OPEN", f"factory/{sec_key}", "sha-92-v1", "url/92", "MERGEABLE", "CLEAN", updated_at=fresh_time)
        snapshot = Snapshot(
            issues={sec_key: issue},
            prs={sec_key: [pr]},
            sessions={sec_key: [session]},
        )

        ao = MockAO(sessions_by_issue={"86": [session]})
        github = MockGitHub(issues_dict={sec_key: issue}, prs_dict={sec_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        records = controller.reconcile(plan, snapshot)
        record = records[sec_key]

        self.assertEqual(record.status, PackageStatus.PR_WAITING)
        self.assertNotEqual(record.progress_fingerprint, "old-fingerprint")
        self.assertEqual(record.last_progress_at, fresh_time)

    def test_3_stale_worker_recovers(self) -> None:
        """
        GIVEN: no meaningful progress beyond idle watchdog, genuinely stale/hung child
        THEN: stale child is recoverable, durable work is preserved, package does not enter permanent human-only BLOCKED state
        """
        plan = milestone(package("sec"))
        sec_key = key("sec")
        issue = Issue(86, "OPEN", "", "url/86", "factory-bot")

        # Stagnant for 20 minutes (max_idle_seconds is 30 in test config)
        twenty_mins_ago = (datetime.now(UTC) - timedelta(minutes=20)).isoformat()
        session = Session("ao-stale", f"factory/{sec_key}", "agy", "idle", "idle", "86", last_activity_at=twenty_mins_ago)

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=86,
            session_id="ao-stale",
            provider="agy",
            started_at=twenty_mins_ago,
            last_progress_at=twenty_mins_ago,
            correction_attempts=0,
            task_attempts=1,
        )
        self.store.save({sec_key: prior_record})

        ao = MockAO(sessions_by_issue={"86": [session]})
        github = MockGitHub(issues_dict={sec_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("sec")]}), encoding="utf-8")
        records = controller.tick()

        # First remediation: prompt sent to continue autonomously without blocking
        record = records[sec_key]
        self.assertNotEqual(record.status, PackageStatus.BLOCKED)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("FULL AUTONOMOUS MODE", ao.sent[0][1])

    def test_4_open_pr_survives_worker_death(self) -> None:
        """
        GIVEN: worker is dead, existing PR exists, current-head CI PASS
        THEN: implementation is not restarted unnecessarily, controller continues through review/merge workflow
        """
        plan = milestone(package("sec"))
        sec_key = key("sec")
        issue = Issue(86, "OPEN", "", "url/86", "factory-bot")
        head = "53f691a55f871feb85e4e0403dee7c319d090378"

        # Worker is terminated
        dead_session = Session("chainsieve-2", f"factory/{sec_key}", "agy", "terminated", "terminated", "86")
        pr = PullRequest(
            92, "OPEN", f"factory/{sec_key}", head, "url/92", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )

        # Prior state has blocked reason from old wall-clock timeout
        prior_record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="task wall-clock budget exhausted; existing work preserved",
            issue_number=86,
            session_id="chainsieve-2",
            provider="agy",
            pr_number=92,
            head_sha=head,
            started_at=(datetime.now(UTC) - timedelta(hours=8)).isoformat(),
            last_progress_at=(datetime.now(UTC) - timedelta(hours=4)).isoformat(),
            task_attempts=1,
            review_attempts=2,
        )
        self.store.save({sec_key: prior_record})

        digest = self._context_digest("m1", package("sec"), head)
        reviews = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head,
                    "status": "complete",
                    "verdict": "approved",
                    "harness": "muse",
                    "body": f"Review passed.\n\n{PROOF_PREFIX}{digest}",
                    "createdAt": "2026-08-16T00:00:00Z",
                }
            }]
        }

        ao = MockAO(sessions_by_issue={"86": [dead_session]}, reviews_by_session={"chainsieve-2": reviews})
        github = MockGitHub(issues_dict={sec_key: issue}, prs_dict={sec_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        # Disable convergence check for this standalone gate test
        from dataclasses import replace
        cfg = replace(self.cfg, convergence_enabled=False)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("sec")]}), encoding="utf-8")
        controller.config = cfg
        records = controller.tick()

        record = records[sec_key]
        # Controller successfully unblocked and merged the PR without restarting worker!
        self.assertEqual(record.status, PackageStatus.COMPLETED)
        self.assertEqual(github.merged, [pr])
        self.assertEqual(ao.spawns, [])

    def test_5_review_evidence_remains_exact_head(self) -> None:
        """
        GIVEN: PR head changes
        THEN: old semantic context/digest cannot satisfy new head
        """
        old_head = "1111111111111111111111111111111111111111"
        new_head = "2222222222222222222222222222222222222222"
        old_digest = self._context_digest("m1", package("sec"), old_head)

        # Review was approved on old_head
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": old_head,
                    "status": "complete",
                    "verdict": "approved",
                    "harness": "muse",
                    "body": f"Review passed.\n\n{PROOF_PREFIX}{old_digest}",
                }
            }]
        }

        # Gate on new_head must fail closed
        ok, reason, _, _ = review_gate(evidence, new_head, "muse", old_digest)
        self.assertFalse(ok)
        self.assertIn("no machine review for current PR head", reason)

    def test_6_productive_old_milestone_survives(self) -> None:
        """
        GIVEN: milestone age exceeds configured wall-clock threshold, recent package progress exists
        THEN: packages are not mass-BLOCKED
        """
        plan = milestone(package("a"), package("b", ["a"]))
        a_key = key("a")
        b_key = key("b")
        issue_a = Issue(1, "CLOSED", "", "url/1", "factory-bot")
        issue_b = Issue(2, "OPEN", "", "url/2", "factory-bot")

        # Milestone started 10 days ago, but package 'a' merged and package 'b' had progress 5 seconds ago
        ten_days_ago = (datetime.now(UTC) - timedelta(days=10)).isoformat()
        five_secs_ago = (datetime.now(UTC) - timedelta(seconds=5)).isoformat()

        merged_pr_a = PullRequest(10, "MERGED", f"factory/{a_key}", "sha-a", "url/10", "UNKNOWN", "UNKNOWN", merged_at=five_secs_ago)
        session_b = Session("ao-b", f"factory/{b_key}", "agy", "working", "working", "2", last_activity_at=five_secs_ago)

        self.store.save(
            {
                a_key: PackageRecord(status=PackageStatus.COMPLETED, issue_number=1, head_sha="sha-a"),
                b_key: PackageRecord(status=PackageStatus.ACTIVE, issue_number=2, session_id="ao-b", provider="agy", started_at=ten_days_ago, last_progress_at=five_secs_ago),
            },
            metadata={"milestoneId": "m1", "milestoneStartedAt": ten_days_ago},
        )

        ao = MockAO(sessions_by_issue={"2": [session_b]})
        github = MockGitHub(issues_dict={a_key: issue_a, b_key: issue_b}, prs_dict={a_key: [merged_pr_a]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a"), package("b", ["a"])]}), encoding="utf-8")
        records = controller.tick()

        self.assertEqual(records[a_key].status, PackageStatus.COMPLETED)
        self.assertEqual(records[b_key].status, PackageStatus.ACTIVE)
        self.assertIsNone(records[b_key].blocked_reason)

    def test_7_truly_stagnant_system_remains_bounded(self) -> None:
        """
        GIVEN: milestone exceeded total duration AND zero progress across any package beyond idle watchdog
        THEN: stagnant system trips bounded milestone watchdog
        """
        plan = milestone(package("a"))
        a_key = key("a")
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")

        # Stagnant for 10 days with no progress
        ten_days_ago = (datetime.now(UTC) - timedelta(days=10)).isoformat()

        self.store.save(
            {a_key: PackageRecord(status=PackageStatus.PLANNED, issue_number=1, started_at=ten_days_ago, last_progress_at=ten_days_ago)},
            metadata={"milestoneId": "m1", "milestoneStartedAt": ten_days_ago},
        )

        ao = MockAO()
        github = MockGitHub(issues_dict={a_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        records = controller.tick()

        self.assertEqual(records[a_key].status, PackageStatus.BLOCKED)
        self.assertIn("milestone stagnant", records[a_key].blocked_reason or "")

    def test_regression_1_no_signal_with_durable_work(self) -> None:
        """
        TEST 1 — no_signal with durable work
        Given: AO session reports no_signal, workspace/branch contains durable work
        Then: work is preserved, package does not immediately escalate to Codex replan, same package is restored/recoverable
        """
        import subprocess
        from dataclasses import replace

        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")

        ws_dir = self.temp_root / "ws_int"
        ws_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", str(ws_dir)], check=True, capture_output=True)
        (ws_dir / "untracked.ts").write_text("// durable work", encoding="utf-8")

        session = Session("chainsieve-6", f"factory/{int_key}", "agy", "no_signal", "no_signal", "89", workspace_path=str(ws_dir))
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=1,
            liveness_remediations_used=2,
            session_restore_attempts=2,
        )
        self.store.save({int_key: prior_record})

        cfg = replace(self.cfg, max_task_attempts=2, max_correction_attempts=2)
        ao = MockAO(sessions_by_issue={"89": [session]})
        github = MockGitHub(issues_dict={int_key: issue})
        controller = FactoryController(self.repo_root, cfg, self.store, github, ao)

        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("int")]}), encoding="utf-8")
        records = controller.tick()

        self.assertIn("chainsieve-6", ao.killed)
        self.assertIn("chainsieve-6", ao.restored)
        record = records[int_key]
        self.assertEqual(record.task_attempts, 2)
        self.assertEqual(record.liveness_remediations_used, 0)
        self.assertEqual(record.session_restore_attempts, 0)
        self.assertNotEqual(record.status, PackageStatus.BLOCKED)

    def test_regression_2_no_signal_with_clean_workspace(self) -> None:
        """
        TEST 2 — no_signal with clean workspace
        Given: child is genuinely dead/stale, no durable implementation exists
        Then: safe same-package retry occurs, Issue remains #89-equivalent, no duplicate PR/worktree ownership
        """
        from dataclasses import replace

        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")

        session = Session("chainsieve-6", f"factory/{int_key}", "agy", "no_signal", "no_signal", "89")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=1,
            liveness_remediations_used=2,
            session_restore_attempts=2,
        )
        self.store.save({int_key: prior_record})

        cfg = replace(self.cfg, max_task_attempts=2, max_correction_attempts=2)
        ao = MockAO(sessions_by_issue={"89": [session]})
        github = MockGitHub(issues_dict={int_key: issue})
        controller = FactoryController(self.repo_root, cfg, self.store, github, ao)

        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("int")]}), encoding="utf-8")
        records = controller.tick()

        record = records[int_key]
        self.assertIn("chainsieve-6", ao.killed)
        self.assertIn(record.status, {PackageStatus.READY, PackageStatus.STARTING})
        self.assertEqual(len(ao.spawns), 1)
        self.assertEqual(record.issue_number, 89)

    def test_regression_3_existing_pr(self) -> None:
        """
        TEST 3 — existing PR
        Given: child unavailable, open PR exists
        Then: controller continues from PR/CI/review state without restarting implementation
        """
        from dataclasses import replace

        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")
        head = "a" * 40

        dead_session = Session("chainsieve-6", f"factory/{int_key}", "agy", "no_signal", "no_signal", "89")
        pr = PullRequest(95, "OPEN", f"factory/{int_key}", head, "url/95", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=1,
            correction_attempts=2,
            pr_number=95,
            head_sha=head,
        )
        self.store.save({int_key: prior_record})

        cfg = replace(self.cfg, max_task_attempts=2, max_correction_attempts=2)
        ao = MockAO(sessions_by_issue={"89": [dead_session]})
        github = MockGitHub(issues_dict={int_key: issue}, prs_dict={int_key: [pr]})
        controller = FactoryController(self.repo_root, cfg, self.store, github, ao)

        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("int")]}), encoding="utf-8")
        records = controller.tick()

        record = records[int_key]
        self.assertIn(record.status, {PackageStatus.PR_WAITING, PackageStatus.REVIEW})
        self.assertEqual(record.pr_number, 95)
        self.assertEqual(ao.spawns, [])

    def test_regression_4_codex_replan_budget_exhausted_unblocks_on_runtime_recovery(self) -> None:
        """
        TEST 4 — Codex replan budget exhausted
        Given: replan call was unavailable/exhausted, but underlying failure is a recoverable runtime failure
        Then: package does NOT become permanently deadlocked; reconciles back to recoverable state
        """
        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")

        session = Session("chainsieve-6", f"factory/{int_key}", "agy", "working", "working", "89")
        prior_record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="Codex replan unavailable or budget exhausted: Codex replan call budget exhausted",
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=1,
            replan_attempted=True,
        )
        self.store.save({int_key: prior_record})

        ao = MockAO(sessions_by_issue={"89": [session]})
        github = MockGitHub(issues_dict={int_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        snapshot = Snapshot(issues={int_key: issue}, sessions={int_key: [session]})
        records = controller.reconcile(plan, snapshot)

        record = records[int_key]
        self.assertIsNone(record.blocked_reason)
        self.assertFalse(record.replan_attempted)
        self.assertEqual(record.status, PackageStatus.ACTIVE)

    def test_regression_5_genuine_repeated_failure_uses_bounded_replan(self) -> None:
        """
        TEST 5 — genuine repeated implementation/decomposition failure
        Given: task attempts exhausted (>= maxTaskAttempts) on persistent failures
        Then: bounded Codex replan is invoked
        """
        from dataclasses import replace

        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")

        class MockReasoner:
            def __init__(self):
                self.replan_called = False

            def replan(self, milestone, pkg, evidence):
                self.replan_called = True
                return {"status": "REPLANNED", "plan": {"id": "m1", "objective": "test", "workPackages": [{"id": "int-reboot", "objective": "reboot", "acceptance": ["pass"], "dependencies": [], "preferredProvider": "muse"}]}}

        session = Session("chainsieve-6", f"factory/{int_key}", "agy", "no_signal", "no_signal", "89")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=2,
            liveness_remediations_used=2,
            session_restore_attempts=2,
        )
        self.store.save({int_key: prior_record})

        cfg = replace(self.cfg, max_task_attempts=2, max_correction_attempts=2)
        ao = MockAO(sessions_by_issue={"89": [session]})
        github = MockGitHub(issues_dict={int_key: issue})
        reasoner = MockReasoner()
        controller = FactoryController(self.repo_root, cfg, self.store, github, ao, reasoner=reasoner)

        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("int")]}), encoding="utf-8")
        records = controller.tick()

        self.assertTrue(reasoner.replan_called)

    def test_regression_6_no_infinite_retry(self) -> None:
        """
        TEST 6 — no infinite retry
        Given: repeated failure after replan already attempted
        Then: failure remains bounded and blocked without infinite loops
        """
        from dataclasses import replace

        plan = milestone(package("int"))
        int_key = key("int")
        issue = Issue(89, "OPEN", "", "url/89", "factory-bot")

        session = Session("chainsieve-6", f"factory/{int_key}", "agy", "no_signal", "no_signal", "89")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=89,
            session_id="chainsieve-6",
            provider="agy",
            task_attempts=2,
            liveness_remediations_used=2,
            session_restore_attempts=2,
            replan_attempted=True,
        )
        self.store.save({int_key: prior_record})

        cfg = replace(self.cfg, max_task_attempts=2, max_correction_attempts=2)
        ao = MockAO(sessions_by_issue={"89": [session]})
        github = MockGitHub(issues_dict={int_key: issue})
        controller = FactoryController(self.repo_root, cfg, self.store, github, ao)

        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("int")]}), encoding="utf-8")
        records = controller.tick()

        record = records[int_key]
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertIn("refusing escalation loop", record.blocked_reason or "")

    def test_regression_7_exact_head_review_gates_unchanged(self) -> None:
        """
        TEST 7 — exact-head/review gates unchanged
        Given: review with mismatched context digest or wrong reviewer
        Then: review gate fails closed
        """
        head = "b" * 40
        valid_digest = self._context_digest("m1", package("int"), head)
        wrong_digest = "f" * 64

        # Case A: Wrong digest
        evidence_wrong_digest = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head,
                    "status": "complete",
                    "verdict": "approved",
                    "harness": "muse",
                    "body": f"Review passed.\n\n{PROOF_PREFIX}{wrong_digest}",
                }
            }]
        }
        ok, reason, _, _ = review_gate(evidence_wrong_digest, head, "muse", valid_digest)
        self.assertFalse(ok)
        self.assertIn("stale or belongs to another work package", reason)

        # Case B: Self-review (agy reviewed agy implementation)
        evidence_self_review = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head,
                    "status": "complete",
                    "verdict": "approved",
                    "harness": "agy",
                    "body": f"Review passed.\n\n{PROOF_PREFIX}{valid_digest}",
                }
            }]
        }
        ok, reason, _, _ = review_gate(evidence_self_review, head, "muse", valid_digest)
        self.assertFalse(ok)
        self.assertIn("required muse", reason)

    def _context_digest(self, milestone_id: str, pkg_dict: dict, head: str) -> str:
        work = WorkPackage.from_dict(pkg_dict)
        context = build_review_context(
            milestone_id,
            work,
            head,
            (
                "docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md",
                "docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json",
                "specs/factory/current-milestone.json",
            ),
        )
        return str(context["contextDigest"])


if __name__ == "__main__":
    unittest.main()
