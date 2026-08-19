/**
 * @requirement FR-ALERT-001 - Distinct alert classification.
 * @requirement FR-ALERT-002 - EARLY_WATCH guardrails: short TTL, explicit missing data, no high-conviction language.
 * @requirement FR-ALERT-003 - Confirmed opportunity gates: tradability, security, cost, freshness, expiry.
 * @requirement AC-140 - EARLY_WATCH and CONFIRMED_OPPORTUNITY separate policies and thresholds.
 */

import { createHash } from 'node:crypto';
import type {
  AlertCandidateInput,
  AlertEvaluationResult,
  AlertPayload,
  AlertPolicyConfig,
  AlertRecord,
  ExecutionImpact,
  MissingDataItem,
  OutboxEntry,
} from './types.js';
import { assertNoHighConvictionLanguage, validateEarlyWatchGuardrails } from './guardrails.js';

export const DEFAULT_ALERT_POLICY_CONFIG: AlertPolicyConfig = {
  id: 'opportunity-alert',
  version: 2,
  automaticSendEnabled: false,
  minimumDataCoverage: 0.75,
  minimumEffectiveIndependenceGroups: 2.0,
  maximumSourceDependenceState: 'PARTIALLY_DEPENDENT',
  maximumMarketAgeSeconds: 180,
  maximumHolderAgeSeconds: 3600,
  maximumSecurityAgeSeconds: 21600,
  requireConservativeExecutionPass: true,
  requireP90ActionDelayPass: true,
  requireActiveStatisticalGate: true,
  blockOnCriticalRisk: true,
  blockOnUnresolvedConflictSeverity: 'HIGH',
  cooldownMinutes: 360,
  maxConfirmedAlertsPerDay: 5,
  maxEarlyWatchPerDay: 10,
  earlyWatchTtlMinutes: 30,
  earlyWatchCooldownMinutes: 60,
  quietHours: { enabled: false },
  costPolicy: 'STRICT_FREE',
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
};

