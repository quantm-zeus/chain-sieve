import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@ciag/provider-contracts';

// Re-export walking skeleton for backwards compatibility
import type { DiscoveryUniverseAdapter, NotificationAdapter, ObjectStoreAdapter } from '@ciag/provider-contracts';
import { assertNoBackdating } from '@ciag/domain';
import { freezeEvidence } from '@ciag/evidence';
import { matureSyntheticOutcome } from '@ciag/evaluation';
import type { InMemoryTracer } from '@ciag/observability';

export interface WalkingSkeletonClock { now(): string; advance(milliseconds: number): void }
export interface WalkingSkeletonResult { assetId: string; observationCount: number; artifactKey: string; outboxState: string; outcomeState: string; capabilityMode: 'SYNTHETIC_SHADOW'; duplicateSuppressed: boolean; traceId: string }

const insertStage = async (database: DatabaseAdapter, input: { id: string; assetId: string; stage: string; payload: unknown; eventTime: string; observedAt: string; availableAt: string; idempotencyKey: string; traceId: string }): Promise<boolean> => {
  assertNoBackdating(input.eventTime, input.availableAt);
  const existing = await database.query('SELECT id FROM synthetic_observations WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (existing.rows.length > 0) return false;
  const result = await database.query(
    `INSERT INTO synthetic_observations (id,asset_id,stage,payload_json,event_time,observed_at,available_at,idempotency_key,capability_mode,trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC_SHADOW',$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.id, input.assetId, input.stage, JSON.stringify(input.payload), input.eventTime, input.observedAt, input.availableAt, input.idempotencyKey, input.traceId],
  );
  return result.rows.length === 1;
};

export const runWalkingSkeleton = async (dependencies: { database: DatabaseAdapter; objectStore: ObjectStoreAdapter; discovery: DiscoveryUniverseAdapter; notifications: NotificationAdapter; clock: WalkingSkeletonClock; tracer: InMemoryTracer }): Promise<WalkingSkeletonResult> => {
  const trace = dependencies.tracer.start('walking-skeleton', { capability: 'SYNTHETIC_SHADOW' });
  const eventTime = dependencies.clock.now();
  const discovered = await dependencies.discovery.discover(eventTime);
  if (discovered.status !== 'AVAILABLE' || !discovered.value?.[0]) throw new Error(discovered.reason ?? 'SYNTHETIC_DISCOVERY_UNAVAILABLE');
  const point = discovered.value[0];
  const asset = point.value;
  const stages = [
    ['discovery', { source: point.provenance }],
    ['canonical_asset', asset],
    ['point_in_time_observation', point],
    ['deterministic_feature', { syntheticMomentum: '0.42', units: 'ratio', sampleSize: 4 }],
    ['candidate', { state: 'SHADOW_CANDIDATE' }],
    ['decision', { disposition: 'OBSERVE_ONLY', confidence: 'SYNTHETIC' }],
  ] as const;
  let inserted = 0;
  for (const [index, [stage, payload]] of stages.entries()) {
    if (await insertStage(dependencies.database, { id: `obs-${index + 1}`, assetId: asset.id, stage, payload, eventTime: point.eventTime, observedAt: point.observedAt, availableAt: point.availableAt, idempotencyKey: `${asset.id}:${stage}:${point.availableAt}`, traceId: trace.span.id })) inserted += 1;
  }
  const duplicateSuppressed = !(await insertStage(dependencies.database, { id: 'obs-duplicate', assetId: asset.id, stage: 'discovery', payload: {}, eventTime: point.eventTime, observedAt: point.observedAt, availableAt: point.availableAt, idempotencyKey: `${asset.id}:discovery:${point.availableAt}`, traceId: trace.span.id }));
  const artifactKey = `evidence/${asset.id.replaceAll(':', '-')}/${point.availableAt.replaceAll(':', '-')}.json`;
  const evidence = await freezeEvidence(dependencies.objectStore, artifactKey, { asset, point, stages, decision: 'OBSERVE_ONLY', traceId: trace.span.id }, dependencies.clock.now());
  await dependencies.database.transaction(async (database) => {
    await database.query(`INSERT INTO artifact_metadata (artifact_key,sha256,media_type,bytes,created_at,frozen,trace_id) VALUES ($1,$2,$3,$4,$5,true,$6) ON CONFLICT (artifact_key) DO NOTHING`, [evidence.artifactKey, evidence.sha256, evidence.mediaType, evidence.bytes, dependencies.clock.now(), trace.span.id]);
    await database.query(`INSERT INTO outbox (id,topic,payload_json,state,attempt_count,available_at,trace_id) VALUES ($1,'synthetic.shadow',$2,'PENDING',0,$3,$4) ON CONFLICT (id) DO NOTHING`, ['outbox-1', JSON.stringify({ assetId: asset.id, evidenceKey: evidence.artifactKey }), dependencies.clock.now(), trace.span.id]);
  });
  let delivery = await dependencies.notifications.enqueue({ outboxId: 'outbox-1', template: 'synthetic-shadow', evidenceKeys: [evidence.artifactKey] });
  if (delivery.status !== 'AVAILABLE') {
    await dependencies.database.query(`UPDATE outbox SET state='RETRY',attempt_count=attempt_count+1 WHERE id='outbox-1'`);
    delivery = await dependencies.notifications.enqueue({ outboxId: 'outbox-1', template: 'synthetic-shadow', evidenceKeys: [evidence.artifactKey] });
  }
  if (delivery.status === 'AVAILABLE') await dependencies.database.query(`UPDATE outbox SET state='DELIVERED',attempt_count=attempt_count+1,delivered_at=$1 WHERE id='outbox-1'`, [dependencies.clock.now()]);
  dependencies.clock.advance(86_400_000);
  const outcome = matureSyntheticOutcome(point.observedAt, dependencies.clock.now(), 43_200_000);
  await dependencies.database.query(`INSERT INTO evaluation_records (id,asset_id,outcome_state,signal_success,tradable_success,evaluated_at,evidence_key,trace_id) VALUES ('eval-1',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [asset.id, outcome.state, outcome.signalSuccess ?? null, outcome.tradableSuccess ?? null, dependencies.clock.now(), evidence.artifactKey, trace.span.id]);
  const observations = await dependencies.database.query<{ count: string }>('SELECT count(*)::text AS count FROM synthetic_observations WHERE asset_id=$1', [asset.id]);
  const outbox = await dependencies.database.query<{ state: string }>(`SELECT state FROM outbox WHERE id='outbox-1'`);
  trace.end();
  return { assetId: asset.id, observationCount: Number(observations.rows[0]?.count ?? inserted), artifactKey, outboxState: outbox.rows[0]?.state ?? 'UNKNOWN', outcomeState: outcome.state, capabilityMode: 'SYNTHETIC_SHADOW', duplicateSuppressed, traceId: trace.span.id };
};

export const replayStagesAsOf = async (database: DatabaseAdapter, assetId: string, asOf: string): Promise<{ stage: string; available_at: string | Date }[]> => { const result = await database.query<{ stage: string; available_at: string | Date }>('SELECT stage, available_at FROM synthetic_observations WHERE asset_id=$1 AND available_at <= $2 ORDER BY available_at, stage', [assetId, asOf]); return result.rows; };

// ---------------------------------------------------------------------------
// Durable Workflow Core — FR-WF-001/002/003/007
// ---------------------------------------------------------------------------

export const canonicalizeExternalMessageId = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('EXTERNAL_MESSAGE_ID_REQUIRED');
  if (trimmed.length > 512) throw new Error('EXTERNAL_MESSAGE_ID_TOO_LONG');
  // Canonical form: trimmed, case preserved but whitespace normalized; QStash uses opaque IDs, keep as-is after trim
  return trimmed;
};

export const hashPayload = (payload: unknown): string => createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
export const hashValue = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

// ----- Trigger Inbox -----

export interface InsertTriggerInboxInput {
  id?: string;
  source: string;
  externalMessageId: string;
  scheduleId?: string | null;
  scheduledFor?: string | null;
  payloadHash: string;
  receivedAt: string;
  verifiedAt?: string | null;
}

export interface InsertTriggerInboxResult {
  inboxId: string;
  inserted: boolean;
  isDuplicate: boolean;
  processedRunId: string | null;
  status: string;
}

export const insertTriggerInbox = async (database: DatabaseAdapter, input: InsertTriggerInboxInput): Promise<InsertTriggerInboxResult> => {
  const canonicalId = canonicalizeExternalMessageId(input.externalMessageId);
  // Idempotent check first for pg-mem compatibility — SELECT before INSERT
  const preExisting = await database.query<{ id: string; processed_run_id: string | null; status: string }>(
    `SELECT id, processed_run_id, status FROM trigger_inbox WHERE external_message_id=$1`,
    [canonicalId],
  );
  if (preExisting.rows.length === 1) {
    return { inboxId: preExisting.rows[0]!.id, inserted: false, isDuplicate: true, processedRunId: preExisting.rows[0]!.processed_run_id ?? null, status: preExisting.rows[0]!.status };
  }
  const inboxId = input.id ?? `inbox-${canonicalId.slice(0, 16)}-${createHash('sha256').update(canonicalId).digest('hex').slice(0, 8)}`;
  try {
    const result = await database.query<{ id: string; processed_run_id: string | null; status: string }>(
      `INSERT INTO trigger_inbox (id, source, external_message_id, schedule_id, scheduled_for, payload_hash, received_at, verified_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RECEIVED')
       ON CONFLICT (external_message_id) DO NOTHING
       RETURNING id, processed_run_id, status`,
      [inboxId, input.source, canonicalId, input.scheduleId ?? null, input.scheduledFor ?? null, input.payloadHash, input.receivedAt, input.verifiedAt ?? null],
    );
    if (result.rows.length === 1) {
      return { inboxId: result.rows[0]!.id, inserted: true, isDuplicate: false, processedRunId: result.rows[0]!.processed_run_id ?? null, status: result.rows[0]!.status };
    }
  } catch {
    // Unique violation fallback for engines without proper ON CONFLICT handling
  }
  // Duplicate — fetch existing after race
  const existing = await database.query<{ id: string; processed_run_id: string | null; status: string }>(
    `SELECT id, processed_run_id, status FROM trigger_inbox WHERE external_message_id=$1`,
    [canonicalId],
  );
  if (existing.rows.length === 0) throw new Error('TRIGGER_INBOX_CONSISTENCY_ERROR');
  return { inboxId: existing.rows[0]!.id, inserted: false, isDuplicate: true, processedRunId: existing.rows[0]!.processed_run_id ?? null, status: existing.rows[0]!.status };
};

export const linkTriggerToRun = async (database: DatabaseAdapter, inboxId: string, runId: string): Promise<void> => {
  await database.query(`UPDATE trigger_inbox SET processed_run_id=$1, status='PROCESSED' WHERE id=$2`, [runId, inboxId]);
};

export interface TriggerInboxRecord {
  id: string;
  source: string;
  external_message_id: string;
  schedule_id: string | null;
  payload_hash: string;
  processed_run_id: string | null;
  status: string;
}

// Returns 202 semantics: whether a new workflow should be started
export const shouldStartWorkflowForTrigger = (insertResult: InsertTriggerInboxResult): boolean => insertResult.inserted;

// ----- Workflow Runs & Steps -----

export type WorkflowRunStatus = 'PENDING' | 'RUNNING' | 'WAITING' | 'RETRYING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'DEAD_LETTERED';
export type WorkflowStepStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTERED' | 'SKIPPED';

export interface CreateWorkflowRunInput {
  id: string;
  workflowName: string;
  scheduleId?: string | null;
  triggerInboxId?: string | null;
  now: string;
}

export const createWorkflowRun = async (database: DatabaseAdapter, input: CreateWorkflowRunInput): Promise<{ id: string; status: WorkflowRunStatus }> => {
  const result = await database.query<{ id: string; status: WorkflowRunStatus }>(
    `INSERT INTO workflow_runs (id, workflow_name, schedule_id, trigger_inbox_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$5)
     ON CONFLICT (id) DO NOTHING RETURNING id, status`,
    [input.id, input.workflowName, input.scheduleId ?? null, input.triggerInboxId ?? null, input.now],
  );
  if (result.rows.length === 1) return { id: result.rows[0]!.id, status: result.rows[0]!.status };
  const existing = await database.query<{ id: string; status: WorkflowRunStatus }>(`SELECT id, status FROM workflow_runs WHERE id=$1`, [input.id]);
  return { id: existing.rows[0]!.id, status: existing.rows[0]!.status };
};

export interface CreateWorkflowStepInput {
  stepId: string;
  runId: string;
  stepType: string;
  idempotencyKey: string;
  inputHash: string;
  leaseOwner?: string | null;
  leaseVersion?: number;
  leaseExpiresAt?: string | null;
  now: string;
}

export const createWorkflowStep = async (database: DatabaseAdapter, input: CreateWorkflowStepInput): Promise<{ stepId: string; inserted: boolean }> => {
  const result = await database.query<{ step_id: string }>(
    `INSERT INTO workflow_steps (step_id, run_id, step_type, idempotency_key, attempt, input_hash, status, lease_owner, lease_version, lease_expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,0,$5,'PENDING',$6,$7,$8,$9,$9)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING step_id`,
    [input.stepId, input.runId, input.stepType, input.idempotencyKey, input.inputHash, input.leaseOwner ?? null, input.leaseVersion ?? 0, input.leaseExpiresAt ?? null, input.now],
  );
  if (result.rows.length === 1) return { stepId: result.rows[0]!.step_id, inserted: true };
  const existing = await database.query<{ step_id: string }>(`SELECT step_id FROM workflow_steps WHERE idempotency_key=$1`, [input.idempotencyKey]);
  return { stepId: existing.rows[0]!.step_id, inserted: false };
};

export interface StepRecord extends Record<string, unknown> {
  step_id: string;
  run_id: string;
  step_type: string;
  idempotency_key: string;
  attempt: number;
  input_hash: string;
  output_hash: string | null;
  status: WorkflowStepStatus;
  lease_owner: string | null;
  lease_version: number;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_class: string | null;
  retryable: boolean;
  next_retry_at: string | null;
}

export const getWorkflowSteps = async (database: DatabaseAdapter, runId: string): Promise<StepRecord[]> => {
  const result = await database.query<StepRecord>(`SELECT step_id, run_id, step_type, idempotency_key, attempt, input_hash, output_hash, status, lease_owner, lease_version, lease_expires_at, started_at, completed_at, error_class, retryable, next_retry_at FROM workflow_steps WHERE run_id=$1 ORDER BY created_at`, [runId]);
  return result.rows;
};

export const getLastCompletedStep = async (database: DatabaseAdapter, runId: string): Promise<StepRecord | null> => {
  const result = await database.query<StepRecord>(
    `SELECT step_id, run_id, step_type, idempotency_key, attempt, input_hash, output_hash, status, lease_owner, lease_version, lease_expires_at, started_at, completed_at, error_class, retryable, next_retry_at FROM workflow_steps WHERE run_id=$1 AND status='COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
    [runId],
  );
  return result.rows[0] ?? null;
};

export const getNextPendingStep = async (database: DatabaseAdapter, runId: string): Promise<StepRecord | null> => {
  const result = await database.query<StepRecord>(
    `SELECT step_id, run_id, step_type, idempotency_key, attempt, input_hash, output_hash, status, lease_owner, lease_version, lease_expires_at, started_at, completed_at, error_class, retryable, next_retry_at FROM workflow_steps WHERE run_id=$1 AND status IN ('PENDING','FAILED') ORDER BY created_at LIMIT 1`,
    [runId],
  );
  return result.rows[0] ?? null;
};

// Resume: returns steps to skip (already completed) and next step to execute
export const resumeFromCheckpoint = async (database: DatabaseAdapter, runId: string): Promise<{ completed: StepRecord[]; next: StepRecord | null }> => {
  const all = await getWorkflowSteps(database, runId);
  const completed = all.filter((s) => s.status === 'COMPLETED');
  const next = all.find((s) => s.status === 'PENDING' || s.status === 'FAILED') ?? null;
  return { completed, next };
};

// ----- Lease Fencing -----

export interface LeaseAcquireResult {
  leaseKey: string;
  owner: string;
  version: number;
  expiresAt: string;
  acquired: boolean;
}

export const acquireLease = async (database: DatabaseAdapter, leaseKey: string, owner: string, ttlMs: number, now: string): Promise<LeaseAcquireResult> => {
  const nowMs = Date.parse(now);
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const toMs = (value: unknown): number => new Date(value as string | Date).getTime();
  // Try insert
  const inserted = await database.query<{ lease_key: string; version: number; expires_at: string | Date }>(
    `INSERT INTO workflow_leases (lease_key, owner, version, acquired_at, expires_at) VALUES ($1,$2,1,$3,$4) ON CONFLICT (lease_key) DO NOTHING RETURNING lease_key, version, expires_at`,
    [leaseKey, owner, now, expiresAt],
  );
  if (inserted.rows.length === 1) return { leaseKey, owner, version: 1, expiresAt: String(inserted.rows[0]!.expires_at), acquired: true };
  // Existing lease — check expiry
  const existing = await database.query<{ owner: string; version: number; expires_at: string | Date }>(`SELECT owner, version, expires_at FROM workflow_leases WHERE lease_key=$1`, [leaseKey]);
  const row = existing.rows[0]!;
  const expired = toMs(row.expires_at) <= nowMs;
  if (!expired && row.owner !== owner) {
    return { leaseKey, owner: row.owner, version: Number(row.version), expiresAt: String(row.expires_at), acquired: false };
  }
  // Takeover or renew — monotonically increase version
  const nextVersion = Number(row.version) + 1;
  const updated = await database.query<{ version: number; expires_at: string | Date }>(
    `UPDATE workflow_leases SET owner=$1, version=$2, acquired_at=$3, expires_at=$4 WHERE lease_key=$5 AND version=$6 RETURNING version, expires_at`,
    [owner, nextVersion, now, expiresAt, leaseKey, row.version],
  );
  if (updated.rows.length === 0) {
    // Concurrent takeover — re-read
    const reread = await database.query<{ owner: string; version: number; expires_at: string | Date }>(`SELECT owner, version, expires_at FROM workflow_leases WHERE lease_key=$1`, [leaseKey]);
    return { leaseKey, owner: String(reread.rows[0]!.owner), version: Number(reread.rows[0]!.version), expiresAt: String(reread.rows[0]!.expires_at), acquired: String(reread.rows[0]!.owner) === owner };
  }
  return { leaseKey, owner, version: Number(updated.rows[0]!.version), expiresAt: String(updated.rows[0]!.expires_at), acquired: true };
};

export const renewLease = async (database: DatabaseAdapter, leaseKey: string, owner: string, expectedVersion: number, ttlMs: number, now: string): Promise<LeaseAcquireResult | null> => {
  const nowMs = Date.parse(now);
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const updated = await database.query<{ version: number; expires_at: string }>(
    `UPDATE workflow_leases SET version=version+1, expires_at=$1, acquired_at=$2 WHERE lease_key=$3 AND owner=$4 AND version=$5 RETURNING version, expires_at`,
    [expiresAt, now, leaseKey, owner, expectedVersion],
  );
  if (updated.rows.length === 0) return null;
  return { leaseKey, owner, version: updated.rows[0]!.version, expiresAt: updated.rows[0]!.expires_at, acquired: true };
};

// Fencing-aware commit: only succeeds if lease version matches
export const commitStepWithFencing = async (
  database: DatabaseAdapter,
  stepId: string,
  expectedOwner: string,
  expectedVersion: number,
  outputHash: string,
  now: string,
): Promise<{ committed: boolean; stale: boolean }> => {
  const result = await database.query<{ step_id: string }>(
    `UPDATE workflow_steps SET output_hash=$1, status='COMPLETED', completed_at=$2, updated_at=$2 WHERE step_id=$3 AND lease_owner=$4 AND lease_version=$5 RETURNING step_id`,
    [outputHash, now, stepId, expectedOwner, expectedVersion],
  );
  if (result.rows.length === 1) return { committed: true, stale: false };
  const current = await database.query<{ lease_owner: string | null; lease_version: number }>(`SELECT lease_owner, lease_version FROM workflow_steps WHERE step_id=$1`, [stepId]);
  if (current.rows.length === 0) return { committed: false, stale: false };
  const stale = current.rows[0]!.lease_owner !== expectedOwner || Number(current.rows[0]!.lease_version) !== expectedVersion;
  return { committed: false, stale };
};

export const claimStepForExecution = async (
  database: DatabaseAdapter,
  stepId: string,
  owner: string,
  version: number,
  expiresAt: string,
  now: string,
): Promise<boolean> => {
  const result = await database.query<{ step_id: string }>(
    `UPDATE workflow_steps SET lease_owner=$1, lease_version=$2, lease_expires_at=$3, status='RUNNING', started_at=$4, updated_at=$4 WHERE step_id=$5 AND status IN ('PENDING','FAILED') RETURNING step_id`,
    [owner, version, expiresAt, now, stepId],
  );
  return result.rows.length === 1;
};

// ----- Retry Taxonomy -----

export type ErrorClass =
  | 'AUTH_ERROR'
  | 'INVALID_INPUT'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'HTTP_5XX'
  | 'SCHEMA_DRIFT'
  | 'MODEL_FORMAT_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'SERIALIZATION_CONFLICT'
  | 'NOTIFICATION_TRANSIENT'
  | string;

export interface RetryDecision {
  retryable: boolean;
  maxAttempts: number;
  backoffMs: number | null; // null = no retry
  applyJitter: boolean;
}

export const classifyRetry = (errorClass: ErrorClass, attempt: number): RetryDecision => {
  switch (errorClass) {
    case 'AUTH_ERROR':
    case 'INVALID_INPUT':
    case 'BUDGET_EXCEEDED':
      return { retryable: false, maxAttempts: 1, backoffMs: null, applyJitter: false };
    case 'SCHEMA_DRIFT':
      return { retryable: false, maxAttempts: 1, backoffMs: null, applyJitter: false };
    case 'MODEL_FORMAT_ERROR':
      return { retryable: attempt < 1, maxAttempts: 2, backoffMs: attempt === 0 ? 500 : null, applyJitter: false };
    case 'RATE_LIMIT':
      return { retryable: true, maxAttempts: 5, backoffMs: computeExponentialBackoff(attempt, 1000, 30000), applyJitter: true };
    case 'TIMEOUT':
    case 'HTTP_5XX':
      return { retryable: true, maxAttempts: 5, backoffMs: computeExponentialBackoff(attempt, 500, 30000), applyJitter: true };
    case 'SERIALIZATION_CONFLICT':
      return { retryable: true, maxAttempts: 10, backoffMs: 50, applyJitter: true };
    case 'NOTIFICATION_TRANSIENT':
      return { retryable: true, maxAttempts: 8, backoffMs: computeExponentialBackoff(attempt, 1000, 60000), applyJitter: true };
    default:
      // Unknown -> treat as retryable bounded
      return { retryable: true, maxAttempts: 3, backoffMs: computeExponentialBackoff(attempt, 1000, 10000), applyJitter: true };
  }
};

export const computeExponentialBackoff = (attempt: number, baseMs: number, capMs: number): number => {
  const exp = baseMs * Math.pow(2, attempt);
  return Math.min(exp, capMs);
};

export const computeJitteredBackoff = (backoffMs: number, jitterFactor = 0.2, randomValue = Math.random()): number => {
  const jitter = (randomValue * 2 - 1) * jitterFactor * backoffMs;
  return Math.max(0, Math.round(backoffMs + jitter));
};

export const hasExhaustedRetries = (errorClass: ErrorClass, attempt: number): boolean => {
  const decision = classifyRetry(errorClass, attempt);
  if (!decision.retryable) return true;
  return attempt + 1 >= decision.maxAttempts;
};

// Apply failure to step, handling retry vs dead-letter
export const recordStepFailure = async (
  database: DatabaseAdapter,
  stepId: string,
  errorClass: ErrorClass,
  errorMessage: string,
  now: string,
): Promise<{ status: WorkflowStepStatus; deadLettered: boolean; nextRetryAt: string | null }> => {
  const step = await database.query<{ attempt: number; run_id: string }>(`SELECT attempt, run_id FROM workflow_steps WHERE step_id=$1`, [stepId]);
  if (step.rows.length === 0) throw new Error('STEP_NOT_FOUND');
  const currentAttempt = Number(step.rows[0]!.attempt);
  const runId = step.rows[0]!.run_id;
  const decision = classifyRetry(errorClass, currentAttempt);

  if (!decision.retryable || currentAttempt + 1 >= decision.maxAttempts) {
    // Exhausted -> DEAD_LETTERED
    await database.query(
      `UPDATE workflow_steps SET status='DEAD_LETTERED', error_class=$1, retryable=$2, completed_at=$3, updated_at=$3, attempt=attempt+1 WHERE step_id=$4`,
      [errorClass, false, now, stepId],
    );
    await database.query(
      `INSERT INTO step_attempts (id, step_id, attempt, started_at, error_class, error_message, retryable) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`attempt-${stepId}-${currentAttempt}`, stepId, currentAttempt, now, errorClass, errorMessage, false],
    );
    await createDeadLetterItem(database, { id: `dl-${stepId}-${Date.now()}`, runId, stepId, errorClass, retryable: false, attempt: currentAttempt + 1, errorMessage, now });
    await database.query(`UPDATE workflow_runs SET status='DEAD_LETTERED', error_class=$1, retryable=$2, updated_at=$3 WHERE id=$4`, [errorClass, false, now, runId]);
    return { status: 'DEAD_LETTERED', deadLettered: true, nextRetryAt: null };
  }

  const backoff = decision.backoffMs ?? 1000;
  const jittered = decision.applyJitter ? computeJitteredBackoff(backoff) : backoff;
  const nextRetryAt = new Date(Date.parse(now) + jittered).toISOString();
  await database.query(
    `UPDATE workflow_steps SET status='FAILED', error_class=$1, retryable=$2, next_retry_at=$3, updated_at=$4, attempt=attempt+1 WHERE step_id=$5`,
    [errorClass, true, nextRetryAt, now, stepId],
  );
  await database.query(
    `INSERT INTO step_attempts (id, step_id, attempt, started_at, error_class, error_message, retryable) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`attempt-${stepId}-${currentAttempt}`, stepId, currentAttempt, now, errorClass, errorMessage, true],
  );
  return { status: 'FAILED', deadLettered: false, nextRetryAt };
};

export const recordStepSuccess = async (database: DatabaseAdapter, stepId: string, outputHash: string, now: string): Promise<void> => {
  await database.query(
    `UPDATE workflow_steps SET output_hash=$1, status='COMPLETED', completed_at=$2, updated_at=$2, error_class=NULL, retryable=false WHERE step_id=$3`,
    [outputHash, now, stepId],
  );
  await database.query(
    `INSERT INTO step_attempts (id, step_id, attempt, started_at, completed_at, retryable, output_hash) VALUES ($1,$2,$3,$4,$4,false,$5) ON CONFLICT (id) DO NOTHING`,
    [`attempt-${stepId}-success-${Date.now()}`, stepId, 0, now, outputHash],
  );
};

// ----- Dead Letter -----

export interface DeadLetterItem extends Record<string, unknown> {
  id: string;
  run_id: string;
  step_id: string | null;
  error_class: string;
  retryable: boolean;
  attempt: number;
  status: string;
  created_at: string;
}

export const createDeadLetterItem = async (
  database: DatabaseAdapter,
  input: { id: string; runId: string; stepId?: string | null; errorClass: string; retryable: boolean; attempt: number; errorMessage?: string; now: string; payload?: unknown },
): Promise<void> => {
  await database.query(
    `INSERT INTO dead_letter_items (id, run_id, step_id, error_class, retryable, attempt, payload_json, error_message, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9) ON CONFLICT (id) DO NOTHING`,
    [input.id, input.runId, input.stepId ?? null, input.errorClass, input.retryable, input.attempt, input.payload ? JSON.stringify(input.payload) : null, input.errorMessage ?? null, input.now],
  );
};

export const listDeadLetters = async (database: DatabaseAdapter, runId?: string): Promise<DeadLetterItem[]> => {
  const result = runId
    ? await database.query<DeadLetterItem>(`SELECT id, run_id, step_id, error_class, retryable, attempt, status, created_at FROM dead_letter_items WHERE run_id=$1 ORDER BY created_at`, [runId])
    : await database.query<DeadLetterItem>(`SELECT id, run_id, step_id, error_class, retryable, attempt, status, created_at FROM dead_letter_items ORDER BY created_at`);
  return result.rows;
};

export const retryDeadLetterFromCheckpoint = async (database: DatabaseAdapter, deadLetterId: string, now: string): Promise<{ retried: boolean; stepId: string | null }> => {
  const dl = await database.query<{ run_id: string; step_id: string | null; status: string }>(`SELECT run_id, step_id, status FROM dead_letter_items WHERE id=$1`, [deadLetterId]);
  if (dl.rows.length === 0) throw new Error('DEAD_LETTER_NOT_FOUND');
  const { run_id: runId, step_id: stepId, status } = dl.rows[0]!;
  if (status !== 'OPEN') return { retried: false, stepId };
  // Reset step to PENDING if exists, else reset run
  if (stepId) {
    await database.query(`UPDATE workflow_steps SET status='PENDING', error_class=NULL, retryable=false, next_retry_at=NULL, updated_at=$1 WHERE step_id=$2`, [now, stepId]);
  }
  await database.query(`UPDATE workflow_runs SET status='RETRYING', updated_at=$1 WHERE id=$2`, [now, runId]);
  await database.query(`UPDATE dead_letter_items SET status='RETRYING', last_retry_at=$1 WHERE id=$2`, [now, deadLetterId]);
  return { retried: true, stepId };
};

export const resolveDeadLetter = async (database: DatabaseAdapter, deadLetterId: string, now: string): Promise<void> => {
  await database.query(`UPDATE dead_letter_items SET status='RESOLVED', resolved_at=$1 WHERE id=$2`, [now, deadLetterId]);
};

// ----- High-level Workflow Execution Helpers -----

export interface WorkflowStepDefinition {
  stepType: string;
  idempotencyKey: string;
  input: unknown;
}

export const ensureWorkflowSteps = async (database: DatabaseAdapter, runId: string, definitions: WorkflowStepDefinition[], now: string): Promise<void> => {
  for (const [index, def] of definitions.entries()) {
    const inputHash = hashValue(def.input);
    await createWorkflowStep(database, {
      stepId: `${runId}--step-${String(index + 1).padStart(3, '0')}`,
      runId,
      stepType: def.stepType,
      idempotencyKey: def.idempotencyKey,
      inputHash,
      now,
    });
  }
};

export const completeWorkflowRun = async (database: DatabaseAdapter, runId: string, now: string): Promise<void> => {
  const steps = await getWorkflowSteps(database, runId);
  const allCompleted = steps.length > 0 && steps.every((s) => s.status === 'COMPLETED');
  const anyDead = steps.some((s) => s.status === 'DEAD_LETTERED');
  const status: WorkflowRunStatus = anyDead ? 'DEAD_LETTERED' : allCompleted ? 'COMPLETED' : 'FAILED';
  await database.query(`UPDATE workflow_runs SET status=$1, completed_at=$2, updated_at=$2 WHERE id=$3`, [status, now, runId]);
};

// Re-export for api handler convenience
export const handleTriggerInboxRequest = async (
  database: DatabaseAdapter,
  input: { source: string; externalMessageId: string; scheduleId?: string | null; scheduledFor?: string | null; payload: unknown; receivedAt: string; verifiedAt?: string | null },
): Promise<{ status: 202; inboxId: string; runId: string | null; isDuplicate: boolean }> => {
  const payloadHash = hashPayload(input.payload);
  const result = await insertTriggerInbox(database, {
    source: input.source,
    externalMessageId: input.externalMessageId,
    scheduleId: input.scheduleId ?? null,
    scheduledFor: input.scheduledFor ?? null,
    payloadHash,
    receivedAt: input.receivedAt,
    verifiedAt: input.verifiedAt ?? null,
  });
  if (result.isDuplicate) {
    return { status: 202, inboxId: result.inboxId, runId: result.processedRunId, isDuplicate: true };
  }
  // Create workflow run for this trigger if not duplicate
  const runId = `run-${createHash('sha256').update(result.inboxId).digest('hex').slice(0, 16)}`;
  await createWorkflowRun(database, { id: runId, workflowName: 'discovery', scheduleId: input.scheduleId ?? null, triggerInboxId: result.inboxId, now: input.receivedAt });
  await linkTriggerToRun(database, result.inboxId, runId);
  return { status: 202, inboxId: result.inboxId, runId, isDuplicate: false };
};
