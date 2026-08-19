export * from '@ciag/shared-schemas';

import type {
  AlertClass,
  AlertActionabilityState,
  AlertPriority,
  AlertChannel,
  MissingDataItem,
  ExecutionImpact,
  AlertPayload,
  AlertRecord,
  OutboxEntry,
  OutboxEntryState,
  AlertPolicyConfig,
  RenderedAlert,
  AlertClassSeparatedMetrics,
  CandidateLifecycle,
  CandidateRiskState,
} from '@ciag/shared-schemas';

export interface AlertTradabilityInput {
  executable: boolean;
  expectedSlippageBps: number;
  feeTotalUsd: string;
  netReturnEstimate: number;
  maxExecutableNotionalUsd?: string;
  minLiquidityUsd: number;
  currentLiquidityUsd: number;
  reason?: string;
}

export interface AlertSecurityInput {
  mintAuthorityRevokedOrDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  lpLockedOrBurned: boolean;
  criticalSecurityEvents: string[];
  findings: string[];
}

export interface AlertFreshnessInput {
  marketObservedAt: string;
  holderObservedAt: string;
  securityObservedAt: string;
}

export interface AlertCostInput {
  mode: 'STRICT_FREE' | 'BYOK_LIMITED' | 'PERMISSIVE';
  costUsd: number;
  unknownCostOperationsCount: number;
}

export interface AlertCandidateInput {
  assetId: string;
  chainId: string;
  contractAddress: string;
  symbol?: string;
  asOf: string;
  profileId: string;
  profileVersion: string;
  lifecycleState: CandidateLifecycle;
  riskState: CandidateRiskState;
  decision: 'ALERT' | 'WATCH' | 'IGNORE' | 'REJECT' | 'INSUFFICIENT_DATA';
  score: number | null;
  rank: number | null;
  dataCoverage: number;
  effectiveIndependenceGroups: number;
  sourceDependenceState: 'INDEPENDENT' | 'PARTIALLY_DEPENDENT' | 'HIGHLY_DEPENDENT' | 'UNKNOWN_DEPENDENCE';
  freshness: AlertFreshnessInput;
  tradability: AlertTradabilityInput;
  security: AlertSecurityInput;
  cost: AlertCostInput;
  unresolvedConflicts: Array<{ description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }>;
  positiveSignals: string[];
  riskSignals: string[];
  missingData: MissingDataItem[];
  thesis: string;
  counterThesis: string;
  thesisInvalidationConditions: string[];
  materialEvidenceFingerprint: string;
  shadowMode: boolean;
  traceId: string;
}

export interface AlertEvaluationResult {
  passed: boolean;
  alertClass: AlertClass | null;
  actionabilityState: AlertActionabilityState | null;
  rejectionReasons: string[];
  missingData: MissingDataItem[];
  alertPayload: AlertPayload | null;
  alertRecord: AlertRecord | null;
  outboxEntry: OutboxEntry | null;
  renderedAlert: RenderedAlert | null;
}

export interface AlertLifecycleDecision {
  transitionType: 'NONE' | 'THESIS_STRENGTHENING' | 'THESIS_WEAKENING' | 'OPPORTUNITY_EXPIRED' | 'RISK_ALERT';
  alertClass: AlertClass;
  actionabilityState: AlertActionabilityState;
  updateReason: string;
  parentAlertId: string;
  materialEvidenceFingerprint: string;
  isIdempotentNoOp: boolean;
}

export interface AlertEvaluationMetricRecord {
  alertId: string;
  alertClass: AlertClass;
  assetId: string;
  asOf: string;
  actionabilityState: AlertActionabilityState;
  tradableSuccess?: boolean;
  signalSuccess?: boolean;
  convertedToConfirmed?: boolean;
  leadTimeMinutes?: number;
  trueRiskDetected?: boolean;
  warningLeadTimeMinutes?: number;
}
