/**
 * @requirement FR-ALERT-004 - Material deterioration, cancellation, and expiry updates for prior actionable alerts.
 * @requirement AC-141 - Material invalidation or expiry of an actionable prior alert creates idempotent update/cancellation.
 */

import { createHash } from 'node:crypto';
import type {
  AlertCandidateInput,
  AlertLifecycleDecision,
  AlertPayload,
  AlertRecord,
  OutboxEntry,
} from './types.js';
import { computeAlertFingerprint } from './policy.js';

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

/**
 * Evaluate if a prior actionable alert requires a lifecycle update:
 * - OPPORTUNITY_EXPIRED when valid_until lapses
 * - THESIS_WEAKENING / RISK_ALERT when risk escalates, tradability fails, or thesis invalidation triggers
 * - THESIS_STRENGTHENING when independent confirmation improves thesis
 */
export const evaluateAlertLifecycle = (
  priorAlert: AlertRecord,
  currentCandidate: AlertCandidateInput | null,
  nowIso: string,
): {
  decision: AlertLifecycleDecision;
  updatePayload: AlertPayload | null;
  updateRecord: AlertRecord | null;
  outboxEntry: OutboxEntry | null;
} => {
  const nowMs = Date.parse(nowIso);
  const validUntilMs = Date.parse(priorAlert.validUntil);

  // If prior alert was not actionable (already expired/cancelled/deteriorated), no further update
  if (priorAlert.actionabilityState !== 'ACTIONABLE' && priorAlert.actionabilityState !== 'WATCH_ONLY') {
    return {
      decision: {
        transitionType: 'NONE',
        alertClass: priorAlert.alertClass,
        actionabilityState: priorAlert.actionabilityState,
        updateReason: 'PRIOR_ALERT_NOT_ACTIONABLE',
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: priorAlert.payload.materialEvidenceFingerprint,
        isIdempotentNoOp: true,
      },
      updatePayload: null,
      updateRecord: null,
      outboxEntry: null,
    };
  }

  // 1. Expiry Check: valid_until has lapsed (inclusive)
  if (nowMs >= validUntilMs) {
    const updateReason = `Opportunity validity lapsed at ${priorAlert.validUntil}`;
    const alertId = `alt_exp_${createHash('sha256').update(`${priorAlert.alertId}:expired:${nowIso}`).digest('hex').slice(0, 24)}`;
    const traceId = currentCandidate?.traceId ?? `trace_exp_${priorAlert.alertId}_${nowMs}`;
    const updateFingerprint = computeAlertFingerprint({
      assetId: priorAlert.assetId,
      profileId: priorAlert.payload.profileId,
      alertClass: 'OPPORTUNITY_EXPIRED',
      lifecycleState: 'ARCHIVED',
      riskState: priorAlert.payload.riskState,
      materialEvidenceFingerprint: priorAlert.payload.materialEvidenceFingerprint,
    });

    const updatePayload: AlertPayload = {
      ...priorAlert.payload,
      alertId,
      alertClass: 'OPPORTUNITY_EXPIRED',
      actionabilityState: 'EXPIRED',
      asOf: nowIso,
      validUntil: nowIso,
      parentAlertId: priorAlert.alertId,
      updateReason,
      shadowMode: priorAlert.shadowMode,
      traceId,
    };

    const canonicalJson = JSON.stringify(canonicalize(updatePayload));
    const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
    const bytes = new TextEncoder().encode(canonicalJson).byteLength;

    const updateRecord: AlertRecord = {
      alertId,
      assetId: priorAlert.assetId,
      alertClass: 'OPPORTUNITY_EXPIRED',
      actionabilityState: 'EXPIRED',
      fingerprint: updateFingerprint,
      validUntil: nowIso,
      payload: updatePayload,
      canonicalJson,
      sha256,
      bytes,
      createdAt: nowIso,
      shadowMode: priorAlert.shadowMode,
      traceId,
    };

    const outboxEntry: OutboxEntry = {
      id: `outbox_${alertId}`,
      topic: priorAlert.shadowMode ? 'alert.shadow.expired' : 'alert.production.expired',
      payloadJson: updatePayload as unknown as Record<string, unknown>,
      state: 'PENDING',
      attemptCount: 0,
      availableAt: nowIso,
      traceId,
    };

    return {
      decision: {
        transitionType: 'OPPORTUNITY_EXPIRED',
        alertClass: 'OPPORTUNITY_EXPIRED',
        actionabilityState: 'EXPIRED',
        updateReason,
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: priorAlert.payload.materialEvidenceFingerprint,
        isIdempotentNoOp: false,
      },
      updatePayload,
      updateRecord,
      outboxEntry,
    };
  }

  // If no new candidate observation, no update needed while within validity
  if (!currentCandidate) {
    return {
      decision: {
        transitionType: 'NONE',
        alertClass: priorAlert.alertClass,
        actionabilityState: priorAlert.actionabilityState,
        updateReason: 'VALID_AND_UNMODIFIED',
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: priorAlert.payload.materialEvidenceFingerprint,
        isIdempotentNoOp: true,
      },
      updatePayload: null,
      updateRecord: null,
      outboxEntry: null,
    };
  }

  // Check idempotency: if candidate evidence has not materially changed and no deterioration is present
  const isTradabilityDegraded = !currentCandidate.tradability.executable || currentCandidate.tradability.netReturnEstimate <= 0;
  const isScoreMateriallyDropped = priorAlert.payload.score !== null && currentCandidate.score !== null && currentCandidate.score < priorAlert.payload.score * 0.7;
  const isRiskStateEscalated = currentCandidate.riskState === 'CRITICAL' || currentCandidate.riskState === 'CONFLICTING' || (priorAlert.payload.riskState === 'LOW' && currentCandidate.riskState === 'HIGH');

  if (
    !isTradabilityDegraded &&
    !isScoreMateriallyDropped &&
    !isRiskStateEscalated &&
    currentCandidate.materialEvidenceFingerprint === priorAlert.payload.materialEvidenceFingerprint &&
    currentCandidate.riskState === priorAlert.payload.riskState &&
    currentCandidate.lifecycleState === priorAlert.payload.lifecycleState
  ) {
    return {
      decision: {
        transitionType: 'NONE',
        alertClass: priorAlert.alertClass,
        actionabilityState: priorAlert.actionabilityState,
        updateReason: 'IDENTICAL_EVIDENCE_FINGERPRINT',
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: priorAlert.payload.materialEvidenceFingerprint,
        isIdempotentNoOp: true,
      },
      updatePayload: null,
      updateRecord: null,
      outboxEntry: null,
    };
  }

  // 2. Deterioration Check: Critical risk escalated
  const isCriticalRisk =
    currentCandidate.riskState === 'CRITICAL' ||
    currentCandidate.riskState === 'CONFLICTING' ||
    currentCandidate.security.criticalSecurityEvents.length > 0;

  if (isCriticalRisk) {
    const updateReason = `Risk escalated to ${currentCandidate.riskState}: ${currentCandidate.security.criticalSecurityEvents.join(', ') || 'Critical security condition detected'}`;
    const alertId = `alt_risk_upd_${createHash('sha256').update(`${priorAlert.alertId}:risk:${nowIso}`).digest('hex').slice(0, 24)}`;
    const updateFingerprint = computeAlertFingerprint({
      assetId: priorAlert.assetId,
      profileId: priorAlert.payload.profileId,
      alertClass: 'RISK_ALERT',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
    });

    const updatePayload: AlertPayload = {
      ...priorAlert.payload,
      alertId,
      alertClass: 'RISK_ALERT',
      actionabilityState: 'CANCELLED',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      asOf: nowIso,
      parentAlertId: priorAlert.alertId,
      updateReason,
      riskSignals: currentCandidate.riskSignals.length > 0 ? currentCandidate.riskSignals : currentCandidate.security.criticalSecurityEvents,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const canonicalJson = JSON.stringify(canonicalize(updatePayload));
    const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
    const bytes = new TextEncoder().encode(canonicalJson).byteLength;

    const updateRecord: AlertRecord = {
      alertId,
      assetId: priorAlert.assetId,
      alertClass: 'RISK_ALERT',
      actionabilityState: 'CANCELLED',
      fingerprint: updateFingerprint,
      validUntil: priorAlert.validUntil,
      payload: updatePayload,
      canonicalJson,
      sha256,
      bytes,
      createdAt: nowIso,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const outboxEntry: OutboxEntry = {
      id: `outbox_${alertId}`,
      topic: currentCandidate.shadowMode ? 'alert.shadow.risk' : 'alert.production.risk',
      payloadJson: updatePayload as unknown as Record<string, unknown>,
      state: 'PENDING',
      attemptCount: 0,
      availableAt: nowIso,
      traceId: currentCandidate.traceId,
    };

    return {
      decision: {
        transitionType: 'RISK_ALERT',
        alertClass: 'RISK_ALERT',
        actionabilityState: 'CANCELLED',
        updateReason,
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
        isIdempotentNoOp: false,
      },
      updatePayload,
      updateRecord,
      outboxEntry,
    };
  }

  // 3. Thesis Weakening: Tradability failed or score dropped sharply or high risk
  const isTradabilityFailed = !currentCandidate.tradability.executable || currentCandidate.tradability.netReturnEstimate <= 0;
  const isScoreDropped = priorAlert.payload.score !== null && currentCandidate.score !== null && currentCandidate.score < priorAlert.payload.score * 0.7;
  const isRiskIncreased = (priorAlert.payload.riskState === 'LOW' || priorAlert.payload.riskState === 'UNKNOWN') && currentCandidate.riskState === 'HIGH';

  if (isTradabilityFailed || isScoreDropped || isRiskIncreased) {
    const reasons: string[] = [];
    if (isTradabilityFailed) reasons.push(`Tradability failure: ${currentCandidate.tradability.reason ?? 'non-executable'}`);
    if (isScoreDropped) reasons.push(`Score dropped from ${priorAlert.payload.score} to ${currentCandidate.score}`);
    if (isRiskIncreased) reasons.push(`Risk increased from ${priorAlert.payload.riskState} to ${currentCandidate.riskState}`);

    const updateReason = reasons.join('; ');
    const alertId = `alt_weak_${createHash('sha256').update(`${priorAlert.alertId}:weak:${nowIso}`).digest('hex').slice(0, 24)}`;
    const updateFingerprint = computeAlertFingerprint({
      assetId: priorAlert.assetId,
      profileId: priorAlert.payload.profileId,
      alertClass: 'THESIS_WEAKENING',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
    });

    const updatePayload: AlertPayload = {
      ...priorAlert.payload,
      alertId,
      alertClass: 'THESIS_WEAKENING',
      actionabilityState: 'DETERIORATED',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      score: currentCandidate.score,
      asOf: nowIso,
      parentAlertId: priorAlert.alertId,
      updateReason,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const canonicalJson = JSON.stringify(canonicalize(updatePayload));
    const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
    const bytes = new TextEncoder().encode(canonicalJson).byteLength;

    const updateRecord: AlertRecord = {
      alertId,
      assetId: priorAlert.assetId,
      alertClass: 'THESIS_WEAKENING',
      actionabilityState: 'DETERIORATED',
      fingerprint: updateFingerprint,
      validUntil: priorAlert.validUntil,
      payload: updatePayload,
      canonicalJson,
      sha256,
      bytes,
      createdAt: nowIso,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const outboxEntry: OutboxEntry = {
      id: `outbox_${alertId}`,
      topic: currentCandidate.shadowMode ? 'alert.shadow.weakening' : 'alert.production.weakening',
      payloadJson: updatePayload as unknown as Record<string, unknown>,
      state: 'PENDING',
      attemptCount: 0,
      availableAt: nowIso,
      traceId: currentCandidate.traceId,
    };

    return {
      decision: {
        transitionType: 'THESIS_WEAKENING',
        alertClass: 'THESIS_WEAKENING',
        actionabilityState: 'DETERIORATED',
        updateReason,
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
        isIdempotentNoOp: false,
      },
      updatePayload,
      updateRecord,
      outboxEntry,
    };
  }

  // 4. Thesis Strengthening: Score increased, lifecycle promoted from EMERGING to CONFIRMED, or new positive signals
  const isLifecyclePromoted = priorAlert.payload.alertClass === 'EARLY_WATCH' && currentCandidate.lifecycleState === 'CONFIRMED' && currentCandidate.decision === 'ALERT';
  const isScoreStrengthened = priorAlert.payload.score !== null && currentCandidate.score !== null && currentCandidate.score >= priorAlert.payload.score * 1.2;

  if (isLifecyclePromoted || isScoreStrengthened) {
    const updateReason = isLifecyclePromoted
      ? 'Candidate promoted from Early Watch to Confirmed Opportunity'
      : `Thesis strengthened: score increased from ${priorAlert.payload.score} to ${currentCandidate.score}`;

    const alertId = `alt_str_${createHash('sha256').update(`${priorAlert.alertId}:str:${nowIso}`).digest('hex').slice(0, 24)}`;
    const updateFingerprint = computeAlertFingerprint({
      assetId: priorAlert.assetId,
      profileId: priorAlert.payload.profileId,
      alertClass: 'THESIS_STRENGTHENING',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
    });

    const updatePayload: AlertPayload = {
      ...priorAlert.payload,
      alertId,
      alertClass: 'THESIS_STRENGTHENING',
      actionabilityState: 'ACTIONABLE',
      lifecycleState: currentCandidate.lifecycleState,
      riskState: currentCandidate.riskState,
      score: currentCandidate.score,
      asOf: nowIso,
      parentAlertId: priorAlert.alertId,
      updateReason,
      positiveSignals: currentCandidate.positiveSignals,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const canonicalJson = JSON.stringify(canonicalize(updatePayload));
    const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
    const bytes = new TextEncoder().encode(canonicalJson).byteLength;

    const updateRecord: AlertRecord = {
      alertId,
      assetId: priorAlert.assetId,
      alertClass: 'THESIS_STRENGTHENING',
      actionabilityState: 'ACTIONABLE',
      fingerprint: updateFingerprint,
      validUntil: priorAlert.validUntil,
      payload: updatePayload,
      canonicalJson,
      sha256,
      bytes,
      createdAt: nowIso,
      shadowMode: currentCandidate.shadowMode,
      traceId: currentCandidate.traceId,
    };

    const outboxEntry: OutboxEntry = {
      id: `outbox_${alertId}`,
      topic: currentCandidate.shadowMode ? 'alert.shadow.strengthening' : 'alert.production.strengthening',
      payloadJson: updatePayload as unknown as Record<string, unknown>,
      state: 'PENDING',
      attemptCount: 0,
      availableAt: nowIso,
      traceId: currentCandidate.traceId,
    };

    return {
      decision: {
        transitionType: 'THESIS_STRENGTHENING',
        alertClass: 'THESIS_STRENGTHENING',
        actionabilityState: 'ACTIONABLE',
        updateReason,
        parentAlertId: priorAlert.alertId,
        materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
        isIdempotentNoOp: false,
      },
      updatePayload,
      updateRecord,
      outboxEntry,
    };
  }

  // No material change
  return {
    decision: {
      transitionType: 'NONE',
      alertClass: priorAlert.alertClass,
      actionabilityState: priorAlert.actionabilityState,
      updateReason: 'NO_MATERIAL_CHANGE',
      parentAlertId: priorAlert.alertId,
      materialEvidenceFingerprint: currentCandidate.materialEvidenceFingerprint,
      isIdempotentNoOp: true,
    },
    updatePayload: null,
    updateRecord: null,
    outboxEntry: null,
  };
};
