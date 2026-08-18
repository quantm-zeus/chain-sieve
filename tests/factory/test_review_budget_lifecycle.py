from __future__ import annotations

import dataclasses
import json
import subprocess
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock

from factory.controller.ao import review_gate
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.models import (
    Issue,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    ReviewDispatchState,
    Session,
    Snapshot,
    WorkPackage,
    review_dispatch_key,
    work_key,
)
from factory.controller.policy import reviewer_for
from factory.controller.reasoning import reconcile_durable_state
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
        self.trigger_hook = None
        self.trigger_exception: Exception | None = None

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
        if self.trigger_exception:
            raise self.trigger_exception
        if self.trigger_hook:
            self.trigger_hook(session_id, reviewer)

    def reviews(self, session_id: str) -> dict:
        return self.reviews_by_session.get(session_id, {"reviews": []})


class ReviewBudgetLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.plan_path = self.temp_root / "plan.json"
        self.plan_path.write_text(json.dumps({
            "id": "m1",
            "objective": "test",
            "workPackages": [package("evaluation-baseline")],
        }), encoding="utf-8")
        self.cfg = dataclasses.replace(
            config(self.temp_root),
            convergence_enabled=False,
            max_review_cycles=2,
            plan_path=self.plan_path,
        )
        self.plan = milestone(package("evaluation-baseline"))
        self.wp = self.plan.packages[0]
        self.wkey = key("evaluation-baseline")
        self.head_a = "1111111111111111111111111111111111111111"
        self.head_b = "2222222222222222222222222222222222222222"
        self.head_c = "3333333333333333333333333333333333333333"
        self.head_d = "4444444444444444444444444444444444444444"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _setup_review_context(self, store: StateStore, head_sha: str) -> tuple[Path, str]:
        path = store.write_review_context(self.plan.id, self.wp, head_sha)
        data = json.loads(path.read_text(encoding="utf-8"))
        return path, data["contextDigest"]

    def _create_controller(self, store: StateStore, github: MockGitHub, ao: MockAO, cfg: FactoryConfig | None = None) -> FactoryController:
        return FactoryController(
            self.repo_root,
            cfg or self.cfg,
            store,
            github,
            ao,
        )

    def test_rb1_initial_approval(self) -> None:
        """RB1 — Initial exact head approved: review_corrections_used=0, one semantic review, merge succeeds."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_a)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Seed initial review completed as approved
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": f"Looks good\n{PROOF_PREFIX}{digest}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used, 0)
        self.assertEqual(saved.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)
        self.assertEqual(github.merged[0].head_sha, self.head_a)

    def test_rb2_one_correction(self) -> None:
        """RB2 — Initial review rejects -> authorize correction #1 -> corrected head CI green -> verification approves."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_b = self._setup_review_context(store, self.head_b)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Step 1: Head A review completed with changes_requested
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Fix issue\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used, 1)
        self.assertEqual(saved.review_correction_authorized_from_sha, self.head_a)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("rejected PR #115", ao.sent[0][1])

        # Step 2: Worker pushes Head B with green CI
        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]
        # Head B review approved
        reviews["chainsieve-88"]["reviews"].append({
            "targetSha": self.head_b,
            "harness": "muse",
            "status": "delivered",
            "verdict": "approved",
            "body": f"Fixed!\n{PROOF_PREFIX}{digest_b}",
            "createdAt": "2026-08-17T13:00:00Z",
        })

        controller.tick()

        saved2 = store.load()[self.wkey]
        self.assertEqual(saved2.review_corrections_used, 1)
        self.assertEqual(saved2.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)
        self.assertEqual(github.merged[0].head_sha, self.head_b)

    def test_rb3_two_corrections_and_final_approval(self) -> None:
        """RB3 — Two corrections + final verification approval: maxReviewCycles=2 allows 3 reviews and merges."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_b = self._setup_review_context(store, self.head_b)
        _, digest_c = self._setup_review_context(store, self.head_c)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Step 1: Head A review rejects -> correction #1
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Needs changes 1\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        s1 = store.load()[self.wkey]
        self.assertEqual(s1.review_corrections_used, 1)

        # Step 2: Head B review rejects -> correction #2
        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]
        reviews["chainsieve-88"]["reviews"].append({
            "targetSha": self.head_b,
            "harness": "muse",
            "status": "delivered",
            "verdict": "changes_requested",
            "body": f"Needs changes 2\n{PROOF_PREFIX}{digest_b}",
            "createdAt": "2026-08-17T13:00:00Z",
        })

        controller.tick()
        s2 = store.load()[self.wkey]
        self.assertEqual(s2.review_corrections_used, 2)
        self.assertEqual(s2.review_correction_authorized_from_sha, self.head_b)

        # Step 3: Head C pushed. Notice corrections_used == max_review_cycles (2).
        # Head C MUST still receive verification review and merge!
        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_c, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]
        reviews["chainsieve-88"]["reviews"].append({
            "targetSha": self.head_c,
            "harness": "muse",
            "status": "delivered",
            "verdict": "approved",
            "body": f"Approved!\n{PROOF_PREFIX}{digest_c}",
            "createdAt": "2026-08-17T14:00:00Z",
        })

        controller.tick()
        s3 = store.load()[self.wkey]
        self.assertEqual(s3.review_corrections_used, 2)
        self.assertEqual(s3.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)
        self.assertEqual(github.merged[0].head_sha, self.head_c)

    def test_rb4_two_corrections_and_final_rejection(self) -> None:
        """RB4 — Two corrections + final review rejection: no third correction, terminal block."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_b = self._setup_review_context(store, self.head_b)
        _, digest_c = self._setup_review_context(store, self.head_c)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Seed with corrections_used=2, currently on Head C which is rejected
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_c,
            review_attempts=3,
            review_corrections_used=2,
            review_correction_authorized_from_sha=self.head_b,
        )
        store.save({self.wkey: record})

        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_c, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_c,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Still broken\n{PROOF_PREFIX}{digest_c}",
                    "createdAt": "2026-08-17T14:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_terminal_rejection_sha, self.head_c)
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        events = store.history(10)
        replan_events = [e for e in events if e.get("type") == "REPLAN_STARTED"]
        self.assertTrue(len(replan_events) >= 1)
        self.assertIn("semantic review correction budget exhausted", replan_events[0].get("reason", ""))
        # No 3rd correction instruction sent to worker
        self.assertEqual(len(ao.sent), 0)

    def test_rb5_product_fix_and_ci_fix_is_one_correction_round(self) -> None:
        """RB5 — Rejection -> product correction (CI fail) -> CI fix (CI pass) consumes exactly one correction cycle."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_c = self._setup_review_context(store, self.head_c)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Step 1: Head A review rejects
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Fix product bug\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        s1 = store.load()[self.wkey]
        self.assertEqual(s1.review_corrections_used, 1)

        # Step 2: Worker pushes Head B (product fix), but CI fails
        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "FAILURE"},),
        )]
        controller.tick()
        s2 = store.load()[self.wkey]
        # review_corrections_used must NOT increase for CI failure
        self.assertEqual(s2.review_corrections_used, 1)
        self.assertEqual(s2.status, PackageStatus.CI)
        # No review triggered for Head B
        self.assertEqual(len(ao.triggered_reviews), 0)

        # Step 3: Worker pushes Head C (CI fix), CI passes
        prs[self.wkey] = [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_c, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]
        controller.tick()
        s3 = store.load()[self.wkey]
        self.assertEqual(s3.review_corrections_used, 1)
        # Review triggered for Head C
        self.assertEqual(len(ao.triggered_reviews), 1)

    def test_rb6_transport_retries(self) -> None:
        """RB6 — Transport retries for trigger failure do not consume review correction budget."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_a)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        ao = MockAO(sessions)
        ao.trigger_exception = RuntimeError("Connection timeout")
        github = MockGitHub(issues, prs)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        record = store.load()[self.wkey]
        self.assertEqual(record.review_corrections_used, 0)
        self.assertEqual(record.review_dispatch_trigger_attempts, 1)

        # Retry after grace period
        record.review_dispatch_last_attempt_at = "2026-08-17T16:00:00+00:00"
        store.save({self.wkey: record})
        ao.trigger_exception = None

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used, 0)
        self.assertEqual(saved.review_dispatch_trigger_attempts, 2)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)

    def test_rb7_duplicate_publication(self) -> None:
        """RB7 — Multiple review entries for same run in AO/GitHub consume correction budget at most once."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_a)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO returns duplicate runs for the same head
        reviews = {
            "chainsieve-88": {
                "reviews": [
                    {
                        "targetSha": self.head_a,
                        "harness": "muse",
                        "status": "delivered",
                        "verdict": "changes_requested",
                        "body": f"Issue 1\n{PROOF_PREFIX}{digest}",
                        "createdAt": "2026-08-17T12:00:00Z",
                    },
                    {
                        "targetSha": self.head_a,
                        "harness": "muse",
                        "status": "delivered",
                        "verdict": "changes_requested",
                        "body": f"Issue 1 duplicate\n{PROOF_PREFIX}{digest}",
                        "createdAt": "2026-08-17T12:00:01Z",
                    },
                ]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        s1 = store.load()[self.wkey]
        self.assertEqual(s1.review_corrections_used, 1)

        # Repeated tick on same state
        controller.tick()
        s2 = store.load()[self.wkey]
        self.assertEqual(s2.review_corrections_used, 1)
        self.assertEqual(len(ao.sent), 1)

    def test_rb8_restart_during_correction(self) -> None:
        """RB8 — Controller restart after rejection survives and allows verification on new head without extra cost."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_b = self._setup_review_context(store, self.head_b)

        # Seed state after rejection of Head A
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_a,
            review_attempts=1,
            review_corrections_used=1,
            review_correction_authorized_from_sha=self.head_a,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        # Worker has created Head B with green CI
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        # Fresh controller tick (simulating restart)
        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used, 1)
        self.assertEqual(saved.review_attempts, 2)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(len(ao.triggered_reviews), 1)

    def test_rb9_terminal_rejection_and_unauthorized_new_head(self) -> None:
        """RB9 — After terminal rejection, unauthorized worker pushes are refused review and remain blocked."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_c = self._setup_review_context(store, self.head_c)
        _, digest_d = self._setup_review_context(store, self.head_d)

        # Seed terminally rejected state
        record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="semantic review correction budget exhausted after final exact-head verification: error",
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_c,
            review_attempts=3,
            review_corrections_used=2,
            review_terminal_rejection_sha=self.head_c,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        # Worker unexpectedly pushed Head D
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_d, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertIn("machine review budget exhausted", saved.blocked_reason or "")
        self.assertEqual(len(ao.triggered_reviews), 0)

    def test_rb10_legacy_budget_block_migration(self) -> None:
        """RB10 — Legacy state migration recovers observed dead-end and allows one final exact-head verification review."""
        store = StateStore(self.temp_root / "state")
        store.prepare()

        proc = subprocess.run(["git", "rev-parse", "HEAD~1", "HEAD"], cwd=self.repo_root, capture_output=True, text=True)
        lines = proc.stdout.strip().splitlines()
        ancestor_sha = lines[0]
        descendant_sha = lines[1]

        _, digest_descendant = self._setup_review_context(store, descendant_sha)

        # Legacy state: blocked with review_attempts=2, no review_corrections_used field
        record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="machine review budget exhausted",
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            pr_state="OPEN",
            head_sha=descendant_sha,
            ci_status="PASS",
            review_attempts=2,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 1})

        # AO has previous review on ancestor SHA with changes_requested
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": descendant_sha,
                    "status": "needs_review",
                    "previousRun": {
                        "targetSha": ancestor_sha,
                        "harness": "muse",
                        "status": "delivered",
                        "verdict": "changes_requested",
                        "body": "Fix inline findings",
                        "createdAt": "2026-08-17T18:26:00Z",
                    }
                }]
            }
        }
        ao = MockAO(reviews_by_session=reviews)

        # Run migration
        records, meta = reconcile_durable_state(store, self.plan, self.repo_root, ao)

        migrated = records[self.wkey]
        self.assertEqual(migrated.status, PackageStatus.PR_WAITING)
        self.assertIsNone(migrated.blocked_reason)
        self.assertEqual(migrated.review_attempts, 2)  # preserved
        self.assertEqual(migrated.review_corrections_used, 2)  # clamped to max
        self.assertEqual(migrated.review_correction_authorized_from_sha, ancestor_sha)
        self.assertIsNone(migrated.review_terminal_rejection_sha)
        self.assertEqual(meta.get("stateMigrationVersion"), 2)

        # Now controller tick should dispatch review for descendant_sha
        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", descendant_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        github = MockGitHub(issues, prs)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_attempts, 3)
        self.assertEqual(saved.review_corrections_used, 2)
        self.assertEqual(saved.review_dispatch_sha, descendant_sha)
        self.assertEqual(len(ao.triggered_reviews), 1)

    def test_rb11_legacy_migration_authority_unavailable(self) -> None:
        """RB11 — Legacy migration fails closed if AO review evidence is unavailable or unproven."""
        store = StateStore(self.temp_root / "state")
        store.prepare()

        record = PackageRecord(
            status=PackageStatus.BLOCKED,
            blocked_reason="machine review budget exhausted",
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            pr_state="OPEN",
            head_sha=self.head_b,
            ci_status="PASS",
            review_attempts=2,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 1})

        # AO has NO review evidence
        ao = MockAO(reviews_by_session={})

        records, meta = reconcile_durable_state(store, self.plan, self.repo_root, ao)

        migrated = records[self.wkey]
        self.assertEqual(migrated.status, PackageStatus.BLOCKED)
        self.assertIn("machine review budget exhausted", migrated.blocked_reason or "")
        self.assertEqual(meta.get("stateMigrationVersion"), 2)

    def test_rb12_max_review_cycles_zero(self) -> None:
        """RB12 — maxReviewCycles=0: initial review MUST happen; if rejected, 0 corrections allowed -> terminal block."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)

        cfg_zero = dataclasses.replace(self.cfg, max_review_cycles=0)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # Step 1: Initial review dispatch MUST happen even with max_review_cycles=0
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao, cfg_zero)

        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)
        s1 = store.load()[self.wkey]
        self.assertEqual(s1.review_attempts, 1)
        self.assertEqual(s1.review_corrections_used, 0)

        # Step 2: Initial review completed with changes_requested
        ao.reviews_by_session = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Rejected\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        controller.tick()

        s2 = store.load()[self.wkey]
        # review_corrections_used is 0, which is >= max_review_cycles (0) -> NO corrections authorized
        self.assertEqual(s2.review_corrections_used, 0)
        self.assertEqual(s2.status, PackageStatus.BLOCKED)
        self.assertEqual(s2.review_terminal_rejection_sha, self.head_a)
        self.assertEqual(len(ao.sent), 0)

    def test_rb13_review_attempts_are_telemetry_only(self) -> None:
        """RB13 — High historical review_attempts alone never prevents required exact-head verification."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_b)

        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_b,
            review_attempts=15,  # Large telemetry number
            review_corrections_used=1,  # Under max_review_cycles=2
            review_correction_authorized_from_sha=self.head_a,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_attempts, 16)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(len(ao.triggered_reviews), 1)

    def test_rb14_exact_head_binding_unchanged(self) -> None:
        """RB14 — Old head approval does not approve a new head."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        _, digest_b = self._setup_review_context(store, self.head_b)

        # Seed with approved review on Head A
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_a,
            review_sha=self.head_a,
            review_verdict="approved",
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        # PR has moved to Head B
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO only has approval for Head A
        reviews = {
            "chainsieve-88": {
                "reviews": [{
                    "targetSha": self.head_a,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": f"Approved A\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-17T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # Head B is NOT merged; a fresh review is triggered for Head B
        self.assertEqual(len(github.merged), 0)
        self.assertEqual(len(ao.triggered_reviews), 1)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_sha, self.head_b)

    def test_rb15_opposite_provider_unchanged(self) -> None:
        """RB15 — Agy implementation uses Muse reviewer; Muse implementation uses Agy reviewer."""
        self.assertEqual(reviewer_for("agy"), "muse")
        self.assertEqual(reviewer_for("muse"), "agy")


if __name__ == "__main__":
    unittest.main()
