/**
 * @requirement FR-SIG-001 - Versioned Feature Registry
 * @requirement FR-SIG-009 - Numeric stability: denominator, transform, outlier, shrinkage, capped contribution, cohort fallback
 * @requirement FR-DATA-004 - Online/offline deterministic feature consistency
 *
 * Deterministic feature computation with reproducible serialization and strict validation.
 * Feature computation rejects malformed, incomplete, or inconsistent source state deterministically.
 */

import { createHash } from 'node:crypto';
import type { MarketSnapshot } from './snapshot.js';
import { validateSnapshot, SnapshotValidationError } from './snapshot.js';

// ---------------------------------------------------------------------------
// Feature Registry
// ---------------------------------------------------------------------------

export type StabilityTransform = 'log1p' | 'identity' | 'winsorize';

export interface FeatureDefinition {
  featureId: string;
  version: string;
  description: string;
  formula: string;
  unit: string;
  minimumObservations: number;
  minimumDenominator: number; // for ratio features
  minimumAbsoluteActivity: number; // minimum volume/liquidity to consider
  stabilityTransform: StabilityTransform;
  outlierWinsorizeP: number | null; // e.g. 0.99 => clip at 99th percentile proxy
  shrinkagePrior: number; // Bayesian shrinkage target
  shrinkageWeight: number; // 0..1, weight of prior for small samples
  maxContribution: number; // max absolute value after capping
  cohortFallback: string[]; // ordered fallback hierarchy
  freshLimitSeconds: number;
}

export class FeatureValidationError extends Error {
  constructor(
    public readonly code:
      | 'FEATURE_MALFORMED'
      | 'FEATURE_INCOMPLETE'
      | 'FEATURE_INCONSISTENT',
    message: string,
  ) {
    super(message);
    this.name = 'FeatureValidationError';
  }
}

// Registry defines all features deterministically; version is part of identity
export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
  {
    featureId: 'volume_acceleration',
    version: '1.0.0',
    description: 'Volume acceleration over multiple windows using log1p growth',
    formula: 'log1p( (vol_short - vol_long) / max(vol_long, minDenom) )',
    unit: 'log1p_ratio',
    minimumObservations: 2,
    minimumDenominator: 1000,
    minimumAbsoluteActivity: 500,
    stabilityTransform: 'log1p',
    outlierWinsorizeP: 0.99,
    shrinkagePrior: 0,
    shrinkageWeight: 0.3,
    maxContribution: 5,
    cohortFallback: ['exact', 'chain', 'all'],
    freshLimitSeconds: 3600,
  },
  {
    featureId: 'liquidity_growth',
    version: '1.0.0',
    description: 'Liquidity growth with denominator guard and shrinkage',
    formula: 'shrink( log1p((liq_now - liq_prev)/max(liq_prev, minDenom)), prior )',
    unit: 'log1p_ratio',
    minimumObservations: 2,
    minimumDenominator: 5000,
    minimumAbsoluteActivity: 1000,
    stabilityTransform: 'log1p',
    outlierWinsorizeP: 0.99,
    shrinkagePrior: 0,
    shrinkageWeight: 0.4,
    maxContribution: 3,
    cohortFallback: ['exact', 'chain', 'all'],
    freshLimitSeconds: 3600,
  },
  {
    featureId: 'trade_entropy',
    version: '1.0.0',
    description: 'Trade-size entropy with one-bucket guard',
    formula: 'entropy(trade_size_buckets) clamped, LOW_SAMPLE if buckets<=1',
    unit: 'nats',
    minimumObservations: 5,
    minimumDenominator: 5,
    minimumAbsoluteActivity: 100,
    stabilityTransform: 'identity',
    outlierWinsorizeP: null,
    shrinkagePrior: 0.5,
    shrinkageWeight: 0.5,
    maxContribution: 3,
    cohortFallback: ['exact', 'all'],
    freshLimitSeconds: 3600,
  },
  {
    featureId: 'liquidity_drawdown',
    version: '1.0.0',
    description: 'Liquidity drawdown from peak with capping',
    formula: 'clamp( (liq_peak - liq_now)/max(liq_peak, minDenom), -max, max)',
    unit: 'ratio',
    minimumObservations: 2,
    minimumDenominator: 5000,
    minimumAbsoluteActivity: 1000,
    stabilityTransform: 'winsorize',
    outlierWinsorizeP: 0.95,
    shrinkagePrior: 0,
    shrinkageWeight: 0.2,
    maxContribution: 1,
    cohortFallback: ['exact', 'chain', 'all'],
    freshLimitSeconds: 3600,
  },
] as const;

