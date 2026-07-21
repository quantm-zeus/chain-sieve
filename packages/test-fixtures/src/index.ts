import { createHash } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import type { DatabaseAdapter, DiscoveryUniverseAdapter, DurableWorkflowAdapter, NotificationAdapter, QueryResult, SchedulerAdapter } from '@ciag/provider-contracts';
import type { DegradedResult, PointInTime, SyntheticAsset } from '@ciag/domain';
export { FakeObjectStore } from '@ciag/object-store';

export class VirtualClock {
  constructor(private current: Date = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): string { return this.current.toISOString(); }
  advance(milliseconds: number): void { this.current = new Date(this.current.getTime() + milliseconds); }
}

export class DeterministicRandom { constructor(private state = 0x12345678) {} next(): number { this.state = (1664525 * this.state + 1013904223) >>> 0; return this.state / 0x1_0000_0000; } }
export class DeterministicIdGenerator { private sequence = 0; constructor(private readonly prefix = 'id') {} next(): string { this.sequence += 1; return `${this.prefix}-${String(this.sequence).padStart(6, '0')}`; } }
export class FailureInjector { private readonly failures = new Map<string, number>(); inject(name: string, times = 1): void { this.failures.set(name, times); } check(name: string): void { const remaining = this.failures.get(name) ?? 0; if (remaining > 0) { this.failures.set(name, remaining - 1); throw new Error(`INJECTED_${name.toUpperCase()}`); } } }

export class MemoryPostgresAdapter implements DatabaseAdapter {
  private readonly pool: { query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number }>; end(): Promise<void> };
  constructor() { const memory = newDb({ autoCreateForeignKeyIndices: true }); memory.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length }); const Pool = memory.adapters.createPg().Pool; this.pool = new Pool(); }
  async query<T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<T>> { const result = await this.pool.query(sql, parameters); return { rows: result.rows as T[], rowCount: result.rowCount }; }
  async transaction<T>(work: (database: DatabaseAdapter) => Promise<T>): Promise<T> { await this.query('BEGIN'); try { const result = await work(this); await this.query('COMMIT'); return result; } catch (error) { await this.query('ROLLBACK'); throw error; } }
  async ready(): Promise<boolean> { return true; }
  async close(): Promise<void> { await this.pool.end(); }
}

export class FakeProviderNetwork implements DiscoveryUniverseAdapter {
  timeout = false; schemaDrift = false;
  constructor(private readonly clock: VirtualClock) {}
  async discover(asOf: string): Promise<DegradedResult<PointInTime<SyntheticAsset>[]>> { if (this.timeout) return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'PROVIDER_TIMEOUT' }; if (this.schemaDrift) return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'SCHEMA_DRIFT' }; return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: [{ value: { id: 'synthetic:asset-1', chain: 'synthetic', symbol: 'SYN1', capability: 'SYNTHETIC_SHADOW' }, eventTime: asOf, observedAt: this.clock.now(), availableAt: this.clock.now(), provenance: 'fixture:golden-v1/normal-asset', quality: 'SYNTHETIC' }] }; }
}
export class FakeScheduler implements SchedulerAdapter { readonly triggers = new Map<string, string>(); async schedule(input: { idempotencyKey: string; runAt: string }): Promise<DegradedResult<{ triggerId: string }>> { const id = this.triggers.get(input.idempotencyKey) ?? `trigger-${this.triggers.size + 1}`; this.triggers.set(input.idempotencyKey, id); return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { triggerId: id } }; } async cancel(triggerId: string): Promise<void> { for (const [key, id] of this.triggers) if (id === triggerId) this.triggers.delete(key); } }
export class FakeNotificationTransport implements NotificationAdapter { attempts = 0; failUntil = 0; async enqueue(input: { outboxId: string }): Promise<DegradedResult<{ deliveryId: string }>> { this.attempts += 1; if (this.attempts <= this.failUntil) return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'RETRYABLE_TRANSPORT' }; return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { deliveryId: `delivery-${input.outboxId}` } }; } }
export class FakeWorkflowRuntime implements DurableWorkflowAdapter { private readonly states = new Map<string, string>(); crashNext = false; async start(input: { idempotencyKey: string }): Promise<DegradedResult<{ runId: string }>> { const runId = `run-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 12)}`; this.states.set(runId, this.crashNext ? 'CRASHED' : 'RUNNING'); this.crashNext = false; return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { runId } }; } async resume(runId: string): Promise<DegradedResult<{ runId: string; state: string }>> { if (!this.states.has(runId)) return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'RUN_NOT_FOUND' }; this.states.set(runId, 'RESUMED'); return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { runId, state: 'RESUMED' } }; } }
export class FakeQuotaClock { used = 0; constructor(readonly limit: number) {} charge(amount: number, cacheHit = false): DegradedResult<{ quotaCharged: number }> { if (cacheHit) return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: 0 } }; if (this.used + amount > this.limit) return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'QUOTA_EXHAUSTED' }; this.used += amount; return { status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: amount } }; } reset(): void { this.used = 0; } }
export interface ReplayManifest { version: '1'; seed: number; clockStart: string; fixtureIds: string[]; sourceHashes: Record<string, string> }
