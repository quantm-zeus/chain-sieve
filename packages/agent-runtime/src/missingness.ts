/**
 * @requirement FR-DATA-011 - Evidence acquisition states are distinct from substantive negative evidence
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY, not RETURNED_EMPTY, PROVIDER_UNAVAILABLE, or a negative feature value
 * @requirement INV-022 - Evidence not requested by policy is distinct from unavailable or negative evidence
 */

import type {
  EvidenceAcquisitionDecision,
  EvidenceAcquisitionState,
} from '@ciag/shared-schemas';

export const ALL_EVIDENCE_ACQUISITION_STATES: readonly EvidenceAcquisitionState[] = [
  'NOT_REQUESTED_BY_POLICY',
  'REQUESTED',
  'COST_BLOCKED',
  'QUOTA_BLOCKED',
  'RIGHTS_BLOCKED',
  'UNSUPPORTED',
  'PROVIDER_UNAVAILABLE',
  'FAILED',
  'RETURNED_EMPTY',
  'RETURNED',
] as const;

export const isEvidenceAcquisitionState = (
  value: unknown,
): value is EvidenceAcquisitionState =>
  typeof value === 'string' &&
  (ALL_EVIDENCE_ACQUISITION_STATES as readonly string[]).includes(value);

export const isSkippedByPolicy = (state: EvidenceAcquisitionState): boolean =>
  state === 'NOT_REQUESTED_BY_POLICY';

export const isBlockedBeforeRetrieval = (state: EvidenceAcquisitionState): boolean =>
  state === 'COST_BLOCKED' ||
  state === 'QUOTA_BLOCKED' ||
  state === 'RIGHTS_BLOCKED' ||
  state === 'UNSUPPORTED' ||
  state === 'NOT_REQUESTED_BY_POLICY';

export const isProviderUnavailableOrFailed = (state: EvidenceAcquisitionState): boolean =>
  state === 'PROVIDER_UNAVAILABLE' || state === 'FAILED';

export const isReturnedEmpty = (state: EvidenceAcquisitionState): boolean =>
  state === 'RETURNED_EMPTY';

export const isReturnedData = (state: EvidenceAcquisitionState): boolean =>
  state === 'RETURNED';

/**
 * Distinguishes affirmative substantive negative evidence (e.g. audit detected honeypot, blacklisted address, frozen mint)
 * from missing, unrequested, or unavailable evidence.
 */
export const isSubstantiveNegativeEvidence = (evidencePayload: unknown): boolean => {
  if (!evidencePayload || typeof evidencePayload !== 'object') return false;

  const rec = evidencePayload as Record<string, unknown>;
  const fields = (rec['normalizedFields'] ?? rec) as Record<string, unknown>;

  if (fields['isHoneypot'] === true) return true;
  if (fields['honeypotDetected'] === true) return true;
  if (fields['isBlacklisted'] === true) return true;
  if (fields['isScam'] === true) return true;
  if (fields['auditPassed'] === false) return true;
  if (fields['sellFeasible'] === false) return true;
  if (fields['risk'] === 'CRITICAL' || fields['risk'] === 'HIGH_RISK_DETECTED') return true;
  if (typeof fields['rugPullHistoryCount'] === 'number' && fields['rugPullHistoryCount'] > 0) return true;
  if (typeof fields['taxBps'] === 'number' && fields['taxBps'] > 5000) return true; // >50% tax

  return false;
};

export interface ImputeFeatureOptions {
  featureId: string;
  acquisitionState: EvidenceAcquisitionState;
  rawValue?: number | null | undefined;
  fallbackValue?: number | null | undefined;
}

export interface ImputedFeatureResult {
  value: number | null;
  quality: 'VALID' | 'INSUFFICIENT_DATA' | 'NOT_REQUESTED' | 'PROVIDER_UNAVAILABLE' | 'FAILED' | 'EMPTY';
  isNegativeImputation: false; // Must ALWAYS be false per AC-242 / INV-022
}

