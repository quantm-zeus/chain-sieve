import { describe, expect, it } from 'vitest';
import { architectureViolations, placeholderViolations, prohibitedCapabilityViolations } from '../../tools/architecture-verifier/verify.js';
import { controls } from '../../tools/spec-mutation/mutations.js';
import { assertLease, type LifecycleDocument } from '../../tools/task-runner/state.js';
import { FakeProviderNetwork, VirtualClock } from '@ciag/test-fixtures';
import { ToolCore } from '@ciag/tool-core';
import { ExactMemoryCache } from '@ciag/runtime-cache';

describe('critical specification mutations', () => {
  it('rejects removal of available_at', () => { expect(() => controls.requireAvailableAt({ asset_id: 'x' })).toThrow('AVAILABLE_AT_REQUIRED'); });
  it('rejects backdated available_at', () => { expect(() => controls.rejectBackdating('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toThrow('AVAILABLE_AT_BACKDATED'); });
  it('rejects a stale worker commit', () => { const state: LifecycleDocument = { schemaVersion: '2.0.0', tasks: { task: { taskId: 'task', state: 'LEASED', leaseVersion: 2, holder: 'new', leaseId: 'task:2:new', expiresAt: '2027-01-01T00:00:00Z' } } }; expect(() => assertLease(state, 'task', 1, 'old', new Date('2026-01-01'))).toThrow('STALE_LEASE_VERSION'); });
  it('rejects charging quota on a cache hit', async () => { const cache = new ExactMemoryCache(); await cache.set('x', 1, '2099-01-01T00:00:00Z'); const core = new ToolCore(cache, { authorize: async () => ({ status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: 1 } }) }); await expect(core.execute({ key: 'x', operation: 'x', costClass: 'FREE', expiresAt: '2099-01-01T00:00:00Z' }, async () => 2)).rejects.toThrow('CACHE_HIT_QUOTA_INVARIANT'); });
  it('rejects paid fallback in STRICT_FREE', () => { expect(() => controls.requireStrictFree('METERED')).toThrow('STRICT_FREE_DENIED'); });
  it('rejects model-direct notification', () => { expect(() => controls.rejectModelNotification()).toThrow('MODEL_DIRECT_NOTIFICATION_PROHIBITED'); });
  it('rejects treating SIGNAL_SUCCESS as sufficient tradable outcome', () => { expect(() => controls.preserveOutcomeDistinction({ signalSuccess: true })).toThrow('TRADABLE_OUTCOME_REQUIRED'); });
  it('fails closed on provider schema drift', async () => { const provider = new FakeProviderNetwork(new VirtualClock()); provider.schemaDrift = true; await expect(provider.discover('2026-01-01T00:00:00Z')).resolves.toMatchObject({ status: 'NOT_AVAILABLE', reason: 'SCHEMA_DRIFT' }); expect(() => controls.rejectSilentSchemaDrift(['price'], ['price', 'unknown'])).toThrow('SCHEMA_DRIFT'); });
  it('rejects automatic alpha activation', () => { expect(() => controls.rejectAutoActivation()).toThrow('AUTOMATIC_CAPABILITY_ACTIVATION_PROHIBITED'); });
  it('rejects dashboard provider imports', () => { expect(architectureViolations('apps/dashboard/src/routes/mutant.ts', "import { x } from '@ciag/provider-contracts';")).toContain('apps/dashboard/src/routes/mutant.ts:dashboard-direct-data-import'); });
  it('rejects skipped tests and weakened assertions', () => { const mutant = ['it', '.', "skip('x', () => ", 'expect(', 'true', ').toBe(', 'true', '));'].join(''); expect(placeholderViolations('tests/mutant.spec.ts', mutant)).toEqual(expect.arrayContaining(['tests/mutant.spec.ts:skipped-test', 'tests/mutant.spec.ts:trivial-assertion'])); });
  it('rejects transaction broadcast capability aliases', () => { expect(prohibitedCapabilityViolations('packages/mutant.ts', 'export const broadcastSignedPayload = async () => 1;')).not.toEqual([]); });
});
