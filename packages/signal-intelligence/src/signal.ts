/**
 * @requirement FR-TRACE-002 - Globally unique, stable, immutable signal IDs; replaced only via explicit supersession.
 * @requirement FR-TRACE-005 - Every decision stores exact requirement/policy/feature/model/tool/provider/adapter/artifact versions.
 * @requirement AC-267 - Every decision/alert traces to document/manifest hash, release, migration, policy, feature, model, tool, provider, pool adapter, evidence, alpha versions.
 *
 * Immutable, attributable signal materialization from funnel candidates.
 *
 * - Every materialized signal identifies its canonical inputs, feature version, adapter provenance, and funnel decision.
 * - Duplicate evaluation of the same candidate and inputs is idempotent (deterministic id/hash).
 * - Invalid or incomplete candidate evidence cannot materialize a signal (fail-closed).
 *
 * Design: deterministic canonical JSON + sha256 + byte length, matching snapshot/feature/funnel patterns.
 * - Input ordering and key ordering do not affect output bytes.
 * - Volatile wall-clock is NOT included in the canonical payload; materializedAt is deterministic (defaults to asOf) so duplicate evaluations produce identical signalId/sha256.
 * - All validation maps to typed codes: SIGNAL_MALFORMED / SIGNAL_INCOMPLETE / SIGNAL_INCONSISTENT
 */

import { createHash } from 'node:crypto';
import type { FeatureSet } from './features.js';
import { validateSnapshot, canonicalSnapshotBytes } from './snapshot.js';
import type { MarketSnapshot } from './snapshot.js';
import type { FunnelCandidate, FunnelProfile, FunnelAdapterEvidence } from './funnel.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SignalMaterializationError extends Error {
  constructor(
    public readonly code: 'SIGNAL_MALFORMED' | 'SIGNAL_INCOMPLETE' | 'SIGNAL_INCONSISTENT',
    message: string,
  ) {
    super(message);
    this.name = 'SignalMaterializationError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalProvenance {
  /** Feature versions keyed by featureId -> version */
  featureVersions: Record<string, string>;
  /** Adapter provenance */
  adapter: {
    poolId: string;
    adapterVersion: string;
    available: boolean;
    verified: boolean;
  };
  /** Funnel decision provenance */
  funnel: {
    funnelVersion: string;
    profileVersion: string;
    eligible: boolean;
    score: number;
    rank: number;
    rejectionReasons: string[];
  };
  /** Canonical input provenance */
  inputs: {
    snapshotId: string | null;
    snapshotHash: string;
    featureSetHash: string;
    observationIds: string[];
    evidenceHashes: string[];
    collectedAt: string | null;
  };
  /** Code/registry versions for traceability (AC-267) */
  codeVersion: string;
  canonicalSnapshotBytes: number | null;
  canonicalFeatureSetBytes: number | null;
}

export interface SignalCanonicalInputs {
  snapshotHash: string;
  featureSetHash: string;
  featureVersions: Record<string, string>;
  adapterPoolId: string;
  adapterVersion: string;
}

export interface SignalFunnelDecision {
  funnelVersion: string;
  profileVersion: string;
  eligible: boolean;
  score: number;
  rank: number;
  componentValues: FunnelCandidate['componentValues'];
  rejectionReasons: string[];
}

export interface SignalRecord {
  /** Deterministic unique id: sig_<first 32 hex of sha256> derived from canonical payload */
  signalId: string;
  assetId: string;
  chainId: string;
  asOf: string;
  /** Deterministic materialization timestamp (defaults to asOf for idempotency) */
  materializedAt: string;
  /** Canonical inputs hash references */
  canonicalInputs: SignalCanonicalInputs;
  /** Feature version map */
  featureVersions: Record<string, string>;
  /** Adapter provenance */
  adapterProvenance: {
    poolId: string;
    adapterVersion: string;
    available: boolean;
    verified: boolean;
  };
  /** Funnel decision (full) */
  funnelDecision: SignalFunnelDecision;
  /** Full provenance for traceability */
  provenance: SignalProvenance;
  /** Deterministic canonical JSON of the immutable payload (excluding sha fields) */
  canonicalJson: string;
  /** sha256 of canonicalJson */
  sha256: string;
  /** byte length of canonicalJson */
  bytes: number;
  /** Immutability marker */
  immutable: true;
}

