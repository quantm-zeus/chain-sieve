import { z } from 'zod';

/**
 * @requirement FR-DR-001
 * @requirement FR-DR-003
 * @requirement FR-DR-005
 * @requirement FR-DR-006
 * Tiered backup, retention, and recovery continuity contracts.
 */

export const BackupTierSchema = z.enum(['CRITICAL_CONFIG', 'CRITICAL_OBSERVATIONS', 'REPLAYABLE_RAW']);
export type BackupTier = z.infer<typeof BackupTierSchema>;

export const TIER_RPO_MINUTES: Record<BackupTier, number> = {
  CRITICAL_CONFIG: 15,
  CRITICAL_OBSERVATIONS: 60,
  REPLAYABLE_RAW: 1440,
};

export const TIER_RTO_MINUTES: Record<BackupTier, number> = {
  CRITICAL_CONFIG: 30,
  CRITICAL_OBSERVATIONS: 60,
  REPLAYABLE_RAW: 240,
};

export const GeographicLocationSchema = z.enum(['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1']);
export type GeographicLocation = z.infer<typeof GeographicLocationSchema>;

export const EncryptionSpecSchema = z.object({
  algorithm: z.enum(['AES-256-GCM', 'AES-256-CBC']),
  keyId: z.string().min(1),
  keyVersion: z.number().int().positive(),
});
export type EncryptionSpec = z.infer<typeof EncryptionSpecSchema>;

export const RightsConstraintSchema = z.object({
  dataClass: z.string().min(1),
  retentionAllowed: z.boolean(),
  geographicRestriction: GeographicLocationSchema.optional(),
  requiresLegalHold: z.boolean().default(false),
});
export type RightsConstraint = z.infer<typeof RightsConstraintSchema>;

export const RetentionPolicySchema = z.object({
  id: z.string().min(1),
  tier: BackupTierSchema,
  retentionDays: z.number().int().positive(),
  version: z.number().int().positive(),
  geographicLocation: GeographicLocationSchema,
  encryption: EncryptionSpecSchema,
  rightsConstraints: z.array(RightsConstraintSchema).min(1),
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  previousVersionId: z.string().min(1).nullable().optional(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const LegalHoldSchema = z.object({
  id: z.string().min(1),
  backupRecordId: z.string().min(1),
  reason: z.string().min(1),
  createdAt: z.string().datetime(),
  createdBy: z.string().min(1),
  releasedAt: z.string().datetime().nullable().optional(),
  active: z.boolean(),
});
export type LegalHold = z.infer<typeof LegalHoldSchema>;

export const BackupRecordSchema = z.object({
  id: z.string().min(1),
  tier: BackupTierSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  location: z.string().min(1),
  geographicLocation: GeographicLocationSchema,
  encryption: EncryptionSpecSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  retentionPolicyId: z.string().min(1),
  version: z.number().int().positive(),
  rightsConstraints: z.array(RightsConstraintSchema).default([]),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export const RestoreDrillResultSchema = z.object({
  drillId: z.string().min(1),
  tier: BackupTierSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  targetRpoMinutes: z.number().int().positive(),
  targetRtoMinutes: z.number().int().positive(),
  achievedRpoMinutes: z.number().nonnegative(),
  achievedRtoMinutes: z.number().nonnegative(),
  artifactsVerified: z.boolean(),
  auditChainVerified: z.boolean(),
  migrationsReplayed: z.boolean(),
  crossStoreReferencesRestored: z.boolean(),
  collectorCheckpointsReestablished: z.boolean(),
  hiddenGapsDetected: z.number().int().nonnegative(),
  status: z.enum(['PASSED', 'FAILED']),
  meetsRpo: z.boolean(),
  meetsRto: z.boolean(),
});
export type RestoreDrillResult = z.infer<typeof RestoreDrillResultSchema>;

export const ReconciliationCheckpointSchema = z.object({
  recoveryId: z.string().min(1),
  providerCallsReconciled: z.boolean(),
  quotaReservationsReconciled: z.boolean(),
  workflowLeasesReconciled: z.boolean(),
  inboxReconciled: z.boolean(),
  outboxReconciled: z.boolean(),
  alertsReconciled: z.boolean(),
  collectorGapsReconciled: z.boolean(),
  artifactsVerified: z.boolean(),
  auditCheckpointsVerified: z.boolean(),
  fencingTokensValidated: z.boolean(),
  staleTokensRejected: z.number().int().nonnegative(),
  resumedAt: z.string().datetime().nullable().optional(),
  degraded: z.boolean(),
});
export type ReconciliationCheckpoint = z.infer<typeof ReconciliationCheckpointSchema>;

export const DegradedModeSchema = z.object({
  tier: BackupTierSchema,
  reason: z.string().min(1),
  degradedAt: z.string().datetime(),
  restoredAt: z.string().datetime().nullable().optional(),
  confirmedOpportunityAlertsDisabled: z.boolean(),
  capabilityMatrix: z.record(z.string(), z.string()),
});
export type DegradedMode = z.infer<typeof DegradedModeSchema>;

export const BackupAccessRoleSchema = z.enum(['owner', 'operator', 'auditor', 'viewer']);
export type BackupAccessRole = z.infer<typeof BackupAccessRoleSchema>;

export const RestoreAccessRequestSchema = z.object({
  actor: z.string().min(1),
  role: BackupAccessRoleSchema,
  backupRecordId: z.string().min(1),
  reason: z.string().min(1),
  requestedAt: z.string().datetime(),
});
export type RestoreAccessRequest = z.infer<typeof RestoreAccessRequestSchema>;

export const BackupAuditRecordSchema = z.object({
  id: z.string().min(1),
  action: z.enum([
    'RETENTION_CREATED',
    'RETENTION_UPDATED',
    'BACKUP_CREATED',
    'BACKUP_DELETED',
    'LEGAL_HOLD_CREATED',
    'LEGAL_HOLD_RELEASED',
    'RESTORE_REQUESTED',
    'RESTORE_GRANTED',
    'RESTORE_DENIED',
    'DRILL_STARTED',
    'DRILL_COMPLETED',
    'DEGRADED_ENTERED',
    'DEGRADED_EXITED',
    'RECONCILIATION_COMPLETED',
  ]),
  actor: z.string().min(1),
  payloadJson: z.unknown(),
  previousHash: z.string().nullable().optional(),
  recordHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.string().datetime(),
});
export type BackupAuditRecord = z.infer<typeof BackupAuditRecordSchema>;

export const validateTierRpo = (tier: BackupTier, achievedMinutes: number): boolean =>
  achievedMinutes <= TIER_RPO_MINUTES[tier];

export const validateTierRto = (tier: BackupTier, achievedMinutes: number): boolean =>
  achievedMinutes <= TIER_RTO_MINUTES[tier];

export const degradedModeMatrix: Record<BackupTier, { disableConfirmedOpportunity: boolean; capability: string }> = {
  CRITICAL_CONFIG: { disableConfirmedOpportunity: true, capability: 'DEGRADED' },
  CRITICAL_OBSERVATIONS: { disableConfirmedOpportunity: true, capability: 'DEGRADED' },
  REPLAYABLE_RAW: { disableConfirmedOpportunity: false, capability: 'PARTIAL' },
};
