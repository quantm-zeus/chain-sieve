import { z } from 'zod';
import { CandidateLifecycleSchema, CandidateRiskStateSchema } from './sig.js';

export const AlertClassSchema = z.enum([
  'EARLY_WATCH',
  'CONFIRMED_OPPORTUNITY',
  'THESIS_STRENGTHENING',
  'THESIS_WEAKENING',
  'OPPORTUNITY_EXPIRED',
  'RISK_ALERT',
]);

export type AlertClass = z.infer<typeof AlertClassSchema>;

export const AlertActionabilityStateSchema = z.enum([
  'ACTIONABLE',
  'DETERIORATED',
  'EXPIRED',
  'CANCELLED',
  'WATCH_ONLY',
]);

export type AlertActionabilityState = z.infer<typeof AlertActionabilityStateSchema>;

export const AlertPrioritySchema = z.enum([
  'IMMEDIATE',
  'HIGH',
  'NORMAL',
  'LOW',
  'BATCH_DIGEST',
]);

export type AlertPriority = z.infer<typeof AlertPrioritySchema>;

export const AlertChannelSchema = z.enum([
  'telegram',
  'admin_inbox',
  'chatgpt_scheduled',
  'shadow_log',
]);

export type AlertChannel = z.infer<typeof AlertChannelSchema>;

export const MissingDataItemSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});

export type MissingDataItem = z.infer<typeof MissingDataItemSchema>;

export const ExecutionImpactSchema = z.object({
  notionalUsd: z.string().regex(/^\d+(\.\d+)?$/, 'DECIMAL_STRING'),
  expectedSlippageBps: z.number().nonnegative(),
  feeTotalUsd: z.string().regex(/^\d+(\.\d+)?$/, 'DECIMAL_STRING'),
  netReturnEstimate: z.number(),
  maxExecutableNotionalUsd: z.string().regex(/^\d+(\.\d+)?$/, 'DECIMAL_STRING').optional(),
});

export type ExecutionImpact = z.infer<typeof ExecutionImpactSchema>;

export const AlertPayloadSchema = z.object({
  alertId: z.string().min(1),
  assetId: z.string().min(1),
  chainId: z.string().min(1),
  contractAddress: z.string().min(1),
  symbol: z.string().optional(),
  alertClass: AlertClassSchema,
  lifecycleState: CandidateLifecycleSchema,
  riskState: CandidateRiskStateSchema,
  profileId: z.string().min(1),
  profileVersion: z.string().min(1),
  asOf: z.string().datetime(),
  validUntil: z.string().datetime(),
  actionabilityState: AlertActionabilityStateSchema,
  score: z.number().nullable(),
  rank: z.number().int().positive().nullable(),
  thesis: z.string().min(1),
  counterThesis: z.string().min(1),
  positiveSignals: z.array(z.string()),
  riskSignals: z.array(z.string()),
  missingData: z.array(MissingDataItemSchema),
  providerConflicts: z.array(z.string()),
  thesisInvalidationConditions: z.array(z.string()),
  execution: ExecutionImpactSchema.optional(),
  parentAlertId: z.string().optional(),
  updateReason: z.string().optional(),
  materialEvidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  shadowMode: z.boolean(),
  traceId: z.string().min(1),
});

export type AlertPayload = z.infer<typeof AlertPayloadSchema>;

export const AlertRecordSchema = z.object({
  alertId: z.string().min(1),
  assetId: z.string().min(1),
  alertClass: AlertClassSchema,
  actionabilityState: AlertActionabilityStateSchema,
  fingerprint: z.string().min(1),
  validUntil: z.string().datetime(),
  payload: AlertPayloadSchema,
  canonicalJson: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  shadowMode: z.boolean(),
  traceId: z.string().min(1),
});

export type AlertRecord = z.infer<typeof AlertRecordSchema>;

export const OutboxEntryStateSchema = z.enum([
  'PENDING',
  'DELIVERED',
  'RETRY',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

export type OutboxEntryState = z.infer<typeof OutboxEntryStateSchema>;

export const OutboxEntrySchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  payloadJson: z.record(z.string(), z.unknown()),
  state: OutboxEntryStateSchema,
  attemptCount: z.number().int().nonnegative(),
  availableAt: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable().optional(),
  traceId: z.string().min(1),
});

export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

