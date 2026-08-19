/**
 * @requirement FR-ALERT-002 - EARLY_WATCH guardrails: short TTL, explicit missing data, and no high-conviction language.
 * @requirement FR-ALERT-003 - Confirmed alert semantic validation and guardrails.
 * @requirement AC-140 - EARLY_WATCH language and policy separation.
 * @requirement AC-143 - Direct model notification prohibition.
 */

import type { AlertPayload, MissingDataItem } from './types.js';

const FORBIDDEN_HIGH_CONVICTION_PATTERNS: RegExp[] = [
  /\b(strong buy|buy now|guaranteed profit|guaranteed return|can't lose|moonshot guaranteed|100x gem|1000x gem|sure thing|massive breakout|high conviction|certain profit|risk-free|free money|target return)\b/i,
  /\b(guaranteed\s+\d+x|easy\s+\d+x)\b/i,
  /\b(100%\s+guaranteed|100%\s+win)\b/i,
];

/**
 * Check if a text contains unpermitted high-conviction, certainty, or financial advisory language.
 */
export const containsHighConvictionLanguage = (text: string): boolean => {
  if (!text) return false;
  return FORBIDDEN_HIGH_CONVICTION_PATTERNS.some((pattern) => pattern.test(text));
};

/**
 * Assert that text does not contain high-conviction or forbidden phrases.
 * Throws an error if violation is detected.
 */
export const assertNoHighConvictionLanguage = (text: string, context = 'Alert content'): void => {
  for (const pattern of FORBIDDEN_HIGH_CONVICTION_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`HIGH_CONVICTION_LANGUAGE_PROHIBITED: ${context} contains forbidden phrase matching "${pattern.source}"`);
    }
  }
};

/**
 * Assert that notification source is strictly deterministic alert policy, never raw model output.
 */
export const assertNotificationSource = (source: 'DETERMINISTIC_POLICY' | 'MODEL_OUTPUT'): void => {
  if (source === 'MODEL_OUTPUT') {
    throw new Error('MODEL_DIRECT_NOTIFICATION_PROHIBITED: Alerts must pass deterministic policy validation');
  }
};

/**
 * Validate EARLY_WATCH guardrails:
 * 1. Short TTL (duration <= ttlMinutesLimit)
 * 2. Explicit missing data entries (at least 1 missing data item with field, reason, severity)
 * 3. No high-conviction language in thesis or signals
 */
