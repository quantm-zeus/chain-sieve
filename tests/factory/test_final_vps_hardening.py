from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from factory.controller.controller import FactoryController
from factory.controller.models import Issue, PackageRecord, PackageStatus, PullRequest, Snapshot, WorkPackage
from factory.controller.reasoning import _validate_requirement_ids
from factory.controller.review_context import PROOF_PREFIX, build_review_context, resolve_task_context
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package


class MergeGitHub:
    def __init__(self) -> None:
        self.runner = object()
        self.merged: list[PullRequest] = []
        self.closed: list[int] = []

    def merge(self, pr: PullRequest) -> None:
        self.merged.append(pr)

    def close_issue(self, number: int, reason: str) -> None:
        self.closed.append(number)


class SnapshotGitHub(MergeGitHub):
    def __init__(self, snapshot: Snapshot) -> None:
        super().__init__()
        self.snapshot = snapshot

    def issues(self):
        return self.snapshot.issues

    def prs(self):
        return self.snapshot.prs

    def branch_exists(self, branch: str) -> bool:
        return False


class ReviewAO:
    def __init__(self, head: str, verdict: str = "approved", digest: str | None = None) -> None:
        self.head = head
        self.verdict = verdict
        self.digest = digest if digest is not None else review_digest(head)
        self.sent: list[str] = []
        self.triggered: list[tuple[str, str]] = []

    def reviews(self, session_id: str):
        if self.verdict == "missing":
            return {"reviews": []}
        return {"reviews": [{"latestRun": {
            "targetSha": self.head,
            "status": "complete",
            "verdict": self.verdict,
            "harness": "agy",
            "body": f"semantic review\n\n{PROOF_PREFIX}{self.digest}",
            "createdAt": "2026-01-01T00:00:00Z",
        }}]}

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        self.triggered.append((session_id, reviewer))

    def send(self, session_id: str, message: str) -> None:
        self.sent.append(message)


class SnapshotAO(ReviewAO):
    def sessions(self):
        return {}


class AuditReasoner:
    def __init__(self, results: list[dict[str, object]]) -> None:
        self.results = list(results)
        self.calls = 0

    def final_audit(self, output: Path) -> dict[str, object]:
        self.calls += 1
        return self.results.pop(0)


def audit(status: str, finding: str = "") -> dict[str, object]:
    return {
        "status": status,
        "blocking_gaps": [finding] if finding else [],
        "requirements_missing": [],
        "architecture_conflicts": [],
        "test_gaps": [],
        "runtime_failures": [],
        "security_gaps": [],
        "operational_gaps": [],
    }


def review_digest(head: str, value: dict[str, object] | None = None, milestone_id: str = "m1") -> str:
    work = WorkPackage.from_dict(value or package("a"))
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


class FinalVPSHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_policy_blocked_merge_state_does_not_deadlock_exact_head_gate(self) -> None:
        head = "a" * 40
        cfg = config(self.root)
        store = StateStore(cfg.state_dir)
        github = MergeGitHub()
        ao = ReviewAO(head)
        controller = FactoryController(self.root, cfg, store, github, ao)
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-1", provider="muse", issue_number=9)
        pr = PullRequest(
            7, "OPEN", "factory/m1--a", head, "url/7", "MERGEABLE", "BLOCKED",
            checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
        )
        controller._handle_pr(milestone(package("a")), work, record, pr)
        self.assertEqual(github.merged, [pr])
        self.assertEqual(record.status, PackageStatus.COMPLETE)

    def test_approved_review_without_exact_digest_blocks_deterministically(self) -> None:
        head = "e" * 40
        cfg = config(self.root)
        github = MergeGitHub()
        ao = ReviewAO(head, digest="f" * 64)
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), github, ao)
        record = PackageRecord(session_id="ao-1", provider="muse", review_attempts=1)
        pr = PullRequest(
            71, "OPEN", "factory/m1--a", head, "url/71", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
        )
        controller._handle_pr(milestone(package("a")), WorkPackage.from_dict(package("a")), record, pr)
        self.assertEqual(github.merged, [])
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertIn("semantic authority proof", record.blocked_reason or "")

    def test_revoked_github_login_is_reported_as_external_blocker(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({
            "id": "m1", "objective": "test", "workPackages": [package("a")],
        }), encoding="utf-8")

        class RevokedGitHub:
            def issues(self):
                raise RuntimeError("gh auth login required: HTTP 401 bad credentials")

        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), RevokedGitHub(), object())
        with self.assertRaisesRegex(RuntimeError, "401"):
            controller.run(once=True)
        status = controller.status()
        self.assertEqual(status["externalBlocker"], "GITHUB_AUTH")
        self.assertEqual(status["status"], "DEGRADED")
        self.assertFalse((cfg.state_dir / "usage.json").exists())

    def test_actual_merge_conflict_blocks_merge(self) -> None:
        head = "b" * 40
        cfg = replace(config(self.root), max_correction_attempts=0)
        github = MergeGitHub()
        controller = FactoryController(self.root, cfg, StateStore(cfg.state_dir), github, ReviewAO(head))
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-1", provider="muse")
        pr = PullRequest(
            8, "OPEN", "factory/m1--a", head, "url/8", "CONFLICTING", "BLOCKED",
            checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
        )
        controller._handle_pr(milestone(package("a")), work, record, pr)
        self.assertEqual(github.merged, [])
        self.assertNotEqual(record.status, PackageStatus.COMPLETE)

    def test_incomplete_dependency_prevents_otherwise_green_reviewed_merge(self) -> None:
        head = "d" * 40
        first = package("a")
        second = package("b")
        second["dependencies"] = ["a"]
        plan_value = {"id": "m1", "objective": "test", "workPackages": [first, second]}
        cfg = replace(config(self.root), convergence_enabled=False, max_active_workers=0)
        cfg.plan_path.write_text(json.dumps(plan_value), encoding="utf-8")
        pr = PullRequest(
            10, "OPEN", "factory/m1--b", head, "url/10", "MERGEABLE", "BLOCKED",
            checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
        )
        snapshot = Snapshot(
            issues={
                key("a"): Issue(1, "OPEN", "", "issue/1", "factory-bot"),
                key("b"): Issue(2, "OPEN", "", "issue/2", "factory-bot"),
            },
            prs={key("b"): [pr]},
        )
        store = StateStore(cfg.state_dir)
        store.save({
            key("a"): PackageRecord(status=PackageStatus.STARTING, issue_number=1),
            key("b"): PackageRecord(status=PackageStatus.PR_WAITING, issue_number=2, session_id="ao-b", provider="muse"),
        })
        github = SnapshotGitHub(snapshot)
        controller = FactoryController(self.root, cfg, store, github, SnapshotAO(head))
        controller.tick()
        self.assertEqual(github.merged, [])

    def test_semantic_review_context_is_controller_owned_and_exact_head(self) -> None:
        head = "c" * 40
        cfg = config(self.root)
        store = StateStore(cfg.state_dir)
        ao = ReviewAO(head, "missing")
        controller = FactoryController(self.root, cfg, store, MergeGitHub(), ao)
        value = package("a")
        value["objective"] = "Return the authoritative semantic outcome"
        value["acceptance"] = ["semantic canary remains rejected until fixed"]
        value["requirementIds"] = ["FR-CORE-001"]
        work = WorkPackage.from_dict(value)
        record = PackageRecord(session_id="ao-1", provider="muse")
        pr = PullRequest(
            9, "OPEN", "factory/m1--a", head, "url/9", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
        )
        controller._handle_pr(milestone(value), work, record, pr)
        path = store.review_dir / "m1--a" / f"{head}.json"
        context = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(context["workKey"], "m1--a")
        self.assertEqual(context["targetSha"], head)
        self.assertEqual(context["objective"], value["objective"])
        self.assertEqual(context["acceptance"], value["acceptance"])
        self.assertEqual(context["requirementIds"], value["requirementIds"])
        self.assertEqual(context["contextDigest"], review_digest(head, value))
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o440)
        self.assertEqual(ao.triggered, [("ao-1", "agy")])
        unit = (Path(__file__).resolve().parents[2] / "factory/deployment/systemd/chainsieve-ao.service").read_text()
        self.assertIn("ReadOnlyPaths=@REPO@ @STATE@", unit)
        contract = (Path(__file__).resolve().parents[2] / "factory/deployment/reviewer-contract.md").read_text()
        self.assertIn("every later AO task", contract)
        self.assertIn(PROOF_PREFIX, contract)

    def test_review_wrappers_establish_standing_contract_on_spawn_and_restore(self) -> None:
        workspace = self.root / "workspace"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "factory/m1--a"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=workspace, check=True)
        (workspace / "file").write_text("content\n", encoding="utf-8")
        subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "test"], cwd=workspace, check=True)
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True,
        ).stdout.strip()
        repo = Path(__file__).resolve().parents[2]
        contract = repo / "factory/deployment/reviewer-contract.md"
        capture = self.root / "capture"
        capture.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "DEVELOPER=%s\\n" "${TBH_EVAL_APPEND_DEVELOPER_PROMPT:-}"\n', encoding="utf-8")
        capture.chmod(0o755)
        deployment = repo / "factory/deployment/bin"
        common = {**os.environ, "CHAINSIEVE_REVIEWER_CONTRACT_FILE": str(contract)}
        invocations = (
            ("agy", "CHAINSIEVE_AGY_REAL", ["--sandbox", "--prompt-interactive", "review this head"]),
            ("muse", "CHAINSIEVE_MUSE_REAL", ["--disable-write", "review this head"]),
        )
        for wrapper, variable, arguments in invocations:
            result = subprocess.run(
                [str(deployment / wrapper), *arguments], cwd=workspace,
                env={**common, variable: str(capture)}, check=True, text=True, capture_output=True,
            )
            self.assertIn("standing reviewer contract", result.stdout)
            self.assertIn("chainsieve-review-context", result.stdout)
        restores = (
            ("muse", "CHAINSIEVE_MUSE_REAL", ["--disable-write", "resume", "muse-native-1"]),
            ("agy", "CHAINSIEVE_AGY_REAL", ["--sandbox", "--prompt-interactive", "idle restored reviewer"]),
        )
        for wrapper, variable, arguments in restores:
            restored = subprocess.run(
                [str(deployment / wrapper), *arguments], cwd=workspace,
                env={**common, variable: str(capture)}, check=True, text=True, capture_output=True,
            )
            self.assertIn("standing reviewer contract", restored.stdout)

        ordinary = (
            ("muse", "CHAINSIEVE_MUSE_REAL", ["--yolo", "implement ordinary work"]),
            ("agy", "CHAINSIEVE_AGY_REAL", ["--dangerously-skip-permissions", "--prompt-interactive", "implement ordinary work"]),
        )
        for wrapper, variable, arguments in ordinary:
            result = subprocess.run(
                [str(deployment / wrapper), *arguments], cwd=workspace,
                env={**common, variable: str(capture)}, check=True, text=True, capture_output=True,
            )
            self.assertNotIn("standing reviewer contract", result.stdout)

    def test_notify_reuse_resolves_new_head_context_and_rejects_stale_proof(self) -> None:
        workspace = self.root / "workspace"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "factory/m1--a"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=workspace, check=True)
        store = StateStore(self.root / "state")
        work = WorkPackage.from_dict(package("a"))
        ao_data = self.root / "ao"
        task_dir = ao_data / "prompts" / "worker" / "reviewer" / "requests" / "batch" / "run"
        task_dir.mkdir(parents=True)

        def commit_and_resolve(content: str) -> dict[str, object]:
            (workspace / "file").write_text(content, encoding="utf-8")
            subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
            subprocess.run(["git", "commit", "-q", "-m", content], cwd=workspace, check=True)
            head_value = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True,
            ).stdout.strip()
            store.write_review_context("m1", work, head_value)
            task = task_dir / "task.md"
            task.write_text(
                f"Review task queue:\n* 1. https://example/pr (head commit {head_value}, run run-1)\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {
                "AO_DATA_DIR": str(ao_data),
                "CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR": str(store.review_dir),
            }, clear=False):
                return resolve_task_context(task, cwd=workspace)

        authority_a = commit_and_resolve("head-a")
        authority_b = commit_and_resolve("head-b")
        self.assertNotEqual(authority_a["contextDigest"], authority_b["contextDigest"])
        head_b = str(authority_b["authority"]["targetSha"])
        approved_b = {"reviews": [{"latestRun": {
            "targetSha": head_b, "status": "completed", "verdict": "approved", "harness": "agy",
            "body": str(authority_b["proofMarker"]),
        }}]}
        from factory.controller.ao import review_gate
        self.assertTrue(review_gate(approved_b, head_b, "agy", str(authority_b["contextDigest"]))[0])
        self.assertFalse(review_gate(approved_b, head_b, "agy", str(authority_a["contextDigest"]))[0])
        wrong_work_key_digest = review_digest(head_b, package("b"))
        self.assertFalse(review_gate(approved_b, head_b, "agy", wrong_work_key_digest)[0])
        missing_proof = {"reviews": [{"latestRun": {
            "targetSha": head_b, "status": "delivered", "verdict": "approved", "harness": "agy", "body": "ready",
        }}]}
        self.assertFalse(review_gate(missing_proof, head_b, "agy", str(authority_b["contextDigest"]))[0])

    def test_changes_requested_head_a_then_same_session_review_head_b_passes_only_with_digest_b(self) -> None:
        head_a = "a" * 40
        head_b = "b" * 40

        class ReusedReviewerAO:
            def __init__(self) -> None:
                self.payload: dict[str, object] = {"reviews": [{"latestRun": {
                    "targetSha": head_a, "status": "delivered", "verdict": "changes_requested",
                    "harness": "agy", "body": "acceptance is not met",
                }}]}
                self.sent: list[tuple[str, str]] = []
                self.triggered: list[tuple[str, str]] = []

            def reviews(self, session_id: str):
                return self.payload

            def send(self, session_id: str, message: str) -> None:
                self.sent.append((session_id, message))

            def trigger_review(self, session_id: str, reviewer: str) -> None:
                self.triggered.append((session_id, reviewer))

        cfg = config(self.root)
        store = StateStore(cfg.state_dir)
        github = MergeGitHub()
        ao = ReusedReviewerAO()
        controller = FactoryController(self.root, cfg, store, github, ao)
        work = WorkPackage.from_dict(package("a"))
        record = PackageRecord(session_id="ao-reused-pane", provider="muse", review_attempts=1)

        def pr(head: str) -> PullRequest:
            return PullRequest(
                81, "OPEN", "factory/m1--a", head, "url/81", "MERGEABLE", "CLEAN",
                checks=({"name": "CI", "conclusion": "SUCCESS"},), base_branch="main", author="factory-bot",
            )

        controller._handle_pr(milestone(package("a")), work, record, pr(head_a))
        self.assertEqual(len(ao.sent), 1)
        self.assertEqual(github.merged, [])

        ao.payload = {"reviews": []}
        controller._handle_pr(milestone(package("a")), work, record, pr(head_b))
        self.assertEqual(ao.triggered, [("ao-reused-pane", "agy")])
        context_b = json.loads((store.review_dir / "m1--a" / f"{head_b}.json").read_text())

        ao.payload = {"reviews": [{"latestRun": {
            "targetSha": head_b, "status": "delivered", "verdict": "approved", "harness": "agy",
            "body": f"ready\n\n{PROOF_PREFIX}{context_b['contextDigest']}",
        }}]}
        controller._handle_pr(milestone(package("a")), work, record, pr(head_b))
        self.assertEqual(github.merged, [pr(head_b)])

    def test_actual_review_without_context_root_fails_closed_while_idle_restore_can_launch(self) -> None:
        workspace = self.root / "workspace"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "factory/m1--a"], cwd=workspace, check=True)
        (workspace / "file").write_text("content", encoding="utf-8")
        subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
        subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "test"], cwd=workspace, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True).stdout.strip()
        ao_data = self.root / "ao"
        task = ao_data / "prompts" / "worker" / "reviewer" / "requests" / "batch" / "run" / "task.md"
        task.parent.mkdir(parents=True)
        task.write_text(f"* 1. https://example/pr (head commit {head}, run run-1)\n", encoding="utf-8")
        deployment = Path(__file__).resolve().parents[2] / "factory/deployment"
        resolver_env = {key: value for key, value in os.environ.items() if key not in {"CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR", "CHAINSIEVE_FACTORY_STATE_DIR"}}
        result = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env={**resolver_env, "AO_DATA_DIR": str(ao_data), "PYTHONPATH": str(Path(__file__).resolve().parents[2])},
            check=False, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 78)
        self.assertIn("review-context root is unavailable", result.stderr)

    def test_reviewer_launch_environment_normalizes_home_under_ao_isolation(self) -> None:
        fake_user_home = self.root / "fake_user_home"
        fake_user_home.mkdir()
        (fake_user_home / ".gemini").mkdir()
        (fake_user_home / ".gemini" / "settings.json").write_text("{}", encoding="utf-8")

        isolated_runtime = self.root / "reviewer-runtime" / "review-session-1" / "config"
        isolated_runtime.mkdir(parents=True)

        capture = self.root / "capture-env"
        capture.write_text(
            '#!/bin/sh\n'
            'printf "HOME=%s\\n" "${HOME:-}"\n'
            'printf "XDG_CONFIG_HOME=%s\\n" "${XDG_CONFIG_HOME:-}"\n'
            'printf "ARGS=%s\\n" "$*"\n',
            encoding="utf-8",
        )
        capture.chmod(0o755)

        repo = Path(__file__).resolve().parents[2]
        deployment = repo / "factory/deployment/bin"
        contract = repo / "factory/deployment/reviewer-contract.md"

        env = {
            **os.environ,
            "CHAINSIEVE_USER_HOME": str(fake_user_home),
            "HOME": str(isolated_runtime),
            "XDG_CONFIG_HOME": str(isolated_runtime),
            "CHAINSIEVE_AGY_REAL": str(capture),
            "CHAINSIEVE_MUSE_REAL": str(capture),
            "CHAINSIEVE_REVIEWER_CONTRACT_FILE": str(contract),
        }

        # Test Agy reviewer
        res_agy = subprocess.run(
            [str(deployment / "agy"), "--sandbox", "--prompt-interactive", "review prompt"],
            env=env, check=True, text=True, capture_output=True,
        )
        self.assertIn(f"HOME={fake_user_home}", res_agy.stdout)
        self.assertIn("XDG_CONFIG_HOME=\n", res_agy.stdout)

    def test_review_context_fallback_to_state_dir_when_review_context_dir_mismatched(self) -> None:
        workspace = self.root / "workspace"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "factory/m1--a"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=workspace, check=True)
        (workspace / "file").write_text("content\n", encoding="utf-8")
        subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "test"], cwd=workspace, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True).stdout.strip()

        store = StateStore(self.root / "actual_state")
        work = WorkPackage.from_dict(package("a"))
        store.write_review_context("m1", work, head)

        ao_data = self.root / "ao"
        task = ao_data / "prompts" / "worker" / "reviewer" / "requests" / "batch" / "run" / "task.md"
        task.parent.mkdir(parents=True)
        task.write_text(f"* 1. https://example/pr (head commit {head}, run run-1)\n", encoding="utf-8")

        deployment = Path(__file__).resolve().parents[2] / "factory/deployment"
        mismatched_env = {
            **os.environ,
            "AO_DATA_DIR": str(ao_data),
            "CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR": str(self.root / "non_existent_canary_state" / "reviews"),
            "CHAINSIEVE_FACTORY_STATE_DIR": str(self.root / "actual_state"),
            "PYTHONPATH": str(Path(__file__).resolve().parents[2]),
        }
        result = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env=mismatched_env, check=True, text=True, capture_output=True,
        )
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["authority"]["targetSha"], head)
        self.assertEqual(parsed["authority"]["workKey"], "m1--a")
        self.assertIn(PROOF_PREFIX, parsed["proofMarker"])

    def test_review_context_fail_closed_on_mismatches_and_stale_digests(self) -> None:
        workspace = self.root / "workspace-failclosed"
        workspace.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "factory/m1--a"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.name", "test"], cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=workspace, check=True)
        (workspace / "file").write_text("initial\n", encoding="utf-8")
        subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=workspace, check=True)
        head1 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True).stdout.strip()

        # Create second commit (new head)
        (workspace / "file").write_text("updated\n", encoding="utf-8")
        subprocess.run(["git", "add", "file"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "update"], cwd=workspace, check=True)
        head2 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=workspace, check=True, text=True, capture_output=True).stdout.strip()

        store = StateStore(self.root / "state-failclosed")
        work = WorkPackage.from_dict(package("a"))
        # Write review context for head1 only
        store.write_review_context("m1", work, head1)

        ao_data = self.root / "ao-failclosed"
        task = ao_data / "prompts" / "worker" / "reviewer" / "requests" / "batch" / "run" / "task.md"
        task.parent.mkdir(parents=True)
        # Task points to head1, but workspace is at head2
        task.write_text(f"* 1. https://example/pr (head commit {head1}, run run-1)\n", encoding="utf-8")

        deployment = Path(__file__).resolve().parents[2] / "factory/deployment"
        env = {
            **os.environ,
            "AO_DATA_DIR": str(ao_data),
            "CHAINSIEVE_FACTORY_STATE_DIR": str(self.root / "state-failclosed"),
            "PYTHONPATH": str(Path(__file__).resolve().parents[2]),
        }
        # 1. Wrong workspace head -> must fail closed with exit 78
        res_wrong_head = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env=env, check=False, text=True, capture_output=True,
        )
        self.assertEqual(res_wrong_head.returncode, 78)
        self.assertIn("workspace head does not match", res_wrong_head.stderr)

        # 2. Task points to head2, but context was only generated for head1 -> missing context for head2 -> fail closed with exit 78
        task.write_text(f"* 1. https://example/pr (head commit {head2}, run run-2)\n", encoding="utf-8")
        res_missing_context = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env=env, check=False, text=True, capture_output=True,
        )
        self.assertEqual(res_missing_context.returncode, 78)
        self.assertIn("review context artifact is unavailable", res_missing_context.stderr)

        # 3. Now write review context for head2 -> must succeed
        store.write_review_context("m1", work, head2)
        res_valid = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env=env, check=True, text=True, capture_output=True,
        )
        parsed = json.loads(res_valid.stdout)
        self.assertEqual(parsed["authority"]["targetSha"], head2)

        # 4. Context with corrupted digest -> must fail closed
        context_path = self.root / "state-failclosed" / "reviews" / "m1--a" / f"{head2}.json"
        raw = json.loads(context_path.read_text(encoding="utf-8"))
        raw["contextDigest"] = "0" * 64
        context_path.chmod(0o644)
        context_path.write_text(json.dumps(raw), encoding="utf-8")
        res_corrupt_digest = subprocess.run(
            [str(deployment / "bin/chainsieve-review-context"), str(task)], cwd=workspace,
            env=env, check=False, text=True, capture_output=True,
        )
        self.assertEqual(res_corrupt_digest.returncode, 78)
        self.assertIn("digest is invalid", res_corrupt_digest.stderr)

    def test_concurrent_heartbeat_writes_are_atomic_and_valid(self) -> None:
        store = StateStore(self.root / "state")
        with ThreadPoolExecutor(max_workers=16) as executor:
            futures = [executor.submit(store.heartbeat, active=bool(index % 2)) for index in range(1000)]
            for future in futures:
                future.result()
        value = json.loads(store.heartbeat_path.read_text(encoding="utf-8"))
        self.assertIn(value["active"], {True, False})
        self.assertIn("controllerHeartbeatAt", value)
        self.assertFalse(list(store.directory.glob(".heartbeat.*")))

    def test_history_reads_bounded_tail_and_skips_truncated_final_line(self) -> None:
        store = StateStore(self.root / "state")
        store.prepare()
        with store.events_path.open("w", encoding="utf-8") as stream:
            for index in range(25_000):
                stream.write(json.dumps({"index": index, "payload": "x" * 80}) + "\n")
            stream.write('{"index":')
        events = store.history(50)
        self.assertEqual(len(events), 50)
        self.assertEqual(events[0]["index"], 24_950)
        self.assertEqual(events[-1]["index"], 24_999)

    def test_requirement_ids_use_exact_authoritative_tokens(self) -> None:
        spec = self.root / "docs/spec"
        spec.mkdir(parents=True)
        (spec / "authority.requirements.json").write_text(json.dumps({
            "requirements": [{"id": "FR-COL-0010"}],
            "acceptanceCriteria": [{"id": "AC-001"}],
            "invariants": [{"id": "INV-001"}],
            "adrs": [{"id": "ADR-001"}],
        }), encoding="utf-8")

        def validate(identifier: str) -> None:
            value = package("a")
            value["requirementIds"] = [identifier]
            _validate_requirement_ids(self.root, milestone(value))

        for identifier in ("FR-COL-0010", "AC-001", "INV-001", "ADR-001"):
            validate(identifier)
        for identifier in ("FR-COL-001", "FR-COL-0010-X", "X-FR-COL-0010", " FR-COL-0010", "FR-COL-0010 "):
            with self.subTest(identifier=identifier), self.assertRaisesRegex(RuntimeError, "unknown normative"):
                validate(identifier)

    def test_final_audit_remediation_then_second_audit_can_finish(self) -> None:
        cfg = config(self.root)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        store = StateStore(cfg.state_dir)
        records = {key("a"): PackageRecord(status=PackageStatus.COMPLETE)}
        metadata = {"milestoneConverged": True}
        reasoner = AuditReasoner([audit("NOT_CONVERGED", "semantic gap"), audit("CONVERGED")])
        controller = FactoryController(self.root, cfg, store, MergeGitHub(), object(), reasoner)
        with patch("factory.controller.controller._roadmap", return_value=[{"id": "m1"}]):
            first = cfg.load_milestone()
            controller._advance_or_audit(first, records, metadata)
            remediation = cfg.load_milestone()
            self.assertEqual(len(remediation.packages), 2)
            records[key(remediation.packages[-1].id)] = PackageRecord(status=PackageStatus.COMPLETE)
            metadata["milestoneConverged"] = True
            controller._advance_or_audit(remediation, records, metadata)
        self.assertTrue(metadata["finalAuditConverged"])
        self.assertEqual(metadata["finalAuditCycles"], 2)
        self.assertEqual(reasoner.calls, 2)

    def test_repeated_not_converged_trips_bounded_audit_circuit(self) -> None:
        cfg = replace(config(self.root), max_final_audit_cycles=3)
        cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [package("a")]}), encoding="utf-8")
        store = StateStore(cfg.state_dir)
        records = {key("a"): PackageRecord(status=PackageStatus.COMPLETE)}
        metadata = {"milestoneConverged": True}
        reasoner = AuditReasoner([audit("NOT_CONVERGED", "same gap") for _ in range(3)])
        controller = FactoryController(self.root, cfg, store, MergeGitHub(), object(), reasoner)
        with patch("factory.controller.controller._roadmap", return_value=[{"id": "m1"}]):
            for _ in range(3):
                current = cfg.load_milestone()
                for item in current.packages:
                    records[key(item.id)] = PackageRecord(status=PackageStatus.COMPLETE)
                metadata["milestoneConverged"] = True
                controller._advance_or_audit(current, records, metadata)
            controller._advance_or_audit(cfg.load_milestone(), records, metadata)
        self.assertEqual(reasoner.calls, 3)
        self.assertTrue(metadata["convergenceBlocked"])
        remediation = json.loads((cfg.state_dir / "remediation-plan.json").read_text())
        self.assertEqual(len(remediation["workPackages"]), 1)

    def test_deployment_sources_have_one_configurable_user_and_paths(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        deployment = repo / "factory/deployment"
        text = "\n".join(
            path.read_text(encoding="utf-8", errors="ignore")
            for path in deployment.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
        )
        for stale in (
            "chainsieve-worker", "chainsieve-controller", "/srv/chainsieve", "/var/lib/chainsieve",
            "required_approving_review_count", "require_last_push_approval",
        ):
            self.assertNotIn(stale, text)
        ao_unit = (deployment / "systemd/chainsieve-ao.service").read_text()
        factory_unit = (deployment / "systemd/chainsieve-factory.service").read_text()
        self.assertIn("User=@DEPLOY_USER@", ao_unit)
        self.assertIn("User=@DEPLOY_USER@", factory_unit)
        self.assertIn("ProtectHome=false", ao_unit)
        self.assertIn("ProtectHome=false", factory_unit)
        self.assertIn('Environment="GH_CONFIG_DIR=@USER_HOME@/.config/gh"', ao_unit)
        self.assertIn("UnsetEnvironment=GH_TOKEN GITHUB_TOKEN", ao_unit)
        self.assertIn("UnsetEnvironment=GH_TOKEN GITHUB_TOKEN", factory_unit)
        self.assertIn('Environment="TMUX_TMPDIR=@AO_DATA@/tmux"', ao_unit)
        self.assertIn('Environment="CHAINSIEVE_REVIEWER_CONTRACT_FILE=/opt/chainsieve/factory-bin/reviewer-contract.md"', ao_unit)
        installer = (deployment / "install-ubuntu.sh").read_text()
        self.assertIn('--user USER --repo PATH', installer)
        self.assertIn('state="$(readlink -m "${state:-$user_home/', installer)
        self.assertIn('install -d -o "$deploy_user" -g "$deploy_group" -m 0700 "$ao_data/tmux"', installer)
        self.assertIn('refusing broad runtime or environment path', installer)
        self.assertIn('runtime and environment paths cannot contain one another', installer)
        self.assertIn("ao_tree=\"ea4d7ee451ca5a529422df66fa97a59af2c33a43\"", installer)
        self.assertIn('refusing to compile local modifications', installer)
        self.assertIn('ls-files --others --ignored --exclude-standard', installer)
        canary = (deployment / "activate-canary.sh").read_text()
        self.assertIn("chainsieve-ao.service.d", canary)
        self.assertIn('"ReadOnlyPaths=$canary_state_unit"', canary)


if __name__ == "__main__":
    unittest.main()