export interface MaterializeSignalInput {
  candidate: FunnelCandidate;
  featureSet: FeatureSet;
  /** Optional snapshot for cross-validation; when provided it is validated and its hash must match featureSet.snapshotHash if that hash is derived from a snapshot */
  snapshot?: MarketSnapshot | null;
  funnelProfile: FunnelProfile;
  /** Funnel engine version; defaults to candidate's provenance or '1.0.0' */
  funnelVersion?: string;
  /** Deterministic materialization timestamp; defaults to candidate.asOf for idempotency */
  materializedAt?: string;
}

export interface MaterializeSignalsOutput {
  signals: SignalRecord[];
  /** Deterministic map from assetId to signalId for idempotency checks */
  signalIds: string[];
  /** Canonical JSON of the batch output (sorted by signalId) */
  canonicalJson: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNAL_VERSION = '1.0.0';
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const isValidIso = (v: string): boolean => ISO_DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));

// Canonicalization helper: sort keys, sort arrays where order is not semantically significant is handled by caller
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

const sha256Hex = (json: string): string => createHash('sha256').update(json).digest('hex');

const featureSetHash = (featureSet: FeatureSet): string => {
  const sortedFeatures = [...featureSet.features].sort((a, b) => {
    const cmp = a.featureId.localeCompare(b.featureId);
    if (cmp !== 0) return cmp;
    return a.version.localeCompare(b.version);
  });
  const canonical = canonicalize({ ...featureSet, features: sortedFeatures });
  return sha256Hex(JSON.stringify(canonical));
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const validateFeatureSetForMaterialization = (featureSet: FeatureSet, candidate: FunnelCandidate): void => {
  if (featureSet === null || typeof featureSet !== 'object')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_SET_NOT_OBJECT');
  if (typeof featureSet.assetId !== 'string' || featureSet.assetId.length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_SET_ASSET_ID_MALFORMED');
  if (typeof featureSet.asOf !== 'string' || !isValidIso(featureSet.asOf))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_SET_AS_OF_MALFORMED');
  if (!Array.isArray(featureSet.features))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURES_NOT_ARRAY');
  if (featureSet.features.length === 0)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'FEATURES_EMPTY');

  // assetId/asOf must match candidate
  if (featureSet.assetId !== candidate.assetId)
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'FEATURE_SET_ASSET_MISMATCH');
  if (featureSet.asOf !== candidate.asOf)
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'FEATURE_SET_AS_OF_MISMATCH');

  // Each feature must be well-formed and have VALID quality and non-null value for required usage
  const seen = new Set<string>();
  for (const f of featureSet.features) {
    if (typeof f.featureId !== 'string' || f.featureId.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_ID_MALFORMED');
    if (typeof f.version !== 'string' || f.version.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_VERSION_MALFORMED');
    if (f.value !== null && (typeof f.value !== 'number' || !Number.isFinite(f.value)))
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_VALUE_MALFORMED');
    if (typeof f.quality !== 'string' || f.quality.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_QUALITY_MALFORMED');
    const key = `${f.featureId}:${f.version}`;
    if (seen.has(key)) throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'DUPLICATE_FEATURE_ID');
    seen.add(key);
  }

  // Validate snapshotHash if present
  if (typeof featureSet.snapshotHash !== 'string' || !SHA256_RE.test(featureSet.snapshotHash))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FEATURE_SET_SNAPSHOT_HASH_MALFORMED');

  // At least the funnel's required features must be VALID
  // We don't have profile here directly in this helper alone; caller checks completeness.
};

const validateCandidateForMaterialization = (candidate: FunnelCandidate): void => {
  if (candidate === null || typeof candidate !== 'object')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_NOT_OBJECT');
  const c = candidate as Record<string, unknown>;
  for (const key of ['assetId', 'chainId', 'asOf', 'eligible', 'score', 'rank', 'rejectionReasons', 'componentValues', 'featureSetHash', 'adapterEvidence'] as const) {
    if (!(key in c)) throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `CANDIDATE_MISSING_${key}`);
  }
  if (typeof c.assetId !== 'string' || (c.assetId as string).length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_ASSET_ID_MALFORMED');
  if (typeof c.chainId !== 'string' || (c.chainId as string).length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_CHAIN_ID_MALFORMED');
  if (typeof c.asOf !== 'string' || !isValidIso(c.asOf as string))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_AS_OF_MALFORMED');
  if (typeof c.eligible !== 'boolean')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_ELIGIBLE_MALFORMED');
  if (c.eligible !== true) {
    // Ineligible candidates cannot materialize a signal; include inspectable reasons in error
    const reasons = Array.isArray(c.rejectionReasons) ? (c.rejectionReasons as string[]).join(',') : String(c.rejectionReasons);
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `CANDIDATE_NOT_ELIGIBLE:${reasons}`);
  }
  if (typeof c.score !== 'number' || !Number.isFinite(c.score as number))
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'CANDIDATE_SCORE_MISSING_FOR_ELIGIBLE');
  if (typeof c.rank !== 'number' || !Number.isInteger(c.rank as number) || (c.rank as number) < 1)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'CANDIDATE_RANK_MISSING_FOR_ELIGIBLE');
  if (!Array.isArray(c.rejectionReasons))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_REJECTION_REASONS_MALFORMED');
  // eligible must have empty rejectionReasons
  if ((c.rejectionReasons as unknown[]).length !== 0)
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'ELIGIBLE_WITH_REJECTION_REASONS');
  if (!Array.isArray(c.componentValues) || (c.componentValues as unknown[]).length === 0)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'CANDIDATE_COMPONENT_VALUES_MISSING');
  for (const comp of c.componentValues as Array<Record<string, unknown>>) {
    if (typeof comp.featureId !== 'string' || comp.featureId.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'COMPONENT_FEATURE_ID_MALFORMED');
    if (typeof comp.version !== 'string' || comp.version.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'COMPONENT_VERSION_MALFORMED');
    if (typeof comp.value !== 'number' || !Number.isFinite(comp.value as number))
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'COMPONENT_VALUE_MALFORMED');
    if (typeof comp.quality !== 'string' || comp.quality.length === 0)
      throw new SignalMaterializationError('SIGNAL_MALFORMED', 'COMPONENT_QUALITY_MALFORMED');
    if (comp.quality !== 'VALID')
      throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `COMPONENT_QUALITY_NOT_VALID:${comp.featureId as string}:${comp.quality as string}`);
  }
  if (typeof c.featureSetHash !== 'string' || !SHA256_RE.test(c.featureSetHash as string))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATE_FEATURE_SET_HASH_MALFORMED');
  // adapterEvidence must be present and verified for eligible
  const ev = c.adapterEvidence as Record<string, unknown> | null;
  if (ev === null || typeof ev !== 'object')
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'ADAPTER_EVIDENCE_MISSING_FOR_ELIGIBLE');
  if (typeof ev.poolId !== 'string' || (ev.poolId as string).length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'ADAPTER_POOL_ID_MALFORMED');
  if (typeof ev.adapterVersion !== 'string' || (ev.adapterVersion as string).length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'ADAPTER_VERSION_MALFORMED');
  if (ev.available !== true || ev.verified !== true)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'ADAPTER_EVIDENCE_UNAVAILABLE');
};

