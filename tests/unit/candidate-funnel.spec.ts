import { describe, it, expect } from 'vitest';
import {
  runFunnel,
  DEFAULT_FUNNEL_PROFILE,
  FunnelValidationError,
} from '@ciag/signal-intelligence';
import type { FunnelInput, FunnelProfile, FunnelAdapterEvidence } from '@ciag/signal-intelligence';
import type { FeatureSet } from '@ciag/signal-intelligence';

const iso = '2026-03-01T00:00:00.000Z';

const makeFeature = (overrides: Partial<FeatureSet['features'][number]> & { featureId: string }): FeatureSet['features'][number] => ({
  featureId: overrides.featureId,
  version: overrides.version ?? '1.0.0',
  entityId: overrides.entityId ?? 'asset-1',
  asOf: overrides.asOf ?? iso,
  windowStart: null,
  windowEnd: iso,
  value: overrides.value ?? 1.0,
  quality: overrides.quality ?? 'VALID',
  denominator: 1000,
  sampleSize: 5,
  cohortLevel: 'exact',
  cohortSize: 5,
  lineage: {
    inputSnapshotIds: ['snap-1'],
    inputHashes: ['a'.repeat(64)],
    codeVersion: '1.0.0',
    calculatedAt: iso,
  },
  capped: false,
});

const makeFeatureSet = (assetId: string, features: FeatureSet['features']): FeatureSet => ({
  assetId,
  asOf: iso,
  features,
  snapshotHash: 'b'.repeat(64),
});

const adapterAvailable = {
  poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolA',
  adapterVersion: '1.0.0',
  available: true,
  verified: true,
};

const adapterUnavailable = {
  poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolB',
  adapterVersion: '1.0.0',
  available: false,
  verified: false,
};

const inputFor = (assetId: string, scoreValue: number, adapter: FunnelAdapterEvidence | null = adapterAvailable): FunnelInput => {
  const fs = makeFeatureSet(assetId, [
    makeFeature({ featureId: 'volume_acceleration', value: scoreValue, entityId: assetId }),
    makeFeature({ featureId: 'liquidity_growth', value: scoreValue, entityId: assetId }),
  ]);
  return {
    assetId,
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asOf: iso,
    featureSet: fs,
    adapterEvidence: adapter,
  };
};

