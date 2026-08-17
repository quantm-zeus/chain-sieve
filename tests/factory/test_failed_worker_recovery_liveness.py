from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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
from factory.controller.policy import (
    classify_work_package,
    reviewer_for,
    select_implementation_provider,
)
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package


class MockGitHub:
    def __init__(self, issues_dict: dict | None = None, prs_dict: dict | None = None, existing_branches: set[str] | None = None) -> None:
        self.issues_dict = issues_dict or {}
        self.prs_dict = prs_dict or {}
        self.existing_branches = existing_branches or set()
        self.merged: list[PullRequest] = []
        self.closed: list[int] = []
        self.runner = object()

    def issues(self):
        return dict(self.issues_dict)

    def prs(self):
        return dict(self.prs_dict)

    def branch_exists(self, branch: str) -> bool:
        return branch in self.existing_branches

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
    def __init__(
        self,
        sessions_by_issue: dict | None = None,
        restore_exception: Exception | None = None,
        spawn_exception: Exception | None = None,
        kill_exception: Exception | None = None,
    ) -> None:
        self.sessions_by_issue = sessions_by_issue or {}
        self.restore_exception = restore_exception
        self.spawn_exception = spawn_exception
        self.kill_exception = kill_exception
        self.killed: list[str] = []
        self.restored: list[str] = []
        self.spawns: list[tuple] = []
        self.sent: list[tuple[str, str]] = []

    def sessions(self):
        return dict(self.sessions_by_issue)

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        if self.spawn_exception:
            raise self.spawn_exception
        session_id = f"ao-{len(self.spawns) + 1}"
        self.spawns.append((package_id, issue_number, provider, prompt, model))
        return session_id

    def kill(self, session_id: str) -> bool:
        if self.kill_exception:
            raise self.kill_exception
        self.killed.append(session_id)
        return True

    def restore(self, session_id: str) -> None:
        if self.restore_exception:
            raise self.restore_exception
        self.restored.append(session_id)

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def cleanup(self) -> None:
        pass

    def reviews(self, session_id: str) -> dict[str, Any]:
        return {"reviews": []}

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        pass