export const validateEarlyWatchGuardrails = (input: {
  asOf: string;
  validUntil: string;
  missingData: MissingDataItem[];
  thesis: string;
  counterThesis?: string;
  positiveSignals?: string[];
  ttlMinutesLimit?: number;
}): { valid: boolean; violations: string[] } => {
  const violations: string[] = [];
  const ttlLimitMinutes = input.ttlMinutesLimit ?? 30;

  const startMs = Date.parse(input.asOf);
  const endMs = Date.parse(input.validUntil);

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    violations.push('INVALID_ISO_TIMESTAMP');
  } else {
    const durationMinutes = (endMs - startMs) / (60 * 1000);
    if (durationMinutes <= 0) {
      violations.push('VALID_UNTIL_MUST_BE_AFTER_AS_OF');
    }
    // Allow slight float tolerance (0.1 min)
    if (durationMinutes > ttlLimitMinutes + 0.1) {
      violations.push(`EARLY_WATCH_TTL_EXCEEDS_LIMIT:${durationMinutes}m_max_${ttlLimitMinutes}m`);
    }
  }

  if (!Array.isArray(input.missingData) || input.missingData.length === 0) {
    violations.push('EARLY_WATCH_EXPLICIT_MISSING_DATA_REQUIRED');
  } else {
    for (const item of input.missingData) {
      if (!item.field || item.field.trim().length === 0) {
        violations.push('MISSING_DATA_FIELD_REQUIRED');
      }
      if (!item.reason || item.reason.trim().length === 0) {
        violations.push('MISSING_DATA_REASON_REQUIRED');
      }
      if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(item.severity)) {
        violations.push('MISSING_DATA_SEVERITY_INVALID');
      }
    }
  }

  if (containsHighConvictionLanguage(input.thesis)) {
    violations.push('EARLY_WATCH_HIGH_CONVICTION_THESIS_PROHIBITED');
  }

  if (input.counterThesis && containsHighConvictionLanguage(input.counterThesis)) {
    violations.push('EARLY_WATCH_HIGH_CONVICTION_COUNTER_THESIS_PROHIBITED');
  }

  if (input.positiveSignals) {
    for (const sig of input.positiveSignals) {
      if (containsHighConvictionLanguage(sig)) {
        violations.push(`EARLY_WATCH_HIGH_CONVICTION_SIGNAL_PROHIBITED:${sig}`);
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
};

/**
 * Validate general semantic integrity of an alert payload before serialization / rendering.
 */
export const validateAlertSemanticIntegrity = (
  payload: AlertPayload,
  maxTtlMinutes = 1440,
  earlyWatchTtlMinutes = 30,
): { valid: boolean; violations: string[] } => {
  const violations: string[] = [];

  // Check timestamp ordering
  const asOfMs = Date.parse(payload.asOf);
  const validUntilMs = Date.parse(payload.validUntil);

  if (Number.isNaN(asOfMs) || Number.isNaN(validUntilMs)) {
    violations.push('INVALID_ISO_TIMESTAMPS');
  } else if (asOfMs > validUntilMs) {
    violations.push('AS_OF_AFTER_VALID_UNTIL');
  } else if ((validUntilMs - asOfMs) / (60 * 1000) > maxTtlMinutes) {
    violations.push(`ALERT_TTL_EXCEEDS_MAX_LIMIT:${(validUntilMs - asOfMs) / (60 * 1000)}m_max_${maxTtlMinutes}m`);
  }

  // Check high conviction language across all classes
  if (containsHighConvictionLanguage(payload.thesis)) {
    violations.push('HIGH_CONVICTION_LANGUAGE_DETECTED_IN_THESIS');
  }

  // Early watch specific checks
  if (payload.alertClass === 'EARLY_WATCH') {
    if (payload.actionabilityState !== 'WATCH_ONLY') {
      violations.push('EARLY_WATCH_ACTIONABILITY_MUST_BE_WATCH_ONLY');
    }
    const ewCheck = validateEarlyWatchGuardrails({
      asOf: payload.asOf,
      validUntil: payload.validUntil,
      missingData: payload.missingData,
      thesis: payload.thesis,
      counterThesis: payload.counterThesis,
      positiveSignals: payload.positiveSignals,
      ttlMinutesLimit: earlyWatchTtlMinutes,
    });
    violations.push(...ewCheck.violations);
  }

  // Critical risk checks: Risk alerts must have risk state HIGH/CRITICAL/CONFLICTING
  if (payload.alertClass === 'RISK_ALERT') {
    if (payload.riskState !== 'HIGH' && payload.riskState !== 'CRITICAL' && payload.riskState !== 'CONFLICTING') {
      violations.push('RISK_ALERT_REQUIRES_ELEVATED_RISK_STATE');
    }
  }

  // Confirmed opportunity checks: Risk state cannot be CRITICAL or CONFLICTING
  if (payload.alertClass === 'CONFIRMED_OPPORTUNITY') {
    if (payload.riskState === 'CRITICAL' || payload.riskState === 'CONFLICTING') {
      violations.push('CONFIRMED_OPPORTUNITY_CANNOT_HAVE_CRITICAL_OR_CONFLICTING_RISK');
    }
    if (payload.actionabilityState !== 'ACTIONABLE') {
      violations.push('CONFIRMED_OPPORTUNITY_MUST_BE_ACTIONABLE');
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
};