export const AlertPolicyConfigSchema = z.object({
  id: z.string().min(1).default('opportunity-alert'),
  version: z.number().int().positive().default(2),
  automaticSendEnabled: z.boolean().default(false),
  minimumDataCoverage: z.number().min(0).max(1).default(0.75),
  minimumEffectiveIndependenceGroups: z.number().nonnegative().default(2.0),
  maximumSourceDependenceState: z.enum(['INDEPENDENT', 'PARTIALLY_DEPENDENT', 'HIGHLY_DEPENDENT', 'UNKNOWN_DEPENDENCE']).default('PARTIALLY_DEPENDENT'),
  maximumMarketAgeSeconds: z.number().int().positive().default(180),
  maximumHolderAgeSeconds: z.number().int().positive().default(3600),
  maximumSecurityAgeSeconds: z.number().int().positive().default(21600),
  requireConservativeExecutionPass: z.boolean().default(true),
  requireP90ActionDelayPass: z.boolean().default(true),
  requireActiveStatisticalGate: z.boolean().default(true),
  blockOnCriticalRisk: z.boolean().default(true),
  blockOnUnresolvedConflictSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'NONE']).default('HIGH'),
  cooldownMinutes: z.number().int().nonnegative().default(360),
  maxConfirmedAlertsPerDay: z.number().int().nonnegative().default(5),
  maxEarlyWatchPerDay: z.number().int().nonnegative().default(10),
  earlyWatchTtlMinutes: z.number().int().positive().default(30),
  earlyWatchCooldownMinutes: z.number().int().nonnegative().default(60),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    startUtcHour: z.number().int().min(0).max(23).optional(),
    endUtcHour: z.number().int().min(0).max(23).optional(),
  }).default({ enabled: false }),
  costPolicy: z.enum(['STRICT_FREE', 'BYOK_LIMITED', 'PERMISSIVE']).default('STRICT_FREE'),
});

export type AlertPolicyConfig = z.infer<typeof AlertPolicyConfigSchema>;

export const RenderedAlertSchema = z.object({
  alertId: z.string().min(1),
  alertClass: AlertClassSchema,
  channel: AlertChannelSchema,
  priority: AlertPrioritySchema,
  headline: z.string().min(1),
  body: z.string().min(1),
  disclaimer: z.string().min(1),
  renderedAt: z.string().datetime(),
  suppressed: z.boolean(),
  suppressionReason: z.string().optional(),
  shadowMode: z.boolean(),
});

export type RenderedAlert = z.infer<typeof RenderedAlertSchema>;

export const ConfirmedOpportunityMetricsSchema = z.object({
  totalAlerts: z.number().int().nonnegative(),
  tradableSuccessCount: z.number().int().nonnegative(),
  tradableFailureCount: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  falseDiscoveryRate: z.number().min(0).max(1),
});

export type ConfirmedOpportunityMetrics = z.infer<typeof ConfirmedOpportunityMetricsSchema>;

export const EarlyWatchMetricsSchema = z.object({
  totalWatches: z.number().int().nonnegative(),
  convertedToConfirmedCount: z.number().int().nonnegative(),
  conversionRate: z.number().min(0).max(1),
  watchPrecision: z.number().min(0).max(1),
  medianLeadTimeMinutes: z.number().nonnegative(),
  excludedFromConfirmedPrecision: z.literal(true),
});

export type EarlyWatchMetrics = z.infer<typeof EarlyWatchMetricsSchema>;

export const RiskAlertMetricsSchema = z.object({
  totalRiskAlerts: z.number().int().nonnegative(),
  trueRiskCount: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  medianWarningLeadTimeMinutes: z.number().nonnegative(),
});

export type RiskAlertMetrics = z.infer<typeof RiskAlertMetricsSchema>;

export const ThesisUpdateMetricsSchema = z.object({
  strengtheningCount: z.number().int().nonnegative(),
  weakeningCount: z.number().int().nonnegative(),
  expiredCount: z.number().int().nonnegative(),
  cancellationCount: z.number().int().nonnegative(),
});

export type ThesisUpdateMetrics = z.infer<typeof ThesisUpdateMetricsSchema>;

export const AlertClassSeparatedMetricsSchema = z.object({
  asOf: z.string().datetime(),
  confirmedOpportunity: ConfirmedOpportunityMetricsSchema,
  earlyWatch: EarlyWatchMetricsSchema,
  riskAlert: RiskAlertMetricsSchema,
  thesisUpdates: ThesisUpdateMetricsSchema,
});

export type AlertClassSeparatedMetrics = z.infer<typeof AlertClassSeparatedMetricsSchema>;
