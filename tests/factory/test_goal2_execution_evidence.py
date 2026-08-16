from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from factory.controller.commands import CommandResult
from factory.controller.config import FactoryConfig
from factory.controller.models import Milestone, PackageRecord, PackageStatus, WorkPackage, work_key
from factory.controller.reasoning import (
    ConvergenceOutputRejectedError,
    ReasoningRunner,
    _format_reasoning_prompt,
    build_reasoning_context,
)
from factory.controller.store import StateStore


def make_package(pkg_id: str, req_ids: list[str] | None = None) -> dict:
    return {
        "id": pkg_id,
        "objective": f"Objective for {pkg_id}",
        "acceptance": [f"Acceptance for {pkg_id}"],
        "dependencies": [],
        "parallelizable": True,
        "preferredProvider": "agy",
        "risk": "LOW",
        "requirementIds": req_ids or ["FR-DATA-001"],
        "authorizedProtectedPaths": [],
    }


def make_test_config(root: Path, state_dir: Path) -> FactoryConfig:
    from factory.controller.config import CodexRoute
    return FactoryConfig(
        repo="quantm-zeus/chain-sieve",
        project_id="chainsieve",
        default_branch="main",
        max_active_workers=3,
        max_task_attempts=2,
        max_correction_attempts=2,
        max_review_cycles=2,
        max_final_audit_cycles=3,
        max_convergence_passes=3,
        max_task_wall_clock_seconds=600,
        max_milestone_wall_clock_seconds=3600,
        max_idle_seconds=60,
        max_starting_seconds=30,
        max_tick_duration_seconds=30,
        disk_min_free_gib=0,
        memory_min_free_mib=0,
        max_worktrees=10,
        required_checks=("CI",),
        protected_paths=("factory/**", "docs/spec/**"),
        integration_branch="main",
        state_dir=state_dir,
        plan_path=state_dir / "active-milestone.json",
        poll_seconds=1,
        convergence_enabled=True,
        notification_command=(),
        codex_routes={
            role: CodexRoute("gpt-test", "medium", 3 if role in {"final_audit", "convergence"} else 1)
            for role in ("planner", "replan", "final_audit", "emergency", "convergence")
        },
        agy_model="gemini-test",
    )