const validateProfile = (profile: FunnelProfile): void => {
  if (profile === null || typeof profile !== 'object')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'PROFILE_NOT_OBJECT');
  const p = profile as Record<string, unknown>;
  if (typeof p.version !== 'string' || (p.version as string).length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'PROFILE_VERSION_MALFORMED');
  if (!Array.isArray(p.requiredFeatureIds) || (p.requiredFeatureIds as unknown[]).length === 0)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'REQUIRED_FEATURE_IDS_MISSING');
};

// ---------------------------------------------------------------------------
// Core materialization
// ---------------------------------------------------------------------------

export const materializeSignal = (input: MaterializeSignalInput): SignalRecord => {
  if (input === null || typeof input !== 'object')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'INPUT_NOT_OBJECT');

  const { candidate, featureSet, snapshot, funnelProfile, funnelVersion, materializedAt } = input;

  // Validate profile and candidate first (malformed vs incomplete vs inconsistent)
  if (funnelProfile === undefined || funnelProfile === null)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'FUNNEL_PROFILE_MISSING');
  validateProfile(funnelProfile);

  if (candidate === undefined || candidate === null)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'CANDIDATE_MISSING');
  if (featureSet === undefined || featureSet === null)
    throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'FEATURE_SET_MISSING');

  validateCandidateForMaterialization(candidate);
  validateFeatureSetForMaterialization(featureSet, candidate);

  // Validate snapshot if provided (strict)
  let snapshotHash: string | null = null;
  let snapshotId: string | null = null;
  let observationIds: string[] = [];
  let evidenceHashes: string[] = [];
  let collectedAt: string | null = null;
  let snapshotBytes: number | null = null;

  if (snapshot !== undefined && snapshot !== null) {
    try {
      const validated = validateSnapshot(snapshot);
      // Cross-check identity
      if (validated.assetId !== candidate.assetId)
        throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'SNAPSHOT_ASSET_MISMATCH');
      if (validated.asOf !== candidate.asOf)
        throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'SNAPSHOT_AS_OF_MISMATCH');
      if (validated.chainId !== candidate.chainId)
        throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'SNAPSHOT_CHAIN_MISMATCH');
      // Compute snapshot hash deterministically
      const snapBytes = canonicalSnapshotBytes(validated);
      snapshotHash = snapBytes.sha256;
      snapshotBytes = snapBytes.bytes;
      snapshotId = validated.snapshotId;
      observationIds = [...validated.provenance.observationIds].sort();
      evidenceHashes = [...validated.provenance.evidenceHashes].sort();
      collectedAt = validated.provenance.collectedAt;
      // If featureSet.snapshotHash is present, it should match snapshot hash (or at least be consistent)
      if (featureSet.snapshotHash !== snapshotHash) {
        // Mismatch is inconsistent evidence
        throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'SNAPSHOT_HASH_MISMATCH');
      }
    } catch (e) {
      if (e instanceof SignalMaterializationError) throw e;
      // Map snapshot validation errors to signal codes
      const msg = e instanceof Error ? e.message : String(e);
      // SnapshotValidationError has code property
      const code = (e as { code?: string })?.code;
      if (code === 'SNAPSHOT_MALFORMED') throw new SignalMaterializationError('SIGNAL_MALFORMED', msg);
      if (code === 'SNAPSHOT_INCOMPLETE') throw new SignalMaterializationError('SIGNAL_INCOMPLETE', msg);
      throw new SignalMaterializationError('SIGNAL_INCONSISTENT', msg);
    }
  } else {
    // No snapshot provided: use featureSet's snapshotHash and extract lineage from featureSet features
    snapshotHash = featureSet.snapshotHash;
    // Try to extract observation mapping from feature lineage if available
    // Feature lineage inputHashes are derived from snapshotIds; use them as evidence pointers
    // Remaining fields stay null/empty but signal still attributions featureSetHash
    observationIds = [];
    evidenceHashes = [];
    // Collect from features' lineage.inputHashes where available
    const hashes = new Set<string>();
    for (const f of featureSet.features) {
      for (const h of f.lineage.inputHashes) hashes.add(h);
    }
    evidenceHashes = [...hashes].sort();
  }

  // Validate featureSetHash matches candidate.featureSetHash and computed hash
  const computedFeatureSetHash = featureSetHash(featureSet);
  if (featureSet.snapshotHash.length === 0) throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'FEATURE_SET_SNAPSHOT_HASH_MISSING');
  if (candidate.featureSetHash !== computedFeatureSetHash)
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'FEATURE_SET_HASH_MISMATCH');
  if (featureSet.snapshotHash !== snapshotHash && snapshot !== null && snapshot !== undefined) {
    // Already checked above; keep for idempotency
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'FEATURE_SET_SNAPSHOT_HASH_MISMATCH_WITH_CANDIDATE');
  }
  // Also validate that computed hash equals candidate's hash
  if (computedFeatureSetHash !== candidate.featureSetHash)
    throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'FEATURE_SET_HASH_MISMATCH');

  // Validate that all required features per profile are present and VALID (complete evidence)
  const featureMap = new Map<string, (typeof featureSet.features)[number]>();
  for (const f of featureSet.features) featureMap.set(f.featureId, f);
  for (const reqId of [...funnelProfile.requiredFeatureIds].sort()) {
    const fv = featureMap.get(reqId);
    if (!fv) throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `MISSING_REQUIRED_FEATURE:${reqId}`);
    if (fv.value === null || fv.value === undefined)
      throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `FEATURE_VALUE_NULL:${reqId}`);
    if (fv.quality !== 'VALID')
      throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `FEATURE_QUALITY_NOT_VALID:${reqId}:${fv.quality}`);
  }
  // Also ensure componentValues in candidate correspond to required features and versions match
  const componentById = new Map<string, (typeof candidate.componentValues)[number]>();
  for (const c of candidate.componentValues) componentById.set(c.featureId, c);
  for (const reqId of funnelProfile.requiredFeatureIds) {
    const comp = componentById.get(reqId);
    if (!comp) throw new SignalMaterializationError('SIGNAL_INCONSISTENT', `COMPONENT_MISSING:${reqId}`);
    const fv = featureMap.get(reqId);
    if (fv && comp.version !== fv.version)
      throw new SignalMaterializationError('SIGNAL_INCONSISTENT', `FEATURE_VERSION_MISMATCH:${reqId}`);
    if (fv && comp.value !== fv.value)
      throw new SignalMaterializationError('SIGNAL_INCONSISTENT', `FEATURE_VALUE_MISMATCH:${reqId}`);
  }

  // Funnel provenance: funnelVersion defaults to '1.0.0' (same as funnel.ts FUNNEL_VERSION)
  const resolvedFunnelVersion = funnelVersion ?? '1.0.0';
  if (typeof resolvedFunnelVersion !== 'string' || resolvedFunnelVersion.length === 0)
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FUNNEL_VERSION_MALFORMED');

  // Deterministic materializedAt: default to candidate.asOf for idempotency (not Date.now())
  const resolvedMaterializedAt = materializedAt ?? candidate.asOf;
  if (!isValidIso(resolvedMaterializedAt))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'MATERIALIZED_AT_MALFORMED');

  const adapterEvidence = candidate.adapterEvidence as FunnelAdapterEvidence;

  // Build featureVersions map deterministically sorted
  const featureVersions: Record<string, string> = {};
  for (const f of [...featureSet.features].sort((a, b) => a.featureId.localeCompare(b.featureId))) {
    featureVersions[f.featureId] = f.version;
  }

  // Canonical payload: everything that contributes to signal identity, sorted deterministically.
  // Exclude sha256/bytes/canonicalJson/signalId themselves; they are derived.
  const canonicalPayload = {
    signalVersion: SIGNAL_VERSION,
    assetId: candidate.assetId,
    chainId: candidate.chainId,
    asOf: candidate.asOf,
    materializedAt: resolvedMaterializedAt,
    canonicalInputs: {
      snapshotId,
      snapshotHash: snapshotHash ?? featureSet.snapshotHash,
      featureSetHash: computedFeatureSetHash,
      observationIds,
      evidenceHashes,
      collectedAt,
      featureVersions,
      adapterPoolId: adapterEvidence.poolId,
      adapterVersion: adapterEvidence.adapterVersion,
    },
    featureVersions,
    adapterProvenance: {
      poolId: adapterEvidence.poolId,
      adapterVersion: adapterEvidence.adapterVersion,
      available: adapterEvidence.available,
      verified: adapterEvidence.verified,
    },
    funnelDecision: {
      funnelVersion: resolvedFunnelVersion,
      profileVersion: funnelProfile.version,
      eligible: candidate.eligible,
      score: candidate.score,
      rank: candidate.rank,
      rejectionReasons: [...candidate.rejectionReasons].sort(),
      componentValues: [...candidate.componentValues].sort((a, b) => a.featureId.localeCompare(b.featureId)),
    },
    provenance: {
      snapshotId,
      snapshotHash: snapshotHash ?? featureSet.snapshotHash,
      featureSetHash: computedFeatureSetHash,
      observationIds,
      evidenceHashes,
      funnelVersion: resolvedFunnelVersion,
      profileVersion: funnelProfile.version,
      adapterPoolId: adapterEvidence.poolId,
      adapterVersion: adapterEvidence.adapterVersion,
      featureVersions,
      codeVersion: SIGNAL_VERSION,
    },
  };

  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload));
  const sha256 = sha256Hex(canonicalJson);
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;
  const signalId = `sig_${sha256.slice(0, 32)}`;

  // FeatureSet bytes for traceability
  let featureSetBytes: number | null = null;
  try {
    featureSetBytes = new TextEncoder().encode(JSON.stringify(canonicalize(featureSet))).byteLength;
  } catch {
    featureSetBytes = null;
  }

  const funnelDecision: SignalFunnelDecision = {
    funnelVersion: resolvedFunnelVersion,
    profileVersion: funnelProfile.version,
    eligible: candidate.eligible,
    score: candidate.score as number,
    rank: candidate.rank as number,
    componentValues: [...candidate.componentValues].sort((a, b) => a.featureId.localeCompare(b.featureId)),
    rejectionReasons: [...candidate.rejectionReasons].sort(),
  };

  const canonicalInputs: SignalCanonicalInputs = {
    snapshotHash: snapshotHash ?? featureSet.snapshotHash,
    featureSetHash: computedFeatureSetHash,
    featureVersions,
    adapterPoolId: adapterEvidence.poolId,
    adapterVersion: adapterEvidence.adapterVersion,
  };

  const provenance: SignalProvenance = {
    featureVersions,
    adapter: {
      poolId: adapterEvidence.poolId,
      adapterVersion: adapterEvidence.adapterVersion,
      available: adapterEvidence.available,
      verified: adapterEvidence.verified,
    },
    funnel: {
      funnelVersion: resolvedFunnelVersion,
      profileVersion: funnelProfile.version,
      eligible: candidate.eligible,
      score: candidate.score as number,
      rank: candidate.rank as number,
      rejectionReasons: [...candidate.rejectionReasons].sort(),
    },
    inputs: {
      snapshotId,
      snapshotHash: snapshotHash ?? featureSet.snapshotHash,
      featureSetHash: computedFeatureSetHash,
      observationIds,
      evidenceHashes,
      collectedAt,
    },
    codeVersion: SIGNAL_VERSION,
    canonicalSnapshotBytes: snapshotBytes,
    canonicalFeatureSetBytes: featureSetBytes,
  };

  const record: SignalRecord = {
    signalId,
    assetId: candidate.assetId,
    chainId: candidate.chainId,
    asOf: candidate.asOf,
    materializedAt: resolvedMaterializedAt,
    canonicalInputs,
    featureVersions,
    adapterProvenance: {
      poolId: adapterEvidence.poolId,
      adapterVersion: adapterEvidence.adapterVersion,
      available: true,
      verified: true,
    },
    funnelDecision,
    provenance,
    canonicalJson,
    sha256,
    bytes,
    immutable: true as const,
  };

  // Freeze for immutability (shallow copy already deterministic)
  return Object.freeze(record) as SignalRecord;
};



