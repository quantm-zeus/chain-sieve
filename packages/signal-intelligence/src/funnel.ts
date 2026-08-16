/**
 * @requirement FR-SIG-002 - Candidate funnel and independent vectors
 * @requirement FR-SIG-009 - Bounded deterministic features (via FeatureSet)
 * @requirement AC-240 - Symmetric decision/action time: funnel does not invent earlier delivery
 *
 * Deterministic candidate funnel that selects, ranks, and records eligible
 * opportunities from canonical features.
 *
 * - Eligibility, ordering, tie-breaking, and rejection reasons are deterministic and inspectable.
 * - Emits no candidate when required feature or adapter evidence is unavailable.
 * - Deterministic ordering: score desc, assetId asc (lexicographic), asOf asc.
 * - Boundary eligibility is inclusive: score == threshold passes.
 */

import { createHash } from 'node:crypto';
import type { FeatureSet, FeatureValue } from './features.js';
import { FeatureValidationError } from './features.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FunnelValidationError extends Error {
  constructor(
    public readonly code:
      | 'FUNNEL_MALFORMED'
      | 'FUNNEL_INCOMPLETE'
      | 'FUNNEL_INCONSISTENT',
    message: string,
  ) {
    super(message);
    this.name = 'FunnelValidationError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FunnelAdapterEvidence {
  poolId: string;
  adapterVersion: string;
  available: boolean;
  verified: boolean;
}

export interface FunnelInput {
  assetId: string;
  chainId: string;
  asOf: string; // ISO datetime, must equal featureSet.asOf
  featureSet: FeatureSet;
  adapterEvidence: FunnelAdapterEvidence | null;
}

export interface FunnelProfile {
  version: string; // e.g. "1.0.0"
  requiredFeatureIds: string[]; // at least one, deterministic order not required (sorted internally)
  featureWeights: Record<string, number>; // weight per featureId; missing => 1.0
  minScore?: number | null; // inclusive threshold; null => no threshold
}

export interface FunnelComponentValue {
  featureId: string;
  version: string;
  value: number;
  weight: number;
  contribution: number;
  quality: string;
}

export interface FunnelCandidate {
  assetId: string;
  chainId: string;
  asOf: string;
  eligible: boolean;
  score: number | null; // null when ineligible
  rank: number | null; // 1-indexed among eligible, null when rejected
  rejectionReasons: string[]; // deterministic sorted, inspectable
  componentValues: FunnelComponentValue[];
  featureSetHash: string;
  adapterEvidence: FunnelAdapterEvidence | null;
}

export interface FunnelOutput {
  funnelVersion: string;
  profileVersion: string;
  asOf: string; // max asOf among inputs or provided runAsOf
  eligibleCount: number;
  rejectedCount: number;
  candidates: FunnelCandidate[]; // all inputs, eligible first ordered by rank, then rejected ordered by assetId
  orderedEligibleAssetIds: string[]; // deterministic order of eligible
  sha256: string; // hash of canonical funnel output (without sha256 field itself)
  canonicalJson: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isValidIso = (v: string): boolean => ISO_DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));

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

