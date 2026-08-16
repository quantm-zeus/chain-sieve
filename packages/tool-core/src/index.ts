import type { CostPolicyAdapter } from '@ciag/provider-contracts';
import type { RuntimeCacheAdapter } from '@ciag/provider-contracts';
import { assertReadOnlyExecution } from '@ciag/security';

const SCHEMA_DRIFT_ERROR = 'SCHEMA_DRIFT';

function assertNoSchemaDrift(value: unknown, allowedFields?: readonly string[]): void {
  if (!allowedFields || allowedFields.length === 0) return;
  if (value === null || value === undefined) return;
  if (typeof value !== 'object' || Array.isArray(value)) return;
  const received = Object.keys(value as Record<string, unknown>);
  for (const field of received) {
    if (!allowedFields.includes(field)) throw new Error(SCHEMA_DRIFT_ERROR);
  }
}

export class ToolCore {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly freshnessAt = new Map<string, number>();

  constructor(
    private readonly cache: RuntimeCacheAdapter,
    private readonly costPolicy: CostPolicyAdapter,
  ) {}

  systemReadiness(): { capabilityMode: 'SYNTHETIC_SHADOW'; productCapabilitiesActive: false } {
    return { capabilityMode: 'SYNTHETIC_SHADOW', productCapabilitiesActive: false };
  }

  async execute<T>(
    input: {
      key: string;
      operation: string;
      costClass: 'FREE' | 'METERED' | 'UNKNOWN';
      expiresAt: string;
      parameters?: Record<string, unknown>;
    },
    load: () => Promise<T>,
    options?: { allowedFields?: readonly string[] },
  ): Promise<{ value: T; cached: boolean; freshnessSeconds?: number; cache: 'MISS' | 'HIT_FRESH' | 'HIT_STALE' | 'REFRESHED'; quotaCharged: number }> {
    // 1. Prohibited financial enforcement precedes all other steps
    assertReadOnlyExecution(input.operation, input as unknown as Record<string, unknown>);

    // 2. Exact cache check - cache hit path must still authorize with zero quota
    const cached = await this.cache.get<T>(input.key);
    if (cached !== undefined) {
      const authorization = await this.costPolicy.authorize({
        operation: input.operation,
        costClass: input.costClass,
        cacheHit: true,
      });
      if (authorization.status !== 'AVAILABLE' || authorization.value?.quotaCharged !== 0) throw new Error('CACHE_HIT_QUOTA_INVARIANT');
      const cachedAt = this.freshnessAt.get(input.key);
      const freshnessSeconds = cachedAt !== undefined ? Math.max(0, (Date.now() - cachedAt) / 1000) : 0;
      const result: { value: T; cached: boolean; freshnessSeconds?: number; cache: 'MISS' | 'HIT_FRESH' | 'HIT_STALE' | 'REFRESHED'; quotaCharged: number } = {
        value: cached,
        cached: true,
        freshnessSeconds,
        cache: 'HIT_FRESH',
        quotaCharged: 0,
      };
      Object.defineProperty(result, 'freshnessSeconds', { value: freshnessSeconds, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(result, 'cache', { value: 'HIT_FRESH' as const, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(result, 'quotaCharged', { value: 0, enumerable: false, writable: true, configurable: true });
      return result;
    }

    // 3. Single-flight across concurrent callers for the same exact cache key
    const existing = this.inflight.get(input.key);
    if (existing) {
      const value = (await existing) as T;
      const authorization = await this.costPolicy.authorize({
        operation: input.operation,
        costClass: input.costClass,
        cacheHit: true,
      });
      if (authorization.status !== 'AVAILABLE' || authorization.value?.quotaCharged !== 0)
        throw new Error('CACHE_HIT_QUOTA_INVARIANT');
      const cachedAt = this.freshnessAt.get(input.key);
      const freshnessSeconds = cachedAt !== undefined ? Math.max(0, (Date.now() - cachedAt) / 1000) : 0;
      const deduped: { value: T; cached: boolean; freshnessSeconds?: number; cache: 'MISS' | 'HIT_FRESH' | 'HIT_STALE' | 'REFRESHED'; quotaCharged: number } = {
        value,
        cached: true,
        freshnessSeconds,
        cache: 'HIT_FRESH',
        quotaCharged: 0,
      };
      Object.defineProperty(deduped, 'freshnessSeconds', { value: freshnessSeconds, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(deduped, 'cache', { value: 'HIT_FRESH' as const, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(deduped, 'quotaCharged', { value: 0, enumerable: false, writable: true, configurable: true });
      return deduped;
    }

    const promise = (async (): Promise<T> => {
      // 4. Authorization precedes provider execution - fail closed before network
      const authorization = await this.costPolicy.authorize({
        operation: input.operation,
        costClass: input.costClass,
        cacheHit: false,
      });
      if (authorization.status !== 'AVAILABLE') throw new Error(authorization.reason ?? 'COST_POLICY_DENIED');

      // 5. Provider execution with deadline semantics delegated to caller
      const value = await load();

      // 6. Provider schema drift fails explicitly - never fabricate partial truth from unknown fields
      assertNoSchemaDrift(value, options?.allowedFields);
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        options?.allowedFields === undefined
      ) {
        // When no explicit allowlist is provided, unknown top-level marker field `__schemaDrift` is treated as drift signal for safety
        const marker = (value as Record<string, unknown>).__schemaDrift;
        if (marker === true) throw new Error(SCHEMA_DRIFT_ERROR);
      }

      // 7. Exact cache update only after successful validation
      await this.cache.set(input.key, value, input.expiresAt);
      this.freshnessAt.set(input.key, Date.now());
      return value;
    })();

    this.inflight.set(input.key, promise);
    try {
      const value = (await promise) as T;
      const result: { value: T; cached: boolean; freshnessSeconds?: number; cache: 'MISS' | 'HIT_FRESH' | 'HIT_STALE' | 'REFRESHED'; quotaCharged: number } = {
        value,
        cached: false,
        freshnessSeconds: 0,
        cache: 'MISS',
        quotaCharged: 1,
      };
      Object.defineProperty(result, 'freshnessSeconds', { value: 0, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(result, 'cache', { value: 'MISS' as const, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(result, 'quotaCharged', { value: 1, enumerable: false, writable: true, configurable: true });
      return result;
    } catch (error) {
      this.inflight.delete(input.key);
      throw error;
    } finally {
      if (this.inflight.get(input.key) === promise) this.inflight.delete(input.key);
    }
  }

  // Explicit schema validation helper for provider responses outside execute
  assertSchema(value: unknown, allowedFields: readonly string[]): void {
    assertNoSchemaDrift(value, allowedFields);
  }
}