/**
 * Batch materialization: deterministically materializes all eligible candidates from a FunnelOutput.
 * - Input order does not affect output order; signals sorted by signalId lexicographically for determinism.
 * - Ineligible candidates are skipped (they cannot materialize).
 * - Duplicate evaluation is idempotent: same funnelOutput + featureSets map yields same signalIds/hashes.
 */
export const materializeSignals = (
  funnelOutput: { candidates: FunnelCandidate[]; funnelVersion?: string; profileVersion?: string },
  featureSetsByAssetId: Map<string, FeatureSet> | Record<string, FeatureSet>,
  snapshotsByAssetId?: Map<string, MarketSnapshot> | Record<string, MarketSnapshot | null> | null,
  funnelProfile?: FunnelProfile | null,
  materializedAt?: string,
): MaterializeSignalsOutput => {
  if (funnelOutput === null || typeof funnelOutput !== 'object')
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'FUNNEL_OUTPUT_NOT_OBJECT');
  if (!Array.isArray((funnelOutput as { candidates: unknown }).candidates))
    throw new SignalMaterializationError('SIGNAL_MALFORMED', 'CANDIDATES_NOT_ARRAY');

  const candidates = (funnelOutput as { candidates: FunnelCandidate[] }).candidates;
  if (candidates.length === 0) throw new SignalMaterializationError('SIGNAL_INCOMPLETE', 'CANDIDATES_EMPTY');

  const profile = funnelProfile ?? null;
  if (profile !== null) validateProfile(profile);

  // Normalize maps to Maps for deterministic lookup
  const fsMap: Map<string, FeatureSet> =
    featureSetsByAssetId instanceof Map
      ? featureSetsByAssetId
      : new Map(Object.entries(featureSetsByAssetId as Record<string, FeatureSet>));
  const snapMap: Map<string, MarketSnapshot | null> | null = snapshotsByAssetId === null || snapshotsByAssetId === undefined
    ? null
    : snapshotsByAssetId instanceof Map
      ? (snapshotsByAssetId as Map<string, MarketSnapshot | null>)
      : new Map(Object.entries(snapshotsByAssetId as Record<string, MarketSnapshot | null>));

  const funnelVersion = (funnelOutput as { funnelVersion?: string }).funnelVersion ?? '1.0.0';

  const signals: SignalRecord[] = [];
  for (const candidate of candidates) {
    if (candidate.eligible !== true) continue; // ineligible cannot materialize; skip (fail-closed for ineligible)
    const featureSet = fsMap.get(candidate.assetId);
    if (!featureSet) throw new SignalMaterializationError('SIGNAL_INCOMPLETE', `FEATURE_SET_MISSING_FOR:${candidate.assetId}`);
    const snapshot = snapMap?.get(candidate.assetId) ?? null;
    // If funnelProfile is not supplied, infer a minimal profile from candidate componentValues for validation
    const effectiveProfile: FunnelProfile = profile ?? {
      version: (funnelOutput as { profileVersion?: string }).profileVersion ?? '1.0.0',
      requiredFeatureIds: candidate.componentValues.map((c) => c.featureId).sort(),
      featureWeights: Object.fromEntries(candidate.componentValues.map((c) => [c.featureId, (c as { weight?: number }).weight ?? 1.0])),
      minScore: null,
    };
    const signal = materializeSignal({
      candidate,
      featureSet,
      snapshot,
      funnelProfile: effectiveProfile,
      funnelVersion,
      materializedAt: materializedAt ?? candidate.asOf,
    });
    signals.push(signal);
  }

  // Deterministic ordering: sort by signalId lexicographically
  signals.sort((a, b) => a.signalId.localeCompare(b.signalId));

  // Batch canonical payload
  const batchPayload = {
    signalVersion: SIGNAL_VERSION,
    funnelVersion,
    profileVersion: profile?.version ?? (funnelOutput as { profileVersion?: string }).profileVersion ?? '1.0.0',
    count: signals.length,
    signalIds: signals.map((s) => s.signalId),
    signals: signals.map((s) => JSON.parse(s.canonicalJson)),
  };
  const canonicalJson = JSON.stringify(canonicalize(batchPayload));
  const sha256 = sha256Hex(canonicalJson);
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;

  return {
    signals,
    signalIds: signals.map((s) => s.signalId),
    canonicalJson,
    sha256,
    bytes,
  };
};

