/**
 * @requirement FR-ALERT-001 - Distinct routing and rendering policy per alert class.
 * @requirement FR-ALERT-002 - EARLY_WATCH rendering: explicit missing data, no high conviction language.
 * @requirement AC-140 - EARLY_WATCH and CONFIRMED_OPPORTUNITY separate presentation and routing.
 */

import type {
  AlertChannel,
  AlertPayload,
  AlertPriority,
  RenderedAlert,
} from './types.js';

const RESEARCH_DISCLAIMER =
  'DISCLAIMER: For research and educational intelligence purposes only. Not financial, investment, or trading advice. No guaranteed returns. All crypto transactions carry substantial financial risk.';

/**
 * Determines notification channel and dispatch priority based on alert class and shadow mode.
 */
export const determineAlertRouting = (
  payload: AlertPayload,
  isShadowMode = false,
): { channel: AlertChannel; priority: AlertPriority } => {
  if (payload.shadowMode || isShadowMode) {
    return { channel: 'shadow_log', priority: 'LOW' };
  }

  switch (payload.alertClass) {
    case 'RISK_ALERT':
      return { channel: 'telegram', priority: 'IMMEDIATE' };
    case 'CONFIRMED_OPPORTUNITY':
      return { channel: 'telegram', priority: 'HIGH' };
    case 'THESIS_WEAKENING':
    case 'OPPORTUNITY_EXPIRED':
      return { channel: 'telegram', priority: 'HIGH' };
    case 'EARLY_WATCH':
      return { channel: 'admin_inbox', priority: 'NORMAL' };
    case 'THESIS_STRENGTHENING':
      return { channel: 'admin_inbox', priority: 'NORMAL' };
    default:
      return { channel: 'admin_inbox', priority: 'NORMAL' };
  }
};

/**
 * Formats user-facing alert headline, markdown body, and disclaimer.
 * Suppresses positive headline if body reveals critical contradictions or expired actionability.
 */
