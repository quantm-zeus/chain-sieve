from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.controller.commands import CommandRunner
from factory.controller.controller import FactoryController, _expired, _provider_for_attempt, _retry_delay
from factory.controller.github import GitHub
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage
from factory.controller.store import StateStore
from factory.controller.reasoning import _write_planning_bundle
from factory.controller.reasoning import ReasoningRunner
from test_controller import FakeAO, FakeGitHub, config, milestone, package


class StaticRunner:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def json(self, argv, **kwargs):
        return self.payload


class CapturingRunner:
    def __init__(self) -> None:
        self.calls = []

    def run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))


class SpawningAO:
    def __init__(self) -> None:
        self.spawns = []

    def sessions(self):
        return {}

    def spawn(self, *args):
        self.spawns.append(args)
        return "ao-new"


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

    def test_network_retry_backoff_is_bounded_and_does_not_invoke_codex(self) -> None:
        self.assertEqual([_retry_delay(30, attempt) for attempt in range(1, 8)], [30, 60, 120, 240, 300, 300, 300])
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")

        class OfflineGitHub:
            def issues(self):
                raise RuntimeError("simulated GitHub unavailable")

        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), OfflineGitHub(), object())
        with self.assertRaisesRegex(RuntimeError, "simulated GitHub unavailable"):
            controller.run(once=True)
        metadata = controller.store.metadata()
        self.assertEqual(metadata["consecutiveTickFailures"], 1)
        self.assertEqual(metadata["retryDelaySeconds"], 1)
        self.assertFalse((cfg.state_dir / "usage.json").exists())

    def test_controller_continues_after_scoped_github_recovery_without_duplicate(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")

        class FlakyGitHub(FakeGitHub):
            def __init__(self):
                super().__init__(Snapshot(issues={"a": issue}))
                self.issue_calls = 0

            def issues(self):
                self.issue_calls += 1
                if self.issue_calls == 1:
                    raise RuntimeError("simulated GitHub unavailable")
                return self.snapshot.issues

        github = FlakyGitHub()
        ao = SpawningAO()
        repo = Path(__file__).resolve().parents[2]
        controller = FactoryController(repo, cfg, StateStore(cfg.state_dir), github, ao)
        with self.assertRaisesRegex(RuntimeError, "simulated GitHub unavailable"):
            controller.run(once=True)
        controller.run(once=True)
        self.assertEqual(len(ao.spawns), 1)
        self.assertEqual(controller.store.metadata()["consecutiveTickFailures"], 0)
        self.assertFalse((cfg.state_dir / "usage.json").exists())

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
        self.assertEqual(record.status, PackageStatus.FAILED)
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
        github = GitHub(StaticRunner(raw), "owner/repo", ("factory-bot",), ("worker-bot",), "main")
        self.assertEqual(github.issues(), {})

    def test_untrusted_or_wrong_base_pull_requests_are_not_routed(self) -> None:
        raw = [
            {
                "number": 1, "state": "OPEN", "headRefName": "factory/a", "headRefOid": "a" * 40,
                "baseRefName": "main", "url": "url/1", "author": {"login": "attacker"},
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "files": [],
            },
            {
                "number": 2, "state": "OPEN", "headRefName": "factory/b", "headRefOid": "b" * 40,
                "baseRefName": "other", "url": "url/2", "author": {"login": "factory-bot"},
                "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN", "files": [],
            },
        ]
        github = GitHub(StaticRunner(raw), "owner/repo", ("factory-bot",), ("factory-bot",), "main")
        self.assertEqual(github.prs(), {})

    def test_worker_subprocess_sees_worker_keys_but_not_integration_keys(self) -> None:
        runner = CommandRunner(self.root, {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "GITHUB_TOKEN": "worker",
            "META_API_KEY": "provider",
            "GH_TOKEN": "integration",
            "OPENAI_API_KEY": "planner",
        })
        probe = (
            "import json,os; print(json.dumps({k:(k in os.environ) for k in "
            "['GITHUB_TOKEN','META_API_KEY','GH_TOKEN','OPENAI_API_KEY']}))"
        )
        result = runner.run([sys.executable, "-c", probe], allowed_env=("GITHUB_TOKEN", "META_API_KEY"))
        self.assertEqual(json.loads(result.stdout), {
            "GITHUB_TOKEN": True,
            "META_API_KEY": True,
            "GH_TOKEN": False,
            "OPENAI_API_KEY": False,
        })

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

    def test_codex_role_counters_are_reported_separately(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        cfg.state_dir.mkdir(parents=True)
        (cfg.state_dir / "usage.json").write_text(json.dumps({
            "codexCalls": 4,
            "codexCallsByRole": {"planner": 1, "replan": 1, "final_audit": 1, "emergency": 1},
        }), encoding="utf-8")
        store = StateStore(cfg.state_dir)
        store.save({"a": PackageRecord(status=PackageStatus.READY)})
        usage = FactoryController(self.root, cfg, store, object(), object()).status()["usage"]["codex"]
        self.assertEqual(usage, {
            "total": 4, "plannerCalls": 1, "replanCalls": 1, "finalAuditCalls": 1, "emergencyCalls": 1,
        })

    def test_codex_routes_use_requested_models_and_per_role_limits(self) -> None:
        cfg = config(self.root)
        cfg.codex_routes["planner"] = replace(cfg.codex_routes["planner"], model="gpt-5.6-luna", reasoning_effort="medium")
        cfg.codex_routes["replan"] = replace(cfg.codex_routes["replan"], model="gpt-5.6-terra", reasoning_effort="high")
        cfg.codex_routes["final_audit"] = replace(cfg.codex_routes["final_audit"], model="gpt-5.6-terra", reasoning_effort="high")
        cfg.codex_routes["emergency"] = replace(cfg.codex_routes["emergency"], model="gpt-5.6-sol", reasoning_effort="high")
        runner = CapturingRunner()
        reasoning = ReasoningRunner(self.root, cfg, StateStore(cfg.state_dir), runner)
        for role in ("planner", "replan", "final_audit", "emergency"):
            reasoning._invoke_codex(role, f"m-{role}", "prompt", self.root / "schema.json", self.root / f"{role}.json")
        models = [(call[0][call[0].index("--model") + 1], call[0][call[0].index("-c") + 1]) for call in runner.calls]
        self.assertEqual(models, [
            ("gpt-5.6-luna", 'model_reasoning_effort="medium"'),
            ("gpt-5.6-terra", 'model_reasoning_effort="high"'),
            ("gpt-5.6-terra", 'model_reasoning_effort="high"'),
            ("gpt-5.6-sol", 'model_reasoning_effort="high"'),
        ])
        with self.assertRaisesRegex(RuntimeError, "planner call budget exhausted"):
            reasoning._invoke_codex("planner", "m-planner", "prompt", self.root / "schema.json", self.root / "again.json")

    def test_routine_controller_tick_never_invokes_codex(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")
        snapshot = Snapshot(issues={"a": issue})
        ao = SpawningAO()
        repo = Path(__file__).resolve().parents[2]
        controller = FactoryController(repo, cfg, StateStore(cfg.state_dir), FakeGitHub(snapshot), ao)
        records = controller.tick()
        self.assertEqual(records["a"].status, PackageStatus.STARTING)
        self.assertEqual(len(ao.spawns), 1)
        self.assertFalse((cfg.state_dir / "usage.json").exists())

    def test_production_entrypoints_are_legacy_independent(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        scripts = json.loads((repo / "package.json").read_text(encoding="utf-8"))["scripts"]
        for name in ("autopilot", "product:autopilot", "factory:run", "factory:start", "factory:status"):
            self.assertIn("python3 -m factory", scripts[name])
        service = (repo / "factory/deployment/systemd/chainsieve-factory.service").read_text(encoding="utf-8")
        self.assertIn("/srv/chainsieve/.venv/bin/python -m factory run", service)
        production_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (repo / "factory").rglob("*.py")
            if "__pycache__" not in path.parts
        )
        for legacy in ("tools/autopilot", "tools/product-factory", "tools/agent/lifecycle", "tools/merge-queue"):
            self.assertNotIn(legacy, production_text)

    def test_deployment_uses_dedicated_python_and_single_supervisors(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        factory_unit = (repo / "factory/deployment/systemd/chainsieve-factory.service").read_text()
        ao_unit = (repo / "factory/deployment/systemd/chainsieve-ao.service").read_text()
        self.assertIn("ExecStart=/srv/chainsieve/.venv/bin/python -m factory run", factory_unit)
        self.assertIn("Environment=PYTHONUNBUFFERED=1", factory_unit)
        self.assertIn("Requires=chainsieve-ao.service", factory_unit)
        self.assertEqual(factory_unit.count("ExecStart="), 1)
        self.assertEqual(ao_unit.count("ExecStart="), 1)
        self.assertIn("ExecStart=/usr/local/bin/ao daemon", ao_unit)
        self.assertNotIn("ao daemon", factory_unit)
        installer = (repo / "factory/deployment/install-ubuntu.sh").read_text()
        self.assertLess(installer.index('repo="${CHAINSIEVE_REPO_PATH'), installer.index('test -d "$repo/.git"'))
        self.assertNotIn("pip install", installer)

    def test_canary_assets_cannot_target_main_or_codex(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        value = json.loads((repo / "factory/deployment/canary-config.json").read_text())
        self.assertEqual(value["integration"]["targetBranch"], "factory/canary-base")
        self.assertEqual(value["defaultBranch"], "factory/canary-base")
        self.assertTrue(all(route["maxCallsPerMilestone"] == 0 for route in value["models"]["codex"].values()))
        script = (repo / "factory/deployment/prepare-canary.sh").read_text()
        self.assertIn('[[ "$target_ref" != main ]]', script)

    def test_acceptance_artifact_has_exact_required_gate_set(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        value = json.loads((repo / "factory/deployment/VPS_ACCEPTANCE.json").read_text())
        expected = {
            "upstream_pin_provenance", "muse_live", "agy_live", "cross_provider_review", "exact_head_review",
            "ci_correction", "parallel_workers", "duplicate_prevention", "worker_credential_boundary",
            "untrusted_comment_filter", "systemd", "ssh_disconnect", "controller_crash", "vps_reboot",
            "network_retry", "resource_circuit_breaker", "codex_cost_routing", "status_observability",
        }
        self.assertEqual({item["gate"] for item in value["gates"]}, expected)
        self.assertTrue(all(item["status"] in {"PASS", "FAIL", "NOT_RUN"} for item in value["gates"]))

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

    def test_disk_pressure_prevents_new_spawn_and_emits_event(self) -> None:
        cfg = replace(config(self.root), disk_min_free_gib=10**9)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        issue = Issue(1, "OPEN", "", "url/1", "factory-bot")
        snapshot = Snapshot(issues={"a": issue})
        ao = SpawningAO()
        repo = Path(__file__).resolve().parents[2]
        controller = FactoryController(repo, cfg, StateStore(cfg.state_dir), FakeGitHub(snapshot), ao)
        records = controller.tick()
        self.assertEqual(records["a"].status, PackageStatus.READY)
        self.assertEqual(ao.spawns, [])
        self.assertTrue(any(event["type"] == "CIRCUIT_BREAKER_OPENED" for event in controller.store.history()))

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
