import type { RuntimeCacheAdapter } from '@ciag/provider-contracts';

export class ExactMemoryCache implements RuntimeCacheAdapter {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  async get<T>(key: string): Promise<T | undefined> { const entry = this.values.get(key); if (!entry || entry.expiresAt <= Date.now()) return undefined; return structuredClone(entry.value) as T; }
  async set<T>(key: string, value: T, expiresAt: string): Promise<void> { this.values.set(key, { value: structuredClone(value), expiresAt: Date.parse(expiresAt) }); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}
