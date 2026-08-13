from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from factory.controller.ao import review_gate
from factory.controller.commands import CommandRunner
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.github import ci_gate
from factory.controller.models import Issue, Milestone, PackageStatus, PullRequest, Session, Snapshot, WorkPackage
from factory.controller.policy import protected_path_violations, reviewer_for
from factory.controller.store import StateStore


def package(package_id: str, dependencies: list[str] | None = None) -> dict[str, object]:
    return {
        "id": package_id,
        "objective": f"Implement {package_id}",
        "acceptance": ["focused evidence passes"],
        "dependencies": dependencies or [],
        "parallelizable": True,
        "preferredProvider": "muse",
        "risk": "MEDIUM",
    }


def milestone(*packages: dict[str, object]) -> Milestone:
    return Milestone.from_dict({"id": "m1", "objective": "test", "workPackages": list(packages)})


class FakeGitHub:
    def __init__(self, snapshot: Snapshot) -> None:
        self.snapshot = snapshot
        self.runner = None

    def issues(self):
        return self.snapshot.issues

    def prs(self):
        return self.snapshot.prs

    def branch_exists(self, branch: str) -> bool:
        return False


class FakeAO:
    def __init__(self, snapshot: Snapshot) -> None:
        self.snapshot = snapshot

    def sessions(self):
        return self.snapshot.sessions


def config(root: Path) -> FactoryConfig:
    return FactoryConfig(
        repo="owner/repo",
        project_id="project",
        default_branch="main",
        max_active_workers=3,
        max_task_attempts=1,
        max_correction_attempts=1,
        max_review_cycles=2,
        max_convergence_passes=3,
        max_codex_calls_per_milestone=2,
        max_task_wall_clock_seconds=60,
        max_milestone_wall_clock_seconds=600,
        disk_min_free_gib=0,
        memory_min_free_mib=0,
        max_worktrees=999,
        required_checks=("CI",),
        protected_paths=("factory/**", "docs/spec/**"),
        trusted_actors=("factory-bot",),
        state_dir=root / "state",
        plan_path=root / "plan.json",
        poll_seconds=1,
        notification_command=(),
        codex_model="gpt-test",
        codex_reasoning_effort="medium",
        agy_model="gemini-test",
    )


class ModelTests(unittest.TestCase):
    def test_rejects_dependency_cycle(self) -> None:
        with self.assertRaisesRegex(ValueError, "cycle"):
            milestone(package("a", ["b"]), package("b", ["a"]))

    def test_rejects_unknown_provider(self) -> None:
        value = package("a")
        value["preferredProvider"] = "unknown"
        with self.assertRaisesRegex(ValueError, "unsupported provider"):
            WorkPackage.from_dict(value)


class GateTests(unittest.TestCase):
    def test_review_is_bound_to_current_head(self) -> None:
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": "a" * 40,
                    "status": "completed",
                    "verdict": "approved",
                    "harness": "agy",
                    "createdAt": "2026-01-01T00:00:00Z",
                }
            }]
        }
        self.assertTrue(review_gate(evidence, "a" * 40)[0])
        allowed, reason, _, _ = review_gate(evidence, "b" * 40)
        self.assertFalse(allowed)
        self.assertIn("current PR head", reason)

    def test_ci_requires_named_success(self) -> None:
        pr = PullRequest(1, "OPEN", "factory/a", "a" * 40, "url", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))
        self.assertTrue(ci_gate(pr, ("CI",))[0])
        self.assertFalse(ci_gate(pr, ("CI", "Security"))[0])

    def test_protected_paths_require_explicit_package_authority(self) -> None:
        work = WorkPackage.from_dict(package("a"))
        self.assertEqual(protected_path_violations(("factory/controller.py",), ("factory/**",), work), ("factory/controller.py",))
        allowed = package("a")
        allowed["authorizedProtectedPaths"] = ["factory/controller.py"]
        self.assertEqual(protected_path_violations(("factory/controller.py",), ("factory/**",), WorkPackage.from_dict(allowed)), ())

    def test_cross_provider_mapping(self) -> None:
        self.assertEqual(reviewer_for("muse"), "agy")
        self.assertEqual(reviewer_for("agy"), "muse")


class EnvironmentTests(unittest.TestCase):
    def test_controller_secrets_are_not_in_worker_or_ao_environment(self) -> None:
        runner = CommandRunner(Path.cwd(), {
            "PATH": "/bin",
            "HOME": "/tmp/controller",
            "GH_TOKEN": "integration-secret",
            "OPENAI_API_KEY": "codex-secret",
            "META_API_KEY": "muse-secret",
            "AO_RUN_FILE": "/run/ao.json",
        })
        ao_env = runner.env(("AO_RUN_FILE",))
        self.assertEqual(ao_env["AO_RUN_FILE"], "/run/ao.json")
        self.assertNotIn("GH_TOKEN", ao_env)
        self.assertNotIn("OPENAI_API_KEY", ao_env)
        self.assertNotIn("META_API_KEY", ao_env)


class ReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def controller(self, snapshot: Snapshot) -> FactoryController:
        return FactoryController(self.root, config(self.root), StateStore(self.root / "state"), FakeGitHub(snapshot), FakeAO(snapshot))

    def test_merged_dependency_makes_dependent_ready(self) -> None:
        plan = milestone(package("a"), package("b", ["a"]))
        issues = {
            "a": Issue(1, "CLOSED", "", "url/1", "factory-bot"),
            "b": Issue(2, "OPEN", "", "url/2", "factory-bot"),
        }
        merged = PullRequest(10, "MERGED", "factory/a", "a" * 40, "pr/10", "UNKNOWN", "UNKNOWN", merged_at="now")
        records = self.controller(Snapshot(issues=issues, prs={"a": [merged]})).reconcile(plan, Snapshot(issues=issues, prs={"a": [merged]}))
        self.assertEqual(records["a"].status, PackageStatus.COMPLETED)
        self.assertEqual(records["b"].status, PackageStatus.READY)

    def test_active_session_prevents_duplicate_spawn(self) -> None:
        plan = milestone(package("a"))
        issues = {"a": Issue(1, "OPEN", "", "url/1", "factory-bot")}
        sessions = {"a": [Session("ao-1", "factory/a", "muse", "working", "active", "1")]}
        snapshot = Snapshot(issues=issues, sessions=sessions)
        record = self.controller(snapshot).reconcile(plan, snapshot)["a"]
        self.assertEqual(record.status, PackageStatus.ACTIVE)
        self.assertEqual(record.session_id, "ao-1")

    def test_ambiguous_duplicate_sessions_block_without_deletion(self) -> None:
        plan = milestone(package("a"))
        issues = {"a": Issue(1, "OPEN", "", "url/1", "factory-bot")}
        sessions = {"a": [
            Session("ao-1", "factory/a", "muse", "working", "active", "1"),
            Session("ao-2", "factory/a", "agy", "working", "active", "1"),
        ]}
        snapshot = Snapshot(issues=issues, sessions=sessions)
        record = self.controller(snapshot).reconcile(plan, snapshot)["a"]
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertIn("preserving", record.blocked_reason or "")


if __name__ == "__main__":
    unittest.main()