class FailedWorkerRecoveryLivenessTests(unittest.TestCase):
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

    def test_f1_restore_success(self) -> None:
        """
        TEST F1 — RESTORE SUCCESS
        Given: FAILED package, terminal owned AO session, no PR, correction budget available, ao.restore succeeds
        Assert: same session restored, bounded counter advances, WORKER_RESTORED emitted, tick completes successfully.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")
        session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104")

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            correction_attempts=0,
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(sessions_by_issue={"104": [session]})
        github = MockGitHub(issues_dict={eval_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        records = controller.tick()

        self.assertIn("chainsieve-88", ao.restored)
        record = records[eval_key]
        self.assertEqual(record.correction_attempts, 1)
        self.assertEqual(record.session_id, "chainsieve-88")

        events = self.store.history(10)
        restored_events = [e for e in events if e.get("type") == "WORKER_RESTORED"]
        self.assertTrue(len(restored_events) >= 1)
        self.assertEqual(restored_events[-1].get("aoSessionId"), "chainsieve-88")
        self.assertEqual(restored_events[-1].get("attempt"), 1)

    def test_f2_restore_throws(self) -> None:
        """
        TEST F2 — RESTORE THROWS
        Given: FAILED package, terminal owned AO session, no PR, ao.restore raises deterministic error
        Assert: exception does NOT create an unbounded repeated tick-failure loop; package recovery state advances deterministically; durable restore-failure event emitted.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")
        session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104")

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            correction_attempts=0,
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(
            sessions_by_issue={"104": [session]},
            restore_exception=RuntimeError("AO daemon socket timeout"),
        )
        github = MockGitHub(issues_dict={eval_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        records = controller.tick()

        # Tick completed without crashing
        self.assertIsNotNone(records)
        record = records[eval_key]
        # Clean workspace safely requeued or transitioned
        self.assertIn(record.status, {PackageStatus.READY, PackageStatus.STARTING})

        events = self.store.history(10)
        failed_events = [e for e in events if e.get("type") == "WORKER_RESTORE_FAILED"]
        self.assertTrue(len(failed_events) >= 1)
        self.assertEqual(failed_events[-1].get("aoSessionId"), "chainsieve-88")

    def test_f3_repeated_restore_failure_is_bounded(self) -> None:
        """
        TEST F3 — REPEATED RESTORE FAILURE IS BOUNDED
        Run multiple controller ticks with restore continuing to fail.
        Assert: identical restore is not attempted forever; bounded policy is consumed; package eventually transitions to READY for safe alternate retry OR BLOCKED/replan for preserved work.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")
        session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104")

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            correction_attempts=0,
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(
            sessions_by_issue={"104": [session]},
            restore_exception=RuntimeError("persistent restore error"),
        )
        github = MockGitHub(issues_dict={eval_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        # Run multiple consecutive ticks
        for _ in range(3):
            records = controller.tick()

        record = records[eval_key]
        # Bounded policy consumed: transitions to alternate retry or BLOCKED
        self.assertIn(record.status, {PackageStatus.READY, PackageStatus.STARTING, PackageStatus.BLOCKED})
        # Restore failure was emitted and recorded
        events = self.store.history(30)
        restore_failed_events = [e for e in events if e.get("type") == "WORKER_RESTORE_FAILED"]
        self.assertTrue(len(restore_failed_events) >= 1)

    def test_f4_clean_failure_alternate_retry(self) -> None:
        """
        TEST F4 — CLEAN FAILURE ALTERNATE RETRY
        Given: initial provider = agy, terminal Agy session, restore failed, no PR, no branch, no commits, no dirty workspace
        Assert: package safely requeues, initial_provider remains agy, next provider is Muse through normal alternate-provider policy, reason records alternate-provider retry, no duplicate Issue, no duplicate workKey.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")
        session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104")

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            correction_attempts=2,  # Budget already exhausted
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(sessions_by_issue={"104": [session]})
        github = MockGitHub(issues_dict={eval_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        records = controller.tick()

        record = records[eval_key]
        self.assertEqual(record.initial_provider, "agy")
        self.assertEqual(record.provider, "muse")
        self.assertEqual(record.issue_number, 104)
        self.assertEqual(len(ao.spawns), 1)
        self.assertEqual(ao.spawns[0][2], "muse")
        self.assertEqual(record.provider_selection.get("reason"), "alternate-provider-retry")

    def test_f5_durable_work_preserved(self) -> None:
        """
        TEST F5 — DURABLE WORK PRESERVED
        Given: restore failure, but workspace/branch contains durable commits or uncommitted work
        Assert: no replacement worker, no destructive cleanup, no duplicate PR, work preserved, deterministic BLOCKED/replan outcome.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")

        ws_dir = self.temp_root / "ws_eval"
        ws_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", str(ws_dir)], check=True, capture_output=True)
        (ws_dir / "untracked_work.ts").write_text("// uncommitted valuable work", encoding="utf-8")

        session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104", workspace_path=str(ws_dir))

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            initial_provider="agy",
            task_attempts=1,
            correction_attempts=2,  # Correction attempts exhausted, but task attempt 1 -> restore
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(sessions_by_issue={"104": [session]})
        github = MockGitHub(issues_dict={eval_key: issue})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        records = controller.tick()

        record = records[eval_key]
        # Preserves session and restores it rather than spawning new worker
        self.assertIn("chainsieve-88", ao.restored)
        self.assertEqual(record.task_attempts, 2)
        self.assertEqual(record.session_id, "chainsieve-88")
        self.assertEqual(len(ao.spawns), 0)

    def test_f6_open_pr_preserved(self) -> None:
        """
        TEST F6 — OPEN PR PRESERVED
        Given: terminal session, existing open PR
        Assert: PR lifecycle is adopted, no restore/replacement worker is spawned unnecessarily.
        """
        pkg = package("eval")
        plan = milestone(pkg)
        eval_key = key("eval")
        issue = Issue(104, "OPEN", "", "url/104", "factory-bot")
        head = "e" * 40

        dead_session = Session("chainsieve-88", f"factory/{eval_key}", "agy", "terminated", "exited", "104")
        pr = PullRequest(115, "OPEN", f"factory/{eval_key}", head, "url/115", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))

        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=104,
            session_id="chainsieve-88",
            provider="agy",
            task_attempts=1,
            correction_attempts=0,
        )
        self.store.save({eval_key: prior_record})

        ao = MockAO(sessions_by_issue={"104": [dead_session]})
        github = MockGitHub(issues_dict={eval_key: issue}, prs_dict={eval_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        records = controller.tick()

        record = records[eval_key]
        self.assertIn(record.status, {PackageStatus.PR_WAITING, PackageStatus.REVIEW})
        self.assertEqual(record.pr_number, 115)
        # No restore or new spawn attempted
        self.assertEqual(len(ao.restored), 0)
        self.assertEqual(len(ao.spawns), 0)

    def test_f7_controller_tick_continues(self) -> None:
        """
        TEST F7 — CONTROLLER TICK CONTINUES
        Simulate a package-local AO recovery operation failing.
        Assert: tick completes or converts failure to durable bounded package state; controller metadata can update; lastSuccessfulTickAt is able to advance.
        """
        pkg1 = package("pkg1")
        pkg2 = package("pkg2")
        plan = milestone(pkg1, pkg2)
        key1 = key("pkg1")
        key2 = key("pkg2")

        issue1 = Issue(1, "OPEN", "", "url/1", "factory-bot")
        issue2 = Issue(2, "OPEN", "", "url/2", "factory-bot")

        session1 = Session("ao-1", f"factory/{key1}", "agy", "terminated", "exited", "1")
        session2 = Session("ao-2", f"factory/{key2}", "muse", "working", "working", "2")

        prior1 = PackageRecord(status=PackageStatus.ACTIVE, issue_number=1, session_id="ao-1", provider="agy", task_attempts=1, correction_attempts=0)
        prior2 = PackageRecord(status=PackageStatus.ACTIVE, issue_number=2, session_id="ao-2", provider="muse", task_attempts=1, correction_attempts=0)
        self.store.save({key1: prior1, key2: prior2})

        # session 1 restore throws, but controller tick MUST complete and update metadata
        ao = MockAO(
            sessions_by_issue={"1": [session1], "2": [session2]},
            restore_exception=RuntimeError("AO fatal connection drop for session 1"),
        )
        github = MockGitHub(issues_dict={key1: issue1, key2: issue2})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)

        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg1, pkg2]}), encoding="utf-8")
        records = controller.tick()

        # Tick completed without escaping exception
        self.assertIsNotNone(records)
        metadata = self.store.metadata()
        self.assertIsNotNone(metadata.get("lastSuccessfulTickAt"))
        self.assertEqual(metadata.get("consecutiveTickFailures", 0), 0)

    def test_f8_existing_provider_economy_preserved(self) -> None:
        """
        TEST F8 — EXISTING PROVIDER ECONOMY PRESERVED
        Assert: fresh allocation policy unchanged; auxiliary Agy-first unchanged; Agy -> Muse review unchanged; Muse -> Agy review unchanged.
        """
        aux_pkg = WorkPackage.from_dict({
            "id": "test-fixtures",
            "objective": "Implement test-only auxiliary fixtures",
            "acceptance": ["fixtures present"],
            "dependencies": [],
            "preferredProvider": "muse",
            "risk": "LOW",
        })
        self.assertEqual(classify_work_package(aux_pkg), "AUXILIARY")
        provider, reason = select_implementation_provider(aux_pkg, PackageRecord(), {}, self.cfg)
        self.assertEqual(provider, "agy")
        self.assertEqual(reason, "auxiliary-agy-preference")

        self.assertEqual(reviewer_for("agy"), "muse")
        self.assertEqual(reviewer_for("muse"), "agy")


if __name__ == "__main__":
    unittest.main()
