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
    def __init__(self, head: str, verdict: str = "approved") -> None:
        self.head = head
        self.verdict = verdict
        self.sent: list[str] = []
        self.triggered: list[tuple[str, str]] = []

    def reviews(self, session_id: str):
        if self.verdict == "missing":
            return {"reviews": []}
        return {"reviews": [{"latestRun": {
            "targetSha": self.head,
            "status": "completed",
            "verdict": self.verdict,
            "harness": "agy",
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
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o440)
        self.assertEqual(ao.triggered, [("ao-1", "agy")])
        unit = (Path(__file__).resolve().parents[2] / "factory/deployment/systemd/chainsieve-ao.service").read_text()
        self.assertIn("ReadOnlyPaths=@REPO@ @STATE@", unit)
        for wrapper in ("agy", "muse"):
            source = (Path(__file__).resolve().parents[2] / "factory/deployment/bin" / wrapper).read_text()
            self.assertIn('context_payload="$(<"$context_file")"', source)
            self.assertIn('arguments[', source)

    def test_review_wrappers_embed_controller_context_in_reviewer_prompt(self) -> None:
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
        context_root = self.root / "reviews"
        context_dir = context_root / "m1--a"
        context_dir.mkdir(parents=True)
        authority = '{"workKey":"m1--a","objective":"semantic authority"}'
        (context_dir / f"{head}.json").write_text(authority, encoding="utf-8")
        capture = self.root / "capture"
        capture.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
        capture.chmod(0o755)
        deployment = Path(__file__).resolve().parents[2] / "factory/deployment/bin"
        common = {**os.environ, "CHAINSIEVE_FACTORY_REVIEW_CONTEXT_DIR": str(context_root)}
        invocations = (
            ("agy", "CHAINSIEVE_AGY_REAL", ["--sandbox", "--prompt-interactive", "review this head"]),
            ("muse", "CHAINSIEVE_MUSE_REAL", ["--disable-write", "review this head"]),
        )
        for wrapper, variable, arguments in invocations:
            result = subprocess.run(
                [str(deployment / wrapper), *arguments], cwd=workspace,
                env={**common, variable: str(capture)}, check=True, text=True, capture_output=True,
            )
            self.assertIn("controller-owned ChainSieve review authority", result.stdout)
            self.assertIn(authority, result.stdout)
        restored = subprocess.run(
            [str(deployment / "muse"), "--disable-write", "resume", "muse-native-1"], cwd=workspace,
            env={**common, "CHAINSIEVE_MUSE_REAL": str(capture)}, check=True, text=True, capture_output=True,
        )
        self.assertNotIn("controller-owned ChainSieve review authority", restored.stdout)
        self.assertTrue(restored.stdout.endswith("resume\nmuse-native-1\n"))
        (context_dir / f"{head}.json").unlink()
        for wrapper, variable, arguments in invocations:
            rejected = subprocess.run(
                [str(deployment / wrapper), *arguments], cwd=workspace,
                env={**common, variable: str(capture)}, check=False, text=True, capture_output=True,
            )
            self.assertEqual(rejected.returncode, 78)
            self.assertIn("controller review context is unavailable", rejected.stderr)

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
        installer = (deployment / "install-ubuntu.sh").read_text()
        self.assertIn('--user USER --repo PATH', installer)
        self.assertIn('state="$(readlink -m "${state:-$user_home/', installer)
        canary = (deployment / "activate-canary.sh").read_text()
        self.assertIn("chainsieve-ao.service.d", canary)
        self.assertIn('"ReadOnlyPaths=$canary_state_unit"', canary)


if __name__ == "__main__":
    unittest.main()
