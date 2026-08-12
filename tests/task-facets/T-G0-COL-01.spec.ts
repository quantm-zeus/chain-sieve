import { describe, it, expect } from 'vitest';
import { createScope, validateScope, isCovered, isSupported } from '../../apps/collector/src/registry.js';
import { createCheckpoint, isMonotonic, detectGap, backfillEnvelope, isAvailableAtPointInTime } from '../../apps/collector/src/checkpoint.js';
import { createHealth, degradedCoverage, pauseScope } from '../../apps/collector/src/health.js';
import { resolveProtocol } from '../../packages/collector-solana/src/index.js';
import { decode } from '../../packages/program-decoders/src/index.js';

describe('T-G0-COL-01 collector facets', () => {
  it('allowlist validates only supported versions', () => {
    const scope = createScope();
    expect(validateScope(scope).ok).toBe(true);
    const bad = createScope({ allowlist: [{ chain: 'solana', program: 'unknown', programVersion: 'v99', accounts: [], eventFamilies: ['swap'], finality: 'confirmed', enabled: true }] });
    expect(validateScope(bad).ok).toBe(false);
    expect(isSupported('pump-bc','v1')).toBe(true);
    expect(isSupported('pump-bc','v99')).toBe(false);
  });
  it('cannot imply coverage outside allowlist', () => {
    const scope = createScope();
    expect(isCovered(scope,'solana','pump-bc','v1','pool_create')).toBe(true);
    expect(isCovered(scope,'solana','pump-bc','v1','swap')).toBe(false);
    expect(isCovered(scope,'solana','raydium-amm-v4','v4','swap')).toBe(false);
  });
  it('checkpoint monotonic and gap detection records before backfill', () => {
    const cp = createCheckpoint('partition-a', 100, 5, '2026-01-01T00:00:00.000Z');
    const next = createCheckpoint('partition-a', 101, 6, '2026-01-01T00:00:01.000Z');
    expect(isMonotonic(cp, next)).toBe(true);
    expect(isMonotonic(next, cp)).toBe(false);
    const gap = detectGap(cp, 103, 10, '2026-01-01T00:00:02.000Z');
    expect(gap).not.toBeNull();
    expect(gap!.status).toBe('detected');
  });
  it('backfill never backdates available_at', () => {
    const envelope = { endpoint: 'https://rpc', subscriptionVersion: '1', connectionGeneration: 1, slot: 100, blockHash: 'abc', signature: 'sig1', instructionIndex: 0, logIndex: null, accountCoordinates: null, receivedAt: '2026-01-01T00:00:01.000Z', availableAt: '2026-01-01T00:00:02.000Z', earliestSystemAvailability: '2026-01-01T00:00:02.000Z', finality: 'confirmed' as const, rawArtifactHash: 'hash', decoderVersion: 'v1', rightsPolicy: 'allow' };
    const later = '2026-01-01T00:00:10.000Z';
    const backfilled = backfillEnvelope(envelope, later);
    expect(backfilled.availableAt).toBe(later);
    expect(isAvailableAtPointInTime(backfilled, '2026-01-01T00:00:05.000Z')).toBe(false);
    expect(isAvailableAtPointInTime(backfilled, '2026-01-01T00:00:11.000Z')).toBe(true);
    const earlier = '2026-01-01T00:00:01.000Z';
    const notBackdated = backfillEnvelope(envelope, earlier);
    expect(notBackdated.availableAt).toBe(envelope.availableAt);
  });
  it('health exposes metrics and degraded coverage', () => {
    const health = createHealth({ connected: true, headSlot: 200, checkpointLag: 2, gapCount: 1 });
    expect(health.connected).toBe(true);
    expect(degradedCoverage([{status:'unresolved'}])).toBe('DEGRADED');
    expect(degradedCoverage([{status:'backfilled'}])).toBe('FULL');
    const incident = pauseScope('decoder_drift','pump-bc:v1');
    expect(incident.rawPreserved).toBe(true);
    expect(incident.derivedBlocked).toBe(true);
  });
  it('protocol registry rejects unknown and unsupported', () => {
    const ok = resolveProtocol('jupiter','v6');
    expect((ok as unknown as { supported: boolean }).supported).toBe(true);
    const unknown = resolveProtocol('unknown','v1') as unknown as { supported: boolean };
    expect(unknown.supported).toBe(false);
    const unsupported = resolveProtocol('jupiter','v99') as unknown as { supported: boolean };
    expect(unsupported.supported).toBe(false);
  });
  it('decoder preserves raw on unknown variant', () => {
    const result = decode('unknown-decoder', new Uint8Array([1,2,3]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rawPreserved).toBe(true);
    const ok = decode('pump-bc-v1', new Uint8Array([1]));
    expect(ok.ok).toBe(true);
  });
});
