from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.controller.commands import CommandResult
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.doctor import filesystem_contract_checks
from factory.controller.github import GitHub
from factory.controller.models import Issue, PackageRecord, PackageStatus, Session, Snapshot, WorkPackage, work_key
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package


class ActorRunner:
    def __init__(self, issue_actor: str = "factory-bot") -> None:
        self.issue_actor = issue_actor
        self.calls: list[list[str]] = []
        self.kwargs: list[dict[str, object]] = []
        self.issue_body = ""

    def run(self, argv, **kwargs):
        self.calls.append(argv)
        self.kwargs.append(kwargs)
        if argv[:3] == ["gh", "api", "user"]:
            return CommandResult(tuple(argv), json.dumps({"login": "factory-bot"}), "", 0)
        if argv[:3] == ["gh", "issue", "list"]:
            return CommandResult(tuple(argv), "[]", "", 0)
        if argv[:3] == ["gh", "issue", "create"]:
            self.issue_body = kwargs.get("input_text", "")
            return CommandResult(tuple(argv), "https://github.test/issues/9\n", "", 0)
        if argv[:3] == ["gh", "issue", "view"]:
            payload = {"number": 9, "state": "OPEN", "body": self.issue_body, "url": "https://github.test/issues/9", "author": {"login": self.issue_actor}}
            return CommandResult(tuple(argv), json.dumps(payload), "", 0)
        if argv[:3] == ["gh", "pr", "merge"]:
            return CommandResult(tuple(argv), "", "", 0)
        raise AssertionError(argv)


class ControllerGitHub:
    def __init__(self, snapshot: Snapshot) -> None:
        self.snapshot_value = snapshot
        self.runner = object()

    def issues(self):
        return self.snapshot_value.issues

    def prs(self):
        return self.snapshot_value.prs

    def branch_exists(self, branch):
        return False


class RetryAO:
    def __init__(self, snapshot: Snapshot) -> None:
        self.snapshot_value = snapshot
        self.spawns: list[tuple[object, ...]] = []
        self.killed: list[str] = []

    def sessions(self):
        return self.snapshot_value.sessions

    def kill(self, session_id):
        self.killed.append(session_id)
        return True

    def spawn(self, *args):
        self.spawns.append(args)
        return "ao-alternate"


class FakeReasoner:
    def __init__(self, *, error: Exception | None = None, contradiction: bool = False) -> None:
        self.error = error
        self.contradiction = contradiction
        self.replan_calls = 0
        self.emergency_calls = 0

    def replan(self, milestone_value, package_value, reason):
        self.replan_calls += 1
        if self.error:
            raise self.error
        if self.contradiction:
            return {"status": "ARCHITECTURE_CONTRADICTION", "reason": "authoritative conflict", "plan": None}
        return {"status": "REPLANNED", "reason": reason, "plan": {}}

    def emergency(self, *args):
        self.emergency_calls += 1
        return {"status": "REPLANNED", "reason": "resolved", "plan": {}}


class PreVPSHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_normal_gh_auth_uses_home_state_without_token_environment(self) -> None:
        runner = ActorRunner()
        github = GitHub(runner, "owner/repo", "main")
        self.assertEqual(github.issues(), {})
        self.assertTrue(all("additions" not in kwargs for kwargs in runner.kwargs))
        self.assertTrue(all("GH_TOKEN" not in kwargs.get("allowed_env", ()) for kwargs in runner.kwargs))
        self.assertTrue(all("GITHUB_TOKEN" not in kwargs.get("allowed_env", ()) for kwargs in runner.kwargs))

    def test_issue_and_merge_use_same_authenticated_account(self) -> None:
        runner = ActorRunner()
        github = GitHub(runner, "owner/repo", "main")
        issue = github.create_issue("m1--a", "title", "body")
        self.assertEqual(issue.author, "factory-bot")
        from factory.controller.models import PullRequest

        github.merge(PullRequest(3, "OPEN", "factory/m1--a", "a" * 40, "url", "MERGEABLE", "BLOCKED", base_branch="main", author="factory-bot"))
        flattened = [part for argv in runner.calls for part in argv]
        self.assertIn("--match-head-commit", flattened)
        self.assertNotIn("--approve", flattened)

    def test_unexpected_action_actor_fails_closed_despite_marker_prose(self) -> None:
        github = GitHub(ActorRunner(issue_actor="attacker"), "owner/repo", "main")
        with self.assertRaisesRegex(RuntimeError, "unexpected author"):
            github.create_issue("m1--a", "title", "claims factory-bot authored this")

    def test_controller_has_no_github_approval_path(self) -> None:
        github_source = (Path(__file__).resolve().parents[2] / "factory/controller/github.py").read_text(encoding="utf-8")
        controller_source = (Path(__file__).resolve().parents[2] / "factory/controller/controller.py").read_text(encoding="utf-8")
        self.assertNotIn("gh\", \"pr\", \"review", github_source)
        self.assertNotIn(".approve(", controller_source)

    def test_immutable_control_plane_cannot_be_model_authorized(self) -> None:
        value = package("a")
        value["risk"] = "CRITICAL"
        value["authorizedProtectedPaths"] = ["factory/**"]
        with self.assertRaisesRegex(ValueError, "immutable control-plane"):
            WorkPackage.from_dict(value)

        elevated = package("b")
        elevated["risk"] = "HIGH"
        elevated["authorizedProtectedPaths"] = ["apps/api/migrations/**"]
        self.assertEqual(WorkPackage.from_dict(elevated).authorized_protected_paths, ("apps/api/migrations/**",))

    def _retry_controller(
        self, preferred: str, attempts: int, provider: str, reasoner: FakeReasoner, *, stuck: bool = False
    ):
        item = package("a")
        item["preferredProvider"] = preferred
        plan = milestone(item)
        cfg = replace(config(self.root), max_task_attempts=2, max_correction_attempts=0, convergence_enabled=False)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [item]}), encoding="utf-8")
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")
        session = Session(
            "ao-failed",
            f"factory/{key('a')}",
            provider,
            "no_signal" if stuck else "terminated",
            "no_signal" if stuck else "terminated",
            "1",
        )
        snapshot = Snapshot(issues={key("a"): issue}, sessions={key("a"): [session]})
        store = StateStore(cfg.state_dir)
        store.save({key("a"): PackageRecord(status=PackageStatus.ACTIVE, issue_number=1, session_id=session.id, provider=provider, task_attempts=attempts)})
        ao = RetryAO(snapshot)
        repo = Path(__file__).resolve().parents[2]
        controller = FactoryController(repo, cfg, store, ControllerGitHub(snapshot), ao, reasoner)
        return controller.tick(), ao

    def test_clean_muse_failure_spawns_agy_without_codex(self) -> None:
        reasoner = FakeReasoner()
        records, ao = self._retry_controller("muse", 1, "muse", reasoner)
        self.assertEqual(ao.spawns[0][2], "agy")
        self.assertEqual(records[key("a")].provider, "agy")
        self.assertEqual(reasoner.replan_calls, 0)

    def test_clean_agy_failure_spawns_muse_without_codex(self) -> None:
        reasoner = FakeReasoner()
        records, ao = self._retry_controller("agy", 1, "agy", reasoner)
        self.assertEqual(ao.spawns[0][2], "muse")
        self.assertEqual(records[key("a")].provider, "muse")
        self.assertEqual(reasoner.replan_calls, 0)

    def test_clean_stuck_worker_spawns_alternate_provider(self) -> None:
        reasoner = FakeReasoner()
        records, ao = self._retry_controller("muse", 1, "muse", reasoner, stuck=True)
        self.assertEqual(ao.spawns[0][2], "agy")
        self.assertEqual(records[key("a")].provider, "agy")
        self.assertEqual(reasoner.replan_calls, 0)

    def test_dual_provider_failure_invokes_one_replan(self) -> None:
        reasoner = FakeReasoner()
        records, ao = self._retry_controller("muse", 2, "agy", reasoner)
        self.assertEqual(ao.spawns, [])
        self.assertEqual(reasoner.replan_calls, 1)
        self.assertEqual(reasoner.emergency_calls, 0)
        self.assertEqual(records[key("a")].status, PackageStatus.BLOCKED)

    def test_replan_budget_exhaustion_blocks_without_loop(self) -> None:
        reasoner = FakeReasoner(error=RuntimeError("Codex replan call budget exhausted"))
        records, _ = self._retry_controller("muse", 2, "agy", reasoner)
        self.assertIn("budget exhausted", records[key("a")].blocked_reason or "")
        self.assertEqual(reasoner.replan_calls, 1)
        self.assertEqual(reasoner.emergency_calls, 0)

    def test_emergency_is_used_only_after_explicit_architecture_contradiction(self) -> None:
        reasoner = FakeReasoner(contradiction=True)
        records, _ = self._retry_controller("muse", 2, "agy", reasoner)
        self.assertEqual(reasoner.replan_calls, 1)
        self.assertEqual(reasoner.emergency_calls, 1)
        self.assertEqual(records[key("a")].status, PackageStatus.BLOCKED)

    def test_same_local_id_in_two_milestones_has_distinct_global_identity(self) -> None:
        first, second = work_key("m1", "same"), work_key("m2", "same")
        self.assertNotEqual(first, second)
        self.assertNotEqual(f"factory/{first}", f"factory/{second}")
        issue_one = Issue(1, "CLOSED", f"<!-- chainsieve-work-package:{first} -->", "url/1", "factory-bot")
        issue_two = Issue(2, "OPEN", f"<!-- chainsieve-work-package:{second} -->", "url/2", "factory-bot")
        from factory.controller.models import PullRequest

        cfg = config(self.root)
        plan_two = milestone(package("same"))
        plan_two = type(plan_two)("m2", plan_two.objective, plan_two.packages)

        class QueueGitHub(ControllerGitHub):
            def __init__(self):
                super().__init__(Snapshot())

            def create_issue(self, package_id, title, body):
                number = len(self.snapshot_value.issues) + 1
                issue = Issue(number, "OPEN", f"<!-- chainsieve-work-package:{package_id} -->", f"url/{number}", "factory-bot")
                self.snapshot_value.issues[package_id] = issue
                return issue

        queue = QueueGitHub()
        queue_controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), queue, RetryAO(Snapshot()))
        queue_controller.sync_issues(milestone(package("same")))
        queue_controller.sync_issues(plan_two)
        self.assertEqual(set(queue.snapshot_value.issues), {first, second})
        self.assertNotEqual(queue.snapshot_value.issues[first].number, queue.snapshot_value.issues[second].number)
        snapshot = Snapshot(
            issues={first: issue_one, second: issue_two},
            prs={first: [PullRequest(4, "MERGED", f"factory/{first}", "a" * 40, "pr/4", "UNKNOWN", "UNKNOWN", merged_at="now")]},
            sessions={second: [Session("ao-m2", f"factory/{second}", "muse", "working", "active", "2")]},
        )
        records = FactoryController(self.root, cfg, StateStore(cfg.state_dir), ControllerGitHub(snapshot), RetryAO(snapshot)).reconcile(plan_two, snapshot)
        self.assertEqual(records[second].status, PackageStatus.ACTIVE)
        self.assertNotIn(first, records)

    def _status_controller(self) -> tuple[FactoryController, StateStore]:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        store = StateStore(cfg.state_dir)
        store.save({key("a"): PackageRecord(status=PackageStatus.READY)}, {"controllerStartedAt": datetime.now(UTC).isoformat()})
        return FactoryController(self.root, cfg, store, object(), object()), store

    def test_status_liveness_fresh_stale_and_historical_start(self) -> None:
        controller, store = self._status_controller()
        store.heartbeat(active=True)
        self.assertEqual(controller.status()["controllerLiveness"]["state"], "ACTIVE")
        old = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        store.heartbeat_path.write_text(json.dumps({"controllerHeartbeatAt": old, "active": True}), encoding="utf-8")
        stale = controller.status()
        self.assertEqual(stale["controllerLiveness"]["state"], "STALE")
        self.assertNotEqual(stale["status"], "RUNNING")
        store.heartbeat_path.unlink()
        self.assertEqual(controller.status()["controllerLiveness"]["state"], "STOPPED_UNKNOWN")

    def test_doctor_accepts_read_only_repository_and_plan(self) -> None:
        repo = self.root / "repo"
        state = self.root / "state"
        repo.mkdir()
        plan = repo / "plan.json"
        plan.write_text("{}", encoding="utf-8")
        plan.chmod(0o444)
        repo.chmod(0o555)
        checks = {item.name: item.status for item in filesystem_contract_checks(repo, state, plan)}
        self.assertEqual(checks["writable factory state"], "PASS")
        self.assertEqual(checks["readable committed plan"], "PASS")
        self.assertEqual(checks["read-only committed repository"], "PASS")

    def test_config_has_no_second_github_actor_requirement(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        loaded = FactoryConfig.load(repo, repo / "factory/config.json")
        self.assertFalse(hasattr(loaded, "worker_actors"))
        self.assertFalse(hasattr(loaded, "integration_actors"))
        raw = (repo / "factory/config.json").read_text(encoding="utf-8")
        self.assertNotIn("workerActors", raw)
        self.assertNotIn("integrationActors", raw)

    def test_untrusted_conversations_are_not_a_merge_dependency(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        script = (repo / "factory/deployment/configure-github.sh").read_text(encoding="utf-8")
        self.assertIn('"required_conversation_resolution": false', script)

    def test_root_checkout_systemd_boundary_is_narrow(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        unit = (repo / "factory/deployment/systemd/chainsieve-ao.service").read_text(encoding="utf-8")
        self.assertIn("ReadOnlyPaths=@REPO@ @STATE@", unit)
        self.assertIn("ReadWritePaths=@REPO@/.git @AO_DATA@", unit)
        self.assertIn("ProtectHome=false", unit)


if __name__ == "__main__":
    unittest.main()