/**
 * Safely resolves a feature value with strict missingness guarantees.
 * Skipped evidence (NOT_REQUESTED_BY_POLICY) is NEVER imputed with negative values or penalties.
 */
export const imputeFeatureWithMissingnessPolicy = (
  options: ImputeFeatureOptions,
): ImputedFeatureResult => {
  const { acquisitionState, rawValue } = options;

  switch (acquisitionState) {
    case 'RETURNED': {
      if (rawValue !== undefined && rawValue !== null && Number.isFinite(rawValue)) {
        return {
          value: rawValue,
          quality: 'VALID',
          isNegativeImputation: false,
        };
      }
      return {
        value: null,
        quality: 'INSUFFICIENT_DATA',
        isNegativeImputation: false,
      };
    }

    case 'NOT_REQUESTED_BY_POLICY': {
      // AC-242 / INV-022: skipped evidence cannot be inferred as absent or unfavorable,
      // and is excluded from negative-feature imputation.
      return {
        value: null,
        quality: 'NOT_REQUESTED',
        isNegativeImputation: false,
      };
    }

    case 'RETURNED_EMPTY': {
      return {
        value: null,
        quality: 'EMPTY',
        isNegativeImputation: false,
      };
    }

    case 'PROVIDER_UNAVAILABLE': {
      return {
        value: null,
        quality: 'PROVIDER_UNAVAILABLE',
        isNegativeImputation: false,
      };
    }

    case 'FAILED': {
      return {
        value: null,
        quality: 'FAILED',
        isNegativeImputation: false,
      };
    }

    case 'COST_BLOCKED':
    case 'QUOTA_BLOCKED':
    case 'RIGHTS_BLOCKED':
    case 'UNSUPPORTED':
    case 'REQUESTED':
    default: {
      return {
        value: null,
        quality: 'INSUFFICIENT_DATA',
        isNegativeImputation: false,
      };
    }
  }
};

/**
 * Validates AC-242 and INV-022 invariants:
 * 1. NOT_REQUESTED_BY_POLICY is never stored as RETURNED_EMPTY or PROVIDER_UNAVAILABLE.
 * 2. Feature values derived from NOT_REQUESTED_BY_POLICY evidence are not mapped to negative values.
 */
export const assertMissingnessInvariants = (
  decision: EvidenceAcquisitionDecision,
  featureValues?: Record<string, number | null | undefined>,
): void => {
  // Invariant 1: State must be one of the exact 10 states
  if (!isEvidenceAcquisitionState(decision.state)) {
    throw new Error(`INVALID_ACQUISITION_STATE: "${decision.state}" is not a valid acquisition state`);
  }

  // Invariant 2: If skipped by policy, state must be NOT_REQUESTED_BY_POLICY (not empty or provider error)
  const isSkippedInReason = decision.reasonCodes.some(
    (r) => r.includes('SKIPPED') || r.includes('NOT_REQUESTED') || r.includes('VOI_BELOW_THRESHOLD'),
  );

  if (isSkippedInReason && (decision.state === 'RETURNED_EMPTY' || decision.state === 'PROVIDER_UNAVAILABLE')) {
    throw new Error(
      `AC_242_VIOLATION: Skipped evidence cannot be stored as "${decision.state}", must be NOT_REQUESTED_BY_POLICY`,
    );
  }

  // Invariant 3: Excluded from negative feature imputation
  if (decision.state === 'NOT_REQUESTED_BY_POLICY' && featureValues) {
    for (const [key, val] of Object.entries(featureValues)) {
      if (val !== null && val !== undefined && typeof val === 'number' && val < 0) {
        throw new Error(
          `INV_022_VIOLATION: Feature "${key}" for NOT_REQUESTED_BY_POLICY evidence family "${decision.evidenceFamily}" was imputed with negative value ${val}`,
        );
      }
    }
  }
};
