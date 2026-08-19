/**
 * @requirement FR-WF-006 - Transactional notification outbox: decision, alert record, and outbox entry commit in one transaction.
 * @requirement FR-WF-008 - Shadow mode execution: persistence without external side effects.
 * @requirement AC-141 - Idempotent delivery worker.
 */

import type { DegradedResult } from '@ciag/domain';
import type { DatabaseAdapter, NotificationAdapter } from '@ciag/provider-contracts';
import type { AlertRecord, OutboxEntry, OutboxEntryState } from './types.js';

export interface CommitAlertTransactionInput {
  decisionRecord?: {
    id: string;
    assetId: string;
    stage: string;
    payload: unknown;
    eventTime: string;
    observedAt: string;
    availableAt: string;
    idempotencyKey: string;
    capabilityMode: string;
    traceId: string;
  };
  alertRecord: AlertRecord;
  outboxEntry: OutboxEntry;
}

export interface ProcessOutboxOptions {
  maxRetries?: number;
  shadowMode?: boolean;
}

export interface OutboxDeliveryResult {
  outboxId: string;
  delivered: boolean;
  state: OutboxEntryState;
  attemptCount: number;
  deliveredAt?: string | null;
  reason?: string;
}

export class ShadowNotificationAdapter implements NotificationAdapter {
  readonly messages: string[] = [];
  async enqueue(input: { outboxId: string; template: string; evidenceKeys?: string[] }): Promise<DegradedResult<{ deliveryId: string }>> {
    this.messages.push(`${input.outboxId}:${input.template}`);
    return {
      status: 'AVAILABLE',
      capabilityMode: 'SYNTHETIC_SHADOW',
      value: { deliveryId: `shadow-${input.outboxId}` },
    };
  }
}

/**
 * Commit decision observation, alert record, and outbox entry in one atomic database transaction.
 * Prevents phantom alerts or missed notifications on system failures (FR-WF-006).
 */
