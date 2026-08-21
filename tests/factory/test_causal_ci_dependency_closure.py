"""Regression tests for causal CI dependency closure and merge gate separation (CAUSAL-01 to CAUSAL-10)."""
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.github import causal_ci_check, ci_state, classify_ci_failure
from factory.controller.models import PackageRecord, PackageStatus, PullRequest, Session, work_key
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package
from test_failed_worker_recovery_liveness import MockAO, MockGitHub


DEFAULT_CAUSAL_CHECKS = (
    "Factory · deterministic control plane",
    "Tier 0 · static and unit",
    "Tier 1 · task contracts",
    "Tier 2 · cluster integration",
    "Tier 3 · production image (api, linux/amd64)",
    "Tier 3 · production image (dashboard, linux/amd64)",
    "Tier 3 · pre-main",
)


class CausalCIDependencyClosureTests(unittest.TestCase):
    """CAUSAL-01 through CAUSAL-10 regression suite."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = replace(
            config(self.temp_root),
            required_checks=("Tier 3 · pre-main",),
            causal_checks=DEFAULT_CAUSAL_CHECKS,
            max_task_attempts=2,
            max_correction_attempts=2,
            max_active_workers=3,
        )
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_causal_01_tier0_failure_identifies_product(self) -> None:
        """CAUSAL-01: Tier 0 failure upstream of skipped Tier 3 classifies as PRODUCT."""
        checks = (
            {"name": "Factory · deterministic control plane", "conclusion": "SUCCESS"},
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/32402560484/job/96533954477",
            },
            {"name": "Tier 1 · task contracts", "conclusion": "SKIPPED"},
            {"name": "Tier 2 · cluster integration", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · production image (api, linux/amd64)", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · production image (dashboard, linux/amd64)", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(154, "OPEN", "factory/pkg", "a58a8d1", "url/154", "MERGEABLE", "CLEAN", checks=checks)

        # Gate check: overall CI = FAIL
        state, reason = ci_state(pr, self.cfg.required_checks)
        self.assertEqual(state, "FAIL")
        self.assertIn("Tier 3 · pre-main", reason)

        # Causal check: identifies Tier 0
        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 0 · static and unit")

        # Classify with mock GitHub jobs
        class JobGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 96533954477,
                    "name": "Tier 0 · static and unit",
                    "conclusion": "failure",
                    "steps": [
                        {"name": "Run pnpm install --frozen-lockfile", "conclusion": "success"},
                        {"name": "Run pnpm lint", "conclusion": "failure"},
                        {"name": "Run pnpm typecheck", "conclusion": "skipped"},
                    ],
                }]

        kind, detail, run_id = classify_ci_failure(pr, causal, JobGitHub())
        self.assertEqual(kind, "PRODUCT")
        self.assertIn("Run pnpm lint", detail)
        self.assertEqual(run_id, 32402560484)

    def test_causal_02_tier2_minio_identifies_infrastructure(self) -> None:
        """CAUSAL-02: MinIO setup failure in Tier 2 classifies as INFRASTRUCTURE."""
        checks = (
            {"name": "Factory · deterministic control plane", "conclusion": "SUCCESS"},
            {"name": "Tier 0 · static and unit", "conclusion": "SUCCESS"},
            {"name": "Tier 1 · task contracts", "conclusion": "SUCCESS"},
            {
                "name": "Tier 2 · cluster integration",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/12345/job/67890",
            },
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(155, "OPEN", "factory/pkg", "b2c3d4e", "url/155", "MERGEABLE", "CLEAN", checks=checks)

        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 2 · cluster integration")

        class MinioFailGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 67890,
                    "name": "Tier 2 · cluster integration",
                    "conclusion": "failure",
                    "steps": [
                        {"name": "Run pnpm install --frozen-lockfile", "conclusion": "success"},
                        {"name": "Start MinIO and wait for API readiness", "conclusion": "failure"},
                        {"name": "pnpm test:integration", "conclusion": "skipped"},
                    ],
                }]

        kind, detail, run_id = classify_ci_failure(pr, causal, MinioFailGitHub())
        self.assertEqual(kind, "INFRASTRUCTURE")
        self.assertIn("Start MinIO", detail)
        self.assertEqual(run_id, 12345)

    def test_causal_03_required_gate_pass_unrelated_optional_failure_passes(self) -> None:
        """CAUSAL-03: Required final gate PASS with optional check FAILURE passes CI."""
        checks = (
            {"name": "Tier 3 · pre-main", "conclusion": "SUCCESS"},
            {"name": "Unrelated Optional Tooling", "conclusion": "FAILURE"},
        )
        pr = PullRequest(156, "OPEN", "factory/pkg", "c3d4e5f", "url/156", "MERGEABLE", "CLEAN", checks=checks)

        state, reason = ci_state(pr, self.cfg.required_checks)
        self.assertEqual(state, "PASS")
        self.assertIn("required CI checks pass", reason)

    def test_causal_04_required_gate_skipped_optional_failure_yields_unknown(self) -> None:
        """CAUSAL-04: Required gate SKIPPED, optional check FAILURE -> UNKNOWN (optional not selected)."""
        checks = (
            {
                "name": "Tier 3 · pre-main",
                "conclusion": "SKIPPED",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/9999/job/8888",
            },
            {"name": "Unrelated Optional Check", "conclusion": "FAILURE"},
        )
        pr = PullRequest(157, "OPEN", "factory/pkg", "d4e5f6a", "url/157", "MERGEABLE", "CLEAN", checks=checks)

        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        # Must select the non-passing causal check Tier 3, NOT Unrelated Optional Check
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 3 · pre-main")

        class NoFailStepsGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 8888,
                    "name": "Tier 3 · pre-main",
                    "conclusion": "skipped",
                    "steps": [],
                }]

        kind, detail, run_id = classify_ci_failure(pr, causal, NoFailStepsGitHub())
        self.assertEqual(kind, "UNKNOWN")
        self.assertIn("Tier 3 · pre-main", detail)

    def test_causal_05_authoritative_job_evidence_unavailable_yields_unknown(self) -> None:
        """CAUSAL-05: GitHub API error fetching evidence yields UNKNOWN without budget consumption."""
        checks = (
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/7777/job/6666",
            },
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(158, "OPEN", "factory/pkg", "e5f6a7b", "url/158", "MERGEABLE", "CLEAN", checks=checks)

        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        self.assertEqual(causal["name"], "Tier 0 · static and unit")

        class BrokenGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                raise RuntimeError("503 Service Unavailable")

        kind, detail, run_id = classify_ci_failure(pr, causal, BrokenGitHub())
        self.assertEqual(kind, "UNKNOWN")
        self.assertIn("evidence retrieval failed", detail)

    def test_causal_06_product_failure_tick_idempotency_one_authorization(self) -> None:
        """CAUSAL-06: Causal product failure on exact head A authorizes exactly one correction."""
        pkg = package("lineage")
        wf_key = key("lineage")
        head = "a58a8d16f485c4074634432d3be15ab1f4db25ee"
        checks = (
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/32402560484/job/96533954477",
            },
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(154, "OPEN", f"factory/{wf_key}", head, "url/154", "MERGEABLE", "CLEAN", checks=checks)
        session = Session("chainsieve-99", f"factory/{wf_key}", "muse", "working", "working", "148")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=148,
            session_id="chainsieve-99",
            provider="muse",
            pr_number=154,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class JobGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 96533954477,
                    "name": "Tier 0 · static and unit",
                    "conclusion": "failure",
                    "steps": [{"name": "Run pnpm lint", "conclusion": "failure"}],
                }]

        ao = MockAO(sessions_by_issue={"148": [session]})
        github = JobGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        # Tick 1: authorizes correction 1
        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.ci_corrections_used, 1)
        self.assertEqual(record.ci_correction_authorized_from_sha, head)
        self.assertEqual(len(ao.sent), 1)

        # Tick 2: same head -> no extra authorization or dispatch
        records2 = controller.tick()
        record2 = records2[wf_key]
        self.assertEqual(record2.ci_corrections_used, 1)
        self.assertEqual(len(ao.sent), 1)

    def test_causal_07_controller_restart_preserves_authority_no_duplicate(self) -> None:
        """CAUSAL-07: Controller restart before head changes does not issue duplicate correction."""
        pkg = package("lineage")
        wf_key = key("lineage")
        head = "a58a8d16f485c4074634432d3be15ab1f4db25ee"
        checks = (
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/32402560484/job/96533954477",
            },
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(154, "OPEN", f"factory/{wf_key}", head, "url/154", "MERGEABLE", "CLEAN", checks=checks)
        session = Session("chainsieve-99", f"factory/{wf_key}", "muse", "working", "working", "148")
        ci_token = f"CI:{head}:checks not passing: Tier 3 · pre-main"
        prior_record = PackageRecord(
            status=PackageStatus.CI_FIX,
            issue_number=148,
            session_id="chainsieve-99",
            provider="muse",
            pr_number=154,
            head_sha=head,
            ci_status="FAIL",
            ci_corrections_used=1,
            ci_correction_authorized_from_sha=head,
            last_error=ci_token,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class JobGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 96533954477,
                    "name": "Tier 0 · static and unit",
                    "conclusion": "failure",
                    "steps": [{"name": "Run pnpm lint", "conclusion": "failure"}],
                }]

        ao = MockAO(sessions_by_issue={"148": [session]})
        github = JobGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.ci_corrections_used, 1)
        self.assertEqual(len(ao.sent), 0)

    def test_causal_08_current_exact_154_shape_classifies_product(self) -> None:
        """CAUSAL-08: Exact #154 PR shape (Tier 0 failure + Tier 3 skipped) classifies as PRODUCT."""
        checks = (
            {"name": "Factory Canary · harmless validation", "conclusion": "SKIPPED"},
            {"name": "Factory · deterministic control plane", "conclusion": "SUCCESS"},
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/32402560484/job/96533954477",
            },
            {"name": "Tier 1 · task contracts", "conclusion": "SKIPPED"},
            {"name": "Tier 2 · cluster integration", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · production image (api, linux/amd64)", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · production image (dashboard, linux/amd64)", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(154, "OPEN", "factory/pkg", "a58a8d16f485c4074634432d3be15ab1f4db25ee", "url/154", "MERGEABLE", "CLEAN", checks=checks)

        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 0 · static and unit")

        class Real154GitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [
                    {"id": 96533954084, "name": "Factory · deterministic control plane", "conclusion": "success", "steps": []},
                    {
                        "id": 96533954477,
                        "name": "Tier 0 · static and unit",
                        "conclusion": "failure",
                        "steps": [
                            {"name": "Set up job", "conclusion": "success"},
                            {"name": "Run actions/checkout@v4", "conclusion": "success"},
                            {"name": "Run pnpm/action-setup@v4", "conclusion": "success"},
                            {"name": "Run actions/setup-node@v4", "conclusion": "success"},
                            {"name": "Run pnpm install --frozen-lockfile", "conclusion": "success"},
                            {"name": "Run pnpm lint", "conclusion": "failure"},
                            {"name": "Run pnpm typecheck", "conclusion": "skipped"},
                            {"name": "Run pnpm test:unit", "conclusion": "skipped"},
                        ],
                    },
                ]

        kind, detail, run_id = classify_ci_failure(pr, causal, Real154GitHub())
        self.assertEqual(kind, "PRODUCT")
        self.assertIn("Run pnpm lint", detail)
        self.assertEqual(run_id, 32402560484)

    def test_causal_09_correction_prompt_contains_causal_and_step_details(self) -> None:
        """CAUSAL-09: Product failure worker prompt includes causal check name, step, PR, head, URL."""
        pkg = package("lineage")
        wf_key = key("lineage")
        head = "a58a8d16f485c4074634432d3be15ab1f4db25ee"
        checks = (
            {
                "name": "Tier 0 · static and unit",
                "conclusion": "FAILURE",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/32402560484/job/96533954477",
            },
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(154, "OPEN", f"factory/{wf_key}", head, "url/154", "MERGEABLE", "CLEAN", checks=checks)
        session = Session("chainsieve-99", f"factory/{wf_key}", "muse", "working", "working", "148")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=148,
            session_id="chainsieve-99",
            provider="muse",
            pr_number=154,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class JobGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 96533954477,
                    "name": "Tier 0 · static and unit",
                    "conclusion": "failure",
                    "steps": [{"name": "Run pnpm lint", "conclusion": "failure"}],
                }]

        ao = MockAO(sessions_by_issue={"148": [session]})
        github = JobGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        controller.tick()
        self.assertEqual(len(ao.sent), 1)
        recipient, prompt = ao.sent[0]
        self.assertEqual(recipient, "chainsieve-99")
        self.assertIn("#154", prompt)
        self.assertIn(head, prompt)
        self.assertIn("Tier 0 · static and unit", prompt)
        self.assertIn("Run pnpm lint", prompt)
        self.assertIn("32402560484", prompt)
        self.assertIn("additive correction commit", prompt)

    def test_causal_10_cancelled_upstream_job_selected_deterministically(self) -> None:
        """CAUSAL-10: Upstream job CANCELLED is selected deterministically and classified."""
        checks = (
            {"name": "Factory · deterministic control plane", "conclusion": "SUCCESS"},
            {
                "name": "Tier 1 · task contracts",
                "conclusion": "CANCELLED",
                "detailsUrl": "https://github.com/quantm-zeus/chain-sieve/actions/runs/5555/job/4444",
            },
            {"name": "Tier 2 · cluster integration", "conclusion": "SKIPPED"},
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED"},
        )
        pr = PullRequest(159, "OPEN", "factory/pkg", "f6a7b8c", "url/159", "MERGEABLE", "CLEAN", checks=checks)

        causal = causal_ci_check(pr, self.cfg.required_checks, self.cfg.effective_causal_checks)
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 1 · task contracts")

        class CancelledJobGitHub(MockGitHub):
            def get_run_jobs(self, run_id):
                return [{
                    "id": 4444,
                    "name": "Tier 1 · task contracts",
                    "conclusion": "cancelled",
                    "steps": [
                        {"name": "Run actions/checkout@v4", "conclusion": "success"},
                        {"name": "pnpm harness:verify", "conclusion": "cancelled"},
                    ],
                }]

        kind, detail, run_id = classify_ci_failure(pr, causal, CancelledJobGitHub())
        self.assertEqual(kind, "PRODUCT")
        self.assertIn("pnpm harness:verify", detail)
        self.assertEqual(run_id, 5555)


if __name__ == "__main__":
    unittest.main()
