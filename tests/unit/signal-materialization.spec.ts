import { describe, it, expect } from 'vitest';
import {
  computeFeatureSet,
  runFunnel,
  DEFAULT_FUNNEL_PROFILE,
  materializeSignal,
  materializeSignals,
  InMemorySignalStore,
  SignalMaterializationError,
  canonicalSnapshotBytes,
  canonicalFeatureSetBytes,
} from '@ciag/signal-intelligence';
import type { FeatureSet, MarketSnapshot } from '@ciag/signal-intelligence';

const iso2 = '2026-03-01T02:00:00.000Z';

const makeSnapshot = (asOf = iso2, overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => {
  const base: MarketSnapshot = {
    snapshotId: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:So11111111111111111111111111111111111111112:${asOf}`,
    assetId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:So11111111111111111111111111111111111111112',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asOf,
    version: '1.0.0',
    pools: [
      {
        poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolA111111111111111111111111111111111111111',
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        dex: 'raydium',
        poolAddress: 'PoolA111111111111111111111111111111111111111',
        liquidityUsd: '100000.00',
        volumeUsd24h: '50000.00',
        quoteAssetRepresentationId: null,
        updatedAt: '2026-02-28T23:59:00.000Z',
        quality: 'VALID',
      },
    ],
    market: {
      priceUsd: '1.23',
      volumeUsd24h: '125000.00',
      marketCapUsd: '5000000.00',
      updatedAt: '2026-02-28T23:59:30.000Z',
    },
    provenance: {
      observationIds: ['obs-1', 'obs-2'],
      evidenceHashes: ['a'.repeat(64), 'b'.repeat(64)],
      collectedAt: '2026-03-01T00:00:01.000Z',
    },
    quality: 'VALID',
  };
  return { ...base, ...overrides, snapshotId: (overrides.snapshotId as string) ?? base.snapshotId } as MarketSnapshot;
};

const history = [makeSnapshot('2026-03-01T00:00:00.000Z'), makeSnapshot('2026-03-01T01:00:00.000Z')];
const now = makeSnapshot(iso2);

const buildEligible = () => {
  const featureSet = computeFeatureSet(history, now, [10, 5, 2, 1], iso2);
  const adapterEvidence = {
    poolId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:raydium:PoolA111111111111111111111111111111111111111',
    adapterVersion: '1.0.0',
    available: true,
    verified: true,
  };
  const funnelInput = {
    assetId: now.assetId,
    chainId: now.chainId,
    asOf: iso2,
    featureSet,
    adapterEvidence,
  };
  const funnelOut = runFunnel([funnelInput], DEFAULT_FUNNEL_PROFILE);
  return { featureSet, funnelOut, adapterEvidence, snapshot: now };
};

describe('signal materialization', () => {
  it('materializes complete provenance: canonical inputs, feature versions, adapter, funnel decision', () => {
    const { featureSet, funnelOut, snapshot } = buildEligible();
    const candidate = funnelOut.candidates[0]!;
    expect(candidate.eligible).toBe(true);

    const signal = materializeSignal({
      candidate,
      featureSet,
      snapshot,
      funnelProfile: DEFAULT_FUNNEL_PROFILE,
      funnelVersion: funnelOut.funnelVersion,
    });

    // Canonical inputs
    expect(signal.canonicalInputs.snapshotHash).toBe(canonicalSnapshotBytes(snapshot).sha256);
    expect(signal.canonicalInputs.featureSetHash).toBe(canonicalFeatureSetBytes(featureSet).sha256);
    expect(signal.canonicalInputs.featureVersions).toEqual(
      Object.fromEntries(featureSet.features.map((f) => [f.featureId, f.version])),
    );
    expect(signal.canonicalInputs.adapterPoolId).toBe(candidate.adapterEvidence!.poolId);
    expect(signal.canonicalInputs.adapterVersion).toBe(candidate.adapterEvidence!.adapterVersion);
    // Schema: canonicalInputs must NOT contain extraneous fields
    expect(signal.canonicalInputs).not.toHaveProperty('snapshotId');
    expect(signal.canonicalInputs).not.toHaveProperty('observationIds');
    expect(signal.canonicalInputs).not.toHaveProperty('evidenceHashes');
    expect(signal.canonicalInputs).not.toHaveProperty('collectedAt');

    // Feature versions map
    expect(signal.featureVersions).toEqual(signal.canonicalInputs.featureVersions);
    expect(signal.featureVersions['volume_acceleration']).toBe('1.0.0');

    // Adapter provenance
    expect(signal.adapterProvenance.poolId).toBe(candidate.adapterEvidence!.poolId);
    expect(signal.adapterProvenance.adapterVersion).toBe(candidate.adapterEvidence!.adapterVersion);
    expect(signal.adapterProvenance.verified).toBe(true);
    expect(signal.adapterProvenance.available).toBe(true);

    // Funnel decision
    expect(signal.funnelDecision.profileVersion).toBe(DEFAULT_FUNNEL_PROFILE.version);
    expect(signal.funnelDecision.funnelVersion).toBe(funnelOut.funnelVersion);
    expect(signal.funnelDecision.score).toBe(candidate.score);
    expect(signal.funnelDecision.rank).toBe(candidate.rank);
    expect(signal.funnelDecision.eligible).toBe(true);
    expect(signal.funnelDecision.componentValues.length).toBeGreaterThan(0);

    // Full provenance inputs (where extra fields belong)
    expect(signal.provenance.inputs.snapshotHash).toBe(signal.canonicalInputs.snapshotHash);
    expect(signal.provenance.inputs.featureSetHash).toBe(signal.canonicalInputs.featureSetHash);
    expect(signal.provenance.inputs.observationIds).toEqual(['obs-1', 'obs-2']);
    expect(signal.provenance.inputs.evidenceHashes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(signal.provenance.inputs.collectedAt).toBe(snapshot.provenance.collectedAt);
    expect(signal.provenance.inputs.snapshotId).toBe(snapshot.snapshotId);

    // Immutable and canonical
    expect(signal.immutable).toBe(true);
    expect(Object.isFrozen(signal)).toBe(true);
    expect(signal.canonicalJson).toBeDefined();
    expect(signal.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(signal.bytes).toBeGreaterThan(0);
    expect(signal.signalId).toMatch(/^sig_[a-f0-9]{32}$/);

    // Canonical payload canonicalInputs does not contain divergent fields
    const parsed = JSON.parse(signal.canonicalJson) as { canonicalInputs: Record<string, unknown> };
    expect(parsed.canonicalInputs).not.toHaveProperty('snapshotId');
    expect(parsed.canonicalInputs).not.toHaveProperty('observationIds');
  });

  it('duplicate evaluation is idempotent with deterministic hash', () => {
    const { featureSet, funnelOut, snapshot } = buildEligible();
    const candidate = funnelOut.candidates[0]!;
    const sig1 = materializeSignal({
      candidate,
      featureSet,
      snapshot,
      funnelProfile: DEFAULT_FUNNEL_PROFILE,
      funnelVersion: funnelOut.funnelVersion,
    });
    const sig2 = materializeSignal({
      candidate,
      featureSet,
      snapshot,
      funnelProfile: DEFAULT_FUNNEL_PROFILE,
      funnelVersion: funnelOut.funnelVersion,
    });
    expect(sig1.signalId).toBe(sig2.signalId);
    expect(sig1.sha256).toBe(sig2.sha256);
    expect(sig1.canonicalJson).toBe(sig2.canonicalJson);
    expect(sig1.bytes).toBe(sig2.bytes);

    // Batch idempotency
    const batch1 = materializeSignals(funnelOut, { [now.assetId]: featureSet }, { [now.assetId]: snapshot }, DEFAULT_FUNNEL_PROFILE);
    const batch2 = materializeSignals(funnelOut, { [now.assetId]: featureSet }, { [now.assetId]: snapshot }, DEFAULT_FUNNEL_PROFILE);
    expect(batch1.sha256).toBe(batch2.sha256);
    expect(batch1.signalIds).toEqual(batch2.signalIds);
    expect(batch1.canonicalJson).toBe(batch2.canonicalJson);
  });

  it('fail-closed on invalid, incomplete, inconsistent evidence with typed errors', () => {
    const { featureSet, funnelOut, snapshot } = buildEligible();
    const candidate = funnelOut.candidates[0]!;

    // Invalid: null candidate => SIGNAL_MALFORMED or INCOMPLETE
    expect(() => materializeSignal({ candidate: null as unknown as typeof candidate, featureSet, snapshot, funnelProfile: DEFAULT_FUNNEL_PROFILE })).toThrow(SignalMaterializationError);
    try {
      materializeSignal({ candidate: null as unknown as typeof candidate, featureSet, snapshot, funnelProfile: DEFAULT_FUNNEL_PROFILE });
    } catch (e) {
      expect((e as SignalMaterializationError).code).toMatch(/SIGNAL_(MALFORMED|INCOMPLETE|INCONSISTENT)/);
    }

    // Incomplete: ineligible candidate
    const badFS = { ...featureSet, features: [featureSet.features[0]!] } as FeatureSet;
    const badInput = {
      assetId: now.assetId,
      chainId: now.chainId,
      asOf: iso2,
      featureSet: badFS,
      adapterEvidence: null,
    };
    const badFunnel = runFunnel([badInput as unknown as import('@ciag/signal-intelligence').FunnelInput], DEFAULT_FUNNEL_PROFILE);
    expect(badFunnel.candidates[0]!.eligible).toBe(false);
    expect(() => materializeSignal({ candidate: badFunnel.candidates[0]!, featureSet: badFS, snapshot, funnelProfile: DEFAULT_FUNNEL_PROFILE })).toThrow(SignalMaterializationError);
    expect(() => materializeSignal({ candidate: badFunnel.candidates[0]!, featureSet: badFS, snapshot, funnelProfile: DEFAULT_FUNNEL_PROFILE })).toThrow(expect.objectContaining({ code: 'SIGNAL_INCOMPLETE' }));

    // Incomplete: missing required feature quality not VALID
    const lowQualityFS: FeatureSet = {
      ...featureSet,
      features: featureSet.features.map((f) => (f.featureId === 'volume_acceleration' ? { ...f, quality: 'LOW_SAMPLE' as const, value: 1 } : f)),
    };
    // Need to recompute candidate with low quality to avoid hash mismatch, so test via malformed lineage instead
    // Test malformed lineage when no snapshot
    const malformedFS = {
      ...featureSet,
      features: featureSet.features.map((f) => ({ ...f, lineage: null as unknown as FeatureSet['features'][number]['lineage'] })),
    } as unknown as FeatureSet;
    expect(() =>
      materializeSignal({
        candidate,
        featureSet: malformedFS,
        snapshot: null,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
        funnelVersion: funnelOut.funnelVersion,
      }),
    ).toThrow(SignalMaterializationError);
    try {
      materializeSignal({
        candidate,
        featureSet: malformedFS,
        snapshot: null,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
        funnelVersion: funnelOut.funnelVersion,
      });
    } catch (e) {
      expect((e as SignalMaterializationError).code).toBe('SIGNAL_MALFORMED');
    }

    // Inconsistent: featureSetHash mismatch
    const mismatchedCandidate = { ...candidate, featureSetHash: 'c'.repeat(64) };
    expect(() => materializeSignal({ candidate: mismatchedCandidate, featureSet, snapshot, funnelProfile: DEFAULT_FUNNEL_PROFILE })).toThrow(SignalMaterializationError);
  });

  it('materializeSignals validates each candidate and throws typed error not TypeError', () => {
    const { featureSet, snapshot } = buildEligible();
    const funnelOutWithNull = { candidates: [null as unknown as import('@ciag/signal-intelligence').FunnelCandidate], funnelVersion: '1.0.0', profileVersion: '1.0.0' };
    expect(() => materializeSignals(funnelOutWithNull as unknown as { candidates: import('@ciag/signal-intelligence').FunnelCandidate[] }, { [now.assetId]: featureSet }, { [now.assetId]: snapshot }, DEFAULT_FUNNEL_PROFILE)).toThrow(SignalMaterializationError);
    const funnelOutMissingComponent = {
      candidates: [{ assetId: now.assetId, eligible: true, componentValues: null as unknown as [], chainId: now.chainId, asOf: iso2, score: 1, rank: 1, rejectionReasons: [], featureSetHash: 'b'.repeat(64), adapterEvidence: { poolId: 'x', adapterVersion: '1.0.0', available: true, verified: true } } as unknown as import('@ciag/signal-intelligence').FunnelCandidate],
      funnelVersion: '1.0.0',
    };
    expect(() => materializeSignals(funnelOutMissingComponent as unknown as { candidates: import('@ciag/signal-intelligence').FunnelCandidate[] }, { [now.assetId]: featureSet }, { [now.assetId]: snapshot }, DEFAULT_FUNNEL_PROFILE)).toThrow(SignalMaterializationError);
  });

  it('batch ordering deterministic and InMemorySignalStore idempotent', () => {
    // Build two eligible candidates with different scores
    const makeSnapshotForAsset = (assetId: string, asOf: string): MarketSnapshot => {
      const snap = makeSnapshot(asOf);
      return {
        ...snap,
        assetId,
        snapshotId: `${assetId}:${asOf}`,
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        pools: snap.pools.map((p) => ({ ...p, chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })),
      } as MarketSnapshot;
    };
    const makeEligibleFor = (assetSuffix: string, vol: number) => {
      const assetId = `asset-${assetSuffix}`;
      const snap = makeSnapshotForAsset(assetId, iso2);
      const hist = [makeSnapshotForAsset(assetId, '2026-03-01T00:00:00.000Z'), makeSnapshotForAsset(assetId, '2026-03-01T01:00:00.000Z')];
      const fs = computeFeatureSet(hist, snap, [vol * 10, vol * 5, vol, 1], iso2);
      const adapter = { poolId: `pool-${assetSuffix}`, adapterVersion: '1.0.0', available: true, verified: true };
      return { snap, fs, adapter };
    };
    const a = makeEligibleFor('A', 2);
    const b = makeEligibleFor('B', 1);
    const funnelOut = runFunnel(
      [
        { assetId: a.fs.assetId, chainId: a.snap.chainId, asOf: iso2, featureSet: a.fs, adapterEvidence: a.adapter },
        { assetId: b.fs.assetId, chainId: b.snap.chainId, asOf: iso2, featureSet: b.fs, adapterEvidence: b.adapter },
      ],
      DEFAULT_FUNNEL_PROFILE,
    );
    expect(funnelOut.eligibleCount).toBe(2);

    const batch = materializeSignals(
      funnelOut,
      { [a.fs.assetId]: a.fs, [b.fs.assetId]: b.fs },
      { [a.fs.assetId]: a.snap, [b.fs.assetId]: b.snap },
      DEFAULT_FUNNEL_PROFILE,
    );
    expect(batch.signals.length).toBe(2);
    // Deterministic ordering by signalId
    expect(batch.signalIds).toEqual([...batch.signalIds].sort());
    expect(batch.signals.map((s) => s.signalId)).toEqual(batch.signalIds);

    // InMemorySignalStore idempotency and integrity
    const store = new InMemorySignalStore();
    const put1 = store.put(batch.signals[0]!);
    const put2 = store.put(batch.signals[0]!);
    expect(put1).toBe(put2);
    expect(store.size()).toBe(1);
    store.put(batch.signals[1]!);
    expect(store.size()).toBe(2);
    // Collision with different payload but same signalId should throw
    const tampered = { ...batch.signals[0]!, sha256: 'd'.repeat(64), canonicalJson: '{"tampered":true}' } as unknown as typeof batch.signals[0];
    // Need to keep same signalId to trigger collision
    (tampered as unknown as Record<string, unknown>).signalId = batch.signals[0]!.signalId;
    expect(() => store.put(tampered as unknown as typeof batch.signals[0])).toThrow(SignalMaterializationError);
  });
});
