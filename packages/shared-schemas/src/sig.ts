import { z } from 'zod';

export const CandidateLifecycleSchema = z.enum([
  'DISCOVERED',
  'QUALIFIED',
  'EMERGING',
  'CONFIRMED',
  'MONITORING',
  'DECAYING',
  'REJECTED',
  'ARCHIVED',
]);

export const CandidateRiskStateSchema = z.enum(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'CONFLICTING']);

export type CandidateLifecycle = z.infer<typeof CandidateLifecycleSchema>;
export type CandidateRiskState = z.infer<typeof CandidateRiskStateSchema>;

export const CandidateStateSchema = z.object({
  lifecycle: CandidateLifecycleSchema,
  risk: CandidateRiskStateSchema,
});

const ALLOWED_LIFECYCLE: Record<string, string[]> = {
  DISCOVERED: ['QUALIFIED', 'REJECTED', 'ARCHIVED'],
  QUALIFIED: ['EMERGING', 'REJECTED', 'ARCHIVED'],
  EMERGING: ['CONFIRMED', 'MONITORING', 'REJECTED', 'ARCHIVED'],
  CONFIRMED: ['MONITORING', 'DECAYING', 'REJECTED', 'ARCHIVED'],
  MONITORING: ['DECAYING', 'CONFIRMED', 'REJECTED', 'ARCHIVED'],
  DECAYING: ['MONITORING', 'REJECTED', 'ARCHIVED'],
  REJECTED: ['ARCHIVED', 'DISCOVERED'],
  ARCHIVED: [],
};

const ALLOWED_RISK: Record<string, string[]> = {
  UNKNOWN: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'CONFLICTING'],
  LOW: ['MEDIUM', 'HIGH', 'CRITICAL', 'CONFLICTING', 'UNKNOWN'],
  MEDIUM: ['LOW', 'HIGH', 'CRITICAL', 'CONFLICTING', 'UNKNOWN'],
  HIGH: ['MEDIUM', 'CRITICAL', 'CONFLICTING', 'LOW', 'UNKNOWN'],
  CRITICAL: ['HIGH', 'CONFLICTING', 'MEDIUM', 'LOW', 'UNKNOWN'],
  CONFLICTING: ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
};

export const CandidateLifecycleTransitionSchema = z
  .object({
    fromState: CandidateLifecycleSchema,
    toState: CandidateLifecycleSchema,
    reasonCodes: z.array(z.string().min(1)).min(1),
    featureVersion: z.string().min(1),
    rankingVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    actorType: z.enum(['SYSTEM', 'HUMAN', 'POLICY']),
    runId: z.string().nullable(),
    eventAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    const allowed = ALLOWED_LIFECYCLE[value.fromState] ?? [];
    if (!allowed.includes(value.toState)) {
      context.addIssue({ code: 'custom', path: ['toState'], message: 'LIFECYCLE_TRANSITION_NOT_ALLOWED' });
    }
    if (Date.parse(value.eventAt) > Date.parse(value.recordedAt)) {
      context.addIssue({ code: 'custom', path: ['eventAt'], message: 'EVENT_AFTER_RECORDED' });
    }
  });

export const CandidateRiskTransitionSchema = z
  .object({
    fromState: CandidateRiskStateSchema,
    toState: CandidateRiskStateSchema,
    reasonCodes: z.array(z.string().min(1)).min(1),
    featureVersion: z.string().min(1),
    rankingVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    actorType: z.enum(['SYSTEM', 'HUMAN', 'POLICY']),
    runId: z.string().nullable(),
    eventAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    const allowed = ALLOWED_RISK[value.fromState] ?? [];
    if (!allowed.includes(value.toState)) {
      context.addIssue({ code: 'custom', path: ['toState'], message: 'RISK_TRANSITION_NOT_ALLOWED' });
    }
    if (Date.parse(value.eventAt) > Date.parse(value.recordedAt)) {
      context.addIssue({ code: 'custom', path: ['eventAt'], message: 'EVENT_AFTER_RECORDED' });
    }
  });

export const ScheduleStateSchema = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'DEGRADED', 'DISABLED', 'DELETED']);
export const WorkflowRunStateSchema = z.enum([
  'PENDING',
  'RUNNING',
  'WAITING',
  'RETRYING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'DEAD_LETTERED',
]);
export const AlertStateSchema = z.enum(['DRAFT', 'SUPPRESSED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'ACKNOWLEDGED', 'EXPIRED']);
export const CheapMonitorStateSchema = z.enum(['NEW', 'MONITORING_CHEAP', 'PROMOTED_TO_VERIFY', 'REJECTED_CHEAP', 'EXPIRED_CHEAP']);
export const OutcomeMaturityStateSchema = z.enum(['PENDING', 'PARTIALLY_MATURED', 'FULLY_MATURED', 'CENSORED', 'INVALID_DATA']);

export const canTransitionLifecycle = (from: z.infer<typeof CandidateLifecycleSchema>, to: z.infer<typeof CandidateLifecycleSchema>): boolean =>
  (ALLOWED_LIFECYCLE[from] ?? []).includes(to);

export const canTransitionRisk = (from: z.infer<typeof CandidateRiskStateSchema>, to: z.infer<typeof CandidateRiskStateSchema>): boolean =>
  (ALLOWED_RISK[from] ?? []).includes(to);