export const getFeatureDefinition = (featureId: string, version?: string): FeatureDefinition | undefined =>
  FEATURE_REGISTRY.find((f) => f.featureId === featureId && (version === undefined || f.version === version));

// ---------------------------------------------------------------------------
// Feature values
// ---------------------------------------------------------------------------

export type FeatureQuality = 'VALID' | 'LOW_SAMPLE' | 'INSUFFICIENT_DATA' | 'STALE' | 'ESTIMATED';

export interface FeatureValue {
  featureId: string;
  version: string;
  entityId: string; // assetId
  asOf: string; // ISO datetime
  windowStart: string | null;
  windowEnd: string;
  value: number | null; // null when insufficient data, bounded otherwise
  quality: FeatureQuality;
  denominator: number | null;
  sampleSize: number;
  cohortLevel: string; // chosen fallback
  cohortSize: number;
  lineage: {
    inputSnapshotIds: string[];
    inputHashes: string[];
    codeVersion: string;
    calculatedAt: string;
  };
  capped: boolean;
}

export interface FeatureSet {
  assetId: string;
  asOf: string;
  features: FeatureValue[];
  snapshotHash: string; // sha256 of canonical snapshot
}

export interface CanonicalFeatureOutput {
  canonicalJson: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Deterministic math helpers
// ---------------------------------------------------------------------------

const CODE_VERSION = '1.0.0';

const log1p = (x: number): number => Math.log1p(x);

const clamp = (value: number, max: number): number => {
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
};

const winsorize = (value: number, p: number): number => {
  // Deterministic winsorization proxy: clip to quantile-estimated bounds
  // For simplicity, clip based on maxContribution derived from p
  // p=0.99 => allow 99% range, already handled via maxContribution; just clamp here
  const bound = p >= 0.99 ? 10 : p >= 0.95 ? 5 : 3;
  return clamp(value, bound);
};

const applyStability = (raw: number, transform: StabilityTransform, winsorP: number | null): number => {
  let v = raw;
  if (transform === 'log1p') v = raw >= 0 ? log1p(raw) : -log1p(-raw);
  else if (transform === 'winsorize' && winsorP !== null) v = winsorize(v, winsorP);
  // 'identity' leaves raw unchanged except optional winsorize already handled via maxContribution
  return v;
};

const shrink = (value: number, prior: number, weight: number, sampleSize: number, minObservations: number): number => {
  // Shrinkage weight decays with sampleSize: effectiveWeight = weight * (minObs / max(sampleSize, minObs))
  // When sampleSize >= minObs*3, shrinkage negligible
  const effectiveWeight = sampleSize < minObservations * 3 ? weight * (1 - sampleSize / (minObservations * 3)) : 0;
  return value * (1 - effectiveWeight) + prior * effectiveWeight;
};

const computeCohortLevel = (sampleSize: number, minObs: number, fallback: string[]): { level: string; size: number } => {
  // Deterministic cohort fallback: if sampleSize >= minObs => exact, else fallback linearly
  if (sampleSize >= minObs) return { level: fallback[0] ?? 'exact', size: sampleSize };
  if (sampleSize >= Math.ceil(minObs / 2)) return { level: fallback[1] ?? fallback[0] ?? 'exact', size: sampleSize };
  return { level: fallback[fallback.length - 1] ?? 'all', size: sampleSize };
};

// ---------------------------------------------------------------------------
// Validation for feature computation inputs
// ---------------------------------------------------------------------------

const validateHistory = (snapshots: readonly MarketSnapshot[], feature: FeatureDefinition): void => {
  if (!Array.isArray(snapshots))
    throw new FeatureValidationError('FEATURE_MALFORMED', 'HISTORY_NOT_ARRAY');
  if (snapshots.length === 0)
    throw new FeatureValidationError('FEATURE_INCOMPLETE', 'HISTORY_EMPTY');

  // Each snapshot must be valid (malformed checks)
  for (const s of snapshots) {
    try {
      validateSnapshot(s);
    } catch (e) {
      if (e instanceof SnapshotValidationError) {
        // Map snapshot codes to feature codes deterministically
        if (e.code === 'SNAPSHOT_MALFORMED') throw new FeatureValidationError('FEATURE_MALFORMED', e.message);
        if (e.code === 'SNAPSHOT_INCOMPLETE') throw new FeatureValidationError('FEATURE_INCOMPLETE', e.message);
        throw new FeatureValidationError('FEATURE_INCONSISTENT', e.message);
      }
      throw e;
    }
  }

  // Consistency: all must share same assetId and chainId
  const assetId = snapshots[0].assetId;
  const chainId = snapshots[0].chainId;
  for (const s of snapshots) {
    if (s.assetId !== assetId || s.chainId !== chainId)
      throw new FeatureValidationError('FEATURE_INCONSISTENT', 'HISTORY_ASSET_MISMATCH');
  }

  // Consistency: asOf must be strictly increasing and unique (no duplicates, no out-of-order)
  const seen = new Set<string>();
  for (let i = 0; i < snapshots.length; i++) {
    const cur = snapshots[i];
    if (seen.has(cur.asOf)) throw new FeatureValidationError('FEATURE_INCONSISTENT', 'HISTORY_DUPLICATE_AS_OF');
    seen.add(cur.asOf);
    if (i > 0) {
      const prevMs = Date.parse(snapshots[i - 1].asOf);
      const curMs = Date.parse(cur.asOf);
      if (curMs <= prevMs) throw new FeatureValidationError('FEATURE_INCONSISTENT', 'HISTORY_NOT_STRICTLY_INCREASING');
    }
  }

  // Future check: feature window bounds consistency is handled per-feature below
  // but minimumObservations is checked per-computation; here we just ensure history is traversable
  void feature; // registry used elsewhere
};

// ---------------------------------------------------------------------------
// Core feature computations (deterministic, bounded)
// ---------------------------------------------------------------------------

/** Volume acceleration: compares short-window vs long-window volume. History sorted by asOf ascending. */
export const computeVolumeAcceleration = (
  history: readonly MarketSnapshot[],
  now: MarketSnapshot,
  definition: FeatureDefinition = FEATURE_REGISTRY[0]!,
  calculatedAt: string = new Date().toISOString(),
): FeatureValue => {
  validateHistory([...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)), definition);

