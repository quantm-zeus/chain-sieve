import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const schemaMigrations = pgTable('schema_migrations', { version: text().primaryKey(), appliedAt: timestamp('applied_at', { withTimezone: true }).notNull() });
export const specificationMetadata = pgTable('specification_metadata', { id: text().primaryKey(), version: text().notNull(), prdSha256: text('prd_sha256').notNull(), manifestSha256: text('manifest_sha256').notNull(), auditSha256: text('audit_sha256').notNull(), recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull() });
export const harnessState = pgTable('harness_state', { key: text().primaryKey(), valueJson: jsonb('value_json').notNull(), version: bigint({ mode: 'number' }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull() });
export const taskState = pgTable('task_state', { taskId: text('task_id').primaryKey(), state: text().notNull(), leaseVersion: bigint('lease_version', { mode: 'number' }).notNull(), leaseHolder: text('lease_holder'), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), commitSha: text('commit_sha'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull() });
export const clusterState = pgTable('cluster_state', { clusterId: text('cluster_id').primaryKey(), state: text().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull() });
export const syntheticObservations = pgTable('synthetic_observations', { id: text().primaryKey(), assetId: text('asset_id').notNull(), stage: text().notNull(), payloadJson: jsonb('payload_json').notNull(), eventTime: timestamp('event_time', { withTimezone: true }).notNull(), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(), availableAt: timestamp('available_at', { withTimezone: true }).notNull(), idempotencyKey: text('idempotency_key').notNull(), capabilityMode: text('capability_mode').notNull(), traceId: text('trace_id').notNull() }, (table) => [uniqueIndex('synthetic_observations_idempotency_idx').on(table.idempotencyKey), index('synthetic_observations_asset_available_idx').on(table.assetId, table.availableAt)]);
export const artifactMetadata = pgTable('artifact_metadata', { artifactKey: text('artifact_key').primaryKey(), sha256: text().notNull(), mediaType: text('media_type').notNull(), bytes: bigint({ mode: 'number' }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), frozen: boolean().notNull(), traceId: text('trace_id').notNull() });
export const outbox = pgTable('outbox', { id: text().primaryKey(), topic: text().notNull(), payloadJson: jsonb('payload_json').notNull(), state: text().notNull(), attemptCount: integer('attempt_count').notNull(), availableAt: timestamp('available_at', { withTimezone: true }).notNull(), deliveredAt: timestamp('delivered_at', { withTimezone: true }), traceId: text('trace_id').notNull() });
export const evaluationRecords = pgTable('evaluation_records', { id: text().primaryKey(), assetId: text('asset_id').notNull(), outcomeState: text('outcome_state').notNull(), signalSuccess: boolean('signal_success'), tradableSuccess: boolean('tradable_success'), evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(), evidenceKey: text('evidence_key').notNull(), traceId: text('trace_id').notNull() });
export const auditRecords = pgTable('audit_records', { id: text().primaryKey(), eventType: text('event_type').notNull(), actor: text().notNull(), payloadJson: jsonb('payload_json').notNull(), previousHash: text('previous_hash'), recordHash: text('record_hash').notNull(), recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull() });
export const triggerInbox = pgTable('trigger_inbox', { id: text().primaryKey(), source: text().notNull(), externalMessageId: text('external_message_id').notNull(), scheduleId: text('schedule_id'), scheduledFor: timestamp('scheduled_for', { withTimezone: true }), payloadHash: text('payload_hash').notNull(), receivedAt: timestamp('received_at', { withTimezone: true }).notNull(), verifiedAt: timestamp('verified_at', { withTimezone: true }), processedRunId: text('processed_run_id'), status: text().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull() }, (table) => [uniqueIndex('trigger_inbox_external_message_id_idx').on(table.externalMessageId), index('trigger_inbox_schedule_idx').on(table.scheduleId, table.scheduledFor)]);
export const workflowRuns = pgTable('workflow_runs', { id: text().primaryKey(), workflowName: text('workflow_name').notNull(), scheduleId: text('schedule_id'), triggerInboxId: text('trigger_inbox_id'), status: text().notNull(), leaseOwner: text('lease_owner'), leaseVersion: bigint('lease_version', { mode: 'number' }).notNull(), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(), completedAt: timestamp('completed_at', { withTimezone: true }), errorClass: text('error_class'), retryable: boolean() });
export const workflowSteps = pgTable('workflow_steps', { stepId: text('step_id').primaryKey(), runId: text('run_id').notNull(), stepType: text('step_type').notNull(), idempotencyKey: text('idempotency_key').notNull(), attempt: integer().notNull(), inputHash: text('input_hash').notNull(), outputHash: text('output_hash'), status: text().notNull(), leaseOwner: text('lease_owner'), leaseVersion: bigint('lease_version', { mode: 'number' }).notNull(), leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }), startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }), errorClass: text('error_class'), retryable: boolean().notNull(), nextRetryAt: timestamp('next_retry_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull() }, (table) => [uniqueIndex('workflow_steps_idempotency_idx').on(table.idempotencyKey), index('workflow_steps_run_idx').on(table.runId, table.stepType)]);
export const stepAttempts = pgTable('step_attempts', { id: text().primaryKey(), stepId: text('step_id').notNull(), attempt: integer().notNull(), startedAt: timestamp('started_at', { withTimezone: true }).notNull(), completedAt: timestamp('completed_at', { withTimezone: true }), errorClass: text('error_class'), errorMessage: text('error_message'), retryable: boolean(), outputHash: text('output_hash') });
export const workflowLeases = pgTable('workflow_leases', { leaseKey: text('lease_key').primaryKey(), owner: text().notNull(), version: bigint({ mode: 'number' }).notNull(), acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), runId: text('run_id') });
export const deadLetterItems = pgTable('dead_letter_items', { id: text().primaryKey(), runId: text('run_id').notNull(), stepId: text('step_id'), errorClass: text('error_class').notNull(), retryable: boolean().notNull(), attempt: integer().notNull(), payloadJson: jsonb('payload_json'), errorMessage: text('error_message'), status: text().notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), resolvedAt: timestamp('resolved_at', { withTimezone: true }), lastRetryAt: timestamp('last_retry_at', { withTimezone: true }) });
export const alerts = pgTable('alerts', { alertId: text('alert_id').primaryKey(), assetId: text('asset_id').notNull(), alertClass: text('alert_class').notNull(), actionabilityState: text('actionability_state').notNull(), fingerprint: text('fingerprint').notNull(), validUntil: timestamp('valid_until', { withTimezone: true }).notNull(), payloadJson: jsonb('payload_json').notNull(), canonicalJson: text('canonical_json').notNull(), sha256: text('sha256').notNull(), bytes: integer('bytes').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull(), shadowMode: boolean('shadow_mode').notNull().default(false), traceId: text('trace_id').notNull() }, (table) => [index('alerts_asset_class_idx').on(table.assetId, table.alertClass), index('alerts_fingerprint_idx').on(table.fingerprint)]);
export const schedules = pgTable('schedules', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  state: text().notNull(),
  currentVersionId: text('current_version_id'),
  currentVersionNumber: integer('current_version_number'),
  externalScheduleId: text('external_schedule_id'),
  paused: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const scheduleVersions = pgTable(
  'schedule_versions',
  {
    id: text().primaryKey(),
    scheduleId: text('schedule_id').notNull(),
    version: integer().notNull(),
    cron: text().notNull(),
    timezone: text().notNull(),
    workflowVersion: text('workflow_version').notNull(),
    agentProfileVersion: text('agent_profile_version').notNull(),
    toolProfileVersion: text('tool_profile_version').notNull(),
    modelProfileVersion: text('model_profile_version'),
    promptVersion: text('prompt_version'),
    outcomeProfileId: text('outcome_profile_id'),
    rankingPolicyId: text('ranking_policy_id'),
    alertPolicyId: text('alert_policy_id'),
    budgets: jsonb().notNull(),
    concurrency: integer().notNull(),
    destination: text().notNull(),
    externalId: text('external_id'),
    targetScope: jsonb('target_scope').notNull(),
    lifecycle: text().notNull(),
    configHash: text('config_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').notNull(),
  },
  (table) => [uniqueIndex('schedule_versions_schedule_version_idx').on(table.scheduleId, table.version), index('schedule_versions_schedule_idx').on(table.scheduleId)],
);
export const scheduleIncidents = pgTable('schedule_incidents', {
  id: text().primaryKey(),
  type: text().notNull(),
  scheduleId: text('schedule_id'),
  externalScheduleId: text('external_schedule_id'),
  detail: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const resolvedRunConfigs = pgTable('resolved_run_configs', {
  id: text().primaryKey(),
  scheduleId: text('schedule_id').notNull(),
  scheduleVersionId: text('schedule_version_id').notNull(),
  runId: text('run_id').notNull(),
  resolvedJson: jsonb('resolved_json').notNull(),
  configHash: text('config_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// --- Recovery Continuity — FR-DR-003/004/005/006 ---
export const backupRetentionPolicies = pgTable('backup_retention_policies', {
  id: text().primaryKey(),
  tier: text().notNull(),
  retentionDays: integer('retention_days').notNull(),
  version: integer().notNull(),
  geographicLocation: text('geographic_location').notNull(),
  encryptionJson: jsonb('encryption_json').notNull(),
  rightsConstraintsJson: jsonb('rights_constraints_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull(),
  previousVersionId: text('previous_version_id'),
});

export const backupRecords = pgTable('backup_records', {
  id: text().primaryKey(),
  tier: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  location: text().notNull(),
  geographicLocation: text('geographic_location').notNull(),
  encryptionJson: jsonb('encryption_json').notNull(),
  hash: text().notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  retentionPolicyId: text('retention_policy_id').notNull(),
  version: integer().notNull(),
  rightsConstraintsJson: jsonb('rights_constraints_json').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const backupLegalHolds = pgTable('backup_legal_holds', {
  id: text().primaryKey(),
  backupRecordId: text('backup_record_id').notNull(),
  reason: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  active: boolean().notNull(),
});

export const restoreDrills = pgTable('restore_drills', {
  id: text().primaryKey(),
  tier: text().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  targetRpoMinutes: integer('target_rpo_minutes').notNull(),
  targetRtoMinutes: integer('target_rto_minutes').notNull(),
  achievedRpoMinutes: integer('achieved_rpo_minutes'),
  achievedRtoMinutes: integer('achieved_rto_minutes'),
  artifactsVerified: boolean('artifacts_verified').notNull(),
  auditChainVerified: boolean('audit_chain_verified').notNull(),
  migrationsReplayed: boolean('migrations_replayed').notNull(),
  crossStoreReferencesRestored: boolean('cross_store_references_restored').notNull(),
  collectorCheckpointsReestablished: boolean('collector_checkpoints_reestablished').notNull(),
  hiddenGapsDetected: integer('hidden_gaps_detected').notNull(),
  status: text().notNull(),
  evidenceJson: jsonb('evidence_json'),
});

export const recoveryReconciliationState = pgTable('recovery_reconciliation_state', {
  id: text().primaryKey(),
  recoveryId: text('recovery_id').notNull(),
  providerCallsReconciled: boolean('provider_calls_reconciled').notNull(),
  quotaReservationsReconciled: boolean('quota_reservations_reconciled').notNull(),
  workflowLeasesReconciled: boolean('workflow_leases_reconciled').notNull(),
  inboxReconciled: boolean('inbox_reconciled').notNull(),
  outboxReconciled: boolean('outbox_reconciled').notNull(),
  alertsReconciled: boolean('alerts_reconciled').notNull(),
  collectorGapsReconciled: boolean('collector_gaps_reconciled').notNull(),
  artifactsVerified: boolean('artifacts_verified').notNull(),
  auditCheckpointsVerified: boolean('audit_checkpoints_verified').notNull(),
  fencingTokensValidated: boolean('fencing_tokens_validated').notNull(),
  staleTokensRejected: integer('stale_tokens_rejected').notNull(),
  resumedAt: timestamp('resumed_at', { withTimezone: true }),
  degraded: boolean().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const degradedModeState = pgTable('degraded_mode_state', {
  id: text().primaryKey(),
  tier: text().notNull(),
  reason: text().notNull(),
  degradedAt: timestamp('degraded_at', { withTimezone: true }).notNull(),
  restoredAt: timestamp('restored_at', { withTimezone: true }),
  confirmedOpportunityAlertsDisabled: boolean('confirmed_opportunity_alerts_disabled').notNull(),
  capabilityMatrixJson: jsonb('capability_matrix_json').notNull(),
  active: boolean().notNull(),
});

export const backupAuditLog = pgTable('backup_audit_log', {
  id: text().primaryKey(),
  action: text().notNull(),
  actor: text().notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  previousHash: text('previous_hash'),
  recordHash: text('record_hash').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
});

export const collectorCheckpoints = pgTable('collector_checkpoints', {
  partition: text().primaryKey(),
  slot: bigint({ mode: 'number' }).notNull(),
  sequence: bigint({ mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