const validateFunnelInput = (input: unknown): FunnelInput => {
  if (input === null || typeof input !== 'object')
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'INPUT_NOT_OBJECT');
  const i = input as Record<string, unknown>;
  for (const key of ['assetId', 'chainId', 'asOf', 'featureSet'] as const) {
    if (!(key in i) || i[key] === undefined || i[key] === null)
      throw new FunnelValidationError('FUNNEL_INCOMPLETE', `MISSING_${key}`);
  }
  if (typeof i.assetId !== 'string' || i.assetId.length === 0)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'ASSET_ID_MALFORMED');
  if (typeof i.chainId !== 'string' || i.chainId.length === 0)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'CHAIN_ID_MALFORMED');
  if (typeof i.asOf !== 'string' || !isValidIso(i.asOf))
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'AS_OF_MALFORMED');
  if (typeof i.featureSet !== 'object' || i.featureSet === null)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_SET_MALFORMED');

  const fs = i.featureSet as Record<string, unknown>;
  if (typeof fs.assetId !== 'string' || fs.assetId.length === 0)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_SET_ASSET_ID_MALFORMED');
  if (typeof fs.asOf !== 'string' || !isValidIso(fs.asOf))
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_SET_AS_OF_MALFORMED');
  if (!Array.isArray(fs.features))
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURES_NOT_ARRAY');

  // assetId/asOf consistency
  if (fs.assetId !== i.assetId)
    throw new FunnelValidationError('FUNNEL_INCONSISTENT', 'ASSET_ID_MISMATCH');
  if (fs.asOf !== i.asOf)
    throw new FunnelValidationError('FUNNEL_INCONSISTENT', 'AS_OF_MISMATCH');

  // validate adapterEvidence if present
  if (i.adapterEvidence !== null && i.adapterEvidence !== undefined) {
    const ev = i.adapterEvidence as Record<string, unknown>;
    if (typeof ev.poolId !== 'string' || ev.poolId.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'ADAPTER_POOL_ID_MALFORMED');
    if (typeof ev.adapterVersion !== 'string' || ev.adapterVersion.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'ADAPTER_VERSION_MALFORMED');
    if (typeof ev.available !== 'boolean')
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'ADAPTER_AVAILABLE_MALFORMED');
    if (typeof ev.verified !== 'boolean')
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'ADAPTER_VERIFIED_MALFORMED');
  }

  // Validate each feature value shape (reuse feature validation semantics but lightweight)
  for (const f of fs.features as unknown[]) {
    const fv = f as Record<string, unknown>;
    if (typeof fv.featureId !== 'string' || fv.featureId.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_ID_MALFORMED');
    if (typeof fv.version !== 'string' || fv.version.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_VERSION_MALFORMED');
    if (fv.value !== null && (typeof fv.value !== 'number' || !Number.isFinite(fv.value as number)))
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_VALUE_MALFORMED');
    if (typeof fv.quality !== 'string' || fv.quality.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_QUALITY_MALFORMED');
  }

  // Check duplicate featureIds
  const ids = (fs.features as Array<{ featureId: string; version: string }>).map(
    (f) => `${f.featureId}:${f.version}`,
  );
  if (new Set(ids).size !== ids.length)
    throw new FunnelValidationError('FUNNEL_INCONSISTENT', 'DUPLICATE_FEATURE_ID');

  return i as unknown as FunnelInput;
};

const validateProfile = (profile: unknown): FunnelProfile => {
  if (profile === null || typeof profile !== 'object')
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'PROFILE_NOT_OBJECT');
  const p = profile as Record<string, unknown>;
  if (typeof p.version !== 'string' || p.version.length === 0)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'PROFILE_VERSION_MALFORMED');
  if (!Array.isArray(p.requiredFeatureIds) || p.requiredFeatureIds.length === 0)
    throw new FunnelValidationError('FUNNEL_INCOMPLETE', 'REQUIRED_FEATURE_IDS_MISSING');
  for (const id of p.requiredFeatureIds as unknown[]) {
    if (typeof id !== 'string' || id.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'REQUIRED_FEATURE_ID_MALFORMED');
  }
  // duplicate required ids
  const req = p.requiredFeatureIds as string[];
  if (new Set(req).size !== req.length)
    throw new FunnelValidationError('FUNNEL_INCONSISTENT', 'DUPLICATE_REQUIRED_FEATURE_ID');
  if (typeof p.featureWeights !== 'object' || p.featureWeights === null)
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_WEIGHTS_MALFORMED');
  for (const [k, v] of Object.entries(p.featureWeights as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0)
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_WEIGHT_KEY_MALFORMED');
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new FunnelValidationError('FUNNEL_MALFORMED', 'FEATURE_WEIGHT_VALUE_MALFORMED');
  }
  if (p.minScore !== undefined && p.minScore !== null && (typeof p.minScore !== 'number' || !Number.isFinite(p.minScore as number)))
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'MIN_SCORE_MALFORMED');
  return p as unknown as FunnelProfile;
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

const FUNNEL_VERSION = '1.0.0';

const featureSetHash = (featureSet: FeatureSet): string => {
  // Deterministic hash via canonical JSON of featureSet (features already sorted)
  // Reuse canonical logic: sort keys and features by featureId
  const sortedFeatures = [...featureSet.features].sort((a, b) => {
    const cmp = a.featureId.localeCompare(b.featureId);
    if (cmp !== 0) return cmp;
    return a.version.localeCompare(b.version);
  });
  const canonical = canonicalize({ ...featureSet, features: sortedFeatures });
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
};

