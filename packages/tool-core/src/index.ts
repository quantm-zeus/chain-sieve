import type { CostPolicyAdapter } from '@ciag/provider-contracts';
import type { RuntimeCacheAdapter } from '@ciag/provider-contracts';
import { assertReadOnlyExecution } from '@ciag/security';

export class ToolCore {
  constructor(private readonly cache: RuntimeCacheAdapter, private readonly costPolicy: CostPolicyAdapter) {}
  systemReadiness(): { capabilityMode: 'SYNTHETIC_SHADOW'; productCapabilitiesActive: false } { return { capabilityMode: 'SYNTHETIC_SHADOW', productCapabilitiesActive: false }; }
  async execute<T>(input: { key: string; operation: string; costClass: 'FREE' | 'METERED' | 'UNKNOWN'; expiresAt: string; parameters?: Record<string, unknown> }, load: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    assertReadOnlyExecution(input.operation, input as unknown as Record<string, unknown>);
    const cached = await this.cache.get<T>(input.key);
    if (cached !== undefined) {
      const authorization = await this.costPolicy.authorize({ operation: input.operation, costClass: input.costClass, cacheHit: true });
      if (authorization.status !== 'AVAILABLE' || authorization.value?.quotaCharged !== 0) throw new Error('CACHE_HIT_QUOTA_INVARIANT');
      return { value: cached, cached: true };
    }
    const authorization = await this.costPolicy.authorize({ operation: input.operation, costClass: input.costClass, cacheHit: false });
    if (authorization.status !== 'AVAILABLE') throw new Error(authorization.reason ?? 'COST_POLICY_DENIED');
    const value = await load(); await this.cache.set(input.key, value, input.expiresAt); return { value, cached: false };
  }
}