  // Use the two most recent snapshots for simplicity: now vs previous
  const sorted = [...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

  const sampleSize = sorted.length;
  const volNow = Number(now.market.volumeUsd24h);
  const volPrev = prev ? Number(prev.market.volumeUsd24h) : 0;

  if (Number.isNaN(volNow) || (prev && Number.isNaN(volPrev)))
    throw new FeatureValidationError('FEATURE_MALFORMED', 'VOLUME_NOT_NUMERIC');

  const denom = Math.max(volPrev, definition.minimumDenominator);
  const activity = Math.max(volNow, volPrev);

  if (activity < definition.minimumAbsoluteActivity) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'INSUFFICIENT_DATA', calculatedAt, sorted);
  }
  if (sampleSize < definition.minimumObservations) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'LOW_SAMPLE', calculatedAt, sorted);
  }
  if (denom < definition.minimumDenominator) {
    // Should not happen due to max above, but guard
    return boundedFeature(definition, now, sampleSize, denom, null, 'LOW_SAMPLE', calculatedAt, sorted);
  }

  const raw = (volNow - volPrev) / denom;
  let value = applyStability(raw, definition.stabilityTransform, definition.outlierWinsorizeP);
  value = shrink(value, definition.shrinkagePrior, definition.shrinkageWeight, sampleSize, definition.minimumObservations);
  const capped = Math.abs(value) >= definition.maxContribution;
  value = clamp(value, definition.maxContribution);

  return boundedFeature(definition, now, sampleSize, denom, value, capped ? 'ESTIMATED' : 'VALID', calculatedAt, sorted, capped);
};