export const computeAlertFingerprint = (input: {
  assetId: string;
  profileId: string;
  alertClass: string;
  lifecycleState: string;
  riskState: string;
  materialEvidenceFingerprint: string;
}): string => {
  const canonical = canonicalize({
    assetId: input.assetId,
    profileId: input.profileId,
    alertClass: input.alertClass,
    lifecycleState: input.lifecycleState,
    riskState: input.riskState,
    materialEvidenceFingerprint: input.materialEvidenceFingerprint,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

/**
 * Evaluates candidate data against deterministic alert policy.
 * Enforces all 14 confirmed-opportunity rules and early-watch guardrails.
 */
export const evaluateAlertPolicy = (
  candidate: AlertCandidateInput,
  customPolicy?: Partial<AlertPolicyConfig>,
  priorAlert?: AlertRecord | null,
  context?: { alertsSentToday?: number; earlyWatchesSentToday?: number },
): AlertEvaluationResult => {
  const policy: AlertPolicyConfig = {
    ...DEFAULT_ALERT_POLICY_CONFIG,
    ...customPolicy,
  };

  const asOfMs = Date.parse(candidate.asOf);
  const nowIso = candidate.asOf;
  const reasons: string[] = [];
  const missingData: MissingDataItem[] = [...candidate.missingData];

  // 1. Critical Risk Check
  if (candidate.riskState === 'CRITICAL' || candidate.riskState === 'CONFLICTING') {
    if (candidate.decision === 'ALERT' && candidate.lifecycleState === 'CONFIRMED') {
      reasons.push('CRITICAL_OR_CONFLICTING_RISK_BLOCKS_OPPORTUNITY');
    }
  }

  // 2. Unresolved Provider Conflicts Check
  const hasBlockingConflict = candidate.unresolvedConflicts.some((c) => {
    if (policy.blockOnUnresolvedConflictSeverity === 'NONE') return false;
    if (policy.blockOnUnresolvedConflictSeverity === 'LOW') return true;
    if (policy.blockOnUnresolvedConflictSeverity === 'MEDIUM') return ['MEDIUM', 'HIGH', 'CRITICAL'].includes(c.severity);
    if (policy.blockOnUnresolvedConflictSeverity === 'HIGH') return ['HIGH', 'CRITICAL'].includes(c.severity);
    if (policy.blockOnUnresolvedConflictSeverity === 'CRITICAL') return c.severity === 'CRITICAL';
    return false;
  });

  if (hasBlockingConflict) {
    reasons.push('UNRESOLVED_PROVIDER_CONFLICT_EXCEEDS_THRESHOLD');
  }

  // 3. Freshness Checks
  const marketAgeSec = (asOfMs - Date.parse(candidate.freshness.marketObservedAt)) / 1000;
  const holderAgeSec = (asOfMs - Date.parse(candidate.freshness.holderObservedAt)) / 1000;
  const securityAgeSec = (asOfMs - Date.parse(candidate.freshness.securityObservedAt)) / 1000;

  if (marketAgeSec > policy.maximumMarketAgeSeconds) {
    reasons.push(`MARKET_DATA_STALE:${marketAgeSec}s_max_${policy.maximumMarketAgeSeconds}s`);
    missingData.push({ field: 'marketData', reason: 'Market observation exceeded maximum freshness limit', severity: 'HIGH' });
  }
  if (holderAgeSec > policy.maximumHolderAgeSeconds) {
    reasons.push(`HOLDER_DATA_STALE:${holderAgeSec}s_max_${policy.maximumHolderAgeSeconds}s`);
    missingData.push({ field: 'holderData', reason: 'Holder observation exceeded maximum freshness limit', severity: 'MEDIUM' });
  }
  if (securityAgeSec > policy.maximumSecurityAgeSeconds) {
    reasons.push(`SECURITY_DATA_STALE:${securityAgeSec}s_max_${policy.maximumSecurityAgeSeconds}s`);
    missingData.push({ field: 'securityData', reason: 'Security observation exceeded maximum freshness limit', severity: 'HIGH' });
  }

  // 4. Data Coverage & Independence
  if (candidate.dataCoverage < policy.minimumDataCoverage) {
    reasons.push(`DATA_COVERAGE_BELOW_MINIMUM:${candidate.dataCoverage}_min_${policy.minimumDataCoverage}`);
  }

  if (candidate.effectiveIndependenceGroups < policy.minimumEffectiveIndependenceGroups) {
    reasons.push(`INSUFFICIENT_INDEPENDENCE_GROUPS:${candidate.effectiveIndependenceGroups}_min_${policy.minimumEffectiveIndependenceGroups}`);
  }

  // 5. Security Invariants (Deterministic Solana Checks)
  if (!candidate.security.mintAuthorityRevokedOrDisabled) {
    reasons.push('SECURITY_MINT_AUTHORITY_NOT_REVOKED');
  }
  if (!candidate.security.freezeAuthorityDisabled) {
    reasons.push('SECURITY_FREEZE_AUTHORITY_ACTIVE');
  }
  if (!candidate.security.lpLockedOrBurned) {
    reasons.push('SECURITY_LP_NOT_LOCKED_OR_BURNED');
  }
  if (candidate.security.criticalSecurityEvents.length > 0) {
    reasons.push(`SECURITY_CRITICAL_EVENTS_PRESENT:${candidate.security.criticalSecurityEvents.join(',')}`);
  }

  // 6. Tradability & Execution Impact
  if (!candidate.tradability.executable) {
    reasons.push(`TRADABILITY_NOT_EXECUTABLE:${candidate.tradability.reason ?? 'UNKNOWN'}`);
  }
  if (candidate.tradability.currentLiquidityUsd < candidate.tradability.minLiquidityUsd) {
    reasons.push(`INSUFFICIENT_LIQUIDITY:${candidate.tradability.currentLiquidityUsd}_min_${candidate.tradability.minLiquidityUsd}`);
  }
  if (candidate.tradability.netReturnEstimate <= 0) {
    reasons.push(`NET_RETURN_NON_POSITIVE:${candidate.tradability.netReturnEstimate}`);
  }

  // 7. Cost Policy (STRICT_FREE enforcement)
  if (policy.costPolicy === 'STRICT_FREE') {
    if (candidate.cost.costUsd > 0) {
      reasons.push(`COST_POLICY_VIOLATION_PAID_OP:${candidate.cost.costUsd}usd`);
    }
    if (candidate.cost.unknownCostOperationsCount > 0) {
      reasons.push(`COST_POLICY_VIOLATION_UNKNOWN_COST:${candidate.cost.unknownCostOperationsCount}`);
    }
  }

  // 8. Cooldown / Duplicate check against prior alert
  if (priorAlert && priorAlert.assetId === candidate.assetId) {
    const priorAlertTime = Date.parse(priorAlert.createdAt);
    const elapsedMinutes = (asOfMs - priorAlertTime) / (60 * 1000);

    const isConfirmedAlert = candidate.decision === 'ALERT' && reasons.length === 0;
    const cooldownLimit = isConfirmedAlert ? policy.cooldownMinutes : policy.earlyWatchCooldownMinutes;

    if (elapsedMinutes < cooldownLimit) {
      // Allow repeat only if material evidence fingerprint or risk/thesis changed materially
      if (priorAlert.payload.materialEvidenceFingerprint === candidate.materialEvidenceFingerprint) {
        reasons.push(`COOLDOWN_ACTIVE:${Math.round(elapsedMinutes)}m_required_${cooldownLimit}m`);
      }
    }
  }

  // 9. Daily limits
  if (context?.alertsSentToday !== undefined && context.alertsSentToday >= policy.maxConfirmedAlertsPerDay) {
    reasons.push(`DAILY_CONFIRMED_ALERT_LIMIT_REACHED:${context.alertsSentToday}_max_${policy.maxConfirmedAlertsPerDay}`);
  }

  // Determine Alert Class & Eligibility
  // Branch A: RISK_ALERT (Critical risk condition)
  if (candidate.riskState === 'CRITICAL' || candidate.riskState === 'HIGH' || candidate.security.criticalSecurityEvents.length > 0) {
    if (candidate.decision === 'REJECT' || candidate.decision === 'ALERT' || candidate.decision === 'WATCH') {
      const validUntil = new Date(asOfMs + 24 * 60 * 60 * 1000).toISOString();
      const alertId = `alt_risk_${createHash('sha256').update(`${candidate.assetId}:risk:${nowIso}`).digest('hex').slice(0, 24)}`;
      const fingerprint = computeAlertFingerprint({
        assetId: candidate.assetId,
        profileId: candidate.profileId,
        alertClass: 'RISK_ALERT',
        lifecycleState: candidate.lifecycleState,
        riskState: candidate.riskState,
        materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
      });

      const payload: AlertPayload = {
        alertId,
        assetId: candidate.assetId,
        chainId: candidate.chainId,
        contractAddress: candidate.contractAddress,
        symbol: candidate.symbol,
        alertClass: 'RISK_ALERT',
        lifecycleState: candidate.lifecycleState,
        riskState: candidate.riskState,
        profileId: candidate.profileId,
        profileVersion: candidate.profileVersion,
        asOf: nowIso,
        validUntil,
        actionabilityState: 'ACTIONABLE',
        score: candidate.score,
        rank: candidate.rank,
        thesis: candidate.thesis,
        counterThesis: candidate.counterThesis,
        positiveSignals: candidate.positiveSignals,
        riskSignals: candidate.riskSignals.length > 0 ? candidate.riskSignals : candidate.security.criticalSecurityEvents,
        missingData: missingData.sort((a, b) => a.field.localeCompare(b.field)),
        providerConflicts: candidate.unresolvedConflicts.map((c) => `${c.severity}:${c.description}`),
        thesisInvalidationConditions: candidate.thesisInvalidationConditions,
        parentAlertId: priorAlert?.alertId,
        materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
        shadowMode: candidate.shadowMode,
        traceId: candidate.traceId,
      };

      const canonicalJson = JSON.stringify(canonicalize(payload));
      const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
      const bytes = new TextEncoder().encode(canonicalJson).byteLength;

      const record: AlertRecord = {
        alertId,
        assetId: candidate.assetId,
        alertClass: 'RISK_ALERT',
        actionabilityState: 'ACTIONABLE',
        fingerprint,
        validUntil,
        payload,
        canonicalJson,
        sha256,
        bytes,
        createdAt: nowIso,
        shadowMode: candidate.shadowMode,
        traceId: candidate.traceId,
      };

      const outboxEntry: OutboxEntry = {
        id: `outbox_${alertId}`,
        topic: candidate.shadowMode ? 'alert.shadow.risk' : 'alert.production.risk',
        payloadJson: payload as unknown as Record<string, unknown>,
        state: 'PENDING',
        attemptCount: 0,
        availableAt: nowIso,
        traceId: candidate.traceId,
      };

      return {
        passed: true,
        alertClass: 'RISK_ALERT',
        actionabilityState: 'ACTIONABLE',
        rejectionReasons: [],
        missingData,
        alertPayload: payload,
        alertRecord: record,
        outboxEntry,
        renderedAlert: null,
      };
    }
  }

  // Branch B: CONFIRMED_OPPORTUNITY (All 14 gates pass)
  if (candidate.decision === 'ALERT' && reasons.length === 0 && candidate.lifecycleState === 'CONFIRMED') {
    // Check no high-conviction language
    assertNoHighConvictionLanguage(candidate.thesis, 'Confirmed alert thesis');

    const validUntil = new Date(asOfMs + 6 * 60 * 60 * 1000).toISOString(); // 6h default validity
    const alertId = `alt_opp_${createHash('sha256').update(`${candidate.assetId}:conf:${nowIso}`).digest('hex').slice(0, 24)}`;
    const fingerprint = computeAlertFingerprint({
      assetId: candidate.assetId,
      profileId: candidate.profileId,
      alertClass: 'CONFIRMED_OPPORTUNITY',
      lifecycleState: candidate.lifecycleState,
      riskState: candidate.riskState,
      materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
    });

    const execution: ExecutionImpact = {
      notionalUsd: candidate.tradability.minLiquidityUsd ? String(candidate.tradability.minLiquidityUsd) : '1000',
      expectedSlippageBps: candidate.tradability.expectedSlippageBps,
      feeTotalUsd: candidate.tradability.feeTotalUsd,
      netReturnEstimate: candidate.tradability.netReturnEstimate,
      maxExecutableNotionalUsd: candidate.tradability.maxExecutableNotionalUsd,
    };

    const payload: AlertPayload = {
      alertId,
      assetId: candidate.assetId,
      chainId: candidate.chainId,
      contractAddress: candidate.contractAddress,
      symbol: candidate.symbol,
      alertClass: 'CONFIRMED_OPPORTUNITY',
      lifecycleState: candidate.lifecycleState,
      riskState: candidate.riskState,
      profileId: candidate.profileId,
      profileVersion: candidate.profileVersion,
      asOf: nowIso,
      validUntil,
      actionabilityState: 'ACTIONABLE',
      score: candidate.score,
      rank: candidate.rank,
      thesis: candidate.thesis,
      counterThesis: candidate.counterThesis,
      positiveSignals: candidate.positiveSignals,
      riskSignals: candidate.riskSignals,
      missingData: missingData.sort((a, b) => a.field.localeCompare(b.field)),
      providerConflicts: candidate.unresolvedConflicts.map((c) => `${c.severity}:${c.description}`),
      thesisInvalidationConditions: candidate.thesisInvalidationConditions,
      execution,
      parentAlertId: priorAlert?.alertId,
      materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
      shadowMode: candidate.shadowMode,
      traceId: candidate.traceId,
    };

    const canonicalJson = JSON.stringify(canonicalize(payload));
    const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
    const bytes = new TextEncoder().encode(canonicalJson).byteLength;

    const record: AlertRecord = {
      alertId,
      assetId: candidate.assetId,
      alertClass: 'CONFIRMED_OPPORTUNITY',
      actionabilityState: 'ACTIONABLE',
      fingerprint,
      validUntil,
      payload,
      canonicalJson,
      sha256,
      bytes,
      createdAt: nowIso,
      shadowMode: candidate.shadowMode,
      traceId: candidate.traceId,
    };

    const outboxEntry: OutboxEntry = {
      id: `outbox_${alertId}`,
      topic: candidate.shadowMode ? 'alert.shadow.opportunity' : 'alert.production.opportunity',
      payloadJson: payload as unknown as Record<string, unknown>,
      state: 'PENDING',
      attemptCount: 0,
      availableAt: nowIso,
      traceId: candidate.traceId,
    };

    return {
      passed: true,
      alertClass: 'CONFIRMED_OPPORTUNITY',
      actionabilityState: 'ACTIONABLE',
      rejectionReasons: [],
      missingData,
      alertPayload: payload,
      alertRecord: record,
      outboxEntry,
      renderedAlert: null,
    };
  }

  // Branch C: EARLY_WATCH (Qualifies as emerging candidate or watch-eligible with explicit missing data and short TTL)
  const isEarlyWatchEligible =
    (candidate.decision === 'WATCH' || candidate.lifecycleState === 'EMERGING' || candidate.lifecycleState === 'QUALIFIED') &&
    candidate.riskState !== 'CRITICAL' &&
    candidate.riskState !== 'CONFLICTING' &&
    missingData.length > 0 &&
    (context?.earlyWatchesSentToday === undefined || context.earlyWatchesSentToday < policy.maxEarlyWatchPerDay);

  if (isEarlyWatchEligible) {
    const validUntil = new Date(asOfMs + policy.earlyWatchTtlMinutes * 60 * 1000).toISOString();

    const guardrailCheck = validateEarlyWatchGuardrails({
      asOf: nowIso,
      validUntil,
      missingData,
      thesis: candidate.thesis,
      counterThesis: candidate.counterThesis,
      positiveSignals: candidate.positiveSignals,
      ttlMinutesLimit: policy.earlyWatchTtlMinutes,
    });

    if (guardrailCheck.valid) {
      const alertId = `alt_watch_${createHash('sha256').update(`${candidate.assetId}:watch:${nowIso}`).digest('hex').slice(0, 24)}`;
      const fingerprint = computeAlertFingerprint({
        assetId: candidate.assetId,
        profileId: candidate.profileId,
        alertClass: 'EARLY_WATCH',
        lifecycleState: candidate.lifecycleState,
        riskState: candidate.riskState,
        materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
      });

      const payload: AlertPayload = {
        alertId,
        assetId: candidate.assetId,
        chainId: candidate.chainId,
        contractAddress: candidate.contractAddress,
        symbol: candidate.symbol,
        alertClass: 'EARLY_WATCH',
        lifecycleState: candidate.lifecycleState,
        riskState: candidate.riskState,
        profileId: candidate.profileId,
        profileVersion: candidate.profileVersion,
        asOf: nowIso,
        validUntil,
        actionabilityState: 'WATCH_ONLY',
        score: candidate.score,
        rank: candidate.rank,
        thesis: candidate.thesis,
        counterThesis: candidate.counterThesis,
        positiveSignals: candidate.positiveSignals,
        riskSignals: candidate.riskSignals,
        missingData: missingData.sort((a, b) => a.field.localeCompare(b.field)),
        providerConflicts: candidate.unresolvedConflicts.map((c) => `${c.severity}:${c.description}`),
        thesisInvalidationConditions: candidate.thesisInvalidationConditions,
        parentAlertId: priorAlert?.alertId,
        materialEvidenceFingerprint: candidate.materialEvidenceFingerprint,
        shadowMode: candidate.shadowMode,
        traceId: candidate.traceId,
      };

      const canonicalJson = JSON.stringify(canonicalize(payload));
      const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
      const bytes = new TextEncoder().encode(canonicalJson).byteLength;

      const record: AlertRecord = {
        alertId,
        assetId: candidate.assetId,
        alertClass: 'EARLY_WATCH',
        actionabilityState: 'WATCH_ONLY',
        fingerprint,
        validUntil,
        payload,
        canonicalJson,
        sha256,
        bytes,
        createdAt: nowIso,
        shadowMode: candidate.shadowMode,
        traceId: candidate.traceId,
      };

      const outboxEntry: OutboxEntry = {
        id: `outbox_${alertId}`,
        topic: candidate.shadowMode ? 'alert.shadow.watch' : 'alert.production.watch',
        payloadJson: payload as unknown as Record<string, unknown>,
        state: 'PENDING',
        attemptCount: 0,
        availableAt: nowIso,
        traceId: candidate.traceId,
      };

      return {
        passed: true,
        alertClass: 'EARLY_WATCH',
        actionabilityState: 'WATCH_ONLY',
        rejectionReasons: [],
        missingData,
        alertPayload: payload,
        alertRecord: record,
        outboxEntry,
        renderedAlert: null,
      };
    } else {
      reasons.push(...guardrailCheck.violations);
    }
  }

  // If none passed, return failure with sorted deterministic rejection reasons
  return {
    passed: false,
    alertClass: null,
    actionabilityState: null,
    rejectionReasons: [...new Set(reasons)].sort(),
    missingData,
    alertPayload: null,
    alertRecord: null,
    outboxEntry: null,
    renderedAlert: null,
  };
};
