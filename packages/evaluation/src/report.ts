/**
 * @requirement FR-EVAL-019 - Backtest, cross-fit, forward shadow, live shadow, and active-production results are separate artifact classes; UI and exports cannot blend them into one performance curve.
 * @requirement AC-040 - Baseline metrics and report artifacts are stable for identical inputs and configuration.
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Deterministic report generation, artifact class separation enforcement, and policy comparison.
 */

import { EvaluationError } from './errors.js';
import { computeEvaluationMetrics } from './metrics.js';
import type { ComputeMetricsOptions } from './metrics.js';
import { assertIdenticalUniverses, validateFrozenUniverse } from './universe.js';
import type {
  EvaluationArtifactClass,
  EvaluationReport,
  FrozenCandidateUniverse,
  OutcomeProfile,
  OutcomeRecord,
  PolicyComparison,
  PolicyMetadata,
} from './types.js';
import { EVALUATION_ARTIFACT_CLASSES } from './types.js';
import { canonicalize, sha256Hex, isValidIso } from './canonical.js';


export interface GenerateReportInput {
  artifactClass: EvaluationArtifactClass;
  candidateUniverse: FrozenCandidateUniverse;
  profile: OutcomeProfile;
  policy: PolicyMetadata;
  outcomes: OutcomeRecord[];
  metricsOptions?: ComputeMetricsOptions | undefined;
  generatedAt?: string | undefined;
}

/**
 * Generate a canonical, reproducible EvaluationReport artifact.
 *
 * Enforces FR-EVAL-019:
 * - Requires explicit artifactClass.
 * - Enforces deterministic JSON serialization, SHA-256 digest, and reportId derivation.
 */
export const generateEvaluationReport = (input: GenerateReportInput): EvaluationReport => {
  if (!input || typeof input !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'REPORT_INPUT_REQUIRED');
  }

  const { artifactClass, candidateUniverse, profile, policy, outcomes, metricsOptions, generatedAt } = input;

  if (!artifactClass || !EVALUATION_ARTIFACT_CLASSES.includes(artifactClass)) {
    throw new EvaluationError(
      'EVAL_MALFORMED',
      `Invalid artifactClass: ${String(artifactClass)}. Must be one of: ${EVALUATION_ARTIFACT_CLASSES.join(', ')}`,
    );
  }

  validateFrozenUniverse(candidateUniverse);

  if (!profile || typeof profile !== 'object' || !profile.profileId) {
    throw new EvaluationError('EVAL_MALFORMED', 'OUTCOME_PROFILE_REQUIRED');
  }

  if (!policy || typeof policy !== 'object' || !policy.policyId) {
    throw new EvaluationError('EVAL_MALFORMED', 'POLICY_METADATA_REQUIRED');
  }

  if (!Array.isArray(outcomes)) {
    throw new EvaluationError('EVAL_MALFORMED', 'OUTCOMES_NOT_ARRAY');
  }

  if (generatedAt !== undefined && !isValidIso(generatedAt)) {
    throw new EvaluationError('EVAL_MALFORMED', 'GENERATED_AT_INVALID_ISO');
  }

  // Sort outcomes deterministically by outcomeId
  const sortedOutcomes = [...outcomes].sort((a, b) => a.outcomeId.localeCompare(b.outcomeId));

  const resolvedGeneratedAt = generatedAt ?? candidateUniverse.dataCutoff;

  // Compute deterministic metrics
  const metrics = computeEvaluationMetrics(sortedOutcomes, {
    totalCandidates: candidateUniverse.totalAssets,
    ...metricsOptions,
  });

  const canonicalPayload = {
    schemaVersion: '1.0.0',
    artifactClass,
    generatedAt: resolvedGeneratedAt,
    candidateUniverse: {
      universeId: candidateUniverse.universeId,
      dataCutoff: candidateUniverse.dataCutoff,
      candidateAssetIds: candidateUniverse.candidateAssetIds,
      totalAssets: candidateUniverse.totalAssets,
      corpusVersion: candidateUniverse.corpusVersion,
      sha256: candidateUniverse.sha256,
    },
    profile: {
      profileId: profile.profileId,
      version: profile.version,
      executionScenario: profile.executionScenario,
      exitPolicy: profile.exitPolicy,
      signalTargetMultiplier: profile.signalTargetMultiplier,
      signalStopMultiplier: profile.signalStopMultiplier,
      horizonMs: profile.horizonMs,
    },
    policy: {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      description: policy.description ?? '',
      minScoreThreshold: policy.minScoreThreshold ?? null,
    },
    metrics,
    outcomes: sortedOutcomes.map((o) => JSON.parse(o.canonicalJson)),
  };

  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload));
  const sha256 = sha256Hex(canonicalJson);
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;
  const reportId = `rep_${sha256.slice(0, 32)}`;

  return Object.freeze({
    schemaVersion: '1.0.0' as const,
    reportId,
    artifactClass,
    generatedAt: resolvedGeneratedAt,
    candidateUniverse,
    profile,
    policy,
    metrics,
    outcomes: sortedOutcomes,
    canonicalJson,
    sha256,
    bytes,
  }) as EvaluationReport;
};

