from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.controller.commands import CommandRunner
from factory.controller.controller import FactoryController, _expired, _provider_for_attempt
from factory.controller.github import GitHub
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage
from factory.controller.store import StateStore
from factory.controller.reasoning import _write_planning_bundle
from test_controller import FakeAO, FakeGitHub, config, milestone, package


class StaticRunner:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def json(self, argv, **kwargs):
        return self.payload


class ActionAO:
    def __init__(self, reviews=None) -> None:
        self.sent: list[tuple[str, str]] = []
        self.review_payload = reviews or {"reviews": []}

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def reviews(self, session_id: str):
        return self.review_payload

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        pass


def work_to_dict(work: WorkPackage) -> dict[str, object]:
    return {
        "id": work.id,
        "objective": work.objective,
        "acceptance": list(work.acceptance),
        "dependencies": list(work.dependencies),
        "preferredProvider": work.preferred_provider,
        "risk": work.risk,
    }


class SafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_missing_executable_is_a_stable_result(self) -> None:
        result = CommandRunner(self.root, {"PATH": "/nonexistent"}).run(["not-installed"], check=False)
        self.assertEqual(result.returncode, 127)
        self.assertIn("executable not found", result.stderr)

    def test_provider_retry_crosses_harness(self) -> None:
        self.assertEqual(_provider_for_attempt("muse", 0), "muse")
        self.assertEqual(_provider_for_attempt("muse", 1), "agy")
        self.assertEqual(_provider_for_attempt("agy", 1), "muse")

    def test_wall_clock_expiration_fails_closed_on_bad_timestamp(self) -> None:
        old = (datetime.now(UTC) - timedelta(seconds=61)).isoformat()
        self.assertTrue(_expired(old, 60))
        self.assertFalse(_expired(datetime.now(UTC).isoformat(), 60))
        self.assertTrue(_expired("not-a-time", 60))

    def test_terminated_session_is_preserved_for_restore(self) -> None:
        plan = milestone(package("a"))
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")
        session = Session("ao-1", "factory/a", "muse", "terminated", "terminated", "1")
        snapshot = Snapshot(issues={"a": issue}, sessions={"a": [session]})
        store = StateStore(self.root / "state")
        prior = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            task_attempts=1,
        )
        store.save({"a": prior})
        controller = FactoryController(self.root, config(self.root), store, FakeGitHub(snapshot), FakeAO(snapshot))
        record = controller.reconcile(plan, snapshot)["a"]
        self.assertEqual(record.status, PackageStatus.ACTIVE)
        self.assertEqual(record.session_id, "ao-1")

    def test_status_is_read_only_and_does_not_query_external_systems(self) -> None:
        plan = {"id": "m1", "objective": "test", "workPackages": [package("a")]}
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps(plan), encoding="utf-8")
        store = StateStore(cfg.state_dir)
        store.save({"a": PackageRecord(status=PackageStatus.READY)})

        class ExplodingGitHub:
            def __getattr__(self, name):
                raise AssertionError(f"status unexpectedly queried GitHub.{name}")

        controller = FactoryController(self.root, cfg, store, ExplodingGitHub(), object())
        before = store.state_path.read_bytes()
        status = controller.status()
        self.assertEqual(status["packages"]["a"]["status"], "READY")
        self.assertEqual(store.state_path.read_bytes(), before)

    def test_untrusted_issue_and_comment_text_cannot_define_work(self) -> None:
        marker = "<!-- chainsieve-work-package:evil -->"
        raw = [
            {"number": 1, "state": "OPEN", "body": marker, "url": "url/1", "author": {"login": "attacker"}},
            {"number": 2, "state": "OPEN", "body": "owner issue without marker", "url": "url/2", "author": {"login": "factory-bot"}},
        ]
        github = GitHub(StaticRunner(raw), "owner/repo", ("factory-bot",))
        self.assertEqual(github.issues(), {})

    def test_usage_is_reconstructed_from_durable_records(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(
            json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}),
            encoding="utf-8",
        )
        store = StateStore(cfg.state_dir)
        store.save({"a": PackageRecord(status=PackageStatus.ACTIVE, provider="agy", task_attempts=2, correction_attempts=1)})
        controller = FactoryController(self.root, cfg, store, object(), object())
        usage = controller.status()["usage"]
        self.assertEqual(usage["workerStarts"], 2)
        self.assertEqual(usage["byProvider"]["agy"], 2)

    def test_production_entrypoints_are_legacy_independent(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        scripts = json.loads((repo / "package.json").read_text(encoding="utf-8"))["scripts"]
        for name in ("autopilot", "product:autopilot", "factory:run", "factory:start", "factory:status"):
            self.assertIn("python3 -m factory", scripts[name])
        service = (repo / "factory/deployment/systemd/chainsieve-factory.service").read_text(encoding="utf-8")
        self.assertIn("python3 -m factory run", service)
        production_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (repo / "factory").rglob("*.py")
            if "__pycache__" not in path.parts
        )
        for legacy in ("tools/autopilot", "tools/product-factory", "tools/agent/lifecycle", "tools/merge-queue"):
            self.assertNotIn(legacy, production_text)

    def test_runtime_plan_advances_without_overwriting_committed_g0(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(
            json.dumps({"id": "g0", "objective": "first", "workPackages": [package("a"), package("b")]}),
            encoding="utf-8",
        )
        active = {"id": "g1", "objective": "next", "workPackages": [package("c"), package("d", ["c"])]}
        cfg.state_dir.mkdir(parents=True)
        (cfg.state_dir / "active-milestone.json").write_text(json.dumps(active), encoding="utf-8")
        self.assertEqual(cfg.load_milestone().id, "g1")
        self.assertEqual(json.loads(cfg.plan_path.read_text())["id"], "g0")

    def test_runtime_spec_kit_bundle_contains_dag_and_tasks(self) -> None:
        value = milestone(package("a"), package("b", ["a"]))
        _write_planning_bundle(self.root / "state", value)
        directory = self.root / "state" / "planning" / value.id
        self.assertIn("`b`", (directory / "plan.md").read_text())
        self.assertIn("- [ ] `a`", (directory / "tasks.md").read_text())

    def test_ci_failure_is_returned_once_to_the_owning_worker(self) -> None:
        cfg = config(self.root)
        ao = ActionAO()
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), object(), ao)
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-1", provider="muse")
        pr = PullRequest(
            7, "OPEN", "factory/a", "a" * 40, "url/7", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        controller._handle_pr(milestone(work_to_dict(work)), work, record, pr)
        controller._handle_pr(milestone(work_to_dict(work)), work, record, pr)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("Required CI is not green", ao.sent[0][1])
        self.assertEqual(record.status, PackageStatus.CI_FIX)

    def test_pending_ci_does_not_consume_correction_budget(self) -> None:
        cfg = config(self.root)
        ao = ActionAO()
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), object(), ao)
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-1", provider="muse")
        pr = PullRequest(
            7, "OPEN", "factory/a", "a" * 40, "url/7", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "status": "IN_PROGRESS"},),
        )
        controller._handle_pr(milestone(work_to_dict(work)), work, record, pr)
        self.assertEqual(ao.sent, [])
        self.assertEqual(record.correction_attempts, 0)

    def test_review_finding_is_returned_to_worker(self) -> None:
        head = "b" * 40
        reviews = {"reviews": [{"latestRun": {
            "targetSha": head,
            "status": "completed",
            "verdict": "changes_requested",
            "harness": "agy",
            "createdAt": "2026-01-01T00:00:00Z",
        }}]}
        cfg = config(self.root)
        ao = ActionAO(reviews)
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), object(), ao)
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-1", provider="muse")
        pr = PullRequest(
            8, "OPEN", "factory/a", head, "url/8", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )
        controller._handle_pr(milestone(work_to_dict(work)), work, record, pr)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("independent agy review rejected", ao.sent[0][1])

    def test_disk_pressure_opens_resource_gate_without_deleting_state(self) -> None:
        cfg = replace(config(self.root), disk_min_free_gib=10**9)
        store = StateStore(cfg.state_dir)
        store.save({"a": PackageRecord(status=PackageStatus.ACTIVE, session_id="ao-1")})
        controller = FactoryController(self.root, cfg, store, object(), object())
        self.assertFalse(controller.resource_state().allowed)
        self.assertTrue(store.state_path.exists())

    def test_waiting_input_exhaustion_blocks_without_more_prompts(self) -> None:
        cfg = config(self.root)
        ao = ActionAO()
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), object(), ao)
        record = PackageRecord(status=PackageStatus.ACTIVE, correction_attempts=cfg.max_correction_attempts)
        session = Session("ao-1", "factory/a", "muse", "working", "waiting_input", "1")
        controller._handle_activity(milestone(package("a")), "a", record, session)
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertEqual(ao.sent, [])


if __name__ == "__main__":
    unittest.main()