export const commitAlertTransaction = async (
  database: DatabaseAdapter,
  input: CommitAlertTransactionInput,
): Promise<void> => {
  await database.transaction(async (tx) => {
    // 1. If decision observation provided, insert into synthetic_observations
    if (input.decisionRecord) {
      await tx.query(
        `INSERT INTO synthetic_observations (id, asset_id, stage, payload_json, event_time, observed_at, available_at, idempotency_key, capability_mode, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.decisionRecord.id,
          input.decisionRecord.assetId,
          input.decisionRecord.stage,
          JSON.stringify(input.decisionRecord.payload),
          input.decisionRecord.eventTime,
          input.decisionRecord.observedAt,
          input.decisionRecord.availableAt,
          input.decisionRecord.idempotencyKey,
          input.decisionRecord.capabilityMode,
          input.decisionRecord.traceId,
        ],
      );
    }

    // 2. Insert Alert Record into alerts table (immutable exactly-once snapshot)
    await tx.query(
      `INSERT INTO alerts (alert_id, asset_id, alert_class, actionability_state, fingerprint, valid_until, payload_json, canonical_json, sha256, bytes, created_at, shadow_mode, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (alert_id) DO NOTHING`,
      [
        input.alertRecord.alertId,
        input.alertRecord.assetId,
        input.alertRecord.alertClass,
        input.alertRecord.actionabilityState,
        input.alertRecord.fingerprint,
        input.alertRecord.validUntil,
        JSON.stringify(input.alertRecord.payload),
        input.alertRecord.canonicalJson,
        input.alertRecord.sha256,
        input.alertRecord.bytes,
        input.alertRecord.createdAt,
        input.alertRecord.shadowMode,
        input.alertRecord.traceId,
      ],
    );

    // 3. Insert Outbox Entry
    await tx.query(
      `INSERT INTO outbox (id, topic, payload_json, state, attempt_count, available_at, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.outboxEntry.id,
        input.outboxEntry.topic,
        JSON.stringify(input.outboxEntry.payloadJson),
        input.outboxEntry.state,
        input.outboxEntry.attemptCount,
        input.outboxEntry.availableAt,
        input.outboxEntry.traceId,
      ],
    );
  });
};

/**
 * Process a single outbox entry with idempotent delivery and retry handling.
 */
export const processOutboxEntry = async (
  database: DatabaseAdapter,
  notifications: NotificationAdapter,
  outboxId: string,
  nowIso: string,
  options: ProcessOutboxOptions = {},
): Promise<OutboxDeliveryResult> => {
  const maxRetries = options.maxRetries ?? 5;

  // 1. Fetch current outbox entry state
  const queryResult = await database.query<{
    id: string;
    topic: string;
    payload_json: Record<string, unknown> | string;
    state: string;
    attempt_count: number;
    available_at: string | Date;
    delivered_at: string | Date | null;
    trace_id: string;
  }>(`SELECT id, topic, payload_json, state, attempt_count, available_at, delivered_at, trace_id FROM outbox WHERE id=$1`, [outboxId]);

  if (queryResult.rows.length === 0) {
    throw new Error(`OUTBOX_ENTRY_NOT_FOUND:${outboxId}`);
  }

  const row = queryResult.rows[0]!;
  const currentState = row.state as OutboxEntryState;
  const currentAttempts = Number(row.attempt_count);

  // 2. Idempotency check: if already DELIVERED, return success immediately without re-sending
  if (currentState === 'DELIVERED') {
    return {
      outboxId,
      delivered: true,
      state: 'DELIVERED',
      attemptCount: currentAttempts,
      deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
      reason: 'IDEMPOTENT_ALREADY_DELIVERED',
    };
  }

  // If already CANCELLED or FAILED, do not attempt
  if (currentState === 'CANCELLED' || currentState === 'FAILED') {
    return {
      outboxId,
      delivered: false,
      state: currentState,
      attemptCount: currentAttempts,
      reason: `OUTBOX_TERMINAL_STATE:${currentState}`,
    };
  }

  // 3. Availability check: do not dispatch before available_at
  const nowMs = Date.parse(nowIso);
  const availableAtMs = Date.parse(String(row.available_at));
  if (nowMs < availableAtMs) {
    return {
      outboxId,
      delivered: false,
      state: currentState,
      attemptCount: currentAttempts,
      reason: `NOT_YET_AVAILABLE:${row.available_at}`,
    };
  }

  // 4. Dispatch to notification adapter (or shadow mode guard)
  const isShadowTopic = row.topic.startsWith('alert.shadow.');
  const isShadowMode = Boolean(options.shadowMode || isShadowTopic);

  let deliveryResult: { status: 'AVAILABLE' | 'UNAVAILABLE'; reason?: string };

  const payloadObj = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
  const templateName = row.topic.replace('alert.', '');

  if (isShadowMode && !(notifications instanceof ShadowNotificationAdapter)) {
    // Prevent external dispatch in shadow mode when non-shadow transport is provided
    deliveryResult = { status: 'AVAILABLE' };
  } else {
    deliveryResult = await notifications.enqueue({
      outboxId,
      template: templateName,
      evidenceKeys: payloadObj.materialEvidenceFingerprint ? [payloadObj.materialEvidenceFingerprint] : [],
    });
  }

  const nextAttemptCount = currentAttempts + 1;

  if (deliveryResult.status === 'AVAILABLE') {
    // Delivery succeeded -> transition to DELIVERED
    await database.query(
      `UPDATE outbox SET state='DELIVERED', attempt_count=$1, delivered_at=$2 WHERE id=$3`,
      [nextAttemptCount, nowIso, outboxId],
    );

    return {
      outboxId,
      delivered: true,
      state: 'DELIVERED',
      attemptCount: nextAttemptCount,
      deliveredAt: nowIso,
    };
  } else {
    // Delivery failed -> check max retries
    const isExhausted = nextAttemptCount >= maxRetries;
    const nextState: OutboxEntryState = isExhausted ? 'FAILED' : 'RETRY';

    await database.query(
      `UPDATE outbox SET state=$1, attempt_count=$2 WHERE id=$3`,
      [nextState, nextAttemptCount, outboxId],
    );

    return {
      outboxId,
      delivered: false,
      state: nextState,
      attemptCount: nextAttemptCount,
      reason: deliveryResult.reason ?? 'TRANSPORT_NOT_AVAILABLE',
    };
  }
};