/**
 * Enforce FR-EVAL-019: Asserts that reports belong to the same artifact class
 * and cannot be blended into a single performance curve or combined result.
 */
export const assertNoArtifactClassBlending = (reports: EvaluationReport[]): void => {
  if (!Array.isArray(reports) || reports.length === 0) return;

  const classes = new Set<EvaluationArtifactClass>();
  for (const report of reports) {
    if (!report || !report.artifactClass) {
      throw new EvaluationError('EVAL_MALFORMED', 'REPORT_ARTIFACT_CLASS_MISSING');
    }
    classes.add(report.artifactClass);
  }

  if (classes.size > 1) {
    throw new EvaluationError(
      'EVAL_CLASS_BLENDED',
      `FR-EVAL-019 violation: Attempted to blend distinct artifact classes: ${Array.from(classes).join(', ')}. UI and exports cannot blend backtest, cross-fit, forward shadow, live shadow, and active production into one curve.`,
    );
  }
};

export interface ComparePoliciesInput {
  baselineReport: EvaluationReport;
  championReport: EvaluationReport;
  frozenUniverse?: FrozenCandidateUniverse | undefined;
}

/**
 * Compare baseline policy vs champion policy over the same frozen candidate universe (AC-042).
 *
 * Requirements:
 * - Enforces AC-042: Baseline and champion MUST use the same frozen candidate universe and data cutoff.
 * - Asserts no illegal cross-class blending.
 * - Computes comparative lift metrics.
 */
export const comparePolicies = (input: ComparePoliciesInput): PolicyComparison => {
  if (!input || typeof input !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'COMPARE_INPUT_REQUIRED');
  }

  const { baselineReport, championReport, frozenUniverse } = input;

  if (!baselineReport || !championReport) {
    throw new EvaluationError('EVAL_INCOMPLETE', 'BASELINE_AND_CHAMPION_REPORTS_REQUIRED');
  }

  // Check artifact class separation (FR-EVAL-019)
  if (baselineReport.artifactClass !== championReport.artifactClass) {
    throw new EvaluationError(
      'EVAL_CLASS_BLENDED',
      `FR-EVAL-019 violation: Cannot compare baseline (${baselineReport.artifactClass}) and champion (${championReport.artifactClass}) across different artifact classes without explicit separation.`,
    );
  }

  // Verify identical candidate universe and cutoff (AC-042)
  assertIdenticalUniverses(baselineReport.candidateUniverse, championReport.candidateUniverse);

  if (frozenUniverse) {
    assertIdenticalUniverses(baselineReport.candidateUniverse, frozenUniverse);
  }

  const baseMetrics = baselineReport.metrics;
  const champMetrics = championReport.metrics;

  const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

  const precisionLift = round6(champMetrics.tradablePrecision - baseMetrics.tradablePrecision);
  const recallLift = round6(champMetrics.tradableRecall - baseMetrics.tradableRecall);
  const utilityLift = round6(champMetrics.netShadowPortfolioUtility - baseMetrics.netShadowPortfolioUtility);
  const lcb95Lift = round6(champMetrics.lcb95Utility - baseMetrics.lcb95Utility);
  const missedGemsReduction = baseMetrics.missedGemsCount - champMetrics.missedGemsCount;

  // PRD 7.1, 7.3, FR-EVAL-020: champion is superior if LCB95 utility improves without higher security/critical risk failures
  const isChampionSuperior =
    lcb95Lift > 0 &&
    champMetrics.securityOrLiquidityFailureCount <= baseMetrics.securityOrLiquidityFailureCount;

  const comparisonPayload = {
    baselineReportId: baselineReport.reportId,
    championReportId: championReport.reportId,
    universeHash: baselineReport.candidateUniverse.sha256,
    dataCutoff: baselineReport.candidateUniverse.dataCutoff,
    artifactClass: baselineReport.artifactClass,
    precisionLift,
    recallLift,
    utilityLift,
    lcb95Lift,
    missedGemsReduction,
    isChampionSuperior,
  };

  const comparisonJson = JSON.stringify(canonicalize(comparisonPayload));
  const sha256 = sha256Hex(comparisonJson);

  return Object.freeze({
    baselineReportId: baselineReport.reportId,
    championReportId: championReport.reportId,
    universeHash: baselineReport.candidateUniverse.sha256,
    dataCutoff: baselineReport.candidateUniverse.dataCutoff,
    artifactClass: baselineReport.artifactClass,
    precisionLift,
    recallLift,
    utilityLift,
    lcb95Lift,
    missedGemsReduction,
    isChampionSuperior,
    comparisonJson,
    sha256,
  }) as PolicyComparison;
};