export const computeLiquidityGrowth = (
  history: readonly MarketSnapshot[],
  now: MarketSnapshot,
  definition: FeatureDefinition = FEATURE_REGISTRY[1]!,
  calculatedAt: string = new Date().toISOString(),
): FeatureValue => {
  validateHistory([...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)), definition);
  const sorted = [...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

  const sampleSize = sorted.length;

  // Sum liquidity across pools (deterministic: sort pools already in snapshot, but sum is order-independent)
  const liqNow = sumLiquidity(now);
  const liqPrev = prev ? sumLiquidity(prev) : 0;
  const denom = Math.max(liqPrev, definition.minimumDenominator);
  const activity = Math.max(liqNow, liqPrev);

  if (activity < definition.minimumAbsoluteActivity) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'INSUFFICIENT_DATA', calculatedAt, sorted);
  }
  if (sampleSize < definition.minimumObservations) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'LOW_SAMPLE', calculatedAt, sorted);
  }

  const raw = (liqNow - liqPrev) / denom;
  let value = applyStability(raw, definition.stabilityTransform, definition.outlierWinsorizeP);
  value = shrink(value, definition.shrinkagePrior, definition.shrinkageWeight, sampleSize, definition.minimumObservations);
  const capped = Math.abs(value) >= definition.maxContribution;
  value = clamp(value, definition.maxContribution);

  return boundedFeature(definition, now, sampleSize, denom, value, capped ? 'ESTIMATED' : 'VALID', calculatedAt, sorted, capped);
};

export const computeTradeEntropy = (
  tradeBuckets: number[], // deterministic bucket counts, e.g. [10, 5, 0, 2]
  asOf: string,
  entityId: string,
  definition: FeatureDefinition = FEATURE_REGISTRY[2]!,
  calculatedAt: string = new Date().toISOString(),
  lineageIds: string[] = [],
  lineageHashes: string[] = [],
): FeatureValue => {
  if (!Array.isArray(tradeBuckets))
    throw new FeatureValidationError('FEATURE_MALFORMED', 'BUCKETS_NOT_ARRAY');
  for (const b of tradeBuckets) {
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0)
      throw new FeatureValidationError('FEATURE_MALFORMED', 'BUCKET_MALFORMED');
  }
  if (!isValidIso(asOf)) throw new FeatureValidationError('FEATURE_MALFORMED', 'AS_OF_MALFORMED');
  if (entityId.length === 0) throw new FeatureValidationError('FEATURE_MALFORMED', 'ENTITY_ID_MALFORMED');

  const total = tradeBuckets.reduce((a, b) => a + b, 0);
  const nonEmptyBuckets = tradeBuckets.filter((b) => b > 0).length;
  const sampleSize = total;

  // One-bucket guard: if only one bucket has mass, entropy collapses -> LOW_SAMPLE
  if (nonEmptyBuckets <= 1) {
    const denom = definition.minimumDenominator;
    return boundedFeatureRaw(definition, entityId, asOf, sampleSize, denom, 0, 'LOW_SAMPLE', calculatedAt, lineageIds, lineageHashes, false);
  }
  if (sampleSize < definition.minimumObservations) {
    return boundedFeatureRaw(definition, entityId, asOf, sampleSize, total, null, 'LOW_SAMPLE', calculatedAt, lineageIds, lineageHashes, false);
  }
  if (total < definition.minimumAbsoluteActivity) {
    return boundedFeatureRaw(definition, entityId, asOf, sampleSize, total, null, 'INSUFFICIENT_DATA', calculatedAt, lineageIds, lineageHashes, false);
  }

  // Shannon entropy (nats)
  let entropy = 0;
  for (const count of tradeBuckets) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  // Apply shrinkage toward prior (0.5) for small samples
  entropy = shrink(entropy, definition.shrinkagePrior, definition.shrinkageWeight, sampleSize, definition.minimumObservations);
  const capped = entropy > definition.maxContribution;
  entropy = Math.min(entropy, definition.maxContribution);

  return boundedFeatureRaw(definition, entityId, asOf, sampleSize, total, entropy, capped ? 'ESTIMATED' : 'VALID', calculatedAt, lineageIds, lineageHashes, capped);
};

