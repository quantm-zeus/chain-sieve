/**
 * @requirement FR-EVAL-019 - Backtest, cross-fit, forward shadow, live shadow, and active-production results are separate artifact classes.
 * @requirement AC-040 - Outcome profiles compute separate signal and tradable labels from actionable delivery time, canonical pool, configured notional/delay, modeled impact, all required fees, fill/liquidity constraints, exit policy and maturity state.
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Core types for evaluation baseline, outcome labeling, metrics, reports, and artifact class separation.
 */

// ---------------------------------------------------------------------------
// Artifact Classes (FR-EVAL-019)
// ---------------------------------------------------------------------------

/**
 * Normative artifact classes. Results from different artifact classes cannot be
 * blended into one performance curve or report without explicit separation.
 */
export type EvaluationArtifactClass =
  | 'BACKTEST'
  | 'CROSS_FIT'
  | 'FORWARD_SHADOW'
  | 'LIVE_SHADOW'
  | 'ACTIVE_PRODUCTION';

export const EVALUATION_ARTIFACT_CLASSES: readonly EvaluationArtifactClass[] = [
  'BACKTEST',
  'CROSS_FIT',
  'FORWARD_SHADOW',
  'LIVE_SHADOW',
  'ACTIVE_PRODUCTION',
] as const;

// ---------------------------------------------------------------------------
// Outcome States & Labels (AC-040, PRD Section 8.1, 8.2)
// ---------------------------------------------------------------------------

export type OutcomeState =
  | 'PENDING'
  | 'MATURE'
  | 'PARTIALLY_MATURED'
  | 'FULLY_MATURED'
  | 'CENSORED'
  | 'INVALID_DATA';

export type SignalOutcomeLabel =
  | 'SIGNAL_WIN'
  | 'SIGNAL_LOSS'
  | 'SIGNAL_NEUTRAL'
  | 'SIGNAL_PENDING'
  | 'SIGNAL_INVALID'
  | 'SIGNAL_CENSORED';

export type TradableOutcomeLabel =
  | 'TRADABLE_SUCCESS'
  | 'TRADABLE_FAILURE'
  | 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY'
  | 'TRADABLE_NEUTRAL'
  | 'UNTRADABLE_SIGNAL_WIN'
  | 'CENSORED'
  | 'INVALID_DATA'
  | 'PENDING';

// ---------------------------------------------------------------------------
// Universal Timing (AC-040, PRD Section 8.1)
// ---------------------------------------------------------------------------

export interface UniversalTiming {
  /** Earliest time at which all evidence/features were available */
  tDecisionReady: string;
  /** Durable commit time of the deterministic policy result */
  tPolicyDecided: string;
  /** max(tDecisionReady, tPolicyDecided) */
  tDeliveryEligible: string;
  /** Actual delivery or counterfactual delivery timestamp */
  tDelivery: string;
  /** Pre-registered action delay in milliseconds */
  dActionMs: number;
  /** max(tDelivery + dActionMs, execution_state_available, security_available) */
  tActionReference: string;
  /** Actionable reference price timestamp */
  actionablePriceTime: string | null;
}

// ---------------------------------------------------------------------------
// Execution Scenario & Exit Policy (AC-040)
// ---------------------------------------------------------------------------

export interface ExecutionScenario {
  scenarioId: string;
  notionalUsd: number;
  actionDelayMs: number;
  slippageBps: number;
  networkFeeUsd: number;
  priorityFeeUsd: number;
  poolFeeBps: number;
  tokenTransferFeeBps: number;
  minLiquidityUsd: number;
  maxImpactBps: number;
}

export interface ExitPolicy {
  policyId: string;
  targetMultiplier: number; // e.g. 2.0 (100% gain)
  stopLossMultiplier: number; // e.g. 0.5 (50% loss)
  maxHorizonMs: number; // e.g. 86400_000 (24h)
  trailingStopLossMultiplier?: number;
}

export interface OutcomeProfile {
  profileId: string; // e.g. "HG-EM-1"
  version: string; // e.g. "1"
  executionScenario: ExecutionScenario;
  exitPolicy: ExitPolicy;
  signalTargetMultiplier: number; // pure signal price target multiple (e.g. 2.0x)
  signalStopMultiplier: number; // pure signal stop multiple (e.g. 0.5x)
  horizonMs: number;
}

// ---------------------------------------------------------------------------
// Forward Observation (Price, Liquidity, Security over Time)
// ---------------------------------------------------------------------------

export interface ForwardObservation {
  timestamp: string; // ISO datetime
  priceUsd: number;
  poolLiquidityUsd: number;
  securityStatus: 'SAFE' | 'WARNING' | 'RUG_PULL' | 'CRITICAL_SECURITY_EVENT';
  tradeCount?: number;
  volumeUsd?: number;
}

