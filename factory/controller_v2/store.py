"""SQLite authority — WAL, FK, transactions (§10)."""
from __future__ import annotations

import sqlite3
from pathlib import Path
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
