"""Idempotent executor — persists command before execution, receipt after (§13)."""
from __future__ import annotations

from typing import Any, Callable

from .commands import Command, Receipt
from .store import Store


class Executor:
    def __init__(self, store: Store, handlers: dict[str, Callable[[Command], dict[str, Any]]]) -> None:
        self.store = store
        self.handlers = handlers

    def execute(self, cmd: Command) -> Receipt:
        # Crash-window reconciliation: receipts keyed by idempotencyKey, but external effect may have succeeded before receipt persisted.
        # Handlers themselves must observe-before-retry (see adapters). Here we ensure local idempotency via idempotencyKey.
        cur = self.store.conn.execute("SELECT status, result FROM command_receipts WHERE idempotencyKey=?", (cmd.idempotencyKey,))
        row = cur.fetchone()
        if row:
            return Receipt(commandId=cmd.commandId, idempotencyKey=cmd.idempotencyKey, status=row[0], result=None)
        # also check if command with same idempotencyKey already exists but no receipt (crash after persist before handler)
        cur0 = self.store.conn.execute("SELECT commandId FROM commands WHERE idempotencyKey=?", (cmd.idempotencyKey,))
        if cur0.fetchone():
            # handler may have already executed externally via adapter reconciliation, check receipt again after handler's observe-before-retry
            cur2 = self.store.conn.execute("SELECT status, result FROM command_receipts WHERE idempotencyKey=?", (cmd.idempotencyKey,))
            r2 = cur2.fetchone()
            if r2:
                return Receipt(commandId=cmd.commandId, idempotencyKey=cmd.idempotencyKey, status=r2[0], result=None)
            # else we will attempt handler which itself reconciles externally, safe to retry

        # Persist command before execution (idempotent)
        try:
            self.store.insert_command(
                {
                    "commandId": cmd.commandId,
                    "idempotencyKey": cmd.idempotencyKey,
                    "workId": cmd.workId,
                    "commandType": cmd.commandType.value if hasattr(cmd.commandType, "value") else str(cmd.commandType),
                    "payload": str(cmd.payload),
                    "expectedStateVersion": cmd.expectedStateVersion,
                    "created_at": "now",
                }
            )
        except Exception as e:
            if "UNIQUE" in str(e) or "unique" in str(e).lower():
                cur2 = self.store.conn.execute("SELECT status, result FROM command_receipts WHERE idempotencyKey=?", (cmd.idempotencyKey,))
                r2 = cur2.fetchone()
                if r2:
                    return Receipt(commandId=cmd.commandId, idempotencyKey=cmd.idempotencyKey, status=r2[0], result=None)
                # command already persisted, proceed to handler reconcile path below
            else:
                raise

        handler = self.handlers.get(cmd.commandType.value if hasattr(cmd.commandType, "value") else str(cmd.commandType))
        try:
            result = handler(cmd) if handler else {"ok": True}
            status = "SUCCESS"
        except Exception as e:
            result = {"error": str(e)}
            status = "FAILED"

        self.store.conn.execute(
            "INSERT OR REPLACE INTO command_receipts(commandId,idempotencyKey,status,result,created_at) VALUES (?,?,?,?,?)",
            (cmd.commandId, cmd.idempotencyKey, status, str(result), "now"),
        )
        return Receipt(commandId=cmd.commandId, idempotencyKey=cmd.idempotencyKey, status=status, result=result)
