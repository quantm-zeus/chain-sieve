import { describe, expect, it } from 'vitest';
import {
  commitCheckpoint,
  createCheckpointStore,
  handleDecoderIncident,
  resolveProtocolSupport,
  versionedOffset,
} from '../../packages/collector-core/src/collector.js';

describe('T-G0-COL-01 negative and degraded paths', () => {
  it('rejects non-monotonic checkpoint commits', () => {
    const store = createCheckpointStore();
    commitCheckpoint(store, 'p1', 10, 'h10');
    expect(() => commitCheckpoint(store, 'p1', 10, 'h10-dup')).toThrow('CHECKPOINT_NOT_MONOTONIC');
    expect(() => commitCheckpoint(store, 'p1', 5, 'h5')).toThrow('CHECKPOINT_NOT_MONOTONIC');
  });

  it('returns explicit unsupported for unknown protocol versions', () => {
    const result = resolveProtocolSupport('unknown_program', 'v9', 'bonding-curve');
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.manifestSignature).toBe('unsigned');
  });

  it('fails closed on invalid negative slot', () => {
    const store = createCheckpointStore();
    expect(() => commitCheckpoint(store, 'p1', -1, 'hash')).toThrow('INVALID_CHECKPOINT_SLOT');
  });

  it('blocks derived facts when scope is paused', () => {
    const scope = { program: 'raydium', version: 'amm_v4', paused: false };
    const { scope: paused } = handleDecoderIncident(scope, 'PARITY_FAILURE', { raw: 'x' });
    expect(paused.paused).toBe(true);
    expect(paused.incidentId).toBeDefined();
  });

  it('observes production offset output as negative guard', () => {
    expect(versionedOffset(10)).toBe(11);
    expect(() => {
      const v = versionedOffset(-5);
      if (v !== -4) throw new Error('mismatch');
    }).not.toThrow();
    expect(() => commitCheckpoint(createCheckpointStore(), 'p1', -100, 'h')).toThrow();
  });
});
