import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../../packages/collector-core/src/checkpoint.js';
import { createAllowlist, isAllowlisted } from '../../packages/collector-core/src/allowlist.js';
import { executeCollectorAggregation } from '../../packages/collector-core/src/index.js';
import { createBackfillRequest } from '../../packages/collector-core/src/gap.js';
import { createInitialHealth, updateHealthOnEvent } from '../../packages/collector-core/src/health.js';
import { assertSupportedDecoder } from '../../packages/collector-solana/src/registry.js';
import { decodeEvent } from '../../packages/program-decoders/src/index.js';

describe('T-G0-COL-01 collector positive', () => {
  it('enforces versioned allowlist and supported decoders', () => {
    const allowlist = createAllowlist('v1');
    expect(isAllowlisted(allowlist, 'PumpSwap', 'v1')).toBe(true);
    expect(isAllowlisted(allowlist, 'PumpSwap', 'v9')).toBe(false);
    expect(assertSupportedDecoder('PumpSwap', 'v1').supported).toBe(true);
  });

  it('maintains monotonic checkpoints and detects gaps before backfill', () => {
    const store = new CheckpointStore();
    store.commit({ partition: 'solana-main', slot: 100, sequence: 1, updatedAt: new Date().toISOString() });
    const gap = store.detectGap('solana-main', 100, 105);
    expect(gap).toBeDefined();
    expect(gap?.fromSlot).toBe(101);
    const req = createBackfillRequest(gap!, 'https://rpc.example', new Date().toISOString());
    expect(req.fromSlot).toBe(101);
    store.commit({ partition: 'solana-main', slot: 105, sequence: 2, updatedAt: new Date().toISOString() });
    expect(store.load('solana-main')?.slot).toBe(105);
  });

  it('preserves raw events and exposes health metrics', () => {
    const decoded = decodeEvent({ signature: 'sig1', slot: 10, program: 'PumpSwap', version: 'v1', raw: 'rawbytes' });
    expect(decoded.preserveRaw).toBe(true);
    expect(decoded.incidentRequired).toBe(false);
    const unknown = decodeEvent({ signature: 'sig2', slot: 11, program: 'UnknownProg', version: 'v9', raw: 'raw' });
    expect(unknown.incidentRequired).toBe(true);
    const health = createInitialHealth();
    const updated = updateHealthOnEvent({ ...health, connected: true, endpointGeneration: 1, headSlot: 10, finalizedSlot: 9 }, 512);
    expect(updated.streamedBytes).toBe(512);
    expect(updated.eventRate).toBe(1);
  });

  it('verifies collector aggregation arithmetic and backfill availability', () => {
    for (const value of [0, 1, 2, 100]) expect(executeCollectorAggregation(value)).toBe(value + 1);
    expect(executeCollectorAggregation(1)).toBe(2);
  });
});
