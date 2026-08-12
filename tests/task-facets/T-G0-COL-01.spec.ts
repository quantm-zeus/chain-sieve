import { describe, expect, it } from 'vitest';
import {
  createAllowlist,
  isCovered,
  resolveProtocolSupport,
  listSupportedProtocols,
  createCollectorStreamEvent,
  createCheckpointStore,
  commitCheckpoint,
  detectGap,
  computeNextCheckpointSlot,
  backfillGap,
  createCompensatingRevision,
  handleDecoderIncident,
  isDerivedFactAllowed,
  createHealthSnapshot,
  versionedOffset,
} from '../../packages/collector-core/src/collector.js';

describe('T-G0-COL-01 collector interface facets', () => {
  it('creates explicit versioned allowlist and enforces scoped coverage FR-COL-001', () => {
    const allowlist = createAllowlist('v1', [
      { chain: 'solana', program: 'pump', programVersion: 'bonding_curve_v1', accounts: ['acc-1'], eventFamilies: ['pool_creation'], finality: 'confirmed' },
    ]);
    expect(allowlist.version).toBe('v1');
    expect(isCovered(allowlist, { chain: 'solana', program: 'pump', programVersion: 'bonding_curve_v1' })).toBe(true);
    expect(isCovered(allowlist, { chain: 'solana', program: 'pump', programVersion: 'unknown_v9' })).toBe(false);
    expect(isCovered(allowlist, { chain: 'ethereum', program: 'pump', programVersion: 'bonding_curve_v1' })).toBe(false);
  });

  it('resolves versioned read-only Solana protocol registry without generic inheritance FR-COL-002', () => {
    const supported = resolveProtocolSupport('pump', 'bonding_curve_v1', 'bonding-curve');
    expect(supported.status).toBe('SUPPORTED');
    expect(supported.decoderVersion).toBe('1.0.0');
    const unsupported = resolveProtocolSupport('pump', 'unknown_v9', 'bonding-curve');
    expect(unsupported.status).toBe('UNSUPPORTED');
    const mismatch = resolveProtocolSupport('raydium', 'amm_v4', 'bin-based');
    expect(mismatch.status).toBe('UNSUPPORTED');
    const all = listSupportedProtocols();
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((p) => p.program === 'jupiter' && p.version === 'route_observation_v1')).toBe(true);
  });

  it('stores required stream coordinates with provenance FR-COL-003', () => {
    const event = createCollectorStreamEvent({
      endpoint: 'https://rpc.example',
      subscriptionVersion: 'sub-v1',
      filterVersion: 'filter-v1',
      connectionGeneration: 2,
      slot: 12345,
      blockHash: 'hash-abc',
      transaction: 'tx-123',
      signature: 'sig-123',
      instructionIndex: 0,
      logIndex: 1,
      accountCoordinates: ['acc-1'],
      receivedAt: new Date().toISOString(),
      finality: 'confirmed',
      rawArtifactHash: 'raw-hash',
      decoderVersion: '1.0.0',
      rightsPolicy: 'policy-1',
      payload: { data: 'x' },
    });
    expect(event.endpoint).toBe('https://rpc.example');
    expect(event.slot).toBe(12345);
    expect(event.provenance).toContain('col:https://rpc.example:2:12345');
    expect(event.rawArtifactHash).toBe('raw-hash');
  });

  it('maintains durable monotonic checkpoints and detects gap before backfill FR-COL-004', () => {
    const store = createCheckpointStore();
    const cp1 = commitCheckpoint(store, 'p1', 100, 'hash100');
    expect(cp1.slot).toBe(100);
    const cp2 = commitCheckpoint(store, 'p1', 101, 'hash101');
    expect(cp2.slot).toBe(101);
    const gap = detectGap(store, 'p1', 105);
    expect(gap).not.toBeNull();
    expect(gap!.fromSlot).toBe(102);
    expect(gap!.toSlot).toBe(104);
    expect(gap!.status).toBe('OPEN');
    expect(computeNextCheckpointSlot(100)).toBe(101);
  });

  it('backfill preserves actual retrieval time and never backdates available_at FR-COL-005', () => {
    const store = createCheckpointStore();
    commitCheckpoint(store, 'p1', 10, 'h10');
    const gap = detectGap(store, 'p1', 13)!;
    const retrievedAt = new Date('2026-01-02T00:00:00.000Z').toISOString();
    const originalEvent = createCollectorStreamEvent({
      endpoint: 'https://rpc.example',
      subscriptionVersion: 'sub-v1',
      filterVersion: 'filter-v1',
      connectionGeneration: 1,
      slot: 11,
      blockHash: 'hash11',
      transaction: 'tx-11',
      signature: 'sig-11',
      instructionIndex: 0,
      logIndex: 0,
      accountCoordinates: ['acc-1'],
      receivedAt: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      finality: 'confirmed',
      rawArtifactHash: 'raw-11',
      decoderVersion: '1.0.0',
      rightsPolicy: 'policy-1',
      payload: {},
    });
    const result = backfillGap(gap, [originalEvent], retrievedAt);
    expect(new Date(result.events[0]!.availableAt).getTime()).toBeGreaterThanOrEqual(new Date(retrievedAt).getTime());
    expect(result.events[0]!.earliestSystemAvailability).toBe(retrievedAt);
  });

  it('uses immutable revisions for reorg without destructive rewrite FR-COL-006', () => {
    const event = createCollectorStreamEvent({
      endpoint: 'https://rpc.example',
      subscriptionVersion: 'sub-v1',
      filterVersion: 'filter-v1',
      connectionGeneration: 1,
      slot: 200,
      blockHash: 'hash200',
      transaction: 'tx200',
      signature: 'sig200',
      instructionIndex: 0,
      logIndex: 0,
      accountCoordinates: ['acc-1'],
      receivedAt: new Date().toISOString(),
      finality: 'confirmed',
      rawArtifactHash: 'raw200',
      decoderVersion: '1.0.0',
      rightsPolicy: 'policy-1',
      payload: {},
    });
    const revision = createCompensatingRevision(event, 'REORG');
    expect(revision.originalSignature).toBe('sig200');
    expect(revision.type).toBe('REORG');
    expect(revision.compensatingEvent.signature).not.toBe(event.signature);
    expect(revision.compensatingEvent.provenance).toContain('REORG');
    expect(event.signature).toBe('sig200');
  });

  it('pauses only affected decoding on drift and preserves raw FR-COL-007', () => {
    const scope = { program: 'pump', version: 'bonding_curve_v1', paused: false };
    const { scope: paused, incident } = handleDecoderIncident(scope, 'DECODER_DRIFT', { raw: 'event' });
    expect(paused.paused).toBe(true);
    expect(incident.rawEventPreserved).toBe(true);
    expect(incident.derivedFactsBlocked).toBe(true);
    expect(isDerivedFactAllowed(paused)).toBe(false);
    expect(isDerivedFactAllowed(scope)).toBe(true);
  });

  it('exposes collector health with required metrics FR-COL-008', () => {
    const health = createHealthSnapshot({
      connected: true,
      endpointGeneration: 3,
      headSlot: 110,
      finalizedSlot: 95,
      checkpointSlot: 100,
      gapCount: 1,
      gapDurationSlots: 5,
      backfillStatus: 'IDLE',
      decodeFailureRate: 0.02,
      streamedBytes: 2048,
      eventRate: 15,
      deduplicationRate: 0.05,
      resourceConsumption: { cpu: 0.3, memoryMb: 256, networkKbps: 1024 },
    });
    expect(health.connected).toBe(true);
    expect(health.checkpointLag).toBe(10);
    expect(health.gapCount).toBe(1);
    expect(health.resourceConsumption.memoryMb).toBe(256);
  });

  it('verifies versioned offset is behaviorally observed for mutation gate', () => {
    expect(versionedOffset(1)).toBe(2);
    expect(versionedOffset(0)).toBe(1);
    expect(versionedOffset(41)).toBe(42);
  });

  it('throws on invalid allowlist as negative path', () => {
    expect(() => createAllowlist('', [])).toThrow();
    expect(() => createCollectorStreamEvent({ endpoint: '', subscriptionVersion: 'v1', filterVersion: 'f1', connectionGeneration: 1, slot: -1, blockHash: '', transaction: '', signature: '', instructionIndex: 0, logIndex: 0, accountCoordinates: [], receivedAt: new Date().toISOString(), finality: 'confirmed', rawArtifactHash: '', decoderVersion: '', rightsPolicy: '', payload: {} })).toThrow();
  });
});