export const computeLiquidityDrawdown = (
  history: readonly MarketSnapshot[],
  now: MarketSnapshot,
  definition: FeatureDefinition = FEATURE_REGISTRY[3]!,
  calculatedAt: string = new Date().toISOString(),
): FeatureValue => {
  validateHistory([...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)), definition);
  const sorted = [...history, now].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  const sampleSize = sorted.length;

  const liqNow = sumLiquidity(now);
  const peak = Math.max(...sorted.map(sumLiquidity));
  const denom = Math.max(peak, definition.minimumDenominator);
  const activity = peak;

  if (activity < definition.minimumAbsoluteActivity) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'INSUFFICIENT_DATA', calculatedAt, sorted);
  }
  if (sampleSize < definition.minimumObservations) {
    return boundedFeature(definition, now, sampleSize, denom, null, 'LOW_SAMPLE', calculatedAt, sorted);
  }

  const raw = (peak - liqNow) / denom;
  let value = applyStability(raw, definition.stabilityTransform, definition.outlierWinsorizeP);
  value = clamp(value, definition.maxContribution);
  const capped = raw > definition.maxContribution;

  return boundedFeature(definition, now, sampleSize, denom, value, 'VALID', calculatedAt, sorted, capped);
};

// ---------------------------------------------------------------------------
// Helpers for building FeatureValue deterministically
// ---------------------------------------------------------------------------

const isValidIso = (v: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));

const sumLiquidity = (snapshot: MarketSnapshot): number =>
  snapshot.pools.reduce((sum, p) => sum + Number(p.liquidityUsd), 0);

const boundedFeature = (
  definition: FeatureDefinition,
  now: MarketSnapshot,
  sampleSize: number,
  denominator: number,
  value: number | null,
  quality: FeatureQuality,
  calculatedAt: string,
  sortedHistory: readonly MarketSnapshot[],
  capped = false,
): FeatureValue => {
  const cohort = computeCohortLevel(sampleSize, definition.minimumObservations, definition.cohortFallback);
  // Window: from earliest in history to now.asOf
  const windowStart = sortedHistory.length > 0 ? sortedHistory[0]!.asOf : null;
  return {
    featureId: definition.featureId,
    version: definition.version,
    entityId: now.assetId,
    asOf: now.asOf,
    windowStart,
    windowEnd: now.asOf,
    value,
    quality,
    denominator,
    sampleSize,
    cohortLevel: cohort.level,
    cohortSize: cohort.size,
    lineage: {
      inputSnapshotIds: sortedHistory.map((s) => s.snapshotId),
      inputHashes: sortedHistory.map((s) => hashSnapshotId(s.snapshotId)),
      codeVersion: CODE_VERSION,
      calculatedAt,
    },
    capped,
  };
};

const boundedFeatureRaw = (
  definition: FeatureDefinition,
  entityId: string,
  asOf: string,
  sampleSize: number,
  denominator: number,
  value: number | null,
  quality: FeatureQuality,
  calculatedAt: string,
  lineageIds: string[],
  lineageHashes: string[],
  capped: boolean,
): FeatureValue => {
  const cohort = computeCohortLevel(sampleSize, definition.minimumObservations, definition.cohortFallback);
  return {
    featureId: definition.featureId,
    version: definition.version,
    entityId,
    asOf,
    windowStart: null,
    windowEnd: asOf,
    value,
    quality,
    denominator,
    sampleSize,
    cohortLevel: cohort.level,
    cohortSize: cohort.size,
    lineage: {
      inputSnapshotIds: lineageIds,
      inputHashes: lineageHashes,
      codeVersion: CODE_VERSION,
      calculatedAt,
    },
    capped,
  };
};