const evaluateEligibility = (
  input: FunnelInput,
  profile: FunnelProfile,
): { eligible: boolean; score: number | null; reasons: string[]; components: FunnelComponentValue[] } => {
  const reasons: string[] = [];
  const components: FunnelComponentValue[] = [];

  // Check adapter evidence first: required
  const ev = input.adapterEvidence;
  if (ev === null || ev === undefined) {
    reasons.push('ADAPTER_EVIDENCE_UNAVAILABLE');
  } else if (ev.available !== true || ev.verified !== true) {
    reasons.push('ADAPTER_EVIDENCE_UNAVAILABLE');
  }

  // Build feature map for quick lookup (keyed by featureId ignoring version for required check)
  const featureMap = new Map<string, FeatureValue>();
  for (const f of input.featureSet.features) {
    // Use latest version per featureId if duplicates across versions shouldn't happen; key by featureId
    if (!featureMap.has(f.featureId)) featureMap.set(f.featureId, f);
  }

  // Required feature gates
  for (const reqId of [...profile.requiredFeatureIds].sort()) {
    const fv = featureMap.get(reqId);
    if (!fv) {
      reasons.push(`MISSING_REQUIRED_FEATURE:${reqId}`);
      continue;
    }
    if (fv.value === null || fv.value === undefined) {
      // Distinguish by quality if available
      if (fv.quality === 'INSUFFICIENT_DATA') reasons.push(`INSUFFICIENT_DATA:${reqId}`);
      else if (fv.quality === 'STALE') reasons.push(`STALE_FEATURE:${reqId}`);
      else if (fv.quality === 'LOW_SAMPLE') reasons.push(`LOW_SAMPLE:${reqId}`);
      else reasons.push(`MISSING_REQUIRED_FEATURE:${reqId}`);
      continue;
    }
    if (fv.quality === 'INSUFFICIENT_DATA') reasons.push(`INSUFFICIENT_DATA:${reqId}`);
    else if (fv.quality === 'STALE') reasons.push(`STALE_FEATURE:${reqId}`);
    // LOW_SAMPLE is considered reject for required features (boundary)
    else if (fv.quality === 'LOW_SAMPLE') reasons.push(`LOW_SAMPLE:${reqId}`);
  }

  // If any hard rejection, not eligible (no score)
  if (reasons.length > 0) {
    // Still populate components for inspectability (with zero contribution for missing)
    for (const reqId of [...profile.requiredFeatureIds].sort()) {
      const fv = featureMap.get(reqId);
      if (fv && fv.value !== null) {
        const weight = profile.featureWeights[reqId] ?? 1.0;
        components.push({
          featureId: fv.featureId,
          version: fv.version,
          value: fv.value,
          weight,
          contribution: fv.value * weight,
          quality: fv.quality,
        });
      }
    }
    // Sort components deterministically
    components.sort((a, b) => a.featureId.localeCompare(b.featureId));
    return { eligible: false, score: null, reasons: [...new Set(reasons)].sort(), components };
  }

  // Compute score: weighted sum across required features (deterministic)
  let score = 0;
  for (const reqId of [...profile.requiredFeatureIds].sort()) {
    const fv = featureMap.get(reqId)!;
    const weight = profile.featureWeights[reqId] ?? 1.0;
    const contribution = (fv.value as number) * weight;
    score += contribution;
    components.push({
      featureId: fv.featureId,
      version: fv.version,
      value: fv.value as number,
      weight,
      contribution,
      quality: fv.quality,
    });
  }
  components.sort((a, b) => a.featureId.localeCompare(b.featureId));

  // Threshold gate (inclusive boundary)
  if (profile.minScore !== null && profile.minScore !== undefined) {
    if (score < profile.minScore) {
      reasons.push('SCORE_BELOW_THRESHOLD');
      return { eligible: false, score, reasons: reasons.sort(), components };
    }
    // score == minScore is eligible (inclusive)
  }

  return { eligible: true, score, reasons: [], components };
};

/**
 * Deterministic candidate funnel.
 * - Input order does not affect output order.
 * - Eligibility, ordering, tie-breaking, rejection reasons are deterministic and inspectable.
 * - Returns no eligible candidate when required feature or adapter evidence is unavailable for all.
 */