export const renderAlert = (
  payload: AlertPayload,
  isShadowMode = false,
): RenderedAlert => {
  const { channel, priority } = determineAlertRouting(payload, isShadowMode);
  const renderedAt = new Date().toISOString();

  // Check contradiction / expiry conditions that mandate suppressing positive headlines
  const hasCriticalRisk = payload.riskState === 'CRITICAL' || payload.riskState === 'CONFLICTING';
  const isExpired = Date.parse(payload.asOf) > Date.parse(payload.validUntil) || payload.actionabilityState === 'EXPIRED';
  const isCancelled = payload.actionabilityState === 'CANCELLED' || payload.actionabilityState === 'DETERIORATED';

  let suppressed = false;
  let suppressionReason: string | undefined;

  let headline = '';
  const bodySections: string[] = [];

  const tokenLabel = payload.symbol ? `${payload.symbol} (${payload.contractAddress.slice(0, 8)}...)` : payload.contractAddress;

  switch (payload.alertClass) {
    case 'EARLY_WATCH': {
      headline = `[EARLY WATCH] ${tokenLabel} - Preliminary Observation`;
      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      bodySections.push(`*Status:* Emerging candidate under profile \`${payload.profileId}@${payload.profileVersion}\``);
      bodySections.push(`*Valid Until:* ${payload.validUntil} (Short TTL: Watch Only)`);
      bodySections.push(`\n*Preliminary Thesis:*\n${payload.thesis}`);
      bodySections.push(`\n*Counter-Thesis:*\n${payload.counterThesis}`);

      if (payload.missingData.length > 0) {
        bodySections.push(`\n*Explicit Missing Data / Information Gaps:*`);
        for (const item of payload.missingData) {
          bodySections.push(`- [${item.severity}] *${item.field}*: ${item.reason}`);
        }
      }

      if (payload.positiveSignals.length > 0) {
        bodySections.push(`\n*Observed Positive Signals:*\n${payload.positiveSignals.map((s) => `- ${s}`).join('\n')}`);
      }

      if (payload.riskSignals.length > 0) {
        bodySections.push(`\n*Observed Risk Signals:*\n${payload.riskSignals.map((s) => `- ${s}`).join('\n')}`);
      }

      bodySections.push(`\n_Notice: This is an EARLY WATCH notification. Deep security and liquidity verification are in progress. Do not treat as a confirmed opportunity._`);
      break;
    }

    case 'CONFIRMED_OPPORTUNITY': {
      headline = `[CONFIRMED OPPORTUNITY] ${tokenLabel} - Research Qualification Pass`;
      if (hasCriticalRisk || isExpired || isCancelled) {
        suppressed = true;
        suppressionReason = 'SUPPRESS_HEADLINE_ON_CRITICAL_RISK_OR_EXPIRY';
        headline = `[INVALIDATED OPPORTUNITY] ${tokenLabel} - Critical Conditions Present`;
      }

      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      bodySections.push(`*Profile:* \`${payload.profileId}@${payload.profileVersion}\` | Lifecycle: \`${payload.lifecycleState}\` | Risk: \`${payload.riskState}\``);
      bodySections.push(`*Detected At:* ${payload.asOf} | *Valid Until:* ${payload.validUntil}`);

      if (payload.score !== null) {
        bodySections.push(`*Deterministic Score:* ${payload.score.toFixed(4)}${payload.rank ? ` (Rank: #${payload.rank})` : ''}`);
      }

      if (payload.execution) {
        bodySections.push(`\n*Modeled Execution Impact:*`);
        bodySections.push(`- Configured Notional: $${payload.execution.notionalUsd}`);
        bodySections.push(`- Expected Slippage: ${payload.execution.expectedSlippageBps} bps`);
        bodySections.push(`- Estimated Fees: $${payload.execution.feeTotalUsd}`);
        bodySections.push(`- Net Return Estimate: ${(payload.execution.netReturnEstimate * 100).toFixed(2)}% (Modeled expectation, not guaranteed)`);
        if (payload.execution.maxExecutableNotionalUsd) {
          bodySections.push(`- Max Executable Notional: $${payload.execution.maxExecutableNotionalUsd}`);
        }
      }

      bodySections.push(`\n*Thesis:*\n${payload.thesis}`);
      bodySections.push(`\n*Counter-Thesis:*\n${payload.counterThesis}`);

      if (payload.positiveSignals.length > 0) {
        bodySections.push(`\n*Positive Evidence:*\n${payload.positiveSignals.map((s) => `- ${s}`).join('\n')}`);
      }

      if (payload.riskSignals.length > 0) {
        bodySections.push(`\n*Risk Assessment:*\n${payload.riskSignals.map((s) => `- ${s}`).join('\n')}`);
      }

      if (payload.thesisInvalidationConditions.length > 0) {
        bodySections.push(`\n*Thesis Invalidation Conditions:*\n${payload.thesisInvalidationConditions.map((c) => `- ${c}`).join('\n')}`);
      }

      if (payload.providerConflicts.length > 0) {
        bodySections.push(`\n*Provider Conflicts:*\n${payload.providerConflicts.map((c) => `- ${c}`).join('\n')}`);
      }
      break;
    }

    case 'THESIS_STRENGTHENING': {
      headline = `[THESIS UPDATE - STRENGTHENING] ${tokenLabel}`;
      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      bodySections.push(`*Parent Alert:* \`${payload.parentAlertId ?? 'unknown'}\``);
      bodySections.push(`*Update Reason:* ${payload.updateReason ?? 'Independent verification strengthened research thesis'}`);
      if (payload.score !== null) bodySections.push(`*Updated Score:* ${payload.score.toFixed(4)}`);
      bodySections.push(`\n*Thesis:*\n${payload.thesis}`);
      if (payload.positiveSignals.length > 0) {
        bodySections.push(`\n*Strengthening Evidence:*\n${payload.positiveSignals.map((s) => `- ${s}`).join('\n')}`);
      }
      break;
    }

    case 'THESIS_WEAKENING': {
      headline = `[THESIS UPDATE - DETERIORATION] ${tokenLabel}`;
      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      bodySections.push(`*Parent Alert:* \`${payload.parentAlertId ?? 'unknown'}\``);
      bodySections.push(`*Actionability:* \`${payload.actionabilityState}\``);
      bodySections.push(`*Deterioration Reason:* ${payload.updateReason ?? 'Thesis weakening conditions observed'}`);
      if (payload.score !== null) bodySections.push(`*Revised Score:* ${payload.score.toFixed(4)}`);
      if (payload.riskSignals.length > 0) {
        bodySections.push(`\n*Negative Drivers:*\n${payload.riskSignals.map((s) => `- ${s}`).join('\n')}`);
      }
      break;
    }

    case 'OPPORTUNITY_EXPIRED': {
      headline = `[OPPORTUNITY EXPIRED] ${tokenLabel}`;
      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      bodySections.push(`*Parent Alert:* \`${payload.parentAlertId ?? 'unknown'}\``);
      bodySections.push(`*Status:* Actionability window lapsed (${payload.validUntil})`);
      bodySections.push(`*Expiry Reason:* ${payload.updateReason ?? 'Configured actionability window expired'}`);
      break;
    }

    case 'RISK_ALERT': {
      headline = `[CRITICAL RISK ALERT] ${tokenLabel} - Immediate Caution`;
      bodySections.push(`*Asset:* \`${payload.contractAddress}\` on \`${payload.chainId}\``);
      if (payload.parentAlertId) bodySections.push(`*Prior Alert:* \`${payload.parentAlertId}\` (NOW CANCELLED)`);
      bodySections.push(`*Risk Level:* \`${payload.riskState}\``);
      bodySections.push(`*Trigger:* ${payload.updateReason ?? 'Critical security or pool hazard identified'}`);
      if (payload.riskSignals.length > 0) {
        bodySections.push(`\n*Critical Risk Evidence:*\n${payload.riskSignals.map((s) => `- [CRITICAL] ${s}`).join('\n')}`);
      }
      break;
    }
  }

  const body = bodySections.join('\n');

  return {
    alertId: payload.alertId,
    alertClass: payload.alertClass,
    channel,
    priority,
    headline,
    body,
    disclaimer: RESEARCH_DISCLAIMER,
    renderedAt,
    suppressed,
    suppressionReason,
    shadowMode: payload.shadowMode || isShadowMode,
  };
};
