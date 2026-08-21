from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from factory.controller.ao import (
    AgentOrchestrator,
    ReviewAuthorityResult,
    ReviewSemanticResult,
    evaluate_review_semantics,
    review_gate,
    validate_review_authority,
)
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.findings import (
    FindingSeverity,
    FindingStatus,
    LateFindingCategory,
    ReviewFinding,
    ReviewMode,
    generate_finding_fingerprint,
    parse_and_reconcile_review,
)
from factory.controller.models import (
    Issue,
    Milestone,
    PackageRecord,
    PackageStatus,
    PullRequest,
    ReviewDispatchState,
    Session,
    WorkPackage,
    review_dispatch_key,
    work_key,
)
from factory.controller.prompts import (
    build_closure_review_prompt,
    build_focused_worker_correction_prompt,
)
from factory.controller.review_context import (
    CONTEXT_SCHEMA_VERSION_V2,
    CONTEXT_SCHEMA_VERSION_V3,
    PROOF_PREFIX,
    build_review_context,
    canonical_context_digest,
    resolve_task_context,
    validate_review_context,
)
from factory.controller.store import StateStore
from tests.factory.test_controller import config as make_config


class MockRunner:
    def __init__(self, source_env: dict[str, str] | None = None) -> None:
        self.source_env = source_env or {}

    def run(self, *args, **kwargs):
        class Result:
            returncode = 0
            stdout = "1" * 40 + "\n"
            stderr = ""
        return Result()

    def json(self, *args, **kwargs):
        return {}


class MockGitHub:
    def __init__(self, issues: dict[str, Issue] | None = None, prs: dict[str, list[PullRequest]] | None = None) -> None:
        self.issues_dict = issues or {}
        self.prs_dict = prs or {}
        self.merged: list[PullRequest] = []
        self.closed: list[int] = []
        self.runner = MockRunner()

    def issues(self) -> dict[str, Issue]:
        return dict(self.issues_dict)

    def prs(self) -> dict[str, list[PullRequest]]:
        return dict(self.prs_dict)

    def branch_exists(self, branch: str) -> bool:
        return False

    def create_issue(self, package_id: str, title: str, body: str) -> Issue:
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
        sessions: dict[str, list[Session]] | None = None,
        reviews_data: dict[str, Any] | None = None,
        source_env: dict[str, str] | None = None,
    ) -> None:
        self.sessions_by_issue = sessions or {}
        self._reviews = reviews_data or {}
        self.sent: list[tuple[str, str]] = []
        self.triggered_reviews: list[tuple[str, str, str | None]] = []
        self.runner = MockRunner(source_env=source_env)

    def sessions(self) -> dict[str, list[Session]]:
        return dict(self.sessions_by_issue)

    def reviews(self, session_id: str) -> dict[str, Any]:
        return self._reviews.get(session_id, {"reviews": []})

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def trigger_review(self, session_id: str, reviewer: str, prompt: str | None = None) -> None:
        self.triggered_reviews.append((session_id, reviewer, prompt))

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        return f"sess-{issue_number}"


class MockReasoner:
    def __init__(self) -> None:
        pass

    def replan(self, milestone: Any, package: Any, reason: str, custom_prompt: str | None = None) -> dict:
        return {
            "status": "REPLANNED",
            "reason": "Autonomous recovery plan",
            "provider": "agy",
            "prompt": "Fix issues",
            "suggested_actions": ["Fix the code"],
        }

    def converge(self, milestone: Any) -> dict:
        return {"status": "CONVERGED"}

    def final_audit(self, *args, **kwargs) -> dict:
        return {"status": "CONVERGED"}

    def _usage(self) -> dict:
        return {"plannerCalls": 0, "replanCalls": 0, "finalAuditCalls": 0, "emergencyCalls": 0, "total": 0}


class ReviewAuthorityContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp())
        self.wkey = "g3-model-assisted-research--skeptic-voi-planner"
        self.head_a = "a" * 40
        self.head_b = "b" * 40
        self.head_c = "c" * 40

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def _setup_package(self) -> tuple[Milestone, WorkPackage]:
        pkg = WorkPackage(
            id="skeptic-voi-planner",
            objective="Implement skeptic agent and VOI planner",
            acceptance=["all acceptance criteria pass"],
            requirement_ids=["FR-AGT-005", "FR-AGT-009", "AC-242"],
            authorized_protected_paths=[],
            preferred_provider="agy",
        )
        ms = Milestone(
            id="g3-model-assisted-research",
            objective="Milestone G3",
            packages=[pkg],
        )
        return ms, pkg

    def _create_controller(
        self,
        store: StateStore,
        github: MockGitHub,
        ao: MockAO,
    ) -> FactoryController:
        ms, pkg = self._setup_package()
        ms_path = self.temp_root / "milestone.json"
        specs_dir = self.temp_root / "specs" / "factory"
        specs_dir.mkdir(parents=True, exist_ok=True)
        roadmap = {"milestones": [{"id": "g3-model-assisted-research", "status": "active"}]}
        (specs_dir / "roadmap.json").write_text(json.dumps(roadmap), encoding="utf-8")
        ms_dict = {
            "id": ms.id,
            "objective": ms.objective,
            "workPackages": [
                {
                    "id": pkg.id,
                    "objective": pkg.objective,
                    "acceptance": list(pkg.acceptance),
                    "requirementIds": list(pkg.requirement_ids),
                    "preferredProvider": pkg.preferred_provider,
                    "risk": pkg.risk,
                    "authorizedProtectedPaths": list(pkg.authorized_protected_paths),
                }
            ],
        }
        ms_path.write_text(json.dumps(ms_dict), encoding="utf-8")
        base_cfg = make_config(self.temp_root)
        from dataclasses import replace
        cfg = replace(base_cfg, state_dir=store.directory, plan_path=ms_path, max_review_cycles=2)
        controller = FactoryController(self.temp_root, cfg, store, github, ao)
        controller.reasoner = MockReasoner()
        return controller

    # AUTHCTX-01: stale product worktree shadowing
    def test_authctx_01_stale_product_worktree_shadowing(self) -> None:
        # Create simulated deployed control plane
        control_plane = self.temp_root / "control_plane"
        shutil.copytree(Path(__file__).parents[2] / "factory", control_plane / "factory")

        # Create simulated stale product worktree with old resolver that rejects closure fields
        product_worktree = self.temp_root / "product_worktree"
        product_worktree.mkdir(parents=True)
        subprocess.run(["git", "init", "-b", "factory/g3-model-assisted-research--skeptic-voi-planner"], cwd=product_worktree, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=product_worktree, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=product_worktree, check=True)
        (product_worktree / "README.md").write_text("product code\n")
        subprocess.run(["git", "add", "."], cwd=product_worktree, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=product_worktree, check=True)
        head_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=product_worktree, check=True, capture_output=True, text=True).stdout.strip()

        # Add old factory/controller/review_context.py in product worktree
        old_factory_controller = product_worktree / "factory" / "controller"
        old_factory_controller.mkdir(parents=True)
        old_resolver_code = "import sys\nraise SystemExit(78)\n"
        (old_factory_controller / "review_context.py").write_text(old_resolver_code)

        # Setup review context and AO task.md
        state_dir = self.temp_root / "state"
        state_dir.mkdir(parents=True)
        reviews_dir = state_dir / "reviews" / self.wkey
        reviews_dir.mkdir(parents=True)
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, head_sha, ["docs/spec.md"],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            baseline_id="base-1",
            baseline_head=head_sha,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        (reviews_dir / f"{head_sha}.json").write_text(json.dumps(context_data))

        ao_data = self.temp_root / "ao_data"
        task_dir = ao_data / "prompts" / "chainsieve-100" / "reviewer" / "run-1"
        task_dir.mkdir(parents=True)
        task_file = task_dir / "task.md"
        task_file.write_text(f"Review PR #156 (head commit {head_sha}, run run-1)\n")

        # Run wrapper script from inside stale product worktree
        wrapper_path = control_plane / "factory" / "deployment" / "bin" / "chainsieve-review-context"
        wrapper_path.chmod(0o755)

        env = dict(os.environ)
        env["CHAINSIEVE_REPO_PATH"] = str(control_plane)
        env["CHAINSIEVE_FACTORY_STATE_DIR"] = str(state_dir)
        env["AO_DATA_DIR"] = str(ao_data)

        proc = subprocess.run([str(wrapper_path), str(task_file)], cwd=product_worktree, env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, f"Resolver failed: {proc.stderr}")
        res = json.loads(proc.stdout)
        self.assertEqual(res["proofMarker"], f"{PROOF_PREFIX}{context_data['contextDigest']}")

    # AUTHCTX-02: reviewer workspace still validated
    def test_authctx_02_reviewer_workspace_still_validated(self) -> None:
        product_worktree = self.temp_root / "product_worktree"
        product_worktree.mkdir(parents=True)
        subprocess.run(["git", "init", "-b", "factory/g3-model-assisted-research--skeptic-voi-planner"], cwd=product_worktree, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=product_worktree, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=product_worktree, check=True)
        (product_worktree / "README.md").write_text("product code\n")
        subprocess.run(["git", "add", "."], cwd=product_worktree, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=product_worktree, check=True)
        head_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=product_worktree, check=True, capture_output=True, text=True).stdout.strip()

        state_dir = self.temp_root / "state"
        reviews_dir = state_dir / "reviews" / self.wkey
        reviews_dir.mkdir(parents=True)
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, head_sha, ["docs/spec.md"],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            baseline_id="base-1",
            baseline_head=head_sha,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        (reviews_dir / f"{head_sha}.json").write_text(json.dumps(context_data))

        ao_data = self.temp_root / "ao_data"
        task_dir = ao_data / "prompts" / "chainsieve-100" / "reviewer" / "run-1"
        task_dir.mkdir(parents=True)
        task_file = task_dir / "task.md"
        task_file.write_text(f"Review PR #156 (head commit {head_sha}, run run-1)\n")

        os.environ["CHAINSIEVE_FACTORY_STATE_DIR"] = str(state_dir)
        os.environ["AO_DATA_DIR"] = str(ao_data)
        try:
            res = resolve_task_context(task_file, cwd=product_worktree)
            self.assertEqual(res["contextDigest"], context_data["contextDigest"])
            self.assertEqual(res["authority"]["workKey"], self.wkey)
        finally:
            os.environ.pop("CHAINSIEVE_FACTORY_STATE_DIR", None)
            os.environ.pop("AO_DATA_DIR", None)

    # AUTHCTX-03: wrong reviewer worktree head -> fail closed
    def test_authctx_03_wrong_reviewer_worktree_head_fails(self) -> None:
        product_worktree = self.temp_root / "product_worktree"
        product_worktree.mkdir(parents=True)
        subprocess.run(["git", "init", "-b", "factory/g3-model-assisted-research--skeptic-voi-planner"], cwd=product_worktree, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=product_worktree, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=product_worktree, check=True)
        (product_worktree / "README.md").write_text("product code\n")
        subprocess.run(["git", "add", "."], cwd=product_worktree, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=product_worktree, check=True)

        ao_data = self.temp_root / "ao_data"
        task_dir = ao_data / "prompts" / "chainsieve-100" / "reviewer" / "run-1"
        task_dir.mkdir(parents=True)
        task_file = task_dir / "task.md"
        task_file.write_text(f"Review PR #156 (head commit {self.head_a}, run run-1)\n")

        os.environ["AO_DATA_DIR"] = str(ao_data)
        try:
            with self.assertRaises(ValueError):
                resolve_task_context(task_file, cwd=product_worktree)
        finally:
            os.environ.pop("AO_DATA_DIR", None)

    # AUTHCTX-04: closure schema version validates under explicit closure schema (v3)
    def test_authctx_04_closure_schema_version(self) -> None:
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, self.head_a, ["docs/spec.md"],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            baseline_id="base-1",
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        self.assertEqual(context_data["schemaVersion"], CONTEXT_SCHEMA_VERSION_V3)
        validated = validate_review_context(context_data, work_key=self.wkey, target_sha=self.head_a)
        self.assertEqual(validated["contextDigest"], context_data["contextDigest"])

    # AUTHCTX-05: legacy schema remains readable where compatibility is supported (v2)
    def test_authctx_05_legacy_schema_compatibility(self) -> None:
        legacy_context = {
            "schemaVersion": CONTEXT_SCHEMA_VERSION_V2,
            "workKey": self.wkey,
            "milestoneId": "g3-model-assisted-research",
            "workPackageId": "skeptic-voi-planner",
            "objective": "Test",
            "acceptance": ["criterion 1"],
            "requirementIds": ["FR-AGT-005"],
            "authoritativeSources": ["docs/spec.md"],
            "targetSha": self.head_a,
        }
        legacy_context["contextDigest"] = canonical_context_digest(legacy_context)
        validated = validate_review_context(legacy_context, work_key=self.wkey, target_sha=self.head_a)
        self.assertEqual(validated["contextDigest"], legacy_context["contextDigest"])

    # AUTHCTX-06: missing proof marker -> AUTHORITY_INVALID, zero ledger mutation, zero correction budget
    def test_authctx_06_missing_proof_marker(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        finding = ReviewFinding(
            fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="runtime-store.ts",
            normalized_summary="isolate persistence errors", blocking=True, status="OPEN",
            first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1",
        )
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=self.head_a, review_baseline_id="base-1", review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-base", review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[finding.to_dict()], review_corrections_used=0, review_corrections_used_in_epoch=0,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                    "verdict": "changes_requested", "body": "No proof marker here, 5 new findings:\n1. bug",
                    "createdAt": "2026-08-21T18:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used_in_epoch, 0)
        self.assertEqual(saved.review_corrections_used, 0)
        self.assertEqual(len(saved.review_findings), 1)
        self.assertEqual(saved.review_findings[0]["fingerprint"], fp1)
        self.assertEqual(len(ao.sent), 0)

    # AUTHCTX-07: wrong digest -> AUTHORITY_INVALID, zero semantic mutation
    def test_authctx_07_wrong_digest_authority_invalid(self) -> None:
        raw_reviews = {
            "reviews": [{
                "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                "verdict": "changes_requested", "body": f"Review\n{PROOF_PREFIX}{'e' * 64}",
                "createdAt": "2026-08-21T18:00:00Z",

            }]
        }
        res = validate_review_authority(raw_reviews, self.head_a, required_reviewer="muse", expected_context_digest="f" * 64)
        self.assertFalse(res.ok)
        self.assertEqual(res.status, "AUTHORITY_INVALID")

    # AUTHCTX-08: base digest in CLOSURE_VERIFY -> REJECTED
    def test_authctx_08_base_digest_in_closure_verify_rejected(self) -> None:
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, self.head_a, ["docs/spec.md"],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            baseline_id="base-1",
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        base_digest = context_data["baseContextDigest"]
        closure_digest = context_data["contextDigest"]
        self.assertNotEqual(base_digest, closure_digest)

        raw_reviews = {
            "reviews": [{
                "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                "verdict": "approved", "body": f"Approved\n{PROOF_PREFIX}{base_digest}",
                "createdAt": "2026-08-21T18:00:00Z",
            }]
        }
        res = validate_review_authority(raw_reviews, self.head_a, required_reviewer="muse", expected_context_digest=closure_digest)
        self.assertFalse(res.ok)
        self.assertEqual(res.status, "AUTHORITY_INVALID")

    # AUTHCTX-09: base digest in FINAL_CONFIRMATION -> REJECTED
    def test_authctx_09_base_digest_in_final_confirmation_rejected(self) -> None:
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, self.head_a, ["docs/spec.md"],
            review_mode=ReviewMode.FINAL_CONFIRMATION.value,
            baseline_id="base-1",
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        base_digest = context_data["baseContextDigest"]
        final_digest = context_data["contextDigest"]
        self.assertNotEqual(base_digest, final_digest)

        raw_reviews = {
            "reviews": [{
                "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                "verdict": "approved", "body": f"Approved\n{PROOF_PREFIX}{base_digest}",
                "createdAt": "2026-08-21T18:00:00Z",
            }]
        }
        res = validate_review_authority(raw_reviews, self.head_a, required_reviewer="muse", expected_context_digest=final_digest)
        self.assertFalse(res.ok)
        self.assertEqual(res.status, "AUTHORITY_INVALID")

    # AUTHCTX-10: correct closure digest -> semantic payload may be processed
    def test_authctx_10_correct_closure_digest_processed(self) -> None:
        ms, pkg = self._setup_package()
        context_data = build_review_context(
            ms.id, pkg, self.head_a, ["docs/spec.md"],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            baseline_id="base-1",
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=156,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        closure_digest = context_data["contextDigest"]
        raw_reviews = {
            "reviews": [{
                "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                "verdict": "approved", "body": f"Approved\n{PROOF_PREFIX}{closure_digest}",
                "createdAt": "2026-08-21T18:00:00Z",
            }]
        }
        res = validate_review_authority(raw_reviews, self.head_a, required_reviewer="muse", expected_context_digest=closure_digest)
        self.assertTrue(res.ok)
        self.assertEqual(res.status, "VALID")

    # AUTHCTX-11: invalid authority containing scary findings -> ignored for canonical ledger
    def test_authctx_11_invalid_authority_scary_findings_ignored(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        finding = ReviewFinding(
            fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="runtime-store.ts",
            normalized_summary="isolate persistence errors", blocking=True, status="OPEN",
            first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1",
        )
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=self.head_a, review_baseline_id="base-1", review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-base", review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[finding.to_dict()],
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                    "verdict": "changes_requested", "body": "10 CRITICAL bugs found in auth, storage, database, etc. No digest proof.",
                    "createdAt": "2026-08-21T18:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(len(saved.review_findings), 1)
        self.assertEqual(saved.review_findings[0]["fingerprint"], fp1)

    # AUTHCTX-12: authority validation before parse/mutation (malformed payload)
    def test_authctx_12_malformed_body_invalid_authority_no_side_effects(self) -> None:
        raw_reviews = {
            "reviews": [{
                "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                "verdict": "changes_requested", "body": "Invalid JSON: {malformed: 123",
                "createdAt": "2026-08-21T18:00:00Z",
            }]
        }
        auth = validate_review_authority(raw_reviews, self.head_a, required_reviewer="muse", expected_context_digest="a" * 64)
        self.assertFalse(auth.ok)
        self.assertEqual(auth.status, "AUTHORITY_INVALID")

    # AUTHCTX-13: closure prompt dispatch
    def test_authctx_13_closure_prompt_dispatch(self) -> None:
        ms, pkg = self._setup_package()
        fp = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        prompt = build_closure_review_prompt(
            milestone=ms,
            package=pkg,
            pr_number=156,
            head_sha=self.head_b,
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[{"fingerprint": fp, "status": "OPEN", "blocking": True, "file_or_component": "runtime-store.ts", "normalized_summary": "isolate persistence errors"}],
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
        )
        self.assertIn("REVIEW MODE: CLOSURE_VERIFY", prompt)
        self.assertIn(fp, prompt)
        self.assertIn("DO NOT restart a full architecture audit", prompt)
        self.assertIn("NON_BLOCKING_FOLLOW_UP", prompt)

    # AUTHCTX-14: final confirmation prompt
    def test_authctx_14_final_confirmation_prompt(self) -> None:
        ms, pkg = self._setup_package()
        prompt = build_closure_review_prompt(
            milestone=ms,
            package=pkg,
            pr_number=156,
            head_sha=self.head_c,
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            review_mode=ReviewMode.FINAL_CONFIRMATION.value,
        )
        self.assertIn("REVIEW MODE: FINAL_CONFIRMATION", prompt)

    # AUTHCTX-15: generic review prompt forbidden for closure
    def test_authctx_15_generic_review_prompt_forbidden_for_closure(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        finding = ReviewFinding(
            fingerprint=fp, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="runtime-store.ts",
            normalized_summary="isolate persistence errors", blocking=True, status="OPEN",
            first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1",
        )
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=self.head_a, review_baseline_id="base-1", review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-base", review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[finding.to_dict()],
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 1)
        sess, reviewer, prompt = ao.triggered_reviews[0]
        self.assertIsNotNone(prompt)
        self.assertIn("REVIEW MODE: CLOSURE_VERIFY", prompt)

    # AUTHCTX-16: invalid review reissue (bounded recovery, no product correction)
    def test_authctx_16_invalid_review_reissue_without_product_correction(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        finding = ReviewFinding(
            fingerprint=fp, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="runtime-store.ts",
            normalized_summary="isolate persistence errors", blocking=True, status="OPEN",
            first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1",
        )
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=self.head_a, review_baseline_id="base-1", review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-base", review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[finding.to_dict()],
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                    "verdict": "changes_requested", "body": "Resolver failed exit 78",
                    "createdAt": "2026-08-21T18:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        # First tick encounters invalid authority -> emits REVIEW_AUTHORITY_INVALID and marks STALE
        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used_in_epoch, 0)
        self.assertEqual(saved.review_dispatch_state, ReviewDispatchState.STALE.value)

        # Clear invalid review and simulate new trigger
        ao._reviews = {"chainsieve-100": {"reviews": []}}
        controller.tick()
        self.assertTrue(len(ao.triggered_reviews) >= 1)

    # AUTHCTX-17: repeated tick idempotency
    def test_authctx_17_repeated_tick_idempotency(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        context_path = store.write_review_context(
            ms.id, pkg, self.head_a, review_mode=ReviewMode.FULL_BASELINE.value,
            pr_number=156, implementation_provider="agy", reviewer_provider="muse",
        )
        ctx = json.loads(context_path.read_text())
        expected_digest = str(ctx["contextDigest"])
        target_dispatch_key = review_dispatch_key(work_key(ms.id, pkg.id), 156, self.head_a, "muse", expected_digest)
        record = PackageRecord(
            status=PackageStatus.REVIEW, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=self.head_a, review_dispatch_key=target_dispatch_key,
            review_dispatch_state=ReviewDispatchState.ACTIVE.value,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        # Multiple ticks do not retrigger while active with matching dispatch key
        controller.tick()
        controller.tick()
        self.assertEqual(len(ao.triggered_reviews), 0)

    # AUTHCTX-18: exact current PR #156 fixture
    def test_authctx_18_exact_pr156_fixture(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors in runtime-store for skeptic artifact")
        fp2 = generate_finding_fingerprint("FR-AGT-005", "bounded-runtime.ts", "preserve real trigger context in fallback skeptic artifact")
        frozen = [
            ReviewFinding(fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors in runtime-store for skeptic artifact", blocking=True, status="OPEN", first_seen_head="7013e9c82e07c39b58cb2c3f367a11e084260d90", last_verified_head="7013e9c82e07c39b58cb2c3f367a11e084260d90", source_review_run_id="run-base").to_dict(),
            ReviewFinding(fingerprint=fp2, requirement_id="FR-AGT-005", severity="HIGH", file_or_component="bounded-runtime.ts", normalized_summary="preserve real trigger context in fallback skeptic artifact", blocking=True, status="OPEN", first_seen_head="7013e9c82e07c39b58cb2c3f367a11e084260d90", last_verified_head="7013e9c82e07c39b58cb2c3f367a11e084260d90", source_review_run_id="run-base").to_dict(),
        ]
        head_156 = "72151ea375ab359fffec1f690c83deea19f75822"
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=156,
            head_sha=head_156, review_baseline_id="baseline-156", review_baseline_head="7013e9c82e07c39b58cb2c3f367a11e084260d90",
            review_baseline_context_digest="digest-base-156", review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=frozen,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(156, "OPEN", f"factory/{self.wkey}", head_156, "url/156", "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},))]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        # Tick writes context and triggers review
        controller.tick()
        ctx_file = store.review_dir / self.wkey / f"{head_156}.json"
        self.assertTrue(ctx_file.is_file())
        ctx_data = json.loads(ctx_file.read_text())
        closure_digest = ctx_data["contextDigest"]

        # Valid closure review arrives with proof marker
        ao._reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": head_156, "harness": "muse", "status": "delivered",
                    "verdict": "approved", "body": (
                        f"FINDING {fp1}\nRESOLVED\nevidence: verified\n\n"
                        f"FINDING {fp2}\nRESOLVED\nevidence: verified\n\n"
                        f"{PROOF_PREFIX}{closure_digest}"
                    ),
                    "createdAt": "2026-08-21T19:15:00Z",
                }]
            }
        }
        controller.tick()
        saved = store.load()[self.wkey]
        self.assertTrue(all(f["status"] == "RESOLVED" for f in saved.review_findings))

    # AUTHCTX-19: correction disposition updates only after authority passes
    def test_authctx_19_correction_disposition_updates_only_after_authority(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        fp2 = generate_finding_fingerprint("FR-AGT-005", "bounded-runtime.ts", "preserve real trigger context")
        frozen = [
            ReviewFinding(fingerprint=fp1, requirement_id="FR-AGT-005", file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors", status="OPEN", blocking=True, severity="HIGH"),
            ReviewFinding(fingerprint=fp2, requirement_id="FR-AGT-005", file_or_component="bounded-runtime.ts", normalized_summary="preserve real trigger context", status="OPEN", blocking=True, severity="HIGH"),
        ]
        body = f"FINDING {fp1}\nRESOLVED\nevidence: ok\n\nFINDING {fp2}\nRESOLVED\nevidence: ok\n\n{PROOF_PREFIX}{1*64}"
        payload = {"verdict": "approved", "findings": [{"fingerprint": fp1, "status": "RESOLVED"}, {"fingerprint": fp2, "status": "RESOLVED"}]}
        sem = evaluate_review_semantics(body, "approved", self.head_b, "run-1", ReviewMode.CLOSURE_VERIFY.value, [f.to_dict() for f in frozen])
        self.assertTrue(sem.ok)
        self.assertTrue(all(f.status == FindingStatus.RESOLVED.value for f in sem.updated_ledger))

    # AUTHCTX-20: late noncritical closure finding -> FOLLOW_UP, does not block
    def test_authctx_20_late_noncritical_closure_finding_follow_up(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [ReviewFinding(fingerprint=fp1, requirement_id="FR-AGT-005", file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors", status="OPEN", blocking=True, severity="HIGH")]
        body = f"FINDING {fp1}\nRESOLVED\nevidence: ok\n\n- spec.ts: minor doc comment could be cleaner"
        payload = {
            "verdict": "approved",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED"},
                {"severity": "LOW", "file": "spec.ts", "issue": "minor doc comment could be cleaner"},
            ],
        }
        sem = evaluate_review_semantics(body, "approved", self.head_b, "run-1", ReviewMode.CLOSURE_VERIFY.value, [f.to_dict() for f in frozen])
        self.assertTrue(sem.ok)
        self.assertEqual(sem.effective_verdict, "approved")
        follow_ups = [f for f in sem.updated_ledger if f.status == FindingStatus.FOLLOW_UP.value]
        self.assertEqual(len(follow_ups), 1)

    # AUTHCTX-21: correction-introduced critical regression -> blocks closure
    def test_authctx_21_correction_introduced_critical_regression_blocks(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [ReviewFinding(fingerprint=fp1, requirement_id="FR-AGT-005", file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors", status="OPEN", blocking=True, severity="HIGH")]
        payload = {
            "verdict": "changes_requested",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED"},
                {"severity": "HIGH", "file": "runtime-store.ts", "issue": "regression: new change introduced crash in runtime store"},
            ],
        }
        body = f"FINDING {fp1}\nRESOLVED\nevidence: ok\n\n```json\n{json.dumps(payload)}\n```\n"
        sem = evaluate_review_semantics(body, "changes_requested", self.head_b, "run-1", ReviewMode.CLOSURE_VERIFY.value, [f.to_dict() for f in frozen])

        self.assertFalse(sem.ok)
        self.assertEqual(sem.effective_verdict, "changes_requested")
        regressions = [f for f in sem.updated_ledger if f.status == FindingStatus.REGRESSION.value]
        self.assertEqual(len(regressions), 1)

    # AUTHCTX-22: no budget changes
    def test_authctx_22_no_budget_changes(self) -> None:
        config_path = Path(__file__).parents[2] / "factory" / "config.json"
        with open(config_path, encoding="utf-8") as f:
            cfg = json.load(f)
        budgets = cfg.get("budgets", {})
        self.assertEqual(budgets.get("maxReviewCycles"), 2)
        self.assertEqual(budgets.get("maxAutonomousRecoveryEpochs"), 3)
        self.assertEqual(budgets.get("maxCiCorrectionRounds"), 2)
        self.assertEqual(budgets.get("maxTaskAttempts"), 2)
        models = cfg.get("models", {}).get("codex", {})
        total_reasoning = sum(v.get("maxCallsPerMilestone", 0) for v in models.values() if isinstance(v, dict))
        self.assertLessEqual(total_reasoning, 15)


if __name__ == "__main__":
    unittest.main()
