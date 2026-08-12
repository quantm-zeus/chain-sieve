import { describe, it, expect } from 'vitest';
import { createScope, validateScope, isCovered } from '../../apps/collector/src/registry.js';
import type { CollectorScope } from '../../apps/collector/src/registry.js';
import { createCheckpoint, isMonotonic } from '../../apps/collector/src/checkpoint.js';
import { decode } from '../../packages/program-decoders/src/index.js';
import { resolveProtocol } from '../../packages/collector-solana/src/index.js';

describe('T-G0-COL-01 negative facets', () => {
  it('rejects empty event families when enabled', () => {
    const scope = createScope({ allowlist: [{ chain: 'solana', program: 'pump-bc', programVersion: 'v1', accounts: [], eventFamilies: [], finality: 'confirmed', enabled: true }] });
    expect(validateScope(scope).ok).toBe(false);
  });
  it('checkpoint rejects non-monotonic sequence', () => {
    const cp = createCheckpoint('p', 10, 5);
    const bad = createCheckpoint('p', 10, 5);
    expect(isMonotonic(cp, bad)).toBe(false);
  });
  it('coverage check denies unsupported program', () => {
    const scope = createScope();
    expect(isCovered(scope,'solana','unknown-program','v1','swap')).toBe(false);
  });
  it('decoder unknown returns degraded not success', () => {
    const r = decode('mismatched-decoder', new Uint8Array([0]));
    expect(r.ok).toBe(false);
  });
  it('protocol unknown does not inherit generic behavior', () => {
    const r = resolveProtocol('raydium-amm-v4','v99') as unknown as { supported: boolean; reason: string };
    expect(r.supported).toBe(false);
    expect(r.reason).toContain('UNSUPPORTED_VERSION');
  });
  it('invalid version fails validation', () => {
    const s = createScope({ version: '' } as unknown as Partial<CollectorScope>);
    expect(validateScope(s).ok).toBe(false);
  });
});
