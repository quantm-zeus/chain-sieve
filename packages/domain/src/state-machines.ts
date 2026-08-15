/**
 * @requirement FR-SIG-005
 * Candidate lifecycle and risk are independent state machines.
 * Lifecycle: DISCOVERED, QUALIFIED, EMERGING, CONFIRMED, MONITORING, DECAYING, REJECTED, ARCHIVED
 * Risk: UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL, CONFLICTING
 * They must not be collapsed into a single merged state. Transitions store
 * full evidence linkage and are hysteresis-aware.
 */

export type CandidateLifecycle =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'EMERGING'
  | 'CONFIRMED'
  | 'MONITORING'
  | 'DECAYING'
  | 'REJECTED'
  | 'ARCHIVED';

export type CandidateRiskState =
  | 'UNKNOWN'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'CRITICAL'
  | 'CONFLICTING';

export interface CandidateState {
  lifecycle: CandidateLifecycle;
  risk: CandidateRiskState;
}

export type ScheduleState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DEGRADED' | 'DISABLED' | 'DELETED';
export type WorkflowRunState = 'PENDING' | 'RUNNING' | 'WAITING' | 'RETRYING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT' | 'DEAD_LETTERED';
export type AlertState = 'DRAFT' | 'SUPPRESSED' | 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'ACKNOWLEDGED' | 'EXPIRED';
export type CheapMonitorState = 'NEW' | 'MONITORING_CHEAP' | 'PROMOTED_TO_VERIFY' | 'REJECTED_CHEAP' | 'EXPIRED_CHEAP';
export type OutcomeMaturityState = 'PENDING' | 'PARTIALLY_MATURED' | 'FULLY_MATURED' | 'CENSORED' | 'INVALID_DATA';

export interface StateTransition<S extends string> {
  fromState: S;
  toState: S;
  reasonCodes: string[];
  featureVersion: string;
  rankingVersion: string;
  policyVersion: string;
  evidenceIds: string[];
  actorType: 'SYSTEM' | 'HUMAN' | 'POLICY';
  runId: string | null;
  eventAt: string;
  recordedAt: string;
}

export type CandidateLifecycleTransition = StateTransition<CandidateLifecycle>;
export type CandidateRiskTransition = StateTransition<CandidateRiskState>;

const LIFECYCLE_ORDER: Record<CandidateLifecycle, number> = {
  DISCOVERED: 0,
  QUALIFIED: 1,
  EMERGING: 2,
  CONFIRMED: 3,
  MONITORING: 4,
  DECAYING: 5,
  REJECTED: 6,
  ARCHIVED: 7,
};

const ALLOWED_LIFECYCLE: Record<CandidateLifecycle, CandidateLifecycle[]> = {
  DISCOVERED: ['QUALIFIED', 'REJECTED', 'ARCHIVED'],
  QUALIFIED: ['EMERGING', 'REJECTED', 'ARCHIVED'],
  EMERGING: ['CONFIRMED', 'MONITORING', 'REJECTED', 'ARCHIVED'],
  CONFIRMED: ['MONITORING', 'DECAYING', 'REJECTED', 'ARCHIVED'],
  MONITORING: ['DECAYING', 'CONFIRMED', 'REJECTED', 'ARCHIVED'],
  DECAYING: ['MONITORING', 'REJECTED', 'ARCHIVED'],
  REJECTED: ['ARCHIVED', 'DISCOVERED'],
  ARCHIVED: [],
};

const ALLOWED_RISK: Record<CandidateRiskState, CandidateRiskState[]> = {
  UNKNOWN: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'CONFLICTING'],
  LOW: ['MEDIUM', 'HIGH', 'CRITICAL', 'CONFLICTING', 'UNKNOWN'],
  MEDIUM: ['LOW', 'HIGH', 'CRITICAL', 'CONFLICTING', 'UNKNOWN'],
  HIGH: ['MEDIUM', 'CRITICAL', 'CONFLICTING', 'LOW', 'UNKNOWN'],
  CRITICAL: ['HIGH', 'CONFLICTING', 'MEDIUM', 'LOW', 'UNKNOWN'],
  CONFLICTING: ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
};

export const isCandidateLifecycle = (value: string): value is CandidateLifecycle =>
  Object.prototype.hasOwnProperty.call(ALLOWED_LIFECYCLE, value);

export const isCandidateRiskState = (value: string): value is CandidateRiskState =>
  Object.prototype.hasOwnProperty.call(ALLOWED_RISK, value);

export const canTransitionLifecycle = (from: CandidateLifecycle, to: CandidateLifecycle): boolean =>
  (ALLOWED_LIFECYCLE[from] ?? []).includes(to);

export const canTransitionRisk = (from: CandidateRiskState, to: CandidateRiskState): boolean =>
  (ALLOWED_RISK[from] ?? []).includes(to);

export const validateLifecycleTransition = (transition: CandidateLifecycleTransition): void => {
  if (!isCandidateLifecycle(transition.fromState) || !isCandidateLifecycle(transition.toState)) throw new Error('INVALID_LIFECYCLE_STATE');
  if (!canTransitionLifecycle(transition.fromState, transition.toState)) throw new Error('LIFECYCLE_TRANSITION_NOT_ALLOWED');
  if (transition.reasonCodes.length === 0) throw new Error('REASON_CODES_REQUIRED');
  if (Date.parse(transition.eventAt) > Date.parse(transition.recordedAt)) throw new Error('EVENT_AFTER_RECORDED');
};

export const validateRiskTransition = (transition: CandidateRiskTransition): void => {
  if (!isCandidateRiskState(transition.fromState) || !isCandidateRiskState(transition.toState)) throw new Error('INVALID_RISK_STATE');
  if (!canTransitionRisk(transition.fromState, transition.toState)) throw new Error('RISK_TRANSITION_NOT_ALLOWED');
  if (transition.reasonCodes.length === 0) throw new Error('REASON_CODES_REQUIRED');
  if (Date.parse(transition.eventAt) > Date.parse(transition.recordedAt)) throw new Error('EVENT_AFTER_RECORDED');
};

export const assertLifecycleAndRiskIndependent = (lifecycle: CandidateLifecycle, risk: CandidateRiskState): CandidateState => {
  if (!isCandidateLifecycle(lifecycle)) throw new Error('INVALID_LIFECYCLE_STATE');
  if (!isCandidateRiskState(risk)) throw new Error('INVALID_RISK_STATE');
  return { lifecycle, risk };
};

export const candidateStateEquals = (a: CandidateState, b: CandidateState): boolean =>
  a.lifecycle === b.lifecycle && a.risk === b.risk;

export const lifecycleRank = (state: CandidateLifecycle): number => LIFECYCLE_ORDER[state];

export interface HysteresisPolicy {
  promotionThreshold: number;
  demotionThreshold: number;
  minimumDwellMs: number;
  cooldownMs: number;
  maximumOscillationPerWindow: number;
}

export const satisfiesHysteresis = (
  current: CandidateLifecycle,
  candidate: CandidateLifecycle,
  score: number,
  policy: HysteresisPolicy,
  elapsedSinceLastTransitionMs: number,
): boolean => {
  if (policy.promotionThreshold <= policy.demotionThreshold) throw new Error('HYSTERESIS_THRESHOLDS_INVALID');
  if (elapsedSinceLastTransitionMs < policy.minimumDwellMs) return false;
  const currentRank = lifecycleRank(current);
  const candidateRank = lifecycleRank(candidate);
  if (candidateRank > currentRank) return score >= policy.promotionThreshold;
  if (candidateRank < currentRank) return score <= policy.demotionThreshold;
  return false;
};
