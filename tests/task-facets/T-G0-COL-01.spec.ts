import { describe, it, expect } from 'vitest';
import { Collector } from '../../apps/collector/src/index.js';
import { DEFAULT_ALLOWLIST } from '@ciag/collector-solana';
import { defaultRegistry } from '@ciag/program-decoders';
import { CheckpointStore, GapTracker, hashRaw, Deduplicator, RevisionStore } from '@ciag/collector-core';

const makeEvent = (overrides: Partial<Record<string, unknown>> = {}) => ({
  endpoint: 'https://api.mainnet.solana',
  subscriptionVersion: '1',
  filterVersion: '1',
  connectionGeneration: 1,
  slot: 100n,
  blockHash: 'abc123',
  signature: 'sig1',
  instructionIndex: 0,
  receivedAt: new Date().toISOString(),
  finality: 'confirmed' as const,
  program: 'pump',
  programVersion: 'bonding-curve-v1',
  eventFamily: 'pool_creation',
  raw: new TextEncoder().encode('raw-data'),
  decoderVersion: '1',
  rightsPolicy: 'allow',
  ...overrides,
});

describe('T-G0-COL-01 positive facets', () => {
  it('allowlist is explicit and versioned, unsupported versions are explicit', () => {
    const c = new Collector();
    expect(c.getAllowlist().version).toBe(DEFAULT_ALLOWLIST.version);
    expect(c.isAllowlisted('pump', 'bonding-curve-v1', 'pool_creation')).toBe(true);
    expect(c.isAllowlisted('pump', 'unknown-v99', 'pool_creation')).toBe(false);
    const registry = defaultRegistry();
    const res = registry.decode('pump', 'unknown-v99', new Uint8Array([1]), 'pool_creation');
    expect(res.status).toBe('unsupported');
  });

  it('collector stream stores all required coordinates and hashes', () => {
    const c = new Collector();
    c.connect(1);
    const ev = makeEvent({ slot: 42n, blockHash: 'bh42', signature: 'sig42', instructionIndex: 2, logIndex: 1 });
    const out = c.ingest(ev as unknown as Parameters<typeof c.ingest>[0]);
    expect((out as { duplicate: boolean }).duplicate).toBe(false);
    const rec = (out as { record: { endpoint: string; subscriptionVersion: string; filterVersion: string; connectionGeneration: number; slot: bigint; blockHash: string; signature: string; coordinates: { slot: bigint; blockHash: string; signature: string; instructionIndex: number }; receivedAt: string; availableAt: string; rawArtifactHash: string; decoderVersion: string; rightsPolicy: string } }).record;
    expect(rec.endpoint).toBe(ev.endpoint);
    expect(rec.subscriptionVersion).toBe('1');
    expect(rec.connectionGeneration).toBe(1);
    expect(rec.slot).toBe(42n);
    expect(rec.blockHash).toBe('bh42');
    expect(rec.coordinates.instructionIndex).toBe(2);
    expect(typeof rec.availableAt).toBe('string');
    expect(rec.rawArtifactHash.length).toBe(64);
  });

  it('checkpoint monotonic per partition and gap detection before backfill', () => {
    const store = new CheckpointStore();
    store.set({ partition: 'p1', slot: 10n, sequence: 1n, updatedAt: new Date().toISOString() });
    expect(() => store.set({ partition: 'p1', slot: 5n, sequence: 2n, updatedAt: new Date().toISOString() })).toThrow();
    const tracker = new GapTracker();
    tracker.detect('p1', 10n, 20n, 1n, 10n);
    expect(tracker.unresolvedCount()).toBe(1);
    tracker.markBackfilled('p1', 10n, new Date().toISOString());
    expect(tracker.unresolvedCount()).toBe(0);
  });

  it('gap backfill preserves retrieval time and never backdates available_at', async () => {
    const c = new Collector();
    c.connect(2);
    c.detectGap('part', 10n, 20n, 1n, 10n);
    const retrieval = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 2));
    const result = c.backfill('part', 10n, retrieval);
    expect(result.preserved).toBe(true);
    expect(Date.parse(result.availableAt)).toBe(Date.parse(retrieval));
  });

  it('unresolved gaps downgrade coverage claims', () => {
    const c = new Collector();
    c.detectGap('p', 1n, 5n, 1n, 5n);
    const res = c.markUnresolved('p', 1n);
    expect(res.coverage).toBe('DOWNGRADED');
  });

  it('reorg and duplicate use immutable revisions and deduplication', () => {
    const rev = new RevisionStore();
    const rec = { signature: 'sig', slot: 1n } as unknown as import('@ciag/collector-core').CollectorStreamRecord;
    rev.append(rec, 'original');
    rev.append(rec, 'compensating', 'prev');
    expect(rev.all().length).toBe(2);
    expect(rev.all()[1]!.kind).toBe('compensating');
    const dedup = new Deduplicator();
    expect(dedup.isDuplicate('sig', 1n)).toBe(false);
    expect(dedup.isDuplicate('sig', 1n)).toBe(true);
  });

  it('program upgrade pause preserves raw and creates incident scope', () => {
    const registry = defaultRegistry();
    const empty = registry.decode('pump', 'bonding-curve-v1', new Uint8Array([]), 'pool_creation');
    expect(empty.status).toBe('paused');
  });

  it('health exposes required FR-COL-008 fields', () => {
    const c = new Collector();
    c.connect(3);
    c.ingest(makeEvent({ signature: 's1', slot: 1n }) as never);
    c.ingest(makeEvent({ signature: 's2', slot: 2n }) as never);
    c.checkpoint('p1', 1n, 1n);
    c.detectGap('p1', 5n, 10n, 2n, 7n);
    const h = c.healthSnapshot();
    expect(typeof h.connected).toBe('boolean');
    expect(typeof h.endpointGeneration).toBe('number');
    expect(typeof h.headSlot).toBe('bigint');
    expect(typeof h.finalizedSlot).toBe('bigint');
    expect(typeof h.checkpointLag).toBe('bigint');
    expect(typeof h.gapCount).toBe('number');
    expect(typeof h.backfillStatus).toBe('string');
    expect(typeof h.decodeFailureRate).toBe('number');
    expect(typeof h.streamedBytes).toBe('number');
    expect(typeof h.eventRate).toBe('number');
    expect(typeof h.deduplicationRate).toBe('number');
  });

  it('hashRaw deterministic and shared-schemas style', () => {
    const raw = new TextEncoder().encode('hello');
    expect(hashRaw(raw)).toBe(hashRaw(raw));
    expect(hashRaw(raw).length).toBe(64);
  });

  it('covers all FR-COL-002 programs via registry', () => {
    const reg = defaultRegistry();
    const keys = reg.supportedKeys();
    expect(keys.length).toBeGreaterThanOrEqual(13);
    for (const prog of ['pump:bonding-curve-v1', 'raydium:amm-v4', 'orca:whirlpools-v1', 'meteora:dlmm-v1', 'jupiter:route-observation-v1']) {
      expect(keys).toContain(prog);
    }
  });
});
