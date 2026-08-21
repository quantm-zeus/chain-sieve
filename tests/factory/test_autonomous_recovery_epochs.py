from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import (
    BlockerClass,
    Issue,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    ReviewDispatchState,
    Session,
    WorkPackage,
    classify_blocker,
    work_key,
)
from factory.controller.prompts import (
    build_recovery_replan_prompt,
    build_recovery_worker_prompt,
    compute_recovery_plan_digest,
    extract_and_categorize_review_findings,
)
from factory.controller.review_context import PROOF_PREFIX, build_review_context
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package


class MockRunner:
    def run(self, cmd, *args, **kwargs):
        class Result:
            returncode = 0
            stdout = "1111111111111111111111111111111111111111\n"
            stderr = ""
        return Result()


class MockGitHub:
    def __init__(self, issues_dict: dict | None = None, prs_dict: dict | None = None) -> None:
        self.issues_dict = issues_dict or {}
        self.prs_dict = prs_dict or {}
        self.merged: list[PullRequest] = []
        self.closed: list[int] = []
        self.runner = MockRunner()

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

    def sessions(self):
        return dict(self.sessions_by_issue)

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        session_id = f"chainsieve-test-{issue_number}"
        self.sessions_by_issue.setdefault(str(issue_number), []).append(
            Session(session_id, f"factory/{package_id}", provider, "working", "working", str(issue_number))
        )
        return session_id

    def restore(self, session_id: str) -> None:
        self.restored.append(session_id)

    def kill(self, session_id: str) -> None:
        self.killed.append(session_id)

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def reviews(self, session_id: str):
        return self.reviews_by_session.get(session_id, {})

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        self.triggered_reviews.append((session_id, reviewer))


class MockReasoner:
    def __init__(self, plan_result: dict | None = None, raise_error: Exception | None = None) -> None:
        self.plan_result = plan_result or {
            "status": "REPLANNED",
            "reason": "Autonomous recovery plan",
            "recoveryPlan": {
                "strategy": "Apply proper voi cost weighting and enforce skeptic budget check",
                "remediationActions": ["Enforce forceSkepticOnHighRisk", "Use costWeight in VOI calculation"],
                "affectedFiles": ["src/skeptic/planner.py"],
                "recommendedProvider": "agy",
                "repairPrompt": "Fix the VOI calculation and skeptic error handling",
            },
        }
        self.raise_error = raise_error
        self.replan_calls: list[dict] = []
        self.emergency_calls: list[dict] = []

    def replan(self, milestone, failed, evidence, custom_prompt=None):
        self.replan_calls.append({
            "milestone": milestone,
            "failed": failed,
            "evidence": evidence,
            "custom_prompt": custom_prompt,
        })
        if self.raise_error:
            raise self.raise_error
        return self.plan_result

    def emergency(self, milestone, failed, contradiction):
        self.emergency_calls.append({
            "milestone": milestone,
            "failed": failed,
            "contradiction": contradiction,
        })
        return self.plan_result


class AutonomousRecoveryEpochsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp_dir.name)
        self.repo_root = self.temp_root / "repo"
        self.repo_root.mkdir(parents=True, exist_ok=True)
        self._init_git_repo(self.repo_root)

        import dataclasses
        self.cfg = dataclasses.replace(config(self.temp_root), convergence_enabled=False)
        self.store = StateStore(self.temp_root / "state")
        self.store.prepare()

        self.pkg = WorkPackage.from_dict({
            "id": "skeptic-voi",
            "objective": "Implement skeptic voi planner",
            "acceptance": ["focused evidence passes"],
            "dependencies": [],
            "parallelizable": True,
            "preferredProvider": "agy",
            "risk": "MEDIUM",
            "requirementIds": ["REQ-VOI-1"],
        })
        self.ms = Milestone("m1", "milestone 1", [self.pkg])
        self.wkey = work_key(self.ms.id, self.pkg.id)

        self.head_a = "1111111111111111111111111111111111111111"
        self.head_b = "2222222222222222222222222222222222222222"
        self.head_c = "3333333333333333333333333333333333333333"
        self.head_d = "4444444444444444444444444444444444444444"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _init_git_repo(self, path: Path) -> None:
        subprocess.run(["git", "init"], cwd=path, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "ci@chainsieve.local"], cwd=path, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "CI Bot"], cwd=path, capture_output=True, check=True)
        (path / "file.txt").write_text("initial\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=path, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=path, capture_output=True, check=True)

    def _create_controller(self, store: StateStore, github: MockGitHub, ao: MockAO, reasoner: Any = None) -> FactoryController:
        self.cfg.plan_path.write_text(json.dumps({
            "id": self.ms.id,
            "objective": self.ms.objective,
            "workPackages": [{
                "id": self.pkg.id,
                "objective": self.pkg.objective,
                "acceptance": list(self.pkg.acceptance),
                "dependencies": list(self.pkg.dependencies),
                "parallelizable": self.pkg.parallelizable,
                "preferredProvider": self.pkg.preferred_provider,
                "risk": self.pkg.risk,
                "requirementIds": list(self.pkg.requirement_ids),
                "authorizedProtectedPaths": list(self.pkg.authorized_protected_paths),
            }],
        }), encoding="utf-8")
        controller = FactoryController(self.repo_root, self.cfg, store, github, ao, reasoner=reasoner)
        return controller

    def _setup_review_context(self, store: StateStore, head_sha: str) -> tuple[Path, str]:
        path = store.write_review_context(self.ms.id, self.pkg, head_sha)
        data = json.loads(path.read_text(encoding="utf-8"))
        return path, data["contextDigest"]

    # AUTO-01: review rejects, correction 1, review rejects, correction 2, review rejects -> triggers replan (not terminal block)
    def test_auto_01_two_review_rejections_exhaust_epoch_and_trigger_replan(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"### Required fixes\n- forceSkepticOnHighRisk exists but is not enforced\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=3,
            review_corrections_used=2,
            review_corrections_used_in_epoch=2,
            review_correction_authorized_from_sha=self.head_b,
        )
        self.store.save({self.wkey: record})

        reasoner = MockReasoner()
        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(len(reasoner.replan_calls), 1)
        self.assertEqual(saved.status, PackageStatus.PR_WAITING)
        self.assertEqual(saved.recovery_epoch, 1)
        self.assertEqual(saved.review_corrections_used_in_epoch, 0)
        self.assertEqual(saved.review_corrections_used, 2)
        self.assertIsNotNone(saved.recovery_epoch_plan_digest)

    # AUTO-02: replan produces materially new strategy -> new recovery epoch, review_corrections_used_in_epoch reset, cumulative preserved
    def test_auto_02_new_strategy_starts_recovery_epoch_and_resets_epoch_budget(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"### Required fixes\n- VOI costWeight is configured but not used\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=2,
            review_corrections_used=2,
            review_corrections_used_in_epoch=2,
            recovery_epoch=0,
        )
        self.store.save({self.wkey: record})

        ao = MockAO(sessions, reviews)
        reasoner = MockReasoner()
        controller = self._create_controller(self.store, MockGitHub(issues, prs), ao, reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.recovery_epoch, 1)
        self.assertEqual(saved.review_corrections_used_in_epoch, 0)
        self.assertEqual(saved.review_corrections_used, 2)
        self.assertEqual(saved.replan_cycles_used, 1)
        # Verify worker received actionable repair prompt
        self.assertTrue(len(ao.sent) >= 1)
        self.assertIn("Recovery Epoch 1", ao.sent[0][1])

    # AUTO-03: next epoch review rejects again -> bounded corrections available again
    def test_auto_03_subsequent_epoch_rejections_consume_epoch_budget(self) -> None:
        _, digest_d = self._setup_review_context(self.store, self.head_d)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_d, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_d,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Needs minor tweak\n{PROOF_PREFIX}{digest_d}",
                    "createdAt": "2026-08-21T15:00:00Z",
                }]
            }
        }
        # In recovery epoch 1, corrections_used_in_epoch starts at 0
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_d,
            review_attempts=1,
            review_corrections_used=2,
            review_corrections_used_in_epoch=0,
            recovery_epoch=1,
        )
        self.store.save({self.wkey: record})

        ao = MockAO(sessions, reviews)
        controller = self._create_controller(self.store, MockGitHub(issues, prs), ao)
        controller.tick()

        saved = self.store.load()[self.wkey]
        # Epoch correction 1 is authorized!
        self.assertEqual(saved.review_corrections_used_in_epoch, 1)
        self.assertEqual(saved.review_corrections_used, 3)
        self.assertEqual(saved.review_correction_authorized_from_sha, self.head_d)
        self.assertTrue(len(ao.sent) >= 1)

    # AUTO-04: worker fixes issues in epoch 1, review approves -> merges cleanly, package completed
    def test_auto_04_recovery_epoch_correction_passes_review_and_merges(self) -> None:
        _, digest_d = self._setup_review_context(self.store, self.head_d)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        pr = PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_d, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )
        prs = {self.wkey: [pr]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_d,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": f"All findings resolved!\n{PROOF_PREFIX}{digest_d}",
                    "createdAt": "2026-08-21T15:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_d,
            review_attempts=1,
            review_corrections_used=3,
            review_corrections_used_in_epoch=1,
            recovery_epoch=1,
        )
        self.store.save({self.wkey: record})

        github = MockGitHub(issues, prs)
        controller = self._create_controller(self.store, github, MockAO(sessions, reviews))
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)
        self.assertEqual(github.merged[0].number, 156)

    # AUTO-05: repeated identical review rejection with no strategy change across epochs -> bounded terminal block
    def test_auto_05_repeated_identical_plan_without_progress_blocks_bounded(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Still broken\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        reasoner = MockReasoner()
        plan_digest = compute_recovery_plan_digest(self.head_c, f"Still broken\n{PROOF_PREFIX}{digest_c}", reasoner.plan_result["recoveryPlan"])

        # Seed with identical plan_digest already recorded and no_progress_epochs=1
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=3,
            review_corrections_used=4,
            review_corrections_used_in_epoch=2,
            recovery_epoch=1,
            recovery_epoch_plan_digest=plan_digest,
            no_progress_epochs=1,
        )
        self.store.save({self.wkey: record})

        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertEqual(saved.blocker_class, BlockerClass.AUTONOMOUS_RECOVERY_EXHAUSTED.value)
        self.assertIn("repeated identical recovery plan", saved.blocked_reason or "")

    # AUTO-06: provider switching on replan (agy -> muse)
    def test_auto_06_provider_switching_in_recovery_epoch_dispatches_correct_reviewer(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Agy struggling with complex logic\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=2,
            review_corrections_used=2,
            review_corrections_used_in_epoch=2,
            recovery_epoch=0,
        )
        self.store.save({self.wkey: record})

        reasoner = MockReasoner(plan_result={
            "status": "REPLANNED",
            "reason": "Escalate to Muse provider",
            "recoveryPlan": {
                "strategy": "Switch implementation provider to muse",
                "remediationActions": ["Rewrite skeptic planner"],
                "affectedFiles": ["src/skeptic/planner.py"],
                "recommendedProvider": "muse",
                "repairPrompt": "Implement skeptic planner with clean semantics",
            },
        })
        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.provider, "muse")
        self.assertEqual(saved.recovery_epoch, 1)

    # AUTO-07: Codex returns ARCHITECTURE_CONTRADICTION during recovery replan -> emergency escalation
    def test_auto_07_architecture_contradiction_escalates_to_emergency_and_classifies(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Irreconcilable spec requirements\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=2,
            review_corrections_used=2,
            review_corrections_used_in_epoch=2,
        )
        self.store.save({self.wkey: record})

        reasoner = MockReasoner(plan_result={
            "status": "ARCHITECTURE_CONTRADICTION",
            "reason": "PRD section 3.2 directly contradicts section 8.1 on budget limits",
            "plan": None,
        })
        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertEqual(saved.blocker_class, BlockerClass.HUMAN_REQUIRED_SPEC_CONFLICT.value)
        self.assertIn("irreconcilable architecture contradiction", saved.blocked_reason or "")

    # AUTO-08: PR #156 scenario reproduction: package blocked with legacy "replan already attempted" false blocker
    def test_auto_08_pr156_legacy_false_block_reconciled_and_recovers_autonomously(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"### Required fixes\n- forceSkepticOnHighRisk not enforced\n- VOI costWeight unused\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        # Exact observed state of PR #156
        record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="replan already attempted; refusing escalation loop",
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=2,
            review_corrections_used=2,
            replan_attempted=True,
            authority_schema_version=0,
        )
        self.store.save({self.wkey: record})

        reasoner = MockReasoner()
        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)

        # Reconcile unblocks PR with LEGACY_REPLAN_BLOCK_RECONCILED event
        milestone = controller.config.load_milestone()
        reconciled = controller.reconcile(milestone)
        self.assertEqual(reconciled[self.wkey].status, PackageStatus.PR_WAITING)
        self.assertIsNone(reconciled[self.wkey].blocked_reason)

        events = self.store.history(10)
        reconciled_events = [e for e in events if e.get("type") == "LEGACY_REPLAN_BLOCK_RECONCILED"]
        self.assertEqual(len(reconciled_events), 1)

        # Tick authorizes review correction pass 1 within Epoch 0
        controller.tick()
        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.recovery_epoch, 0)
        self.assertEqual(saved.review_corrections_used_in_epoch, 1)

    # AUTO-09: maxReviewCycles=2 limits corrections PER EPOCH, not lifetime package corrections
    def test_auto_09_max_review_cycles_is_epoch_scoped_not_lifetime(self) -> None:
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            review_corrections_used=4,
            review_corrections_used_in_epoch=1,
            recovery_epoch=2,
        )
        self.assertTrue(record.review_corrections_used_in_epoch < 2)

    # AUTO-10: maxAutonomousRecoveryEpochs=3 bounds global attempts
    def test_auto_10_max_autonomous_recovery_epochs_bounds_global_attempts(self) -> None:
        _, digest_c = self._setup_review_context(self.store, self.head_c)
        issues = {self.wkey: Issue(149, "OPEN", "", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_c, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Rejection in epoch 3\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-21T14:00:00Z",
                }]
            }
        }
        # Already at max epochs (3)
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_c,
            review_attempts=6,
            review_corrections_used=6,
            review_corrections_used_in_epoch=2,
            recovery_epoch=3,
        )
        self.store.save({self.wkey: record})

        reasoner = MockReasoner()
        controller = self._create_controller(self.store, MockGitHub(issues, prs), MockAO(sessions, reviews), reasoner=reasoner)
        controller.tick()

        saved = self.store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertEqual(saved.blocker_class, BlockerClass.AUTONOMOUS_RECOVERY_EXHAUSTED.value)
        self.assertIn("autonomous recovery exhausted", saved.blocked_reason or "")
        self.assertEqual(len(reasoner.replan_calls), 0)

    # AUTO-11: recovery_epoch_plan_digest novelty checking
    def test_auto_11_plan_digest_novelty_computation(self) -> None:
        target_sha = "abc1234"
        findings = "- forceSkepticOnHighRisk not enforced"
        plan1 = {
            "strategy": "Fix voi cost weighting",
            "remediationActions": ["Action 1", "Action 2"],
            "affectedFiles": ["file_a.py", "file_b.py"],
            "recommendedProvider": "agy",
        }
        plan2 = {
            "strategy": "Fix voi cost weighting",
            "remediationActions": ["Action 1", "Action 2"],
            "affectedFiles": ["file_b.py", "file_a.py"],  # different order
            "recommendedProvider": "agy",
        }
        digest1 = compute_recovery_plan_digest(target_sha, findings, plan1)
        digest2 = compute_recovery_plan_digest(target_sha, findings, plan2)
        # Order of files is sorted deterministically
        self.assertEqual(digest1, digest2)

        # Material change produces different digest
        plan3 = dict(plan1, strategy="Different strategy")
        digest3 = compute_recovery_plan_digest(target_sha, findings, plan3)
        self.assertNotEqual(digest1, digest3)

    # AUTO-12: review findings categorization
    def test_auto_12_review_findings_categorization(self) -> None:
        reviews_data = {
            "reviews": [
                {
                    "targetSha": self.head_a,
                    "body": "### Required fixes\n- forceSkepticOnHighRisk not enforced\n- VOI costWeight unused\n- typo in docstring",
                    "createdAt": "2026-08-21T10:00:00Z",
                },
                {
                    "targetSha": self.head_b,
                    "body": "### Required fixes\n- forceSkepticOnHighRisk not enforced\n- VOI costWeight unused\n- new bug in error handler",
                    "createdAt": "2026-08-21T11:00:00Z",
                },
            ]
        }
        categorized = extract_and_categorize_review_findings(reviews_data, self.head_b)
        self.assertTrue(any("forceSkeptic" in f for f in categorized["still_open_findings"]))
        self.assertTrue(any("VOI costWeight" in f for f in categorized["still_open_findings"]))
        self.assertTrue(any("new bug in error handler" in f for f in categorized["newly_introduced_findings"]))
        self.assertTrue(any("typo in docstring" in f for f in categorized["already_fixed_findings"]))

    # AUTO-13: BlockerClass categorization
    def test_auto_13_blocker_classification_human_vs_autonomous(self) -> None:
        self.assertEqual(classify_blocker("missing credentials in vault"), BlockerClass.HUMAN_REQUIRED_CREDENTIAL.value)
        self.assertEqual(classify_blocker("permission denied accessing repo"), BlockerClass.HUMAN_REQUIRED_PERMISSION.value)
        self.assertEqual(classify_blocker("spec contradiction between prd and adr"), BlockerClass.HUMAN_REQUIRED_SPEC_CONFLICT.value)
        self.assertEqual(classify_blocker("requires manual authorization for destructive force wipe"), BlockerClass.HUMAN_REQUIRED_DESTRUCTIVE_ACTION.value)
        self.assertEqual(classify_blocker("exceeded max recovery epochs"), BlockerClass.AUTONOMOUS_RECOVERY_EXHAUSTED.value)
        self.assertEqual(classify_blocker("github api 500 error"), BlockerClass.EXTERNAL_INFRASTRUCTURE_EXHAUSTED.value)

    # AUTO-14: persistence across crash/restart in Epoch > 0
    def test_auto_14_epoch_persistence_across_restart(self) -> None:
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_d,
            review_attempts=3,
            review_corrections_used=4,
            review_corrections_used_in_epoch=1,
            recovery_epoch=2,
            replan_cycles_used=2,
            recovery_epoch_plan_digest="abc123digest",
            no_progress_epochs=0,
            authority_schema_version=1,
        )
        self.store.save({self.wkey: record})

        reloaded_record = self.store.load()[self.wkey]
        self.assertEqual(reloaded_record.recovery_epoch, 2)
        self.assertEqual(reloaded_record.review_corrections_used_in_epoch, 1)
        self.assertEqual(reloaded_record.review_corrections_used, 4)
        self.assertEqual(reloaded_record.replan_cycles_used, 2)
        self.assertEqual(reloaded_record.recovery_epoch_plan_digest, "abc123digest")

    # AUTO-15: CI corrections are epoch-scoped and escalate to replan
    def test_auto_15_ci_corrections_epoch_scoped_and_escalate(self) -> None:
        issues = {self.wkey: Issue(101, "OPEN", "", "url/101", "author")}
        checks_tuple = tuple(
            {"name": name, "conclusion": "FAILURE", "failure_kind": "PRODUCT", "failure_detail": "typecheck error"}
            for name in self.cfg.required_checks
        )
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_b, "url/156",
            "MERGEABLE", "CLEAN", checks=checks_tuple,
        )]}
        sessions = {"101": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "101")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        reasoner = MockReasoner(plan_result={
            "status": "RECOVERY_PLAN",
            "recoveryPlan": {
                "strategy": "Fix typecheck errors",
                "remediationActions": ["Fix persistence types"],
                "affectedFiles": ["packages/agent-runtime/src/persistence.ts"],
                "recommendedProvider": "agy",
                "repairPrompt": "Fix typecheck errors in persistence.ts",
            },
        })

        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=101,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_b,
            ci_corrections_used=4,
            ci_corrections_used_in_epoch=2, # max reached in epoch 0
            recovery_epoch=0,
            replan_cycles_used=0,
            authority_schema_version=1,
        )
        self.store.save({self.wkey: record})

        controller = self._create_controller(self.store, github, ao, reasoner=reasoner)
        controller.tick()

        updated = self.store.load()[self.wkey]
        self.assertEqual(updated.recovery_epoch, 1)
        self.assertEqual(updated.ci_corrections_used_in_epoch, 0)
        self.assertEqual(updated.replan_cycles_used, 1)

    # AUTO-16: Reconcile false CI correction budget exhausted blocks
    def test_auto_16_reconcile_ci_exhaustion_legacy_block(self) -> None:
        issues = {self.wkey: Issue(101, "OPEN", "", "url/101", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"101": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "101")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)

        record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="CI correction budget exhausted: checks not passing: Tier 3 · pre-main",
            last_error="CI correction budget exhausted: checks not passing: Tier 3 · pre-main",
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_a,
            ci_corrections_used=2,
            recovery_epoch=0,
            replan_cycles_used=0,
            authority_schema_version=1,
        )
        self.store.save({self.wkey: record})

        controller = self._create_controller(self.store, github, ao)
        controller.tick()

        updated = self.store.load()[self.wkey]
        self.assertIn(updated.status, {PackageStatus.PR_WAITING, PackageStatus.REVIEW})
        self.assertIsNone(updated.blocked_reason)
        self.assertEqual(updated.ci_corrections_used_in_epoch, 0)


if __name__ == "__main__":
    unittest.main()

