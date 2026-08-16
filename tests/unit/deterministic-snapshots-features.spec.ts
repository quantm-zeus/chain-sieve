import { describe, it, expect } from 'vitest';
import {
  canonicalSnapshotBytes,
  canonicalSnapshotJson,
  validateSnapshot,
  SnapshotValidationError,
} from '@ciag/signal-intelligence';
import {
  canonicalFeatureSetBytes,
  canonicalFeatureSetJson,
  computeFeatureSet,
  computeTradeEntropy,
  computeVolumeAcceleration,
  FeatureValidationError,
} from '@ciag/signal-intelligence';
import type { MarketSnapshot } from '@ciag/signal-intelligence';

const makeSnapshot = (overrides: Partial<MarketSnapshot> & { poolsOrder?: 'normal' | 'reversed' } = {}): MarketSnapshot => {
  const asOf = overrides.asOf ?? '2026-03-01T00:00:00.000Z';
  const assetId = overrides.assetId ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:So11111111111111111111111111111111111111112';
  const chainId = overrides.chainId ?? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

  const pools = [
    {
      poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolA111111111111111111111111111111111111111',
      chainId,
      dex: 'raydium',
      poolAddress: 'PoolA111111111111111111111111111111111111111',
      liquidityUsd: '100000.00',
      volumeUsd24h: '50000.00',
      quoteAssetRepresentationId: null,
      updatedAt: '2026-02-28T23:59:00.000Z',
      quality: 'VALID' as const,
    },
    {
      poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolB222222222222222222222222222222222222222',
      chainId,
      dex: 'raydium',
      poolAddress: 'PoolB222222222222222222222222222222222222222',
      liquidityUsd: '200000.00',
      volumeUsd24h: '75000.00',
      quoteAssetRepresentationId: null,
      updatedAt: '2026-02-28T23:58:00.000Z',
      quality: 'VALID' as const,
    },
  ];

  const orderedPools = overrides.poolsOrder === 'reversed' ? [...pools].reverse() : pools;

  const snap: MarketSnapshot = {
    snapshotId: `${assetId}:${asOf}`,
    assetId,
    chainId,
    asOf,
    version: '1.0.0',
    pools: (overrides.pools as MarketSnapshot['pools']) ?? orderedPools,
    market: overrides.market ?? {
      priceUsd: '1.23',
      volumeUsd24h: '125000.00',
      marketCapUsd: '5000000.00',
      updatedAt: '2026-02-28T23:59:30.000Z',
    },
    provenance: overrides.provenance ?? {
      observationIds: ['obs-1', 'obs-2'],
      evidenceHashes: ['a'.repeat(64), 'b'.repeat(64)],
      collectedAt: '2026-03-01T00:00:01.000Z',
    },
    quality: overrides.quality ?? 'VALID',
  };
  // Ensure snapshotId consistency if asOf/assetId overridden
  snap.snapshotId = `${snap.assetId}:${snap.asOf}`;
  return snap;
};

