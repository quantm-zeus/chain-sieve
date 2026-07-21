import { describe, expect, it } from 'vitest';
import { applyBootstrapMigration } from '@ciag/persistence';
import { FakeObjectStore } from '@ciag/object-store';
import { InMemoryTracer } from '@ciag/observability';
import { FakeNotificationTransport, FakeProviderNetwork, MemoryPostgresAdapter, VirtualClock } from '@ciag/test-fixtures';
import { runWalkingSkeleton } from '@ciag/workflow-runtime';

describe('synthetic walking skeleton', () => {
  it('persists point-in-time state, immutable evidence, retry and mature evaluation', async () => { const database = new MemoryPostgresAdapter(); await applyBootstrapMigration(database); const clock = new VirtualClock(); const objectStore = new FakeObjectStore(); const notifications = new FakeNotificationTransport(); notifications.failUntil = 1; const tracer = new InMemoryTracer(); const result = await runWalkingSkeleton({ database, objectStore, discovery: new FakeProviderNetwork(clock), notifications, clock, tracer }); expect(result).toMatchObject({ observationCount: 6, duplicateSuppressed: true, outboxState: 'DELIVERED', outcomeState: 'MATURE', capabilityMode: 'SYNTHETIC_SHADOW' }); expect(await objectStore.exists(result.artifactKey)).toBe(true); const temporal = await database.query<{ violations: string }>('SELECT count(*)::text AS violations FROM synthetic_observations WHERE available_at < event_time'); expect(temporal.rows[0]?.violations).toBe('0'); const evidence = await database.query<{ evidence_key: string; signal_success: boolean; tradable_success: boolean }>('SELECT evidence_key,signal_success,tradable_success FROM evaluation_records'); expect(evidence.rows[0]).toMatchObject({ evidence_key: result.artifactKey, signal_success: true, tradable_success: false }); expect(notifications.attempts).toBe(2); expect(tracer.spans[0]?.endedAt).toBeDefined(); });
});