// ---------------------------------------------------------------------------
// Evaluated Outcome Record (AC-040)
// ---------------------------------------------------------------------------

export interface OutcomeRecord {
  /** Deterministic outcome ID: out_<first 32 hex of sha256> */
  outcomeId: string;
  signalId: string;
  assetId: string;
  chainId: string;
  asOf: string;
  profileId: string;
  profileVersion: string;
  scenarioId: string;
  state: OutcomeState;

  /** Separate signal and tradable labels (AC-040) */
  signalSuccess: boolean;
  tradableSuccess: boolean;
  signalOutcome: SignalOutcomeLabel;
  tradableOutcome: TradableOutcomeLabel;

  /** Execution & price metrics */
  timing: UniversalTiming;
  entryPrice: number | null;
  exitPrice: number | null;
  exitTime: string | null;
  rawReturn: number | null; // (exitPrice - entryPrice) / entryPrice
  netReturn: number | null; // return after impact and all required fees
  mfe: number | null; // Maximum Favorable Excursion multiple
  mae: number | null; // Maximum Adverse Excursion multiple
  modeledImpactBps: number;
  totalFeesUsd: number;
  liquiditySurvives: boolean;
  securitySurvives: boolean;
  failureReason: string | null;

  canonicalJson: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Frozen Candidate Universe (AC-042)
// ---------------------------------------------------------------------------

export interface FrozenCandidateUniverse {
  universeId: string;
  dataCutoff: string; // ISO datetime
  candidateAssetIds: string[]; // deterministic lexicographic order
  totalAssets: number;
  corpusVersion: string;
  sha256: string; // canonical hash of the universe definition
}

// ---------------------------------------------------------------------------
// Evaluation Metrics (PRD Section 7, Section 38.42)
// ---------------------------------------------------------------------------

export interface EvaluationMetrics {
  // Counts
  totalCandidates: number;
  eligibleCandidates: number;
  rejectedCandidates: number;
  materializedSignals: number;
  evaluatedOutcomes: number;
  fullyMaturedCount: number;
  partiallyMaturedCount: number;
  pendingCount: number;
  censoredCount: number;
  invalidCount: number;

  // Pure Signal Metrics
  signalSuccessCount: number;
  signalFailureCount: number;
  signalPrecision: number;
  signalRecall: number;

  // Tradable Execution Metrics (AC-040)
  tradableSuccessCount: number;
  tradableFailureCount: number;
  securityOrLiquidityFailureCount: number;
  tradableNeutralCount: number;
  untradableSignalWinCount: number;
  tradablePrecision: number;
  tradableRecall: number;
  missedGemsCount: number;
  falseDiscoveryRate: number;

  // Ranking / Opportunity Diagnostics (PRD 7.5)
  precisionAt1: number;
  precisionAt3: number;
  precisionAt5: number;
  recallAtGems: number;
  ndcgAt5: number;
  ndcgAt10: number;
  meanReciprocalRank: number;

  // Financial & Net Portfolio Utility Diagnostics (PRD 7.1, 7.2, 7.4)
  averageNetReturn: number;
  profitFactor: number;
  winLossRatio: number;
  netExpectancy: number;
  maxDrawdown: number;
  cvar95: number;
  netShadowPortfolioUtility: number;
  lcb95Utility: number;
}

// ---------------------------------------------------------------------------
// Evaluation Report (FR-EVAL-019, AC-040, AC-042)
// ---------------------------------------------------------------------------

export interface PolicyMetadata {
  policyId: string;
  policyVersion: string;
  description?: string;
  minScoreThreshold?: number | null;
}

export interface EvaluationReport {
  schemaVersion: '1.0.0';
  /** Deterministic report ID: rep_<first 32 hex of sha256> */
  reportId: string;
  artifactClass: EvaluationArtifactClass; // FR-EVAL-019
  generatedAt: string;
  candidateUniverse: FrozenCandidateUniverse; // AC-042
  profile: OutcomeProfile; // AC-040
  policy: PolicyMetadata;
  metrics: EvaluationMetrics;
  outcomes: OutcomeRecord[];
  canonicalJson: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Policy Comparison (AC-042)
// ---------------------------------------------------------------------------

export interface PolicyComparison {
  baselineReportId: string;
  championReportId: string;
  universeHash: string;
  dataCutoff: string;
  artifactClass: EvaluationArtifactClass;
  precisionLift: number;
  recallLift: number;
  utilityLift: number;
  lcb95Lift: number;
  missedGemsReduction: number;
  isChampionSuperior: boolean;
  comparisonJson: string;
  sha256: string;
}

// ---------------------------------------------------------------------------
// Backwards Compatibility Types
// ---------------------------------------------------------------------------

export interface Outcome {
  state: OutcomeState;
  signalSuccess?: boolean;
  tradableSuccess?: boolean;
}
