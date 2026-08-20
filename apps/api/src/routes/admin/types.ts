import { z } from 'zod';

export const KillSwitchNameSchema = z.enum([
  'DISABLE_ALL_AUTOMATION',
  'DISABLE_ALL_MODEL_CALLS',
  'DISABLE_ALL_PROVIDER_CALLS',
  'DISABLE_NOTIFICATIONS',
  'REVOKE_ALL_MCP_CLIENTS',
  'EMERGENCY_READ_ONLY_MODE',
]);
export type KillSwitchName = z.infer<typeof KillSwitchNameSchema>;

export const KillSwitchStateSchema = z.object({
  name: KillSwitchNameSchema,
  enabled: z.boolean(),
  enabledAt: z.string().datetime().nullable().optional(),
  enabledBy: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  requiresReauth: z.literal(true),
  auditLogged: z.boolean(),
});
export type KillSwitchState = z.infer<typeof KillSwitchStateSchema>;

export const IncidentSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentStatusSchema = z.enum([
  'OPEN',
  'ACKNOWLEDGED',
  'CONTAINED',
  'REVALIDATING',
  'RESOLVED',
  'DISMISSED',
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentTypeSchema = z.enum([
  'PROVIDER_OUTAGE',
  'PROVIDER_DEPRECATION',
  'PROVIDER_PLAN_OR_RIGHTS_DRIFT',
  'SCHEMA_DRIFT',
  'SOURCE_DEPENDENCE_CHANGE',
  'COLLECTOR_OUTAGE',
  'COLLECTOR_GAP',
  'COLLECTOR_REORG_ERROR',
  'POOL_ADAPTER_PARITY_FAILURE',
  'SCHEDULE_DRIFT',
  'WORKFLOW_FAILURE',
  'DATABASE_DEGRADED',
  'OBJECT_STORE_FAILURE',
  'MODEL_FAILURE',
  'QUOTA_EXHAUSTION',
  'CAPACITY_CONTRACT_BREACH',
  'NOTIFICATION_FAILURE',
  'SECURITY_EVENT',
  'MCP_ORIGIN_OR_AUTH_EVENT',
  'EVALUATION_LEAKAGE',
  'HOLDOUT_EXHAUSTION',
  'PUBLIC_CLAIM_OR_RIGHTS_EVENT',
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const AutomatedContainmentSchema = z.object({
  action: z.string().min(1),
  appliedAt: z.string().datetime(),
  success: z.boolean(),
  detail: z.string().optional(),
});
export type AutomatedContainment = z.infer<typeof AutomatedContainmentSchema>;

export const IncidentSchema = z.object({
  id: z.string().min(1),
  type: IncidentTypeSchema,
  severity: IncidentSeveritySchema,
  owner: z.string().min(1),
  status: IncidentStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  affectedScopes: z.array(z.string().min(1)),
  automatedContainment: AutomatedContainmentSchema.nullable().optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  revalidationRequirements: z.array(z.string().min(1)).default([]),
  rootCause: z.string().nullable().optional(),
  correctiveAction: z.string().nullable().optional(),
  resolutionNotes: z.string().nullable().optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const SystemModeSchema = z.enum(['SYNTHETIC_SHADOW', 'ACTIVE', 'DEGRADED', 'READ_ONLY', 'MAINTENANCE']);
export type SystemMode = z.infer<typeof SystemModeSchema>;

export const QuotaForecastSchema = z.object({
  provider: z.string().min(1),
  costClass: z.string().min(1),
  remainingQuota: z.number().nonnegative(),
  forecastDaysRemaining: z.number().nullable().optional(),
  exhaustionAt: z.string().datetime().nullable().optional(),
  status: z.enum(['HEALTHY', 'WARNING', 'EXHAUSTED', 'UNVERIFIED']),
});
export type QuotaForecast = z.infer<typeof QuotaForecastSchema>;

export const ScheduleDriftSchema = z.object({
  scheduleId: z.string().min(1),
  expectedCron: z.string().min(1),
  actualCron: z.string().nullable().optional(),
  driftDetected: z.boolean(),
  driftType: z.string().nullable().optional(),
  detectedAt: z.string().datetime().nullable().optional(),
});
export type ScheduleDrift = z.infer<typeof ScheduleDriftSchema>;

export const WorkflowStatesSchema = z.object({
  running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type WorkflowStates = z.infer<typeof WorkflowStatesSchema>;

export const CandidateCountsSchema = z.object({
  byLifecycle: z.record(z.string(), z.number().int().nonnegative()),
  byRisk: z.record(z.string(), z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
});
export type CandidateCounts = z.infer<typeof CandidateCountsSchema>;

export const LastBackupStatusSchema = z.object({
  tier: z.string().min(1),
  lastBackupAt: z.string().datetime().nullable().optional(),
  status: z.enum(['HEALTHY', 'STALE', 'FAILED', 'NOT_AVAILABLE']),
  meetsRpo: z.boolean().nullable().optional(),
  meetsRto: z.boolean().nullable().optional(),
  location: z.string().nullable().optional(),
});
export type LastBackupStatus = z.infer<typeof LastBackupStatusSchema>;

export const OverviewResponseSchema = z.object({
  systemMode: SystemModeSchema,
  globalKillSwitchState: z.array(KillSwitchStateSchema),
  providerIncidents: z.array(IncidentSchema),
  quotaExhaustionForecast: z.array(QuotaForecastSchema),
  activeSchedules: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      state: z.string().min(1),
      cron: z.string().min(1),
      timezone: z.string().min(1),
      paused: z.boolean(),
    }),
  ),
  scheduleDrift: z.array(ScheduleDriftSchema),
  workflowStates: WorkflowStatesSchema,
  candidateCounts: CandidateCountsSchema,
  lastBackupStatus: LastBackupStatusSchema,
  generatedAt: z.string().datetime(),
  // Ensures refresh never triggers external provider calls — no provider fields
});
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;

export const AuditRecordSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED', 'INCIDENT_CREATED', 'INCIDENT_ACKNOWLEDGED']),
  actor: z.string().min(1),
  target: z.string().min(1),
  timestamp: z.string().datetime(),
  reauthVerified: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
  previousHash: z.string().nullable().optional(),
  recordHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
