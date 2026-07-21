import { describe, expect, it } from 'vitest';
import { loadConfig } from '@ciag/config';
import { CapabilityRegistry } from '@ciag/capability-registry';
import { ExactMemoryCache } from '@ciag/runtime-cache';
import { ToolCore } from '@ciag/tool-core';

describe('bootstrap core', () => {
  it('validates configuration and pins synthetic shadow mode', () => { expect(loadConfig({ NODE_ENV: 'test' }).CAPABILITY_MODE).toBe('SYNTHETIC_SHADOW'); expect(() => loadConfig({ API_PORT: '0' })).toThrow(); expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('PRODUCTION_CONFIG_REQUIRED'); expect(() => loadConfig({ NODE_ENV: 'test', OBJECT_STORE_DRIVER: 's3' })).toThrow(); });
  it('keeps engineering and influence states independent', () => { const registry = new CapabilityRegistry(); registry.register({ id: 'example', engineeringState: 'IMPLEMENTED', availabilityState: 'DISABLED', influenceState: 'DISABLED', reason: 'bootstrap' }); expect(registry.get('example')?.influenceState).toBe('DISABLED'); expect(() => registry.activate()).toThrow('AUTOMATIC_CAPABILITY_ACTIVATION_PROHIBITED'); });
  it('does not charge quota on an exact cache hit', async () => { const cache = new ExactMemoryCache(); let charges = 0; const core = new ToolCore(cache, { authorize: async ({ cacheHit }) => ({ status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: cacheHit ? 0 : ++charges } }) }); const input = { key: 'x', operation: 'free.synthetic', costClass: 'FREE' as const, expiresAt: '2099-01-01T00:00:00.000Z' }; await core.execute(input, async () => 7); const result = await core.execute(input, async () => 9); expect(result).toEqual({ value: 7, cached: true }); expect(charges).toBe(1); });
});
