from __future__ import annotations

import dataclasses
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
    ReviewDispatchState,
    Session,
    Snapshot,
    WorkPackage,
    review_dispatch_key,
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


class ReviewDispatchIdempotencyTests(unittest.TestCase):
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
        self.cfg = dataclasses.replace(config(self.temp_root), convergence_enabled=False)
        self.plan = milestone(package("evaluation-baseline"))
        self.wp = self.plan.packages[0]
        self.wkey = key("evaluation-baseline")
        self.head_sha = "fa18101b35e23b8ba23925e7c0d7ccea45459388"
        self.head_sha_alt = "72922e160c8023c3360be1b436b60fbaf538c034"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _setup_review_context(self, store: StateStore, head_sha: str) -> tuple[Path, str]:
        path = store.write_review_context(self.plan.id, self.wp, head_sha)
        data = json.loads(path.read_text(encoding="utf-8"))
        return path, data["contextDigest"]

    def _create_controller(self, store: StateStore, github: MockGitHub, ao: MockAO) -> FactoryController:
        return FactoryController(
            self.repo_root,
            self.cfg,
            store,
            github,
            ao,
        )

    def test_r1_repeated_ticks_same_logical_review(self) -> None:
        """R1 — Repeated controller ticks for same logical review call ao.trigger_review exactly once."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)

        # Hook trigger to simulate AO registering pending review on trigger
        def on_trigger(session_id: str, reviewer: str):
            ao.reviews_by_session[session_id] = {
                "reviews": [{
                    "latestRun": {
                        "id": "run-1",
                        "targetSha": self.head_sha,
                        "harness": reviewer,
                        "status": "running",
                        "createdAt": "2026-08-17T16:00:00Z",
                    }
                }]
            }
        ao.trigger_hook = on_trigger

        controller = self._create_controller(store, github, ao)

        # Run 5 consecutive ticks
        for _ in range(5):
            controller.tick()

        self.assertEqual(len(ao.triggered_reviews), 1)
        self.assertEqual(ao.triggered_reviews[0], ("chainsieve-88", "muse"))
        record = store.load()[self.wkey]
        self.assertEqual(record.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(record.review_attempts, 1)

    def test_r2_reconcile_preserves_in_flight_identity(self) -> None:
        """R2 — Reconcile preserves durable review dispatch identity and does not re-trigger."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        # Seed durable state with in-flight review dispatch
        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=1,
            review_dispatch_key=dkey,
            review_dispatch_state=ReviewDispatchState.ACTIVE.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest,
            review_dispatch_run_id="run-1",
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-1",
                "targetSha": self.head_sha,
                "harness": "muse",
                "status": "pending",
                "createdAt": "2026-08-17T16:00:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        # Reconcile snapshot
        snapshot = Snapshot(issues=issues, prs=prs, sessions=sessions)
        records = controller.reconcile(self.plan, snapshot)

        self.assertEqual(records[self.wkey].status, PackageStatus.REVIEW)
        self.assertEqual(records[self.wkey].review_dispatch_key, dkey)
        self.assertEqual(records[self.wkey].review_dispatch_state, ReviewDispatchState.ACTIVE.value)

        # Next tick must not trigger review again
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 0)

    def test_r3_crash_after_claim_before_ao_call(self) -> None:
        """R3 — Claim persisted before AO trigger; crash occurs; restart recovers without deadlock."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        # Simulate state saved with CLAIMED status, but process crashed before AO call completed
        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=1,
            review_dispatch_key=dkey,
            review_dispatch_state=ReviewDispatchState.CLAIMED.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO has no review record yet
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)

        def on_trigger(session_id: str, reviewer: str):
            ao.reviews_by_session[session_id] = {
                "reviews": [{
                    "latestRun": {
                        "id": "run-recovered",
                        "targetSha": self.head_sha,
                        "harness": reviewer,
                        "status": "running",
                        "createdAt": "2026-08-17T16:05:00Z",
                    }
                }]
            }
        ao.trigger_hook = on_trigger

        controller = self._create_controller(store, github, ao)

        # First tick after restart executes the claimed review
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)

        # Second tick does NOT trigger again
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)

        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_attempts, 1)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)

    def test_r4_ao_succeeds_caller_times_out_or_crashes_before_post_save(self) -> None:
        """R4 (CRITICAL) — AO review exists; controller crashed before post-trigger update; adopts on restart."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        # Simulate state saved before AO call (or previous state)
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=0,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO already has the matching review run
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-existing",
                "targetSha": self.head_sha,
                "harness": "muse",
                "status": "delivered",
                "verdict": "approved",
                "body": f"Review approved\n\n{PROOF_PREFIX}{digest}",
                "createdAt": "2026-08-17T16:00:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # MUST NOT call trigger_review again
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.COMPLETED.value)
        self.assertEqual(saved.review_verdict, "approved")
        self.assertEqual(saved.review_dispatch_run_id, "run-existing")

    def test_r5_pending_ao_review(self) -> None:
        """R5 — Pending AO review prevents new triggers across repeated ticks."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-pending",
                "targetSha": self.head_sha,
                "harness": "muse",
                "status": "pending",
                "createdAt": "2026-08-17T16:00:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        for _ in range(4):
            controller.tick()

        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.REVIEW)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)

    def test_r6_completed_exact_review(self) -> None:
        """R6 — Completed exact review with valid context digest is adopted without new trigger."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-complete",
                "targetSha": self.head_sha,
                "harness": "muse",
                "status": "complete",
                "verdict": "approved",
                "body": f"Review approved\n\n{PROOF_PREFIX}{digest}",
                "createdAt": "2026-08-17T16:00:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.COMPLETED.value)
        self.assertEqual(saved.review_verdict, "approved")
        # PR is merged because review passed and PR is clean/mergeable
        self.assertEqual(len(github.merged), 1)

    def test_r7_head_change(self) -> None:
        """R7 — Old dispatch belongs to old SHA; new head with green CI marks old dispatch stale and triggers exactly one review for new SHA."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_old = self._setup_review_context(store, self.head_sha_alt)
        _, digest_new = self._setup_review_context(store, self.head_sha)

        dkey_old = review_dispatch_key(self.wkey, 115, self.head_sha_alt, "muse", digest_old)

        # Seed state with old head dispatch
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha_alt,
            review_attempts=1,
            review_sha=self.head_sha_alt,
            review_verdict="changes_requested",
            review_dispatch_key=dkey_old,
            review_dispatch_state=ReviewDispatchState.COMPLETED.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha_alt,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest_old,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        # PR now has new head
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        # AO has only old review run
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-old",
                "targetSha": self.head_sha_alt,
                "harness": "muse",
                "status": "delivered",
                "verdict": "changes_requested",
                "body": f"Changes requested\n\n{PROOF_PREFIX}{digest_old}",
                "createdAt": "2026-08-17T15:00:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)

        def on_trigger(session_id: str, reviewer: str):
            ao.reviews_by_session[session_id]["reviews"].append({
                "latestRun": {
                    "id": "run-new",
                    "targetSha": self.head_sha,
                    "harness": reviewer,
                    "status": "running",
                    "createdAt": "2026-08-17T16:10:00Z",
                }
            })
        ao.trigger_hook = on_trigger

        controller = self._create_controller(store, github, ao)

        # Tick triggers new review for new head
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)

        # Subsequent tick does not re-trigger
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)

        saved = store.load()[self.wkey]
        dkey_new = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest_new)
        self.assertEqual(saved.review_dispatch_key, dkey_new)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)

    def test_r8_empty_github_reply_artifacts(self) -> None:
        """R8 — Empty GitHub COMMENTED review objects from replies are not treated as independent reviews."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        # 1. Reply-generated empty COMMENTED object fails review_gate
        reply_evidence = {
            "reviews": [
                {
                    "latestRun": {
                        "id": "reply-1",
                        "targetSha": self.head_sha,
                        "harness": "muse",
                        "status": "complete",
                        "verdict": "commented",
                        "body": "",
                        "createdAt": "2026-08-17T16:00:00Z",
                    }
                }
            ]
        }
        ok, reason, reviewer, verdict = review_gate(reply_evidence, self.head_sha, "muse", digest)
        self.assertFalse(ok)
        self.assertIn("commented", reason)

        # 2. Approved review missing exact context digest proof marker fails proof check
        empty_approved = {
            "reviews": [
                {
                    "latestRun": {
                        "id": "approved-empty",
                        "targetSha": self.head_sha,
                        "harness": "muse",
                        "status": "complete",
                        "verdict": "approved",
                        "body": "Looks good!",
                        "createdAt": "2026-08-17T16:00:00Z",
                    }
                }
            ]
        }
        ok2, reason2, _, _ = review_gate(empty_approved, self.head_sha, "muse", digest)
        self.assertFalse(ok2)
        self.assertIn("missing one exact semantic context digest", reason2)

    def test_r9_existing_duplicate_github_evidence(self) -> None:
        """R9 — Multiple GitHub review objects for same logical review adopt deterministically without generating a new review."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO records multiple runs / duplicates for exact same head
        reviews = {"chainsieve-88": {"reviews": [
            {
                "latestRun": {
                    "id": "run-dup-1",
                    "targetSha": self.head_sha,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"First submission body\n\n{PROOF_PREFIX}{digest}",
                    "githubReviewId": "4952583774",
                    "createdAt": "2026-08-17T16:17:52Z",
                }
            },
            {
                "latestRun": {
                    "id": "run-dup-2",
                    "targetSha": self.head_sha,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "changes_requested",
                    "body": f"Second submission with comments\n\n{PROOF_PREFIX}{digest}",
                    "githubReviewId": "4952584255",
                    "createdAt": "2026-08-17T16:17:59Z",
                }
            }
        ]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # No new review triggered
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.COMPLETED.value)
        self.assertEqual(saved.review_dispatch_run_id, "run-dup-2")

    def test_r10_restart_stress(self) -> None:
        """R10 — Repeatedly restarting/reconstructing controller state retains exactly 1 review trigger."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)

        def on_trigger(session_id: str, reviewer: str):
            ao.reviews_by_session[session_id] = {
                "reviews": [{
                    "latestRun": {
                        "id": "run-10",
                        "targetSha": self.head_sha,
                        "harness": reviewer,
                        "status": "running",
                        "createdAt": "2026-08-17T16:00:00Z",
                    }
                }]
            }
        ao.trigger_hook = on_trigger

        # Instantiate fresh controller 5 times (simulating 5 process restarts)
        for i in range(5):
            fresh_controller = self._create_controller(store, github, ao)
            fresh_controller.tick()

        self.assertEqual(len(ao.triggered_reviews), 1)

    def test_r11_policy_regression(self) -> None:
        """R11 — Opposite-provider policy, exact-head binding, and context digest invariants remain unchanged."""
        # 1. Opposite provider policy
        self.assertEqual(reviewer_for("agy"), "muse")
        self.assertEqual(reviewer_for("muse"), "agy")

        # 2. Exact-head binding in review_gate
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        matching_review = {
            "reviews": [{
                "latestRun": {
                    "targetSha": self.head_sha,
                    "harness": "muse",
                    "status": "complete",
                    "verdict": "approved",
                    "body": f"Pass\n\n{PROOF_PREFIX}{digest}",
                    "createdAt": "2026-08-17T16:00:00Z",
                }
            }]
        }
        # Correct head passes
        ok, _, _, _ = review_gate(matching_review, self.head_sha, "muse", digest)
        self.assertTrue(ok)

        # Wrong head fails
        ok_wrong_head, reason_head, _, _ = review_gate(matching_review, self.head_sha_alt, "muse", digest)
        self.assertFalse(ok_wrong_head)
        self.assertIn("current PR head", reason_head)

        # Stale context digest fails
        ok_stale_digest, reason_digest, _, _ = review_gate(matching_review, self.head_sha, "muse", "stale_digest_123")
        self.assertFalse(ok_stale_digest)
        self.assertIn("stale or belongs to another", reason_digest)

        # Wrong reviewer provider fails
        ok_wrong_reviewer, reason_rev, _, _ = review_gate(matching_review, self.head_sha, "agy", digest)
        self.assertFalse(ok_wrong_reviewer)
        self.assertIn("required agy", reason_rev)

    def test_u1_trigger_review_raises_bounded_retry(self) -> None:
        """U1 — trigger_review raises -> UNKNOWN. No retry on immediate tick. After grace period exactly one retry occurs."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        ao = MockAO(sessions)
        ao.trigger_exception = RuntimeError("Connection timeout to AO daemon")
        github = MockGitHub(issues, prs)
        controller = self._create_controller(store, github, ao)

        # First tick: trigger fails with exception -> UNKNOWN
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)
        record = store.load()[self.wkey]
        self.assertEqual(record.review_dispatch_state, ReviewDispatchState.UNKNOWN.value)
        self.assertEqual(record.review_dispatch_trigger_attempts, 1)
        self.assertEqual(record.review_attempts, 1)

        # Second tick immediately: grace period has not elapsed -> no retry
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)

        # Simulate elapsed time beyond grace period (40 seconds ago)
        older_time = "2026-08-17T16:00:00+00:00"
        record.review_dispatch_last_attempt_at = older_time
        store.save({self.wkey: record})

        # Clear exception so retry succeeds
        ao.trigger_exception = None
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 2)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(saved.review_dispatch_trigger_attempts, 2)
        # Semantic review cycle count MUST NOT increase on transport retry
        self.assertEqual(saved.review_attempts, 1)

    def test_u2_trigger_fails_but_ao_run_exists_adopts(self) -> None:
        """U2 — trigger call appears to fail/timeout but matching AO run exists; controller adopts without extra trigger."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=1,
            review_dispatch_key=dkey,
            review_dispatch_state=ReviewDispatchState.UNKNOWN.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest,
            review_dispatch_trigger_attempts=1,
            review_dispatch_last_attempt_at="2026-08-17T16:00:00+00:00",
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}
        reviews = {"chainsieve-88": {"reviews": [{
            "latestRun": {
                "id": "run-u2",
                "targetSha": self.head_sha,
                "harness": "muse",
                "status": "running",
                "createdAt": "2026-08-17T16:01:00Z",
            }
        }]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # MUST NOT call trigger_review again
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(saved.review_dispatch_run_id, "run-u2")

    def test_u3_restart_while_unknown_survives(self) -> None:
        """U3 — Restart while in UNKNOWN state recovers and allows bounded retry after grace period."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        # Saved state in UNKNOWN with older attempt timestamp
        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=1,
            review_dispatch_key=dkey,
            review_dispatch_state=ReviewDispatchState.UNKNOWN.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest,
            review_dispatch_trigger_attempts=1,
            review_dispatch_last_attempt_at="2026-08-17T16:00:00+00:00",
            last_error="AO review trigger failed: connection reset",
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)

        # Fresh controller instance post-restart
        fresh_controller = self._create_controller(store, github, ao)
        fresh_controller.tick()

        # Executes exactly one retry
        self.assertEqual(len(ao.triggered_reviews), 1)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(saved.review_dispatch_trigger_attempts, 2)
        self.assertEqual(saved.review_attempts, 1)

    def test_u4_unknown_recovery_exhausted_blocks(self) -> None:
        """U4 — When UNKNOWN recovery trigger attempts are exhausted, package transitions to BLOCKED with diagnostic."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)
        dkey = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest)

        # Seed record with trigger attempts exhausted (attempts=2)
        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha,
            review_attempts=1,
            review_dispatch_key=dkey,
            review_dispatch_state=ReviewDispatchState.UNKNOWN.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest,
            review_dispatch_trigger_attempts=2,
            review_dispatch_last_attempt_at="2026-08-17T16:00:00+00:00",
            last_error="AO review trigger retry failed: fatal socket error",
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # No new trigger attempted
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.FAILED.value)
        self.assertIn("review dispatch trigger recovery exhausted", saved.blocked_reason or "")

    def test_b1_head_change_preserves_review_attempts_budget(self) -> None:
        """B1 — Review changes_requested -> additive new head. Old dispatch STALE. review_attempts DOES NOT reset."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_old = self._setup_review_context(store, self.head_sha_alt)
        _, digest_new = self._setup_review_context(store, self.head_sha)

        dkey_old = review_dispatch_key(self.wkey, 115, self.head_sha_alt, "muse", digest_old)

        # Seed with completed review on old head (review_attempts=1)
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha_alt,
            review_attempts=1,
            review_sha=self.head_sha_alt,
            review_verdict="changes_requested",
            review_dispatch_key=dkey_old,
            review_dispatch_state=ReviewDispatchState.COMPLETED.value,
            review_dispatch_pr=115,
            review_dispatch_sha=self.head_sha_alt,
            review_dispatch_reviewer="muse",
            review_dispatch_context_digest=digest_old,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        # Reconcile snapshot -> review_attempts must remain 1
        snapshot = Snapshot(issues=issues, prs=prs, sessions=sessions)
        records = controller.reconcile(self.plan, snapshot)
        self.assertEqual(records[self.wkey].review_attempts, 1)
        self.assertEqual(records[self.wkey].review_dispatch_state, ReviewDispatchState.STALE.value)

        # Tick claims next review for new head -> review_attempts increments to 2
        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_attempts, 2)
        dkey_new = review_dispatch_key(self.wkey, 115, self.head_sha, "muse", digest_new)
        self.assertEqual(saved.review_dispatch_key, dkey_new)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)

    def test_b2_max_review_cycles_exhausted_across_corrected_heads_blocks(self) -> None:
        """B2 — After max_review_cycles across multiple corrected heads, next review cycle is refused / package blocks."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_old = self._setup_review_context(store, self.head_sha_alt)
        _, digest_new = self._setup_review_context(store, self.head_sha)

        cfg_limited = dataclasses.replace(self.cfg, max_review_cycles=2)

        # Seed with review_attempts=2 (budget exhausted for max_review_cycles=2)
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-88",
            provider="agy",
            pr_number=115,
            head_sha=self.head_sha_alt,
            review_attempts=2,
            review_sha=self.head_sha_alt,
            review_verdict="changes_requested",
            review_dispatch_key="old-key",
            review_dispatch_state=ReviewDispatchState.COMPLETED.value,
        )
        store.save({self.wkey: record})

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = FactoryController(self.repo_root, cfg_limited, store, github, ao)

        controller.tick()

        # Trigger is refused, package is blocked
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.BLOCKED)
        self.assertIn("machine review budget exhausted", saved.blocked_reason or "")

    def test_b3_transport_retries_do_not_increment_semantic_review_cycles(self) -> None:
        """B3 — Transport retries for same dispatch do not increment semantic review-cycle count."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        ao = MockAO(sessions)
        ao.trigger_exception = RuntimeError("Temporary network glitch")
        github = MockGitHub(issues, prs)
        controller = self._create_controller(store, github, ao)

        # Initial trigger fails -> UNKNOWN, review_attempts=1
        controller.tick()
        record = store.load()[self.wkey]
        self.assertEqual(record.review_attempts, 1)
        self.assertEqual(record.review_dispatch_trigger_attempts, 1)

        # Simulate retry after grace period
        record.review_dispatch_last_attempt_at = "2026-08-17T16:00:00+00:00"
        store.save({self.wkey: record})
        ao.trigger_exception = None

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.ACTIVE.value)
        self.assertEqual(saved.review_dispatch_trigger_attempts, 2)
        # Semantic review cycle count MUST remain 1
        self.assertEqual(saved.review_attempts, 1)

    def test_p1_publication_layer_duplicate_evidence_handled_safely(self) -> None:
        """P1 — Duplicate publication evidence in AO/GitHub is adopted deterministically without second dispatch."""
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest = self._setup_review_context(store, self.head_sha)

        issues = {self.wkey: Issue(104, "OPEN", "", "url/104", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_sha, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"104": [Session("chainsieve-88", f"factory/{self.wkey}", "agy", "working", "active", "104")]}

        # AO contains both the duplicate review runs / submissions
        reviews = {"chainsieve-88": {"reviews": [
            {
                "latestRun": {
                    "id": "run-pub-1",
                    "targetSha": self.head_sha,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": f"Review body 1\n\n{PROOF_PREFIX}{digest}",
                    "githubReviewId": "4952583774",
                    "createdAt": "2026-08-17T16:17:52Z",
                }
            },
            {
                "latestRun": {
                    "id": "run-pub-2",
                    "targetSha": self.head_sha,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": f"Review body 2 with comments\n\n{PROOF_PREFIX}{digest}",
                    "githubReviewId": "4952584255",
                    "createdAt": "2026-08-17T16:17:59Z",
                }
            }
        ]}}

        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()

        # No new review triggered; PR merged safely
        self.assertEqual(len(ao.triggered_reviews), 0)
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.COMPLETED.value)
        self.assertEqual(saved.review_dispatch_run_id, "run-pub-2")
        self.assertEqual(len(github.merged), 1)


if __name__ == "__main__":
    unittest.main()