describe('deterministic-snapshots-features', () => {
  it('equivalent ordered input produces byte-stable canonical snapshot', () => {
    const a = makeSnapshot({ poolsOrder: 'normal' });
    const b = makeSnapshot({ poolsOrder: 'reversed' });

    const bytesA = canonicalSnapshotBytes(a);
    const bytesB = canonicalSnapshotBytes(b);

    expect(bytesA.canonicalJson).toBe(bytesB.canonicalJson);
    expect(bytesA.sha256).toBe(bytesB.sha256);
    expect(bytesA.bytes).toBe(bytesB.bytes);

    // Also ensure JSON keys are sorted and pools sorted by poolId
    const parsed = JSON.parse(bytesA.canonicalJson);
    expect(parsed.pools[0].poolId < parsed.pools[1].poolId).toBe(true);
  });

  it('reordered object keys still produce identical bytes', () => {
    const base = makeSnapshot();
    // Create a snapshot with same logical data but different key insertion order
    const reordered: MarketSnapshot = {
      quality: base.quality,
      provenance: {
        collectedAt: base.provenance.collectedAt,
        evidenceHashes: [...base.provenance.evidenceHashes],
        observationIds: [...base.provenance.observationIds],
      },
      market: {
        updatedAt: base.market.updatedAt,
        marketCapUsd: base.market.marketCapUsd,
        volumeUsd24h: base.market.volumeUsd24h,
        priceUsd: base.market.priceUsd,
      },
      pools: [...base.pools].reverse(),
      version: base.version,
      asOf: base.asOf,
      chainId: base.chainId,
      assetId: base.assetId,
      snapshotId: base.snapshotId,
    } as MarketSnapshot;

    expect(canonicalSnapshotJson(base)).toBe(canonicalSnapshotJson(reordered));
  });

  it('feature computation is deterministic and byte-stable across reordered inputs', () => {
    const history = [
      makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' }),
      makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z' }),
    ];
    const now = makeSnapshot({ asOf: '2026-03-01T02:00:00.000Z' });
    const nowReordered = makeSnapshot({ asOf: '2026-03-01T02:00:00.000Z', poolsOrder: 'reversed' });

    const setA = computeFeatureSet(history, now, [10, 5, 2, 1], '2026-03-01T02:00:01.000Z');
    const setB = computeFeatureSet(history, nowReordered, [10, 5, 2, 1], '2026-03-01T02:00:01.000Z');

    const bytesA = canonicalFeatureSetBytes(setA);
    const bytesB = canonicalFeatureSetBytes(setB);

    expect(bytesA.canonicalJson).toBe(bytesB.canonicalJson);
    expect(bytesA.sha256).toBe(bytesB.sha256);

    // Features sorted by featureId
    const parsed = JSON.parse(bytesA.canonicalJson);
    const ids = parsed.features.map((f: { featureId: string }) => f.featureId);
    expect(ids).toEqual([...ids].sort());
  });

  it('feature computation rejects malformed snapshot deterministically', () => {
    const malformed = makeSnapshot() as unknown as Record<string, unknown>;
    malformed.asOf = 'not-a-date';
    // Must fix snapshotId to match asOf for consistency, but asOf itself is malformed so validation hits malformed first
    expect(() => validateSnapshot(malformed)).toThrow(SnapshotValidationError);
    try {
      validateSnapshot(malformed);
    } catch (e) {
      expect((e as SnapshotValidationError).code).toBe('SNAPSHOT_MALFORMED');
    }

    const history = [makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' })];
    expect(() => computeFeatureSet(history, malformed as unknown as MarketSnapshot)).toThrow(FeatureValidationError);
  });

  it('feature computation rejects incomplete snapshot deterministically', () => {
    const incomplete = { ...makeSnapshot() } as unknown as Record<string, unknown>;
    delete incomplete.market;
    expect(() => validateSnapshot(incomplete)).toThrow(SnapshotValidationError);
    try {
      validateSnapshot(incomplete);
    } catch (e) {
      expect((e as SnapshotValidationError).code).toBe('SNAPSHOT_INCOMPLETE');
    }
  });

  it('feature computation rejects inconsistent snapshot deterministically', () => {
    const inconsistent = makeSnapshot();
    // Pool updated after asOf -> inconsistent
    inconsistent.pools[0].updatedAt = '2026-04-01T00:00:00.000Z';
    expect(() => validateSnapshot(inconsistent)).toThrow(SnapshotValidationError);
    try {
      validateSnapshot(inconsistent);
    } catch (e) {
      expect((e as SnapshotValidationError).code).toBe('SNAPSHOT_INCONSISTENT');
    }

    // Duplicate poolIds
    const dup = makeSnapshot();
    dup.pools = [dup.pools[0], { ...dup.pools[0] }];
    expect(() => validateSnapshot(dup)).toThrow(SnapshotValidationError);

    // History with duplicate asOf
    const h1 = makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' });
    const h2 = makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' });
    const now = makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z' });
    expect(() => computeVolumeAcceleration([h1, h2], now)).toThrow(FeatureValidationError);
  });

  it('low denominator and one-bucket entropy produce bounded deterministic features with correct quality codes', () => {
    const historyLow = [
      makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z', market: { priceUsd: '1.00', volumeUsd24h: '100.00', marketCapUsd: null, updatedAt: '2026-02-28T23:59:00.000Z' } }),
    ];
    const nowLow = makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z', market: { priceUsd: '1.00', volumeUsd24h: '120.00', marketCapUsd: null, updatedAt: '2026-03-01T00:59:00.000Z' } });

    // Low absolute activity -> INSUFFICIENT_DATA with null value
    const volLow = computeVolumeAcceleration(historyLow, nowLow);
    expect(volLow.quality).toBe('INSUFFICIENT_DATA');
    expect(volLow.value).toBeNull();

    // One-bucket entropy -> LOW_SAMPLE with bounded value
    const entropyOne = computeTradeEntropy([100, 0, 0], '2026-03-01T01:00:00.000Z', 'asset-1');
    expect(entropyOne.quality).toBe('LOW_SAMPLE');
    expect(entropyOne.value).toBe(0);
    expect(entropyOne.capped).toBe(false);

    // Normal entropy should be bounded and VALID
    const entropyNormal = computeTradeEntropy([10, 5, 2, 1], '2026-03-01T01:00:00.000Z', 'asset-1');
    expect(entropyNormal.quality).toBe('VALID');
    expect(entropyNormal.value).not.toBeNull();
    expect(Math.abs(entropyNormal.value as number)).toBeLessThanOrEqual(3);

    // Shrinkage: small sample should pull toward prior
    const entropySmall = computeTradeEntropy([2, 1], '2026-03-01T01:00:00.000Z', 'asset-1');
    expect(entropySmall.quality).toBe('LOW_SAMPLE');
  });

  it('feature values are capped and deterministic', () => {
    const history = [
      makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z', market: { priceUsd: '1.00', volumeUsd24h: '1000.00', marketCapUsd: null, updatedAt: '2026-02-28T23:59:00.000Z' } }),
      makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z', market: { priceUsd: '1.00', volumeUsd24h: '10000.00', marketCapUsd: null, updatedAt: '2026-03-01T00:59:00.000Z' } }),
    ];
    const now = makeSnapshot({ asOf: '2026-03-01T02:00:00.000Z', market: { priceUsd: '1.00', volumeUsd24h: '100000.00', marketCapUsd: null, updatedAt: '2026-03-01T01:59:00.000Z' } });
    const vol = computeVolumeAcceleration(history, now, undefined, '2026-03-01T02:00:01.000Z');
    // Even with huge growth, log1p + capping keeps it bounded
    expect(vol.value).not.toBeNull();
    expect(Math.abs(vol.value as number)).toBeLessThanOrEqual(5);
  });

  it('canonical feature set json rejects inconsistent bounded values', () => {
    const history = [makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' })];
    const now = makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z' });
    const set = computeFeatureSet(history, now, null, '2026-03-01T01:00:01.000Z');
    // Mutate to exceed cap
    const mutated = { ...set, features: set.features.map((f) => ({ ...f, value: 999 })) };
    expect(() => canonicalFeatureSetJson(mutated as unknown as typeof set)).toThrow(FeatureValidationError);
  });

  it('snapshot bytes are reproducible offline: same logical state yields same hash regardless of input order', () => {
    const a = makeSnapshot({ poolsOrder: 'normal' });
    const bPoolsReversed: MarketSnapshot = { ...a, pools: [...a.pools].reverse() };
    // Ensure IDs still consistent
    bPoolsReversed.snapshotId = a.snapshotId;

    const hashA = canonicalSnapshotBytes(a).sha256;
    const hashB = canonicalSnapshotBytes(bPoolsReversed).sha256;
    expect(hashA).toBe(hashB);

    // Feature set offline vs online should match when calculatedAt is pinned
    const hist = [makeSnapshot({ asOf: '2026-03-01T00:00:00.000Z' })];
    const now1 = makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z' });
    const now2 = makeSnapshot({ asOf: '2026-03-01T01:00:00.000Z', poolsOrder: 'reversed' });
    const pin = '2026-03-01T01:00:05.000Z';
    const offline = computeFeatureSet(hist, now1, null, pin);
    const online = computeFeatureSet(hist, now2, null, pin);
    expect(canonicalFeatureSetBytes(offline).sha256).toBe(canonicalFeatureSetBytes(online).sha256);
  });
});
