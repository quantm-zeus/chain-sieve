import { describe, expect, it } from 'vitest';
import { assertAllowlisted } from '../../packages/collector-core/src/allowlist.js';
import { CheckpointStore } from '../../packages/collector-core/src/checkpoint.js';
import { createAllowlist } from '../../packages/collector-core/src/allowlist.js';
import { executeCollectorAggregation } from '../../packages/collector-core/src/index.js';
import { assertSupportedDecoder } from '../../packages/collector-solana/src/registry.js';
import { isAvailableAtBackdated } from '../../packages/collector-core/src/gap.js';

describe('T-G0-COL-01 collector negative and degraded', () => {
  it('rejects unsupported program and version', () => {
    const allowlist = createAllowlist('v1');
    expect(() => assertAllowlisted(allowlist, 'UnknownProgram', 'v1')).toThrow('UNSUPPORTED_PROGRAM');
    expect(() => assertAllowlisted(allowlist, 'PumpSwap', 'v99')).toThrow('UNSUPPORTED_VERSION');
    expect(() => assertSupportedDecoder('PumpSwap', 'v99')).toThrow('UNSUPPORTED_DECODER');
  });

  it('rejects checkpoint regression', () => {
    const store = new CheckpointStore();
    store.commit({ partition: 'p1', slot: 10, sequence: 1, updatedAt: new Date().toISOString() });
    expect(() => store.commit({ partition: 'p1', slot: 9, sequence: 2, updatedAt: new Date().toISOString() })).toThrow('CHECKPOINT_REGRESSION');
    expect(() => store.commit({ partition: 'p1', slot: 10, sequence: 1, updatedAt: new Date().toISOString() })).toThrow('CHECKPOINT_REGRESSION');
  });

  it('rejects invalid aggregation input and detects backdated availability', () => {
    expect(() => executeCollectorAggregation(-1)).toThrow('invalid');
    const chainTime = new Date('2026-08-12T00:10:00.000Z').toISOString();
    const earlier = new Date('2026-08-12T00:09:00.000Z').toISOString();
    expect(isAvailableAtBackdated(chainTime, earlier)).toBe(true);
    expect(isAvailableAtBackdated(earlier, chainTime)).toBe(false);
  });
});