describe('candidate funnel - deterministic selection', () => {
  it('emits no eligible candidate when required feature is missing', () => {
    const fs = makeFeatureSet('asset-missing', [
      makeFeature({ featureId: 'volume_acceleration', value: 1.0, entityId: 'asset-missing' }),
      // liquidity_growth missing
    ]);
    const input: FunnelInput = {
      assetId: 'asset-missing',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asOf: iso,
      featureSet: fs,
      adapterEvidence: adapterAvailable,
    };
    const out = runFunnel([input], DEFAULT_FUNNEL_PROFILE);
    expect(out.eligibleCount).toBe(0);
    expect(out.rejectedCount).toBe(1);
    expect(out.candidates[0]!.eligible).toBe(false);
    expect(out.candidates[0]!.rejectionReasons.some((r) => r.includes('MISSING_REQUIRED_FEATURE'))).toBe(true);
    // inspectable: componentValues present, rank null, score null
    expect(out.candidates[0]!.rank).toBeNull();
    expect(out.candidates[0]!.score).toBeNull();
  });

  it('emits no eligible candidate when adapter evidence unavailable', () => {
    const input = inputFor('asset-adapter-missing', 1.0, null);
    const out = runFunnel([input], DEFAULT_FUNNEL_PROFILE);
    expect(out.eligibleCount).toBe(0);
    expect(out.candidates[0]!.rejectionReasons).toContain('ADAPTER_EVIDENCE_UNAVAILABLE');
  });

  it('emits no eligible when adapter unverified', () => {
    const input = inputFor('asset-unverified', 1.0, adapterUnavailable);
    const out = runFunnel([input], DEFAULT_FUNNEL_PROFILE);
    expect(out.eligibleCount).toBe(0);
    expect(out.candidates[0]!.rejectionReasons).toContain('ADAPTER_EVIDENCE_UNAVAILABLE');
  });

  it('emits no eligible when required feature has INSUFFICIENT_DATA', () => {
    const fs = makeFeatureSet('asset-insufficient', [
      makeFeature({ featureId: 'volume_acceleration', value: null as unknown as number, quality: 'INSUFFICIENT_DATA', entityId: 'asset-insufficient' }),
      makeFeature({ featureId: 'liquidity_growth', value: 1.0, entityId: 'asset-insufficient' }),
    ]);
    const input: FunnelInput = {
      assetId: 'asset-insufficient',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asOf: iso,
      featureSet: fs,
      adapterEvidence: adapterAvailable,
    };
    const out = runFunnel([input], DEFAULT_FUNNEL_PROFILE);
    expect(out.eligibleCount).toBe(0);
    expect(out.candidates[0]!.rejectionReasons.some((r) => r.startsWith('INSUFFICIENT_DATA'))).toBe(true);
  });

  it('boundary eligibility: score == threshold is eligible (inclusive)', () => {
    const profile: FunnelProfile = {
      version: '1.0.0',
      requiredFeatureIds: ['volume_acceleration', 'liquidity_growth'],
      featureWeights: { volume_acceleration: 1, liquidity_growth: 1 },
      minScore: 2.0,
    };
    // value 1.0 + 1.0 = 2.0 exactly threshold
    const input = inputFor('asset-boundary-exact', 1.0);
    const out = runFunnel([input], profile);
    expect(out.eligibleCount).toBe(1);
    expect(out.candidates[0]!.eligible).toBe(true);
    expect(out.candidates[0]!.score).toBe(2.0);
  });

  it('boundary eligibility: score just below threshold is rejected', () => {
    const profile: FunnelProfile = {
      version: '1.0.0',
      requiredFeatureIds: ['volume_acceleration', 'liquidity_growth'],
      featureWeights: { volume_acceleration: 1, liquidity_growth: 1 },
      minScore: 2.0,
    };
    const fs = makeFeatureSet('asset-below', [
      makeFeature({ featureId: 'volume_acceleration', value: 0.99, entityId: 'asset-below' }),
      makeFeature({ featureId: 'liquidity_growth', value: 0.99, entityId: 'asset-below' }),
    ]);
    const input: FunnelInput = {
      assetId: 'asset-below',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asOf: iso,
      featureSet: fs,
      adapterEvidence: adapterAvailable,
    };
    const out = runFunnel([input], profile);
    expect(out.eligibleCount).toBe(0);
    expect(out.candidates[0]!.rejectionReasons).toContain('SCORE_BELOW_THRESHOLD');
    // score inspectable even when rejected by threshold
    expect(out.candidates[0]!.score).toBeCloseTo(1.98);
  });

  it('deterministic tie-breaking by assetId lexicographically', () => {
    const a = inputFor('asset-aaa', 1.0);
    const b = inputFor('asset-bbb', 1.0);
    const c = inputFor('asset-zzz', 1.0);
    // All have same score (2.0)
    const out1 = runFunnel([c, a, b], DEFAULT_FUNNEL_PROFILE);
    const out2 = runFunnel([b, c, a], DEFAULT_FUNNEL_PROFILE);

    expect(out1.orderedEligibleAssetIds).toEqual(['asset-aaa', 'asset-bbb', 'asset-zzz']);
    expect(out2.orderedEligibleAssetIds).toEqual(['asset-aaa', 'asset-bbb', 'asset-zzz']);
    // Ranks are deterministic
    expect(out1.candidates.map((x) => [x.assetId, x.rank])).toEqual([
      ['asset-aaa', 1],
      ['asset-bbb', 2],
      ['asset-zzz', 3],
    ]);
  });

  it('repeatable ordering: same inputs different order produce identical output hash', () => {
    const inputs = [inputFor('asset-3', 0.5), inputFor('asset-1', 2.0), inputFor('asset-2', 1.0)];
    const outA = runFunnel(inputs, DEFAULT_FUNNEL_PROFILE);
    const outB = runFunnel([...inputs].reverse(), DEFAULT_FUNNEL_PROFILE);
    const outC = runFunnel([...inputs].sort(() => Math.random() - 0.5), DEFAULT_FUNNEL_PROFILE);
    expect(outA.sha256).toBe(outB.sha256);
    expect(outA.sha256).toBe(outC.sha256);
    expect(outA.canonicalJson).toBe(outB.canonicalJson);
    expect(outA.orderedEligibleAssetIds).toEqual(['asset-1', 'asset-2', 'asset-3']);
  });

  it('ordering is deterministic by score desc then assetId asc', () => {
    const low = inputFor('asset-low', 0.1);
    const high = inputFor('asset-high', 5.0);
    const mid = inputFor('asset-mid', 2.0);
    const out = runFunnel([low, high, mid], DEFAULT_FUNNEL_PROFILE);
    expect(out.orderedEligibleAssetIds).toEqual(['asset-high', 'asset-mid', 'asset-low']);
    expect(out.candidates[0]!.score).toBeGreaterThan(out.candidates[1]!.score as number);
  });

  it('rejection reasons are deterministic sorted and inspectable', () => {
    const fs = makeFeatureSet('asset-reject', [
      makeFeature({ featureId: 'volume_acceleration', value: null as unknown as number, quality: 'STALE', entityId: 'asset-reject' }),
    ]);
    const input: FunnelInput = {
      assetId: 'asset-reject',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asOf: iso,
      featureSet: fs,
      adapterEvidence: null,
    };
    const out = runFunnel([input], DEFAULT_FUNNEL_PROFILE);
    const reasons = out.candidates[0]!.rejectionReasons;
    // must be sorted lexicographically for determinism
    expect(reasons).toEqual([...reasons].sort());
    expect(reasons).toContain('ADAPTER_EVIDENCE_UNAVAILABLE');
    expect(reasons.some((r) => r.includes('liquidity_growth'))).toBe(true);
  });

  it('eligibleCount + rejectedCount equals total inputs', () => {
    const inputs = [inputFor('asset-ok', 1.0), inputFor('asset-bad', 1.0, null)];
    const out = runFunnel(inputs, DEFAULT_FUNNEL_PROFILE);
    expect(out.eligibleCount + out.rejectedCount).toBe(inputs.length);
    expect(out.candidates.length).toBe(inputs.length);
  });

  it('throws deterministic error on malformed input', () => {
    const bad = { assetId: '', chainId: 'x', asOf: iso, featureSet: makeFeatureSet('', []) } as unknown as FunnelInput;
    expect(() => runFunnel([bad], DEFAULT_FUNNEL_PROFILE)).toThrow(FunnelValidationError);
  });
});