class Goal2ExecutionEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        (self.root / "factory").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "prompts").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "schemas").mkdir(parents=True, exist_ok=True)
        (self.root / "factory" / "constitution.md").write_text("# Constitution\nAuthoritative rules.", encoding="utf-8")
        (self.root / "factory" / "prompts" / "convergence.md").write_text("Base prompt", encoding="utf-8")
        (self.root / "factory" / "prompts" / "final-audit.md").write_text("Audit prompt", encoding="utf-8")
        (self.root / "factory" / "schemas" / "convergence.schema.json").write_text(
            json.dumps({"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}),
            encoding="utf-8",
        )
        (self.root / "factory" / "schemas" / "final-audit.schema.json").write_text(
            json.dumps({"type": "object", "required": ["status"], "properties": {"status": {"type": "string"}}}),
            encoding="utf-8",
        )

        (self.root / "docs" / "spec").mkdir(parents=True, exist_ok=True)
        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Deterministic ingestion"},
                ]
            }),
            encoding="utf-8",
        )

        state_dir = self.root / ".factory"
        state_dir.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(state_dir)
        self.config = make_test_config(self.root, state_dir)

        self.valid_head = "1" * 40
        self.runner = MagicMock()
        self.runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), self.valid_head, "", 0)

        self.ms = Milestone.from_dict({
            "id": "g1-deterministic-signal-execution",
            "objective": "Test G1",
            "workPackages": [make_package("pkg-1")],
        })

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_e1_context_digest_determinism(self) -> None:
        """E1: Same semantic context snapshot produces identical contextDigest."""
        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        self.assertEqual(ctx1["contextDigest"], ctx2["contextDigest"])

    def test_e2_ci_mutation_changes_prompt_and_digest(self) -> None:
        """E2: Package CI status mutation changes both rendered prompt and context digest."""
        key = work_key(self.ms.id, "pkg-1")
        rec = PackageRecord(status=PackageStatus.ACTIVE, ci_status="WAIT", provider="agy", head_sha="a" * 40)
        self.store.save({key: rec}, {})

        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt1 = _format_reasoning_prompt("Base", ctx1, self.ms, role="convergence")

        rec.ci_status = "PASS"
        self.store.save({key: rec}, {})

        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt2 = _format_reasoning_prompt("Base", ctx2, self.ms, role="convergence")

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])
        self.assertNotEqual(prompt1, prompt2)
        self.assertIn("CI Status: `PASS`", prompt2)

    def test_e3_review_mutation_changes_prompt_and_digest(self) -> None:
        """E3: Review verdict mutation changes both rendered prompt and context digest."""
        key = work_key(self.ms.id, "pkg-1")
        rec = PackageRecord(status=PackageStatus.ACTIVE, review_verdict="rejected", provider="agy", head_sha="a" * 40)
        self.store.save({key: rec}, {})

        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt1 = _format_reasoning_prompt("Base", ctx1, self.ms, role="convergence")

        rec.review_verdict = "approved"
        self.store.save({key: rec}, {})

        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt2 = _format_reasoning_prompt("Base", ctx2, self.ms, role="convergence")

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])
        self.assertNotEqual(prompt1, prompt2)
        self.assertIn("Verdict: approved", prompt2)

    def test_e4_reviewed_head_mutation_changes_prompt_and_digest(self) -> None:
        """E4: Reviewed head SHA mutation changes both rendered prompt and context digest."""
        key = work_key(self.ms.id, "pkg-1")
        rec = PackageRecord(status=PackageStatus.ACTIVE, review_sha="b" * 40, provider="agy", head_sha="a" * 40)
        self.store.save({key: rec}, {})

        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt1 = _format_reasoning_prompt("Base", ctx1, self.ms, role="convergence")

        rec.review_sha = "c" * 40
        self.store.save({key: rec}, {})

        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt2 = _format_reasoning_prompt("Base", ctx2, self.ms, role="convergence")

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])
        self.assertNotEqual(prompt1, prompt2)
        self.assertIn(f"Reviewed Head SHA: {'c' * 40}", prompt2)

    def test_e5_package_status_mutation_changes_prompt_and_digest(self) -> None:
        """E5: Package lifecycle status change alters both prompt and context digest."""
        key = work_key(self.ms.id, "pkg-1")
        rec = PackageRecord(status=PackageStatus.STARTING, provider="agy")
        self.store.save({key: rec}, {})

        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt1 = _format_reasoning_prompt("Base", ctx1, self.ms, role="convergence")

        rec.status = PackageStatus.COMPLETED
        self.store.save({key: rec}, {})

        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt2 = _format_reasoning_prompt("Base", ctx2, self.ms, role="convergence")

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])
        self.assertNotEqual(prompt1, prompt2)
        self.assertIn(f"Status: `{PackageStatus.COMPLETE}`", prompt2)

    def test_e6_sentinel_reaches_exact_provider_prompt(self) -> None:
        """E6: TEST_EXECUTION_EVIDENCE_SENTINEL_41729 in execution evidence reaches exact provider prompt."""
        key = work_key(self.ms.id, "pkg-1")
        sentinel = "TEST_EXECUTION_EVIDENCE_SENTINEL_41729"
        rec = PackageRecord(status=PackageStatus.FAILED, last_error=sentinel, provider="agy")
        self.store.save({key: rec}, {})

        ctx = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
        prompt = _format_reasoning_prompt("Base", ctx, self.ms, role="convergence")

        self.assertIn(sentinel, prompt)
        self.assertIn("### Verified Execution Evidence:", prompt)

    def test_e7_constitution_mutation_changes_digest(self) -> None:
        """E7: Literal constitution text change changes context digest."""
        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)

        (self.root / "factory" / "constitution.md").write_text("# Constitution\nMutated text.", encoding="utf-8")
        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])

    def test_e8_requirement_definition_mutation_changes_digest(self) -> None:
        """E8: Requirement definition mutation changes context digest."""
        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)

        (self.root / "docs" / "spec" / "product.requirements.json").write_text(
            json.dumps({
                "requirements": [
                    {"id": "FR-DATA-001", "title": "Data Pipeline", "description": "Mutated description"},
                ]
            }),
            encoding="utf-8",
        )
        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])

    def test_e9_integration_head_mutation_changes_digest(self) -> None:
        """E9: Integration HEAD commit SHA mutation changes context digest."""
        ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)

        runner2 = MagicMock()
        runner2.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "2" * 40, "", 0)
        ctx2 = build_reasoning_context(self.root, self.config, self.ms, self.store, runner2)

        self.assertNotEqual(ctx1["contextDigest"], ctx2["contextDigest"])

    def test_e10_machine_local_path_invariance(self) -> None:
        """E10: Machine-local state directory path difference does NOT alter semantic contextDigest."""
        temp_dir2 = tempfile.TemporaryDirectory()
        try:
            state_dir2 = Path(temp_dir2.name) / "different_local_path" / ".factory"
            state_dir2.mkdir(parents=True, exist_ok=True)
            store2 = StateStore(state_dir2)
            config2 = make_test_config(self.root, state_dir2)

            ctx1 = build_reasoning_context(self.root, self.config, self.ms, self.store, self.runner)
            ctx2 = build_reasoning_context(self.root, config2, self.ms, store2, self.runner)

            self.assertEqual(ctx1["contextDigest"], ctx2["contextDigest"])
            self.assertNotIn("planningDirectory", ctx1)
            self.assertNotIn("planningDirectory", ctx2)
        finally:
            temp_dir2.cleanup()

    def test_stale_guards_fail_closed(self) -> None:
        """Stale reasoning guards: integration HEAD advance or context digest change fails closed."""
        reasoning = ReasoningRunner(self.root, self.config, self.store, self.runner)
        out_path = self.config.state_dir / "convergence-result.json"

        # 1. Stale HEAD
        def advance_head(role, mid, prompt, schema, out):
            out.write_text(json.dumps({"status": "CONVERGED", "gaps": []}), encoding="utf-8")
            self.runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), "3" * 40, "", 0)

        with patch.object(reasoning, "_invoke_codex", side_effect=advance_head):
            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                reasoning.converge(self.ms)
            self.assertEqual(cm.exception.failure_class, "STALE_INTEGRATION_HEAD")

        # Reset runner
        self.runner.run.return_value = CommandResult(("git", "rev-parse", "HEAD"), self.valid_head, "", 0)

        # 2. Stale Digest (e.g. constitution changed during reasoning call)
        def change_constitution(role, mid, prompt, schema, out):
            out.write_text(json.dumps({"status": "CONVERGED", "gaps": []}), encoding="utf-8")
            (self.root / "factory" / "constitution.md").write_text("Mutated during call", encoding="utf-8")

        with patch.object(reasoning, "_invoke_codex", side_effect=change_constitution):
            with self.assertRaises(ConvergenceOutputRejectedError) as cm:
                reasoning.converge(self.ms)
            self.assertEqual(cm.exception.failure_class, "STALE_CONTEXT_DIGEST")


if __name__ == "__main__":
    unittest.main()
