"""SQLite authority — WAL, FK, transactions (§10)."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from contextlib import contextmanager
from datetime import UTC, datetime
import json
import os
import tempfile
import threading
from typing import Iterator
from typing import Any


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS work_items (
    workId TEXT PRIMARY KEY,
    gapKey TEXT NOT NULL UNIQUE,
    strategyEpoch INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    issue_number INTEGER,
    branch TEXT,
    pr_number INTEGER,
    session_id TEXT,
    head_sha TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS external_bindings (
    workId TEXT PRIMARY KEY REFERENCES work_items(workId),
    issue INTEGER,
    branch TEXT,
    pr INTEGER,
    session TEXT
);

CREATE TABLE IF NOT EXISTS commands (
    commandId TEXT PRIMARY KEY,
    idempotencyKey TEXT NOT NULL UNIQUE,
    workId TEXT NOT NULL REFERENCES work_items(workId),
    commandType TEXT NOT NULL,
    payload TEXT NOT NULL,
    expectedStateVersion INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_receipts (
    commandId TEXT PRIMARY KEY REFERENCES commands(commandId),
    idempotencyKey TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ci_evidence (
    pr INTEGER NOT NULL,
    head TEXT NOT NULL,
    gate_set TEXT NOT NULL,
    passed INTEGER NOT NULL,
    classification TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (pr, head)
);

CREATE TABLE IF NOT EXISTS review_evidence (
    workId TEXT NOT NULL,
    pr INTEGER NOT NULL,
    targetHead TEXT NOT NULL,
    mode TEXT NOT NULL,
    reviewScopeId TEXT NOT NULL,
    contextDigest TEXT NOT NULL,
    verdict TEXT NOT NULL,
    payload TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (workId, targetHead, mode)
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    workId TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path), isolation_level=None, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA foreign_keys=ON;")
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(SCHEMA)

    def tx(self):
        return self.conn  # caller uses BEGIN/COMMIT

    def insert_work_item(self, item: dict[str, Any]) -> None:
        # Use UPSERT with history: INSERT ... ON CONFLICT updates mutable fields, prior state preserved in events table
        self.conn.execute(
            "INSERT INTO work_items(workId,gapKey,strategyEpoch,status,issue_number,branch,pr_number,session_id,head_sha,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(workId) DO UPDATE SET status=excluded.status, issue_number=COALESCE(excluded.issue_number, work_items.issue_number), "
            "branch=COALESCE(excluded.branch, work_items.branch), pr_number=COALESCE(excluded.pr_number, work_items.pr_number), "
            "session_id=COALESCE(excluded.session_id, work_items.session_id), head_sha=COALESCE(excluded.head_sha, work_items.head_sha), "
            "strategyEpoch=excluded.strategyEpoch, updated_at=excluded.updated_at",
            (
                item["workId"],
                item["gapKey"],
                item.get("strategyEpoch", 0),
                item["status"],
                item.get("issue_number"),
                item.get("branch"),
                item.get("pr_number"),
                item.get("session_id"),
                item.get("head_sha"),
                item.get("updated_at"),
            ),
        )
        # also append to events for audit/history (append-only)
        import json as _json, datetime as _dt
        self.conn.execute(
            "INSERT INTO events(type, workId, payload, created_at) VALUES (?,?,?,?)",
            ("work_item_upsert", item["workId"], _json.dumps(item), _dt.datetime.utcnow().isoformat()+"Z"),
        )

    def insert_command(self, cmd: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO commands(commandId,idempotencyKey,workId,commandType,payload,expectedStateVersion,created_at) VALUES (?,?,?,?,?,?,?)",
            (
                cmd["commandId"],
                cmd["idempotencyKey"],
                cmd["workId"],
                cmd["commandType"],
                cmd["payload"],
                cmd["expectedStateVersion"],
                cmd["created_at"],
            ),
        )

    def hash_db(self) -> str:
        import hashlib
        data = self.conn.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall()
        h = hashlib.sha256(str(data).encode()).hexdigest()[:16]
        return h

    def close(self) -> None:
        self.conn.close()


from .models import PackageRecord
from .review_context import build_review_context

def utc_now() -> str:
    return datetime.now(UTC).isoformat()

# --- V1 compatibility: StateStore for legacy tests ---
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

    def write_review_context(
        self,
        milestone_id: str,
        package: Any,
        head_sha: str,
        *,
        review_mode: str = "FULL_BASELINE",
        baseline_id: str | None = None,
        baseline_head: str | None = None,
        baseline_context_digest: str | None = None,
        frozen_findings: Sequence[dict[str, Any]] | None = None,
        previous_reviewed_head: str | None = None,
        pr_number: int | None = None,
        implementation_provider: str | None = None,
        reviewer_provider: str | None = None,
    ) -> Path:
        if len(head_sha) != 40 or any(character not in "0123456789abcdefABCDEF" for character in head_sha):
            raise ValueError("review context requires a 40-character hexadecimal PR head SHA")
        head_sha = head_sha.lower()
        pkg_id = package["id"] if isinstance(package, dict) else package.id
        key = f"{milestone_id}--{pkg_id}"
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
            review_mode=review_mode,
            baseline_id=baseline_id,
            baseline_head=baseline_head,
            baseline_context_digest=baseline_context_digest,
            frozen_findings=frozen_findings,
            previous_reviewed_head=previous_reviewed_head,
            pr_number=pr_number,
            implementation_provider=implementation_provider,
            reviewer_provider=reviewer_provider,
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
