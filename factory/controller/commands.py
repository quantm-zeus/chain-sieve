from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


BASE_ENV_KEYS = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "HOME",
    "USER",
    "LOGNAME",
)


@dataclass(frozen=True)
class CommandResult:
    argv: tuple[str, ...]
    stdout: str
    stderr: str
    returncode: int


class CommandError(RuntimeError):
    def __init__(self, result: CommandResult) -> None:
        safe = " ".join(result.argv[:3])
        detail = (result.stderr or result.stdout).strip()[-2000:]
        super().__init__(f"command failed ({result.returncode}): {safe}: {detail}")
        self.result = result


class CommandRunner:
    """Run trusted fixed commands without leaking the controller environment."""

    def __init__(self, root: Path, source_env: Mapping[str, str] | None = None) -> None:
        self.root = root
        self.source_env = dict(source_env or os.environ)

    def env(self, allowed: Iterable[str] = (), additions: Mapping[str, str] | None = None) -> dict[str, str]:
        keys = set(BASE_ENV_KEYS) | set(allowed)
        result = {key: self.source_env[key] for key in keys if self.source_env.get(key)}
        result.update(additions or {})
        return result

    def run(
        self,
        argv: list[str],
        *,
        allowed_env: Iterable[str] = (),
        additions: Mapping[str, str] | None = None,
        input_text: str | None = None,
        timeout: int = 60,
        check: bool = True,
    ) -> CommandResult:
        try:
            process = subprocess.run(
                argv,
                cwd=self.root,
                env=self.env(allowed_env, additions),
                input=input_text,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
            result = CommandResult(tuple(argv), process.stdout, process.stderr, process.returncode)
        except FileNotFoundError:
            result = CommandResult(tuple(argv), "", f"executable not found: {argv[0]}", 127)
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout if isinstance(error.stdout, str) else ""
            stderr = error.stderr if isinstance(error.stderr, str) else ""
            result = CommandResult(tuple(argv), stdout, f"{stderr}\ncommand timed out after {timeout}s".strip(), 124)
        if check and result.returncode != 0:
            raise CommandError(result)
        return result

    def json(self, argv: list[str], **kwargs: Any) -> Any:
        output = self.run(argv, **kwargs).stdout
        try:
            return json.loads(output)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"command returned invalid JSON: {' '.join(argv[:3])}") from error
