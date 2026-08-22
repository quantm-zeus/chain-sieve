"""Typed commands — idempotent with receipts (§13)."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class CommandType(StrEnum):
    CREATE_ISSUE = "CREATE_ISSUE"
    START_WORKER = "START_WORKER"
    SEND_PRODUCT_CORRECTION = "SEND_PRODUCT_CORRECTION"
    TRIGGER_REVIEW = "TRIGGER_REVIEW"
    RETRY_CI_INFRA = "RETRY_CI_INFRA"
    REQUEST_STRATEGY = "REQUEST_STRATEGY"
    UPDATE_BRANCH = "UPDATE_BRANCH"
    MERGE_PR = "MERGE_PR"
    CLOSE_LEGACY_DUPLICATE = "CLOSE_LEGACY_DUPLICATE"


@dataclass(frozen=True)
class Command:
    commandId: str
    idempotencyKey: str
    expectedStateVersion: int
    workId: str
    commandType: CommandType
    payload: dict[str, Any]

    @staticmethod
    def new(
        workId: str,
        commandType: CommandType,
        expectedStateVersion: int,
        payload: dict[str, Any],
        idempotencyKey: str | None = None,
    ) -> Command:
        if idempotencyKey is None:
            raw = f"{workId}|{commandType.value}|{expectedStateVersion}|{sorted(payload.items())}"
            idempotencyKey = hashlib.sha256(raw.encode()).hexdigest()[:16]
        # Deterministic commandId from idempotencyKey keeps reducer pure (§9).
        # Identical reducer inputs -> byte-identical commands; random identity
        # must be assigned outside the pure reducer if ever needed.
        cid = hashlib.sha256(f"cmd|{idempotencyKey}".encode()).hexdigest()[:16]
        return Command(
            commandId=cid,
            idempotencyKey=idempotencyKey,
            expectedStateVersion=expectedStateVersion,
            workId=workId,
            commandType=commandType,
            payload=dict(payload),
        )


@dataclass(frozen=True)
class Receipt:
    commandId: str
    idempotencyKey: str
    status: str  # SUCCESS | FAILED | REJECTED
    result: dict[str, Any] | None = None