export const runFunnel = (
  inputs: readonly FunnelInput[],
  profile: FunnelProfile,
  runAsOf?: string,
): FunnelOutput => {
  if (!Array.isArray(inputs))
    throw new FunnelValidationError('FUNNEL_MALFORMED', 'INPUTS_NOT_ARRAY');
  const validatedProfile = validateProfile(profile);
  if (inputs.length === 0)
    throw new FunnelValidationError('FUNNEL_INCOMPLETE', 'INPUTS_EMPTY');

  // Validate each input deterministically
  const validatedInputs: FunnelInput[] = inputs.map(validateFunnelInput);

  // Deterministic asOf for output: use runAsOf if provided else max asOf among inputs
  const outputAsOf =
    runAsOf !== undefined
      ? (() => {
          if (!isValidIso(runAsOf)) throw new FunnelValidationError('FUNNEL_MALFORMED', 'RUN_AS_OF_MALFORMED');
          return runAsOf;
        })()
      : validatedInputs.map((i) => i.asOf).sort().at(-1)!;

  // Evaluate each candidate
  const evaluated: FunnelCandidate[] = validatedInputs.map((input) => {
    const { eligible, score, reasons, components } = evaluateEligibility(input, validatedProfile);
    return {
      assetId: input.assetId,
      chainId: input.chainId,
      asOf: input.asOf,
      eligible,
      score,
      rank: null, // assigned after sorting
      rejectionReasons: reasons,
      componentValues: components,
      featureSetHash: featureSetHash(input.featureSet),
      adapterEvidence: input.adapterEvidence,
    };
  });

  // Separate eligible and rejected
  const eligible = evaluated.filter((c) => c.eligible);
  const rejected = evaluated.filter((c) => !c.eligible);

  // Deterministic ordering for eligible: score desc, assetId asc, asOf asc, featureSetHash asc
  eligible.sort((a, b) => {
    const scoreA = a.score as number;
    const scoreB = b.score as number;
    if (scoreA !== scoreB) return scoreB - scoreA; // desc
    const idCmp = a.assetId.localeCompare(b.assetId);
    if (idCmp !== 0) return idCmp;
    const asOfCmp = a.asOf.localeCompare(b.asOf);
    if (asOfCmp !== 0) return asOfCmp;
    return a.featureSetHash.localeCompare(b.featureSetHash);
  });

  // Assign ranks deterministically (1-indexed)
  eligible.forEach((c, idx) => {
    c.rank = idx + 1;
  });

  // Rejected ordered deterministically by assetId asc, asOf asc
  rejected.sort((a, b) => {
    const idCmp = a.assetId.localeCompare(b.assetId);
    if (idCmp !== 0) return idCmp;
    return a.asOf.localeCompare(b.asOf);
  });

  // Final candidate list: eligible in rank order, then rejected in deterministic order
  const allCandidates: FunnelCandidate[] = [...eligible, ...rejected];

  // Build canonical output (excluding sha256/bytes/canonicalJson from hash input would be circular,
  // so we hash a canonicalized object without those fields)
  const baseOutput = {
    funnelVersion: FUNNEL_VERSION,
    profileVersion: validatedProfile.version,
    asOf: outputAsOf,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
    candidates: allCandidates,
    orderedEligibleAssetIds: eligible.map((c) => c.assetId),
  };

  const canonicalJson = JSON.stringify(canonicalize(baseOutput));
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;
  const sha256 = createHash('sha256').update(canonicalJson).digest('hex');

  return {
    funnelVersion: FUNNEL_VERSION,
    profileVersion: validatedProfile.version,
    asOf: outputAsOf,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
    candidates: allCandidates,
    orderedEligibleAssetIds: eligible.map((c) => c.assetId),
    sha256,
    canonicalJson,
    bytes,
  };
};

// ---------------------------------------------------------------------------
// Helpers for tests / external use
// ---------------------------------------------------------------------------

export const DEFAULT_FUNNEL_PROFILE: FunnelProfile = {
  version: '1.0.0',
  requiredFeatureIds: ['volume_acceleration', 'liquidity_growth'],
  featureWeights: {
    volume_acceleration: 1.0,
    liquidity_growth: 1.0,
    trade_entropy: 0.5,
    liquidity_drawdown: -1.0,
  },
  minScore: null,
};

export const funnelEligibleAssetIds = (output: FunnelOutput): string[] => [...output.orderedEligibleAssetIds];

export const funnelRejectedWithReason = (output: FunnelOutput, reasonPrefix: string): FunnelCandidate[] =>
  output.candidates.filter((c) => !c.eligible && c.rejectionReasons.some((r) => r.startsWith(reasonPrefix)));
