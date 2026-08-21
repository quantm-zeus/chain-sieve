from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from factory.controller.ao import AgentOrchestrator, _parse_review_payload, review_gate
from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.findings import (
    FindingSeverity,
    FindingStatus,
    LateFindingCategory,
    ReviewFinding,
    ReviewMode,
    detect_material_scope_change,
    generate_finding_fingerprint,
    is_critical_late_blocker,
    is_non_blocking_follow_up,
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
from factory.controller.reasoning import reconcile_durable_state
from factory.controller.review_context import (
    PROOF_PREFIX,
    build_review_context,
    canonical_context_digest,
    validate_review_context,
)
from factory.controller.store import StateStore


class MockRunner:
    def run(self, *args, **kwargs):
        class Result:
            returncode = 0
            stdout = "1" * 40 + "\n"
            stderr = ""
        return Result()


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
    ) -> None:
        self.sessions_by_issue = sessions or {}
        self._reviews = reviews_data or {}
        self.sent: list[tuple[str, str]] = []
        self.triggered_reviews: list[tuple[str, str]] = []
        self.killed: list[str] = []
        self.restored: list[str] = []

    def sessions(self) -> dict[str, list[Session]]:
        return dict(self.sessions_by_issue)

    def reviews(self, session_id: str) -> dict[str, Any]:
        return self._reviews.get(session_id, {"reviews": []})

    def send(self, session_id: str, message: str) -> None:
        self.sent.append((session_id, message))

    def trigger_review(self, session_id: str, reviewer: str) -> None:
        self.triggered_reviews.append((session_id, reviewer))

    def spawn(self, package_id: str, issue_number: int, provider: str, prompt: str, model: str | None = None) -> str:
        return f"sess-{issue_number}"


class MockReasoner:
    def __init__(self, result: dict | None = None) -> None:
        self.result = result or {
            "status": "REPLANNED",
            "reason": "Autonomous recovery plan",
            "provider": "agy",
            "prompt": "Fix issues",
            "suggested_actions": ["Fix the code"],
        }

    def replan(self, milestone: Any, package: Any, reason: str, custom_prompt: str | None = None) -> dict:
        return self.result

    def converge(self, milestone: Any) -> dict:
        return {"status": "CONVERGED"}

    def final_audit(self, *args, **kwargs) -> dict:
        return {"status": "CONVERGED"}

    def _usage(self) -> dict:
        return {"plannerCalls": 0, "replanCalls": 0, "finalAuditCalls": 0, "emergencyCalls": 0, "total": 0}


class SemanticReviewClosureProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp())
        self.wkey = "g3-model-assisted-research--skeptic-voi-planner"
        self.head_a = "a" * 40
        self.head_b = "b" * 40
        self.head_c = "c" * 40
        self.head_d = "d" * 40

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
        from test_controller import config as make_config
        base_cfg = make_config(self.temp_root)
        from dataclasses import replace
        cfg = replace(base_cfg, state_dir=store.directory, plan_path=ms_path, max_review_cycles=2)
        controller = FactoryController(self.temp_root, cfg, store, github, ao)
        controller.reasoner = MockReasoner()
        return controller

    # RC-01: FULL_BASELINE review freezes blocker ledger
    def test_rc01_full_baseline_freezes_blocker_ledger(self) -> None:
        body = (
            "Review findings:\n"
            "- runtime-store.ts: isolate persistence errors in database repository\n"
            "- voi-planner.ts: filter voi plan totals to requested families\n"
            "- optional style suggestion: improve variable naming in spec\n"
        )
        payload = {
            "verdict": "changes_requested",
            "findings": [
                {
                    "severity": "HIGH",
                    "requirementId": "FR-AGT-005",
                    "file": "runtime-store.ts",
                    "issue": "isolate persistence errors in database repository",
                },
                {
                    "severity": "MEDIUM",
                    "requirementId": "FR-AGT-009",
                    "file": "voi-planner.ts",
                    "issue": "filter voi plan totals to requested families",
                },
                {
                    "severity": "INFORMATIONAL",
                    "requirementId": "FR-AGT-005",
                    "file": "spec.ts",
                    "issue": "optional style suggestion: improve variable naming in spec",
                },
            ],
        }
        ledger, blockers = parse_and_reconcile_review(
            body, payload, self.head_a, "run-01", ReviewMode.FULL_BASELINE.value, []
        )
        self.assertEqual(len(ledger), 3)
        self.assertEqual(len(blockers), 2)
        open_blockers = [f for f in ledger if f.blocking and f.status == FindingStatus.OPEN.value]
        follow_ups = [f for f in ledger if f.status == FindingStatus.FOLLOW_UP.value]
        self.assertEqual(len(open_blockers), 2)
        self.assertEqual(len(follow_ups), 1)

    # RC-02: CLOSURE_VERIFY with all baseline blockers resolved -> passes
    def test_rc02_closure_verify_all_blockers_resolved(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        fp2 = generate_finding_fingerprint("FR-AGT-009", "voi-planner.ts", "filter totals")
        frozen = [
            ReviewFinding(
                fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
            ReviewFinding(
                fingerprint=fp2, requirement_id="FR-AGT-009", severity="MEDIUM", category="CORRECTNESS",
                file_or_component="voi-planner.ts", normalized_summary="filter totals",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
        ]
        body = (
            f"FINDING {fp1}\nRESOLVED\nevidence: Added try-catch in persistence repo\n\n"
            f"FINDING {fp2}\nRESOLVED\nevidence: Filter applied in plan calculation\n"
        )
        payload = {
            "verdict": "approved",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed"},
                {"fingerprint": fp2, "status": "RESOLVED", "evidence": "Fixed"},
            ],
        }
        updated, blockers = parse_and_reconcile_review(
            body, payload, self.head_b, "run-02", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers), 0)
        self.assertTrue(all(f.status == FindingStatus.RESOLVED.value for f in updated))

    # RC-03: CLOSURE_VERIFY with new non-blocking follow-up -> does not block merge
    def test_rc03_closure_verify_with_new_follow_up_does_not_block(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [
            ReviewFinding(
                fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
        ]
        payload = {
            "verdict": "approved",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed"},
                {
                    "severity": "LOW",
                    "requirementId": "FR-AGT-005",
                    "file": "utils.ts",
                    "issue": "consider adding optional type docstring",
                },
            ],
        }
        updated, blockers = parse_and_reconcile_review(
            "", payload, self.head_b, "run-02", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers), 0)
        follow_ups = [f for f in updated if f.status == FindingStatus.FOLLOW_UP.value]
        self.assertEqual(len(follow_ups), 1)

    # RC-04: CLOSURE_VERIFY with correction regression -> blocks merge
    def test_rc04_closure_verify_with_regression_blocks(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [
            ReviewFinding(
                fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
        ]
        payload = {
            "verdict": "changes_requested",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed"},
                {
                    "severity": "HIGH",
                    "requirementId": "FR-AGT-005",
                    "file": "runtime-store.ts",
                    "issue": "regression: correction broke null check on record lookup",
                },
            ],
        }
        updated, blockers = parse_and_reconcile_review(
            "", payload, self.head_b, "run-02", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers), 1)
        regressions = [f for f in updated if f.status == FindingStatus.REGRESSION.value]
        self.assertEqual(len(regressions), 1)

    # RC-05: CLOSURE_VERIFY with critical late blocker -> admitted and blocks
    def test_rc05_closure_verify_critical_late_blocker_admitted(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [
            ReviewFinding(
                fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
        ]
        payload = {
            "verdict": "changes_requested",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed"},
                {
                    "severity": "CRITICAL",
                    "requirementId": "SEC-001",
                    "file": "auth.ts",
                    "issue": "critical security vulnerability in token validation allows bypass",
                },
            ],
        }
        updated, blockers = parse_and_reconcile_review(
            "", payload, self.head_b, "run-02", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers), 1)
        criticals = [f for f in updated if f.severity == FindingSeverity.CRITICAL.value and f.blocking]
        self.assertEqual(len(criticals), 1)

    # RC-06: CLOSURE_VERIFY non-critical late finding on untouched code -> rejected as moving goalpost
    def test_rc06_non_critical_late_finding_on_untouched_code_rejected(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        frozen = [
            ReviewFinding(
                fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                source_review_run_id="run-1",
            ),
        ]
        payload = {
            "verdict": "changes_requested",
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed"},
                {
                    "severity": "MEDIUM",
                    "requirementId": "FR-OTHER",
                    "file": "unrelated_module.ts",
                    "issue": "refactor helper architecture for future extensibility",
                },
            ],
        }
        updated, blockers = parse_and_reconcile_review(
            "", payload, self.head_b, "run-02", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers), 0)
        follow_ups = [f for f in updated if f.status == FindingStatus.FOLLOW_UP.value]
        self.assertEqual(len(follow_ups), 1)

    # RC-07: Finding fingerprint determinism & collision resistance
    def test_rc07_fingerprint_determinism_and_collision_resistance(self) -> None:
        fp1 = generate_finding_fingerprint(
            "FR-AGT-005", "runtime-store.ts", "isolate persistence errors in database repo at line 42"
        )
        fp2 = generate_finding_fingerprint(
            "FR-AGT-005", "runtime-store.ts", "isolate persistence errors in database repo at line 58"
        )
        self.assertEqual(fp1, fp2)

        fp3 = generate_finding_fingerprint(
            "FR-AGT-009", "voi-planner.ts", "filter voi plan totals to requested families"
        )
        self.assertNotEqual(fp1, fp3)

    # RC-08: Multi-round closure convergence
    def test_rc08_multi_round_closure_convergence(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate errors")
        fp2 = generate_finding_fingerprint("FR-AGT-009", "voi-planner.ts", "filter totals")
        fp3 = generate_finding_fingerprint("FR-AGT-005", "bounded-runtime.ts", "trigger context")

        frozen = [
            ReviewFinding(fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS", file_or_component="runtime-store.ts", normalized_summary="isolate errors", blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1"),
            ReviewFinding(fingerprint=fp2, requirement_id="FR-AGT-009", severity="MEDIUM", category="CORRECTNESS", file_or_component="voi-planner.ts", normalized_summary="filter totals", blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1"),
            ReviewFinding(fingerprint=fp3, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS", file_or_component="bounded-runtime.ts", normalized_summary="trigger context", blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a, source_review_run_id="run-1"),
        ]

        # Round 1: Fix fp1 and fp2, fp3 remains open
        round1_payload = {
            "findings": [
                {"fingerprint": fp1, "status": "RESOLVED", "evidence": "Fixed 1"},
                {"fingerprint": fp2, "status": "RESOLVED", "evidence": "Fixed 2"},
                {"fingerprint": fp3, "status": "OPEN"},
            ]
        }
        ledger_r1, blockers_r1 = parse_and_reconcile_review(
            "", round1_payload, self.head_b, "run-2", ReviewMode.CLOSURE_VERIFY.value, frozen
        )
        self.assertEqual(len(blockers_r1), 1)
        open_r1 = [f for f in ledger_r1 if f.blocking and f.status == "OPEN"]
        self.assertEqual(len(open_r1), 1)
        self.assertEqual(open_r1[0].fingerprint, fp3)

        # Round 2: Fix fp3
        round2_payload = {
            "findings": [
                {"fingerprint": fp3, "status": "RESOLVED", "evidence": "Fixed 3"},
            ]
        }
        ledger_r2, blockers_r2 = parse_and_reconcile_review(
            "", round2_payload, self.head_c, "run-3", ReviewMode.CLOSURE_VERIFY.value, ledger_r1
        )
        self.assertEqual(len(blockers_r2), 0)
        self.assertTrue(all(f.status == FindingStatus.RESOLVED.value for f in ledger_r2))

    # RC-09: New commit on PR stales approval but preserves blocker ledger
    def test_rc09_new_commit_stales_approval_preserves_ledger(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")

        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=115,
            head_sha=self.head_a,
            review_baseline_id="baseline-01",
            review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-baseline",
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[
                ReviewFinding(
                    fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                    file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                    blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                    source_review_run_id="baseline-01",
                ).to_dict()
            ],
            review_dispatch_key="old-dispatch-key",
            review_dispatch_state=ReviewDispatchState.COMPLETED.value,
            review_verdict="approved",
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_b, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_baseline_id, "baseline-01")
        self.assertEqual(len(saved.review_findings), 1)
        self.assertEqual(saved.review_findings[0]["fingerprint"], fp1)

    # RC-10: Material scope change invalidates baseline
    def test_rc10_material_scope_change_invalidates_baseline(self) -> None:
        _, pkg = self._setup_package()
        baseline_ctx = {
            "requirementIds": ["FR-AGT-005", "FR-AGT-009"],
            "acceptance": ["criterion 1"],
        }
        changed_pkg = WorkPackage(
            id="skeptic-voi-planner",
            objective="Implement skeptic agent and VOI planner",
            acceptance=["criterion 1", "criterion 2 - newly added requirement"],
            requirement_ids=["FR-AGT-005", "FR-AGT-009", "FR-NEW-010"],
            authorized_protected_paths=[],
            preferred_provider="agy",
        )
        self.assertTrue(detect_material_scope_change(changed_pkg, baseline_ctx))

    # RC-11: Recovery epoch does not reset review scope
    def test_rc11_recovery_epoch_does_not_reset_review_scope(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")

        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=115,
            head_sha=self.head_a,
            review_baseline_id="baseline-01",
            review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-baseline",
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[
                ReviewFinding(
                    fingerprint=fp1, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
                    file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
                    blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
                    source_review_run_id="baseline-01",
                ).to_dict()
            ],
            review_corrections_used=2,
            review_corrections_used_in_epoch=2,
            recovery_epoch=0,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})

        ms, pkg = self._setup_package()
        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {pkg.id: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )], self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_a, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        github = MockGitHub(issues, prs)
        ao = MockAO()
        controller = self._create_controller(store, github, ao)
        controller.reasoner = MockReasoner()
        controller._escalate_replan(ms, pkg, self.wkey, record, "test escalation", pr=prs[self.wkey][0])

        self.assertEqual(record.recovery_epoch, 1)
        self.assertEqual(record.review_baseline_id, "baseline-01")
        self.assertEqual(len(record.review_findings), 1)

    # RC-12: Focused worker correction prompt formatting
    def test_rc12_focused_worker_correction_prompt_formatting(self) -> None:
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        blockers = [
            {
                "fingerprint": fp1,
                "requirement_id": "FR-AGT-005",
                "severity": "HIGH",
                "file_or_component": "runtime-store.ts",
                "normalized_summary": "isolate persistence errors in runtime-store for skeptic artifact",
            }
        ]
        msg = build_focused_worker_correction_prompt("muse", 156, self.head_a, blockers, "persistence error unhandled")
        self.assertIn("PR #156", msg)
        self.assertIn("FR-AGT-005", msg)
        self.assertIn("runtime-store.ts", msg)
        self.assertIn("Do not amend, rebase, or force-push", msg)

    # RC-13: Reviewer prompt formatting for CLOSURE_VERIFY
    def test_rc13_reviewer_closure_prompt_formatting(self) -> None:
        ms, pkg = self._setup_package()
        fp1 = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        findings = [
            {
                "fingerprint": fp1,
                "requirement_id": "FR-AGT-005",
                "severity": "HIGH",
                "file_or_component": "runtime-store.ts",
                "normalized_summary": "isolate persistence errors",
                "status": "OPEN",
                "blocking": True,
            }
        ]
        prompt = build_closure_review_prompt(
            milestone=ms,
            package=pkg,
            pr_number=156,
            head_sha=self.head_b,
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=findings,
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
        )
        self.assertIn("CLOSURE_VERIFY", prompt)
        self.assertIn(fp1, prompt)
        self.assertIn("runtime-store.ts", prompt)
        self.assertIn("DO NOT restart a full architecture audit", prompt)

    # RC-14: Review budget consumption bounded
    def test_rc14_review_budget_consumption_bounded(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        _, digest_a = self._setup_review_context(store, self.head_a)
        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_a, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_a, "harness": "muse", "status": "delivered",
                    "verdict": "changes_requested", "body": f"Reject\n{PROOF_PREFIX}{digest_a}",
                    "createdAt": "2026-08-21T12:00:00Z",
                }]
            }
        }
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.review_corrections_used_in_epoch, 1)

    # RC-15: FINAL_CONFIRMATION pass enables merge
    def test_rc15_final_confirmation_pass_enables_merge(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()
        context_path = store.write_review_context(
            ms.id, pkg, self.head_c,
            review_mode=ReviewMode.FINAL_CONFIRMATION.value,
            baseline_id="base-1",
            baseline_head=self.head_a,
            baseline_context_digest="digest-base",
            frozen_findings=[],
            pr_number=115,
            implementation_provider="agy",
            reviewer_provider="muse",
        )
        digest = json.loads(context_path.read_text())["contextDigest"]

        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            115, "OPEN", f"factory/{self.wkey}", self.head_c, "url/115",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_c, "harness": "muse", "status": "delivered",
                    "verdict": "approved", "body": f"Final confirmation approved\n{PROOF_PREFIX}{digest}",
                    "createdAt": "2026-08-21T16:00:00Z",
                }]
            }
        }
        record = PackageRecord(
            status=PackageStatus.PR_WAITING, session_id="chainsieve-100", provider="agy", pr_number=115,
            head_sha=self.head_c, review_baseline_id="base-1", review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-base",
            review_mode=ReviewMode.FINAL_CONFIRMATION.value,
            review_closure_round=1, review_findings=[],
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 3})
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions, reviews)
        controller = self._create_controller(store, github, ao)

        controller.tick()
        saved = store.load()[self.wkey]
        self.assertEqual(saved.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)

    # RC-16: Conformance pass separation
    def test_rc16_conformance_pass_separation(self) -> None:
        self.assertTrue(is_non_blocking_follow_up("AC-242 full acceptance suite planned for conformance pass", "INFORMATIONAL"))
        self.assertFalse(is_critical_late_blocker("conformance suite", "INFORMATIONAL"))

    # RC-17: State store serialization / deserialization round-trip
    def test_rc17_state_store_serialization_round_trip(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        fp = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors")
        finding = ReviewFinding(
            fingerprint=fp, requirement_id="FR-AGT-005", severity="HIGH", category="CORRECTNESS",
            file_or_component="runtime-store.ts", normalized_summary="isolate persistence errors",
            blocking=True, status="OPEN", first_seen_head=self.head_a, last_verified_head=self.head_a,
            source_review_run_id="run-1",
        )
        record = PackageRecord(
            status=PackageStatus.REVIEW,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=self.head_a,
            review_baseline_id="baseline-xyz",
            review_baseline_head=self.head_a,
            review_baseline_context_digest="digest-abc",
            review_mode=ReviewMode.CLOSURE_VERIFY.value,
            review_findings=[finding.to_dict()],
            review_closure_round=2,
            final_confirmation_used=True,
        )
        store.save({self.wkey: record})

        loaded = store.load()[self.wkey]
        self.assertEqual(loaded.review_baseline_id, "baseline-xyz")
        self.assertEqual(loaded.review_baseline_head, self.head_a)
        self.assertEqual(loaded.review_baseline_context_digest, "digest-abc")
        self.assertEqual(loaded.review_mode, ReviewMode.CLOSURE_VERIFY.value)
        self.assertEqual(loaded.review_closure_round, 2)
        self.assertTrue(loaded.final_confirmation_used)
        self.assertEqual(len(loaded.review_findings), 1)
        self.assertEqual(loaded.review_findings[0]["fingerprint"], fp)

    # RC-18: Review context validation tool
    def test_rc18_review_context_validation_tool(self) -> None:
        ms, pkg = self._setup_package()
        context = build_review_context(
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
        validated = validate_review_context(context, work_key=self.wkey, target_sha=self.head_a)
        self.assertEqual(validated["contextDigest"], context["contextDigest"])

    # RC-19: Historical review reconciliation on startup / migration
    def test_rc19_historical_review_reconciliation_migration(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()

        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha="7013e9c82e07c39b58cb2c3f367a11e084260d90",
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 2})

        records, metadata = reconcile_durable_state(store, ms, self.temp_root)
        self.assertEqual(metadata.get("stateMigrationVersion"), 3)
        reconciled = records[self.wkey]
        self.assertEqual(reconciled.review_mode, ReviewMode.CLOSURE_VERIFY.value)
        self.assertEqual(reconciled.review_baseline_head, "7013e9c82e07c39b58cb2c3f367a11e084260d90")
        open_blockers = [f for f in reconciled.review_findings if f["blocking"] and f["status"] == "OPEN"]
        self.assertEqual(len(open_blockers), 2)

    # RC-20: End-to-end simulation of PR #156 scenario
    def test_rc20_end_to_end_simulation_pr156(self) -> None:
        store = StateStore(self.temp_root / "state")
        store.prepare()
        ms, pkg = self._setup_package()

        # Step 1: Reconcile historical state for PR 156
        initial_sha = "7013e9c82e07c39b58cb2c3f367a11e084260d90"
        record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            session_id="chainsieve-100",
            provider="agy",
            pr_number=156,
            head_sha=initial_sha,
        )
        store.save({self.wkey: record}, {"stateMigrationVersion": 2})
        records, meta = reconcile_durable_state(store, ms, self.temp_root)
        store.save(records, meta)

        # Step 2: Worker pushes fixed head (head_b) with green CI
        issues = {self.wkey: Issue(149, "OPEN", f"<!-- chainsieve-work-package:{self.wkey} -->\n", "url/149", "author")}
        prs = {self.wkey: [PullRequest(
            156, "OPEN", f"factory/{self.wkey}", self.head_b, "url/156",
            "MERGEABLE", "CLEAN", checks=({"name": "CI", "conclusion": "SUCCESS"},),
        )]}
        sessions = {"149": [Session("chainsieve-100", f"factory/{self.wkey}", "agy", "working", "active", "149")]}
        github = MockGitHub(issues, prs)
        ao = MockAO(sessions)
        controller = self._create_controller(store, github, ao)

        # First tick writes review context for head_b and triggers review
        controller.tick()
        context_b = json.loads((store.review_dir / self.wkey / f"{self.head_b}.json").read_text())

        # Muse delivers CLOSURE_VERIFY review approving the fixes with explicit disposition blocks
        fp_runtime = generate_finding_fingerprint("FR-AGT-005", "runtime-store.ts", "isolate persistence errors in runtime-store for skeptic artifact")
        fp_bounded = generate_finding_fingerprint("FR-AGT-005", "bounded-runtime.ts", "preserve real trigger context in fallback skeptic artifact")
        ao._reviews = {
            "chainsieve-100": {
                "reviews": [{
                    "targetSha": self.head_b,
                    "harness": "muse",
                    "status": "delivered",
                    "verdict": "approved",
                    "body": (
                        f"FINDING {fp_runtime}\nRESOLVED\nevidence: Added try-catch in persistence\n\n"
                        f"FINDING {fp_bounded}\nRESOLVED\nevidence: Trigger context preserved\n\n"
                        f"{PROOF_PREFIX}{context_b['contextDigest']}"
                    ),
                    "createdAt": "2026-08-21T18:00:00Z",
                }]
            }
        }

        # Second tick processes the review approval and merges PR 156
        controller.tick()
        final_record = store.load()[self.wkey]
        self.assertEqual(final_record.status, PackageStatus.COMPLETED)
        self.assertEqual(len(github.merged), 1)
        self.assertEqual(github.merged[0].number, 156)

    def _setup_review_context(self, store: StateStore, head: str) -> tuple[Path, str]:
        ms, pkg = self._setup_package()
        context_path = store.write_review_context(ms.id, pkg, head)
        digest = json.loads(context_path.read_text())["contextDigest"]
        return context_path, digest


if __name__ == "__main__":
    unittest.main()
