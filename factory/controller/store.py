from __future__ import annotations

import json
import os
import tempfile
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .models import PackageRecord
from .review_context import build_review_context


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class StateStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.state_path = directory / "state.json"
        self.events_path = directory / "events.jsonl"
        self.lock_path = directory / "controller.lock"
        self.review_dir = directory / "reviews"
        self.heartbeat_path = directory / "heartbeat.json"
        self._heartbeat_lock = threading.Lock()

    def prepare(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o750)
        self.review_dir.mkdir(parents=True, exist_ok=True, mode=0o750)

    def load(self) -> dict[str, PackageRecord]:
        if not self.state_path.exists():
            return {}
        raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        return {key: PackageRecord.from_dict(value) for key, value in raw.get("packages", {}).items()}

    def metadata(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {}
        return dict(json.loads(self.state_path.read_text(encoding="utf-8")).get("metadata", {}))

    def save(self, records: dict[str, PackageRecord], metadata: dict[str, Any] | None = None) -> None:
        self.prepare()
        payload = {
            "schemaVersion": 1,
            "updatedAt": utc_now(),
            "packages": {key: value.to_dict() for key, value in sorted(records.items())},
            "metadata": metadata or {},
        }
        temporary = self.state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o640)
        temporary.replace(self.state_path)

    def set_reasoning_operation(
        self,
        *,
        role: str | None,
        provider: str | None = None,
        milestone_id: str | None = None,
        started_at: str | None = None,
    ) -> None:
        records = self.load()
        metadata = self.metadata()
        if role is None:
            metadata.pop("reasoningOperation", None)
        else:
            metadata["reasoningOperation"] = {
                "role": role,
                "provider": provider,
                "milestoneId": milestone_id,
                "startedAt": started_at or utc_now(),
            }
        self.save(records, metadata)

    def event(self, event_type: str, **fields: Any) -> None:
        self.prepare()
        payload = {"timestamp": utc_now(), "type": event_type}
        payload.update({key: value for key, value in fields.items() if value is not None})
        with self.events_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
        os.chmod(self.events_path, 0o640)

    def archive(self, milestone_id: str, records: dict[str, PackageRecord], metadata: dict[str, Any]) -> Path:
        directory = self.directory / "archive"
        directory.mkdir(parents=True, exist_ok=True, mode=0o750)
        path = directory / f"{milestone_id}.json"
        payload = {
            "schemaVersion": 1,
            "milestoneId": milestone_id,
            "archivedAt": utc_now(),
            "packages": {key: value.to_dict() for key, value in sorted(records.items())},
            "metadata": metadata,
        }
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o640)
        temporary.replace(path)
        return path

    def history(self, limit: int = 50) -> list[dict[str, Any]]:
        if limit <= 0 or not self.events_path.exists():
            return []
        events: list[dict[str, Any]] = []
        with self.events_path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            position = stream.tell()
            suffix = b""
            while position > 0 and len(events) < limit:
                size = min(8192, position)
                position -= size
                stream.seek(position)
                parts = (stream.read(size) + suffix).split(b"\n")
                suffix = parts[0]
                for raw in reversed(parts[1:]):
                    if not raw.strip():
                        continue
                    try:
                        value = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
                        continue
                    if isinstance(value, dict):
                        events.append(value)
                        if len(events) == limit:
                            break
            if position == 0 and len(events) < limit and suffix.strip():
                try:
                    value = json.loads(suffix.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
                    pass
                else:
                    if isinstance(value, dict):
                        events.append(value)
        events.reverse()
        return events

    def heartbeat(self, *, active: bool) -> None:
        with self._heartbeat_lock:
            self.prepare()
            payload = {
                "controllerHeartbeatAt": utc_now(),
                "pid": os.getpid(),
                "active": active,
            }
            descriptor, name = tempfile.mkstemp(prefix=".heartbeat.", dir=self.directory)
            temporary = Path(name)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write(json.dumps(payload, sort_keys=True) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o640)
                os.replace(temporary, self.heartbeat_path)
            finally:
                temporary.unlink(missing_ok=True)

    def write_review_context(self, milestone_id: str, package: Any, head_sha: str) -> Path:
        if len(head_sha) != 40 or any(character not in "0123456789abcdefABCDEF" for character in head_sha):
            raise ValueError("review context requires a 40-character hexadecimal PR head SHA")
        head_sha = head_sha.lower()
        key = f"{milestone_id}--{package.id}"
        directory = self.review_dir / key
        directory.mkdir(parents=True, exist_ok=True, mode=0o750)
        path = directory / f"{head_sha}.json"
        payload = build_review_context(
            milestone_id,
            package,
            head_sha,
            (
                "docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.md",
                "docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json",
                "specs/factory/current-milestone.json",
            ),
        )
        descriptor, name = tempfile.mkstemp(prefix=".review-context.", dir=directory)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o440)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return path

    def heartbeat_state(self) -> dict[str, Any]:
        if not self.heartbeat_path.exists():
            return {}
        try:
            return dict(json.loads(self.heartbeat_path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return {}

    @contextmanager
    def lock(self) -> Iterator[None]:
        self.prepare()
        import fcntl

        with self.lock_path.open("a+", encoding="utf-8") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError("another factory controller instance is active") from error
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
            handle.flush()
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
