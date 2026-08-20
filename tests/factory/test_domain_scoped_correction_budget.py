from dataclasses import replace
from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from factory.controller.config import FactoryConfig
from factory.controller.controller import FactoryController
from factory.controller.github import causal_ci_check, ci_state, classify_ci_failure
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, work_key
from factory.controller.store import StateStore
from test_controller import config, key, milestone, package
from test_failed_worker_recovery_liveness import MockAO, MockGitHub


class DomainScopedCorrectionBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp.name)
        self.repo_root = Path(__file__).resolve().parents[2]
        self.cfg = replace(
            config(self.temp_root),
            max_task_attempts=2,
            max_correction_attempts=2,
            max_active_workers=3,
        )
        self.store = StateStore(self.cfg.state_dir)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_budget_01_liveness_nudge_does_not_consume_ci_budget(self) -> None:
        """
        BUDGET-01: Liveness nudge on waiting/stuck worker increments liveness_remediations_used
        and does NOT increment ci_corrections_used.
        """
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        twenty_mins_ago = (datetime.now(UTC) - timedelta(minutes=20)).isoformat()
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1", last_activity_at=twenty_mins_ago)

        token = f"CI:{head}:checks not passing: CI"
        prior_record = PackageRecord(
            status=PackageStatus.CI,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="FAIL",
            last_error=token,
            ci_corrections_used=1,
            ci_correction_authorized_from_sha=head,
            liveness_remediations_used=0,
            task_attempts=1,
            started_at=twenty_mins_ago,
            last_progress_at=twenty_mins_ago,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # Liveness remediation used was incremented, but CI corrections used remained 1!
        self.assertEqual(record.liveness_remediations_used, 1)
        self.assertEqual(record.ci_corrections_used, 1)
        self.assertEqual(record.ci_correction_authorized_from_sha, head)
        self.assertNotEqual(record.status, PackageStatus.BLOCKED)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("FULL AUTONOMOUS MODE", ao.sent[0][1])

    def test_budget_02_session_restore_does_not_consume_ci_budget(self) -> None:
        """
        BUDGET-02: Terminated session restore increments session_restore_attempts
        and does NOT increment ci_corrections_used.
        """
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "terminated", "exited", "1")

        token = f"CI:{head}:checks not passing: CI"
        prior_record = PackageRecord(
            status=PackageStatus.CI,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="FAIL",
            last_error=token,
            ci_corrections_used=1,
            ci_correction_authorized_from_sha=head,
            session_restore_attempts=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # Session restore incremented, but CI budget remained intact
        self.assertEqual(record.session_restore_attempts, 1)
        self.assertEqual(record.ci_corrections_used, 1)
        self.assertIn("ao-1", ao.restored)

    def test_budget_03_ci_correction_authorization_is_head_scoped_and_idempotent(self) -> None:
        """
        BUDGET-03: On initial CI failure, CI correction is authorized and increments ci_corrections_used.
        On subsequent ticks with the same failing head, no duplicate increment occurs.
        """
        pkg = package("core")
        wf_key = key("core")
        head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        # Tick 1: authorizes CI correction round 1
        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.ci_corrections_used, 1)
        self.assertEqual(record.ci_correction_authorized_from_sha, head)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("Required CI is not green", ao.sent[0][1])

        # Tick 2: same head, same failure -> no additional CI correction consumed
        records2 = controller.tick()
        record2 = records2[wf_key]
        self.assertEqual(record2.ci_corrections_used, 1)
        self.assertEqual(record2.ci_correction_authorized_from_sha, head)
        self.assertEqual(len(ao.sent), 1)  # No extra dispatch

    def test_budget_04_new_failing_head_consumes_next_ci_correction_round(self) -> None:
        """
        BUDGET-04: When worker pushes a new head that also fails CI, the next CI correction round is consumed.
        """
        pkg = package("core")
        wf_key = key("core")
        head1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        head2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head2, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head1,
            ci_status="FAIL",
            last_error=f"CI:{head1}:checks not passing: CI",
            ci_corrections_used=1,
            ci_correction_authorized_from_sha=head1,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.ci_corrections_used, 2)
        self.assertEqual(record.ci_correction_authorized_from_sha, head2)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn(head2, ao.sent[0][1])

    def test_budget_05_ci_budget_exhaustion_blocks(self) -> None:
        """
        BUDGET-05: When ci_corrections_used reaches max_ci_correction_rounds on a new failing head,
        the package is cleanly BLOCKED with diagnostic reason.
        """
        pkg = package("core")
        wf_key = key("core")
        head1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        head2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head2, "url/101", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head1,
            ci_status="FAIL",
            last_error=f"CI:{head1}:checks not passing: CI",
            ci_corrections_used=2,
            ci_correction_authorized_from_sha=head1,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertIn("CI correction budget exhausted", record.blocked_reason or "")

    def test_budget_06_integration_conflict_does_not_consume_ci_or_liveness_budget(self) -> None:
        """
        BUDGET-06: Material merge conflict consumes integration_corrections_used
        and does NOT consume ci_corrections_used or liveness_remediations_used.
        """
        pkg = package("core")
        pkg["risk"] = "LOW"
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "CONFLICTING", "DIRTY",
            checks=({"name": "CI", "conclusion": "SUCCESS"},),
            files=("packages/core/index.ts",),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="PASS",
            ci_corrections_used=0,
            liveness_remediations_used=0,
            integration_corrections_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.integration_corrections_used, 1)
        self.assertEqual(record.ci_corrections_used, 0)
        self.assertEqual(record.liveness_remediations_used, 0)
        self.assertEqual(len(ao.sent), 1)
        self.assertIn("relative to main", ao.sent[0][1])

    def test_budget_07_ci_infra_failure_triggers_rerun_without_code_changes(self) -> None:
        """
        BUDGET-07: Infrastructure failure (e.g. runner setup/bootstrap) triggers job rerun
        and does NOT increment ci_corrections_used.
        """
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({
                "name": "CI",
                "conclusion": "FAILURE",
                "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
            },),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="WAIT",
            ci_corrections_used=0,
            ci_infra_retries_used=0,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class InfraMockGitHub(MockGitHub):
            def __init__(self, *args: any, **kwargs: any) -> None:
                super().__init__(*args, **kwargs)
                self.reruns: list[int] = []

            def get_check_runs(self, ref: str) -> list[dict[str, any]]:
                return [{
                    "name": "CI",
                    "conclusion": "FAILURE",
                    "status": "COMPLETED",
                    "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
                }]

            def get_run_jobs(self, run_id: int) -> list[dict[str, any]]:
                return [{
                    "id": 111,
                    "conclusion": "failure",
                    "steps": [{"name": "Set up Node", "conclusion": "failure"}],
                }]

            def rerun_failed_jobs(self, run_id: int) -> None:
                self.reruns.append(run_id)

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = InfraMockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]

        # Rerun triggered for run 999
        self.assertEqual(github.reruns, [999])
        self.assertEqual(record.ci_infra_retries_used, 1)
        self.assertEqual(record.ci_corrections_used, 0)
        # Worker was not sent any prompt to edit code
        self.assertEqual(len(ao.sent), 0)

    def test_budget_08_reconciliation_clears_false_ci_blocker(self) -> None:
        """
        BUDGET-08: State recovery from historical events reconciles false CI blocker,
        sets status to PR_WAITING, and emits LEGACY_CORRECTION_BUDGET_RECONCILED.
        """
        pkg = package("production-governance")
        wf_key = key("production-governance")
        head = "860e15dadb182ef72df32da78bce72eee5cd421e"
        pr = PullRequest(
            145, "OPEN", f"factory/{wf_key}", head, "url/145", "MERGEABLE", "CLEAN",
            checks=({"name": "CI", "conclusion": "FAILURE"},),
        )
        session = Session("chainsieve-97", f"factory/{wf_key}", "muse", "working", "working", "134")

        # Simulate historical events with 1 CI correction and 1 liveness nudge
        self.store.event(
            "CI_CORRECTION_STARTED",
            milestoneId="m1",
            workPackageId="production-governance",
            workKey=wf_key,
            headSha=head,
            pr=145,
            attempt=1,
        )
        self.store.event(
            "CORRECTION_STARTED",
            milestoneId="m1",
            workPackageId="production-governance",
            workKey=wf_key,
            attempt=2,
        )

        # Record was poisoned by legacy counter
        prior_record = PackageRecord(
            status=PackageStatus.BLOCKED,
            issue_number=134,
            session_id="chainsieve-97",
            provider="muse",
            pr_number=145,
            head_sha=head,
            ci_status="FAIL",
            correction_attempts=2,
            ci_corrections_used=0,
            liveness_remediations_used=0,
            blocked_reason="CI correction budget exhausted: checks not passing: Tier 3 · pre-main",
            task_attempts=2,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"134": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        # Reconcile should unblock the package and correct domain counters
        records = controller.tick()
        record = records[wf_key]

        self.assertEqual(record.ci_corrections_used, 1)
        self.assertEqual(record.liveness_remediations_used, 1)
        self.assertIsNone(record.blocked_reason)
        self.assertNotEqual(record.status, PackageStatus.BLOCKED)

        # Event emitted
        events = self.store.history(10)
        reconcile_events = [e for e in events if e.get("type") == "LEGACY_CORRECTION_BUDGET_RECONCILED"]
        self.assertEqual(len(reconcile_events), 1)
        self.assertEqual(reconcile_events[0]["reconstructedCiCorrectionsUsed"], 1)
        self.assertEqual(reconcile_events[0]["reconstructedLivenessRemediationsUsed"], 1)

    def test_budget_09_liveness_remediation_exhaustion_escalates(self) -> None:
        """
        BUDGET-09: When liveness_remediations_used reaches max_liveness_remediations,
        the controller escalates to retry or replan.
        """
        pkg = package("core")
        wf_key = key("core")
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1", last_activity_at="2020-01-01T00:00:00Z")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            task_attempts=1,
            liveness_remediations_used=2,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(issues_dict={wf_key: Issue(1, "OPEN", "", "url/1", "factory-bot")})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        # Escalation occurred without infinite prompts
        self.assertEqual(len(ao.sent), 0)

    def test_budget_10_terminated_restore_exhaustion_escalates(self) -> None:
        """
        BUDGET-10: When session_restore_attempts reaches max_session_restores,
        the controller escalates to clean alternate retry or replan.
        """
        pkg = package("core")
        wf_key = key("core")
        session = Session("ao-1", f"factory/{wf_key}", "muse", "terminated", "exited", "1")
        prior_record = PackageRecord(
            status=PackageStatus.ACTIVE,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            task_attempts=1,
            session_restore_attempts=2,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(issues_dict={wf_key: Issue(1, "OPEN", "", "url/1", "factory-bot")})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        # No more restore calls to the dead session
        self.assertNotIn("ao-1", ao.restored)

    def test_budget_11_ambiguous_historical_record_without_events_fails_closed(self) -> None:
        """
        BUDGET-11: Historical BLOCKED record without matching events in events.jsonl
        fails closed and remains BLOCKED.
        """
        pkg = package("core")
        wf_key = key("core")
        prior_record = PackageRecord(
            status=PackageStatus.BLOCKED,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ci_status="FAIL",
            correction_attempts=2,
            ci_corrections_used=0,
            liveness_remediations_used=0,
            blocked_reason="ambiguous duplicate PR/session state; preserving existing work",
            task_attempts=2,
        )
        self.store.save({wf_key: prior_record})

        pr = PullRequest(101, "OPEN", f"factory/{wf_key}", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "url", "MERGEABLE", "CLEAN")
        pr2 = PullRequest(102, "OPEN", f"factory/{wf_key}", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "url2", "MERGEABLE", "CLEAN")
        ao = MockAO(sessions_by_issue={"1": [Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")]})
        github = MockGitHub(prs_dict={wf_key: [pr, pr2]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        # Fails closed because no events exist to prove budget was poisoned and duplicate PRs exist
        self.assertEqual(record.status, PackageStatus.BLOCKED)

    def test_budget_12_merge_update_exhaustion_escalates_to_replan(self) -> None:
        """
        BUDGET-12: When integration_corrections_used reaches max_integration_corrections,
        the controller escalates to replan.
        """
        pkg = package("core")
        pkg["risk"] = "LOW"
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "CONFLICTING", "DIRTY",
            checks=({"name": "CI", "conclusion": "SUCCESS"},),
            files=("packages/core/index.ts",),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        self.store.event(
            "MERGE_UPDATE_STARTED",
            milestoneId="m1",
            workPackageId="core",
            workKey=wf_key,
            attempt=1,
            headSha=head,
            domain="integration",
            integrationCorrectionsUsed=1,
        )
        self.store.event(
            "MERGE_UPDATE_STARTED",
            milestoneId="m1",
            workPackageId="core",
            workKey=wf_key,
            attempt=2,
            headSha=head,
            domain="integration",
            integrationCorrectionsUsed=2,
        )
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="PASS",
            integration_corrections_used=2,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = MockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(len(ao.sent), 0)

    def test_budget_13_ci_infra_retry_exhaustion_blocks(self) -> None:
        """
        BUDGET-13: CI infrastructure retries reaching max_ci_infra_retries cleanly blocks.
        """
        pkg = package("core")
        wf_key = key("core")
        head = "1111111111111111111111111111111111111111"
        pr = PullRequest(
            101, "OPEN", f"factory/{wf_key}", head, "url/101", "MERGEABLE", "CLEAN",
            checks=({
                "name": "CI",
                "conclusion": "FAILURE",
                "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
            },),
        )
        session = Session("ao-1", f"factory/{wf_key}", "muse", "working", "working", "1")
        prior_record = PackageRecord(
            status=PackageStatus.PR_WAITING,
            issue_number=1,
            session_id="ao-1",
            provider="muse",
            pr_number=101,
            head_sha=head,
            ci_status="WAIT",
            ci_infra_retries_used=2,
            task_attempts=1,
        )
        self.store.save({wf_key: prior_record})

        class InfraMockGitHub(MockGitHub):
            def __init__(self, *args: any, **kwargs: any) -> None:
                super().__init__(*args, **kwargs)
                self.reruns: list[int] = []

            def get_check_runs(self, ref: str) -> list[dict[str, any]]:
                return [{
                    "name": "CI",
                    "conclusion": "FAILURE",
                    "status": "COMPLETED",
                    "html_url": "https://github.com/quantm-zeus/chain-sieve/actions/runs/999/job/111",
                }]

            def get_run_jobs(self, run_id: int) -> list[dict[str, any]]:
                return [{
                    "id": 111,
                    "conclusion": "failure",
                    "steps": [{"name": "Set up Node", "conclusion": "failure"}],
                }]

            def rerun_failed_jobs(self, run_id: int) -> None:
                self.reruns.append(run_id)

        ao = MockAO(sessions_by_issue={"1": [session]})
        github = InfraMockGitHub(prs_dict={wf_key: [pr]})
        controller = FactoryController(self.repo_root, self.cfg, self.store, github, ao)
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")

        records = controller.tick()
        record = records[wf_key]
        self.assertEqual(record.status, PackageStatus.BLOCKED)
        self.assertIn("infrastructure retry budget exhausted", record.blocked_reason or "")
        self.assertEqual(len(github.reruns), 0)

    def test_budget_14_status_summary_reports_domain_counters(self) -> None:
        """
        BUDGET-14: controller.status() correctly breaks down usage into ciCorrections,
        livenessRemediations, sessionRestores, and integrationCorrections.
        """
        pkg = package("core")
        wf_key = key("core")
        record = PackageRecord(
            status=PackageStatus.ACTIVE,
            task_attempts=1,
            ci_corrections_used=1,
            liveness_remediations_used=2,
            session_restore_attempts=1,
            integration_corrections_used=1,
        )
        self.store.save({wf_key: record})
        self.cfg.plan_path.write_text(json.dumps({"id": "m1", "objective": "test", "workPackages": [pkg]}), encoding="utf-8")
        controller = FactoryController(self.repo_root, self.cfg, self.store, MockGitHub(), MockAO())
        summary = controller.status()

        usage = summary["usage"]
        self.assertEqual(usage["ciCorrections"], 1)
        self.assertEqual(usage["livenessRemediations"], 2)
        self.assertEqual(usage["sessionRestores"], 1)
        self.assertEqual(usage["integrationCorrections"], 1)
        self.assertEqual(usage["corrections"], 4)  # 1 ci + 2 liveness + 1 integration

    def test_ci_causal_failure_prioritized_over_skipped_tier(self) -> None:
        """
        CI-01: Causal CI failure (e.g. Tier 2 failure) is prioritized over downstream skipped checks (e.g. Tier 3 skipped).
        """
        checks = (
            {"name": "Tier 1 · fast", "conclusion": "SUCCESS", "status": "COMPLETED"},
            {"name": "Tier 2 · domain", "conclusion": "FAILURE", "status": "COMPLETED"},
            {"name": "Tier 3 · pre-main", "conclusion": "SKIPPED", "status": "COMPLETED"},
        )
        pr = PullRequest(
            145, "OPEN", "factory/branch", "headsha", "url", "MERGEABLE", "CLEAN",
            checks=checks,
        )
        status, reason = ci_state(pr, ("Tier 1 · fast", "Tier 2 · domain", "Tier 3 · pre-main"))
        self.assertEqual(status, "FAIL")
        # Must report the causal failure Tier 2, NOT Tier 3 skipped!
        self.assertIn("Tier 2 · domain", reason)
        self.assertNotIn("Tier 3 · pre-main", reason)

        causal = causal_ci_check(pr, ("Tier 1 · fast", "Tier 2 · domain", "Tier 3 · pre-main"))
        self.assertIsNotNone(causal)
        self.assertEqual(causal["name"], "Tier 2 · domain")
        self.assertEqual(causal["conclusion"].upper(), "FAILURE")


if __name__ == "__main__":
    unittest.main()
