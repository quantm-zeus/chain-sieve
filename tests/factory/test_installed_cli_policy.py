from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from factory.controller.commands import CommandResult, CommandRunner
from factory.controller.reasoning import ReasoningRunner, _validate_json_schema
from factory.controller.store import StateStore
from test_controller import config


class SequenceRunner:
    def __init__(self, root: Path, codex: list[tuple[int, str]], *, muse_ok: bool = True) -> None:
        self.root = root
        self.source_env: dict[str, str] = {}
        self.codex = list(codex)
        self.muse_ok = muse_ok
        self.calls: list[list[str]] = []

    def run(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
        if argv[0] == "codex":
            returncode, detail = self.codex.pop(0)
            if returncode == 0:
                output = Path(argv[argv.index("--output-last-message") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text('{"status":"PASS","summary":"codex"}\n', encoding="utf-8")
            return CommandResult(tuple(argv), "", detail, returncode)
        if argv[0] == "muse":
            if not self.muse_ok:
                return CommandResult(tuple(argv), "", "Muse persisted login unavailable", 1)
            payload = {"payload_type": "run.terminal.completed", "payload": {
                "text": '{"status":"PASS","summary":"muse"}',
            }}
            return CommandResult(tuple(argv), json.dumps(payload) + "\n", "", 0)
        raise AssertionError(argv)


class InstalledCliPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.schema = self.root / "schema.json"
        self.schema.write_text(json.dumps({
            "type": "object",
            "additionalProperties": False,
            "required": ["status", "summary"],
            "properties": {
                "status": {"type": "string", "const": "PASS"},
                "summary": {"type": "string"},
            },
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def reasoner(self, runner: SequenceRunner, *, cooldown: int = 0) -> ReasoningRunner:
        cfg = replace(config(self.root), provider_cooldown_seconds=cooldown)
        cfg.codex_routes["planner"] = replace(cfg.codex_routes["planner"], max_calls_per_milestone=3)
        return ReasoningRunner(self.root, cfg, StateStore(cfg.state_dir), runner)

    def test_cli_default_codex_omits_unverified_model(self) -> None:
        runner = SequenceRunner(self.root, [(0, "")])
        reasoner = self.reasoner(runner)
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "out.json")
        self.assertNotIn("--model", runner.calls[0])
        usage = json.loads((reasoner.config.state_dir / "usage.json").read_text())
        self.assertEqual(usage["codexCalls"], 1)
        self.assertEqual(usage["reasoningOperations"]["actualLastReasoningProvider"], "codex")

    def test_explicit_model_failure_retries_codex_default_before_muse(self) -> None:
        runner = SequenceRunner(self.root, [(1, "model is not available"), (0, "")])
        reasoner = self.reasoner(runner)
        reasoner.config.codex_routes["planner"] = replace(
            reasoner.config.codex_routes["planner"], explicit_model="gpt-test",
        )
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "out.json")
        self.assertIn("--model", runner.calls[0])
        self.assertNotIn("--model", runner.calls[1])
        self.assertFalse(any(call[0] == "muse" for call in runner.calls))
        events = reasoner.store.history()
        self.assertEqual(sum(item["type"] == "CODEX_DEFAULT_MODEL_RETRY" for item in events), 1)

    def test_persistent_auth_failure_falls_back_once_with_same_schema_and_budget(self) -> None:
        runner = SequenceRunner(self.root, [(1, "authentication invalid; login required")])
        reasoner = self.reasoner(runner)
        output = self.root / "out.json"
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, output)
        self.assertEqual(json.loads(output.read_text())["summary"], "muse")
        self.assertEqual(sum(call[0] == "muse" for call in runner.calls), 1)
        usage = json.loads((reasoner.config.state_dir / "usage.json").read_text())
        self.assertEqual(usage["codexCalls"], 1)
        self.assertEqual(usage["reasoningOperations"]["museFallbackSuccesses"], 1)
        self.assertEqual(usage["reasoningOperations"]["actualLastReasoningProvider"], "muse")

    def test_transient_failures_use_bounded_codex_retry_before_fallback(self) -> None:
        runner = SequenceRunner(self.root, [(1, "DNS temporary failure"), (1, "HTTP 503"), (0, "")])
        reasoner = self.reasoner(runner)
        with patch("factory.controller.reasoning.time.sleep") as sleep:
            reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "out.json")
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(sum(call[0] == "codex" for call in runner.calls), 3)
        self.assertFalse(any(call[0] == "muse" for call in runner.calls))

    def test_fallback_failure_does_not_recurse(self) -> None:
        runner = SequenceRunner(self.root, [(1, "quota exhausted")], muse_ok=False)
        reasoner = self.reasoner(runner)
        with self.assertRaisesRegex(RuntimeError, "one-shot Muse fallback failed"):
            reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "out.json")
        self.assertEqual(sum(call[0] == "muse" for call in runner.calls), 1)
        self.assertEqual(sum(call[0] == "codex" for call in runner.calls), 1)

    def test_fallback_schema_validation_resolves_refs_and_combinators(self) -> None:
        schema = {
            "type": "object", "required": ["plan"],
            "properties": {"plan": {"oneOf": [{"type": "null"}, {"$ref": "#/$defs/plan"}]}},
            "$defs": {"plan": {
                "type": "object", "required": ["items"],
                "properties": {"items": {"type": "array", "minItems": 2, "uniqueItems": True}},
            }},
        }
        _validate_json_schema({"plan": {"items": ["a", "b"]}}, schema)
        with self.assertRaisesRegex(RuntimeError, "oneOf"):
            _validate_json_schema({"plan": {"items": ["a"]}}, schema)

    def test_cooldown_skips_tight_polling_then_later_request_retries_codex(self) -> None:
        runner = SequenceRunner(self.root, [(1, "entitlement unavailable"), (0, "")])
        reasoner = self.reasoner(runner, cooldown=60)
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "one.json")
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "two.json")
        self.assertEqual(sum(call[0] == "codex" for call in runner.calls), 1)
        usage_path = reasoner.config.state_dir / "usage.json"
        usage = json.loads(usage_path.read_text())
        usage["reasoningOperations"]["codexUnavailableUntilEpoch"] = 0
        usage_path.write_text(json.dumps(usage), encoding="utf-8")
        reasoner._invoke_codex("planner", "m1", "prompt", self.schema, self.root / "three.json")
        self.assertEqual(sum(call[0] == "codex" for call in runner.calls), 2)
        self.assertEqual(json.loads(usage_path.read_text())["codexCalls"], 3)

    def test_exact_gh_and_codex_paths_override_path_lookup(self) -> None:
        runner = CommandRunner(self.root, {
            "PATH": "/bin:/usr/bin",
            "CHAINSIEVE_GH_BIN": "/installed/user/bin/gh",
            "CHAINSIEVE_CODEX_BIN": "/installed/user/bin/codex",
        })
        gh = runner.run(["gh", "--version"], check=False)
        codex = runner.run(["codex", "--version"], check=False)
        self.assertEqual(gh.argv[0], "/installed/user/bin/gh")
        self.assertEqual(codex.argv[0], "/installed/user/bin/codex")

    def test_wrappers_omit_model_in_cli_default_mode_and_reject_recursion(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        capture = self.root / "capture"
        capture.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
        capture.chmod(0o755)
        for provider, variable in (("muse", "CHAINSIEVE_MUSE_BIN"), ("agy", "CHAINSIEVE_AGY_BIN")):
            wrapper = repo / "factory" / "deployment" / "bin" / provider
            result = subprocess.run(
                [str(wrapper), "--version"], env={**os.environ, variable: str(capture)},
                check=True, text=True, capture_output=True,
            )
            self.assertNotIn("--model", result.stdout)
            recursive = subprocess.run(
                [str(wrapper), "--version"], env={**os.environ, variable: str(wrapper)},
                check=False, text=True, capture_output=True,
            )
            self.assertNotEqual(recursive.returncode, 0)
            self.assertIn("recursive", recursive.stderr)

    def test_wrappers_pass_only_safely_resolved_explicit_models(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        capture = self.root / "capture-explicit"
        capture.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
        capture.chmod(0o755)
        cases = (
            ("muse", "CHAINSIEVE_MUSE_BIN", "CHAINSIEVE_MUSE_MODEL", "muse-spark-1.2-contributor", ["exec", "reason"]),
            ("agy", "CHAINSIEVE_AGY_BIN", "CHAINSIEVE_AGY_MODEL", "installed-cli-model-id", ["--print", "reason"]),
        )
        for provider, binary_var, model_var, model, arguments in cases:
            wrapper = repo / "factory" / "deployment" / "bin" / provider
            result = subprocess.run(
                [str(wrapper), *arguments],
                env={**os.environ, binary_var: str(capture), model_var: model},
                check=True, text=True, capture_output=True,
            )
            lines = result.stdout.splitlines()
            self.assertEqual(lines[:2], ["--model", model])

    def test_installer_discovers_user_clis_without_staging_or_tokens(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        installer = (repo / "factory" / "deployment" / "install-ubuntu.sh").read_text()
        self.assertIn('runuser -l "$deploy_user"', installer)
        for name in ("gh", "muse", "agy", "codex"):
            self.assertIn(f'{name}_bin="$(resolve_cli {name}', installer)
        for forbidden in (
            "CHAINSIEVE_MUSE_SOURCE", "CHAINSIEVE_MUSE_SHA256", "CHAINSIEVE_AGY_SOURCE",
            "CHAINSIEVE_AGY_SHA256", "OPENAI_API_KEY", "/usr/local/lib/chainsieve/providers",
        ):
            self.assertNotIn(forbidden, installer)


if __name__ == "__main__":
    unittest.main()
