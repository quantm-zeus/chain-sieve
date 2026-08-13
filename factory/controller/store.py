from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .models import PackageRecord


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
        if not self.events_path.exists():
            return []
        lines = self.events_path.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines[-limit:] if line.strip()]

    def heartbeat(self, *, active: bool) -> None:
        self.prepare()
        payload = {
            "controllerHeartbeatAt": utc_now(),
            "pid": os.getpid(),
            "active": active,
        }
        temporary = self.heartbeat_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o640)
        temporary.replace(self.heartbeat_path)

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