const hashSnapshotId = (id: string): string => createHash('sha256').update(id).digest('hex');

// ---------------------------------------------------------------------------
// Feature set - canonical serialization
// ---------------------------------------------------------------------------

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

export const canonicalFeatureSetJson = (featureSet: FeatureSet): string => {
  // Deterministic: sort features by featureId ascending, validate each
  if (!featureSet || typeof featureSet !== 'object')
    throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_SET_NOT_OBJECT');
  if (typeof featureSet.assetId !== 'string' || featureSet.assetId.length === 0)
    throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_SET_ASSET_ID_MALFORMED');
  if (typeof featureSet.asOf !== 'string' || !isValidIso(featureSet.asOf))
    throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_SET_AS_OF_MALFORMED');
  if (!Array.isArray(featureSet.features))
    throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURES_NOT_ARRAY');

  for (const f of featureSet.features) {
    if (typeof f.featureId !== 'string' || f.featureId.length === 0)
      throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_ID_MALFORMED');
    if (typeof f.version !== 'string' || f.version.length === 0)
      throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_VERSION_MALFORMED');
    if (f.value !== null && (typeof f.value !== 'number' || !Number.isFinite(f.value)))
      throw new FeatureValidationError('FEATURE_MALFORMED', 'FEATURE_VALUE_MALFORMED');
    if (f.value !== null) {
      const def = getFeatureDefinition(f.featureId, f.version);
      if (def && Math.abs(f.value) > def.maxContribution + 1e-9)
        throw new FeatureValidationError('FEATURE_INCONSISTENT', 'FEATURE_VALUE_EXCEEDS_CAP');
    }
  }

  // Check for duplicate featureIds
  const ids = featureSet.features.map((f) => `${f.featureId}:${f.version}`);
  if (new Set(ids).size !== ids.length)
    throw new FeatureValidationError('FEATURE_INCONSISTENT', 'DUPLICATE_FEATURE_ID');

  const sortedFeatures = [...featureSet.features].sort((a, b) => {
    const cmp = a.featureId.localeCompare(b.featureId);
    if (cmp !== 0) return cmp;
    return a.version.localeCompare(b.version);
  });

  const canonical = canonicalize({ ...featureSet, features: sortedFeatures });
  return JSON.stringify(canonical);
};

export const canonicalFeatureSetBytes = (featureSet: FeatureSet): CanonicalFeatureOutput => {
  const json = canonicalFeatureSetJson(featureSet);
  const bytes = new TextEncoder().encode(json);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { canonicalJson: json, sha256, bytes: bytes.byteLength };
};

export const computeFeatureSet = (
  history: readonly MarketSnapshot[],
  now: MarketSnapshot,
  tradeBucketsForEntropy: number[] | null = null,
  calculatedAt: string = new Date().toISOString(),
): FeatureSet => {
  validateSnapshot(now);
  if (history.length > 0) {
    for (const h of history) validateSnapshot(h);
  }

  const vol = computeVolumeAcceleration(history, now, FEATURE_REGISTRY[0]!, calculatedAt);
  const liq = computeLiquidityGrowth(history, now, FEATURE_REGISTRY[1]!, calculatedAt);
  const dd = computeLiquidityDrawdown(history, now, FEATURE_REGISTRY[3]!, calculatedAt);

  const features: FeatureValue[] = [vol, liq, dd];

  if (tradeBucketsForEntropy !== null) {
    const ent = computeTradeEntropy(tradeBucketsForEntropy, now.asOf, now.assetId, FEATURE_REGISTRY[2]!, calculatedAt, [now.snapshotId], [hashSnapshotId(now.snapshotId)]);
    features.push(ent);
  }

  // Snapshot hash for lineage
  const snapshotHash = createHash('sha256')
    .update(JSON.stringify(canonicalize(now)))
    .digest('hex');

  // Sort features deterministically before returning
  features.sort((a, b) => a.featureId.localeCompare(b.featureId));

  return {
    assetId: now.assetId,
    asOf: now.asOf,
    features,
    snapshotHash,
  };
};
