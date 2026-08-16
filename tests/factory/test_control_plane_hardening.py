from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from factory.controller.ao import review_gate
from factory.controller.commands import CommandResult, CommandRunner
from factory.controller.config import CodexRoute, FactoryConfig
from factory.controller.controller import FactoryController, _apply_pr, _is_descendant
from factory.controller.github import ci_gate
from factory.controller.models import Issue, Milestone, PackageRecord, PackageStatus, PullRequest, Session, Snapshot, WorkPackage, work_key
from factory.controller.reasoning import ReasoningRunner
from factory.controller.store import StateStore
from test_controller import config as test_config, milestone as make_milestone, package as make_package


class HardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = test_config(self.root)
        self.store = StateStore(self.config.state_dir)
        self.store.prepare()
        self.config.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.plan_path.write_text(
            json.dumps({"id": "m1", "objective": "test", "workPackages": [make_package("pkg1")]}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_pass_with_non_blocking_suggestions_allows_merge_without_worker_restart(self) -> None:
        head_sha = "a" * 40
        digest = "d" * 64
        body = (
            "```json\n"
            + json.dumps({
                "verdict": "PASS",
                "headSha": head_sha,
                "reviewScope": "FULL",
                "blockingFindings": [],
                "nonBlockingSuggestions": [
                    {"file": "src/core.ts", "suggestion": "Consider minor naming cleanup", "category": "style"}
                ],
            })
            + "\n```\n"
            + f"Proof: CHAINSIEVE_REVIEW_CONTEXT_SHA256:{digest}"
        )
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head_sha,
                    "status": "complete",
                    "verdict": "pass",
                    "harness": "muse",
                    "body": body,
                    "createdAt": "2026-08-16T10:00:00Z",
                }
            }]
        }
        ok, reason, reviewer, verdict = review_gate(evidence, head_sha, "muse", digest)
        self.assertTrue(ok)
        self.assertEqual(verdict, "approved")
        self.assertEqual(reviewer, "muse")

    def test_review_head_freeze_prevents_concurrent_worker_mutation(self) -> None:
        ms = make_milestone(make_package("pkg1"))
        key = work_key(ms.id, "pkg1")
        record = PackageRecord(status=PackageStatus.REVIEW, session_id="sess-1", provider="agy")
        session = Session(id="sess-1", branch="b1", harness="agy", status="active", activity="waiting_input")
        pr = PullRequest(
            number=10, url="http", head_sha="a" * 40, state="OPEN", branch="b1",
            mergeable="MERGEABLE", merge_state="CLEAN",
            checks=({"name": "CI", "status": "completed", "conclusion": "success"},),
        )

        mock_ao = MagicMock()
        mock_github = MagicMock()
        controller = FactoryController(self.root, self.config, self.store, mock_github, mock_ao, MagicMock())

        controller._handle_activity(ms, ms.packages[0], key, record, session, pr)
        mock_ao.send.assert_not_called()
        mock_ao.kill.assert_not_called()

    def test_blocking_findings_triggers_additive_correction_instruction(self) -> None:
        head_sha = "a" * 40
        digest = "d" * 64
        body = (
            "```json\n"
            + json.dumps({
                "verdict": "FINDINGS",
                "headSha": head_sha,
                "reviewScope": "FULL",
                "blockingFindings": [
                    {"file": "src/service.ts", "issue": "Missing input validation", "severity": "HIGH"}
                ],
                "nonBlockingSuggestions": [],
            })
            + "\n```\n"
            + f"Proof: CHAINSIEVE_REVIEW_CONTEXT_SHA256:{digest}"
        )
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head_sha,
                    "status": "complete",
                    "verdict": "changes_requested",
                    "harness": "muse",
                    "body": body,
                    "createdAt": "2026-08-16T10:00:00Z",
                }
            }]
        }
        ok, reason, reviewer, verdict = review_gate(evidence, head_sha, "muse", digest)
        self.assertFalse(ok)
        self.assertIn("blocking findings", reason)
        self.assertEqual(verdict, "changes_requested")

        ms = make_milestone(make_package("pkg1"))
        record = PackageRecord(status=PackageStatus.PR_WAITING, session_id="sess-1", provider="agy")
        pr = PullRequest(
            number=10, url="http", head_sha=head_sha, state="OPEN", branch="b1",
            mergeable="MERGEABLE", merge_state="CLEAN",
            checks=({"name": "CI", "status": "completed", "conclusion": "success"},),
        )

        mock_ao = MagicMock()
        mock_ao.reviews.return_value = evidence
        mock_github = MagicMock()
        controller = FactoryController(self.root, self.config, self.store, mock_github, mock_ao, MagicMock())

        with patch.object(self.store, "write_review_context") as mock_ctx:
            ctx_file = self.root / "ctx.json"
            ctx_file.write_text(json.dumps({"contextDigest": digest}), encoding="utf-8")
            mock_ctx.return_value = ctx_file
            controller._handle_pr(ms, ms.packages[0], record, pr)

        mock_ao.send.assert_called_once()
        sent_message = mock_ao.send.call_args[0][1]
        self.assertIn("additive correction commit", sent_message)
        self.assertIsNotNone(record.last_error)
        self.assertIn("REVIEW:", record.last_error or "")

    def test_delta_review_scope_supported(self) -> None:
        head_sha = "b" * 40
        digest = "e" * 64
        body = (
            "```json\n"
            + json.dumps({
                "verdict": "PASS",
                "headSha": head_sha,
                "reviewScope": "DELTA",
                "blockingFindings": [],
                "nonBlockingSuggestions": [],
            })
            + "\n```\n"
            + f"Proof: CHAINSIEVE_REVIEW_CONTEXT_SHA256:{digest}"
        )
        evidence = {
            "reviews": [{
                "latestRun": {
                    "targetSha": head_sha,
                    "status": "complete",
                    "verdict": "pass",
                    "harness": "muse",
                    "body": body,
                    "createdAt": "2026-08-16T10:00:00Z",
                }
            }]
        }
        ok, reason, reviewer, verdict = review_gate(evidence, head_sha, "muse", digest)
        self.assertTrue(ok)
        self.assertEqual(verdict, "approved")

    def test_non_fast_forward_pr_head_blocks_with_ancestry_guard(self) -> None:
        prev_sha = "1" * 40
        new_sha = "2" * 40
        record = PackageRecord(status=PackageStatus.PR_WAITING, head_sha=prev_sha)
        pr = PullRequest(
            number=10, url="http", head_sha=new_sha, state="OPEN", branch="b1",
            mergeable="MERGEABLE", merge_state="CLEAN",
            checks=({"name": "CI", "status": "completed", "conclusion": "success"},),
        )

        with patch("factory.controller.controller._is_descendant", return_value=False):
            _apply_pr(record, pr, self.root)
            self.assertEqual(record.status, PackageStatus.BLOCKED)
            self.assertIn("non-fast-forward PR head history rewrite detected", record.blocked_reason or "")

    def test_merged_package_terminates_active_ao_worker_session(self) -> None:
        ms = make_milestone(make_package("pkg1"))
        key = work_key(ms.id, "pkg1")
        record = PackageRecord(status=PackageStatus.PR_WAITING, session_id="sess-active", provider="agy")
        pr = PullRequest(
            number=10, url="http", head_sha="a" * 40, state="OPEN", branch="b1",
            mergeable="MERGEABLE", merge_state="CLEAN",
            checks=({"name": "CI", "status": "completed", "conclusion": "success"},),
        )

        mock_ao = MagicMock()
        mock_ao.reviews.return_value = {
            "reviews": [{
                "latestRun": {
                    "targetSha": "a" * 40,
                    "status": "complete",
                    "verdict": "pass",
                    "harness": "muse",
                    "body": f"Proof: CHAINSIEVE_REVIEW_CONTEXT_SHA256:{'0'*64}",
                    "createdAt": "2026-08-16T10:00:00Z",
                }
            }]
        }
        mock_github = MagicMock()
        controller = FactoryController(self.root, self.config, self.store, mock_github, mock_ao, MagicMock())

        # Mock review context digest write
        with patch.object(self.store, "write_review_context") as mock_ctx:
            ctx_file = self.root / "ctx.json"
            ctx_file.write_text(json.dumps({"contextDigest": "0" * 64}), encoding="utf-8")
            mock_ctx.return_value = ctx_file
            controller._handle_pr(ms, ms.packages[0], record, pr)

        mock_github.merge.assert_called_once()
        mock_ao.kill.assert_called_once_with("sess-active")
        self.assertEqual(record.status, PackageStatus.COMPLETED)
        self.assertEqual(record.ao_status, "merged")
        self.assertEqual(record.ao_activity, "merged")

    def test_bounded_reasoning_timeout_and_status_tracking(self) -> None:
        repo_root = Path(__file__).parents[2]
        mock_runner = MagicMock()
        reasoning = ReasoningRunner(repo_root, self.config, self.store, mock_runner)

        # Mock codex exec output
        def fake_run(argv, **kwargs):
            if "git" in argv and "rev-parse" in argv:
                return CommandResult(tuple(argv), "a" * 40, "", 0)
            timeout = kwargs.get("timeout")
            self.assertEqual(timeout, self.config.reasoning_timeout_seconds)
            self.assertEqual(timeout, 300)
            # Write expected output schema to output path
            output_path = Path(argv[argv.index("--output-last-message") + 1])
            output_path.write_text(json.dumps({"status": "CONVERGED", "gaps": []}), encoding="utf-8")
            return CommandResult(tuple(argv), "", "", 0)

        mock_runner.run.side_effect = fake_run

        ms = make_milestone(make_package("pkg1"))
        result = reasoning.converge(ms)
        self.assertEqual(result["status"], "CONVERGED")

        # Verify status exposes reasoningOperation field (None when no op active)
        controller = FactoryController(self.root, self.config, self.store, MagicMock(), MagicMock(), mock_runner)
        status = controller.status()
        self.assertIn("reasoningOperation", status)
        self.assertIsNone(status["reasoningOperation"])

        # Set active reasoning operation and verify status includes it
        self.store.set_reasoning_operation(role="convergence", provider="codex", milestone_id="m1")
        status_active = controller.status()
        self.assertIsNotNone(status_active["reasoningOperation"])
        self.assertEqual(status_active["reasoningOperation"]["role"], "convergence")
        self.assertEqual(status_active["reasoningOperation"]["provider"], "codex")


if __name__ == "__main__":
    unittest.main()