/**
 * In-memory idempotent signal store (optional helper for workflow/runtime use).
 * Duplicate put of same signalId is idempotent and returns existing.
 */
export class InMemorySignalStore {
  private readonly byId = new Map<string, SignalRecord>();
  private readonly byAssetAsOf = new Map<string, SignalRecord>();

  put(signal: SignalRecord): SignalRecord {
    const existing = this.byId.get(signal.signalId);
    if (existing) {
      // Idempotent: must match byte-for-byte
      if (existing.sha256 !== signal.sha256 || existing.canonicalJson !== signal.canonicalJson) {
        throw new SignalMaterializationError('SIGNAL_INCONSISTENT', 'SIGNAL_ID_COLLISION_WITH_DIFFERENT_PAYLOAD');
      }
      return existing;
    }
    const key = `${signal.assetId}:${signal.asOf}`;
    const dupAsOf = this.byAssetAsOf.get(key);
    if (dupAsOf && dupAsOf.signalId !== signal.signalId) {
      // Same asset+asOf re-materialized with different inputs => inconsistent; but we allow different signals for different inputs
      // This is not an error, just store both under id
    }
    // Freeze for immutability
    const frozen = Object.freeze({ ...signal }) as SignalRecord;
    this.byId.set(signal.signalId, frozen);
    this.byAssetAsOf.set(key, frozen);
    return frozen;
  }

  get(signalId: string): SignalRecord | undefined {
    return this.byId.get(signalId);
  }

  getByAssetAsOf(assetId: string, asOf: string): SignalRecord | undefined {
    return this.byAssetAsOf.get(`${assetId}:${asOf}`);
  }

  has(signalId: string): boolean {
    return this.byId.has(signalId);
  }

  size(): number {
    return this.byId.size;
  }

  all(): SignalRecord[] {
    return [...this.byId.values()].sort((a, b) => a.signalId.localeCompare(b.signalId));
  }

  clear(): void {
    this.byId.clear();
    this.byAssetAsOf.clear();
  }
}

export const SIGNAL_VERSION_TAG = SIGNAL_VERSION;
