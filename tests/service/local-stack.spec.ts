import { beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@ciag/object-store';
import { InMemoryTracer } from '@ciag/observability';
import { applyBootstrapMigration, PostgresDatabaseAdapter } from '@ciag/persistence';
import { FakeNotificationTransport, FakeProviderNetwork, VirtualClock } from '@ciag/test-fixtures';
import { replayStagesAsOf, runWalkingSkeleton } from '@ciag/workflow-runtime';

const databaseUrl = process.env.CIAG_TEST_DATABASE_URL; const s3Endpoint = process.env.CIAG_TEST_S3_ENDPOINT; const s3Bucket = process.env.CIAG_TEST_S3_BUCKET; const accessKeyId = process.env.CIAG_TEST_S3_ACCESS_KEY_ID; const secretAccessKey = process.env.CIAG_TEST_S3_SECRET_ACCESS_KEY;
if (!databaseUrl || !s3Endpoint || !s3Bucket || !accessKeyId || !secretAccessKey) throw new Error('SERVICE_TEST_CONFIGURATION_REQUIRED');
const database = new PostgresDatabaseAdapter(databaseUrl); const store = new S3ObjectStore(s3Bucket, { endpoint: s3Endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

describe('live PostgreSQL and S3-compatible walking skeleton', () => {
  beforeAll(async () => { await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); });
  it('fails readiness before migration, rolls transactions back, then persists the complete synthetic flow', async () => { await expect(database.ready()).resolves.toBe(false); await applyBootstrapMigration(database); await expect(database.ready()).resolves.toBe(true); await expect(database.transaction(async (transaction) => { await transaction.query("INSERT INTO harness_state (key,value_json,version,updated_at) VALUES ('rollback','{}',1,now())"); throw new Error('ROLLBACK'); })).rejects.toThrow('ROLLBACK'); expect((await database.query("SELECT key FROM harness_state WHERE key='rollback'")).rowCount).toBe(0); await expect(store.ready()).resolves.toBe(true); const clock = new VirtualClock(); const result = await runWalkingSkeleton({ database, objectStore: store, discovery: new FakeProviderNetwork(clock), notifications: new FakeNotificationTransport(), clock, tracer: new InMemoryTracer(() => 'trace-service-000001', () => clock.now()) }); expect(result).toMatchObject({ observationCount: 6, outboxState: 'DELIVERED', outcomeState: 'MATURE', capabilityMode: 'SYNTHETIC_SHADOW', traceId: 'trace-service-000001' }); expect(await store.exists(result.artifactKey)).toBe(true); expect(await replayStagesAsOf(database, result.assetId, '2025-12-31T23:59:59Z')).toEqual([]); expect(await replayStagesAsOf(database, result.assetId, '2026-01-01T00:00:00Z')).toHaveLength(6); const traces = await database.query<{ count: string }>('SELECT count(DISTINCT trace_id)::text AS count FROM (SELECT trace_id FROM synthetic_observations UNION ALL SELECT trace_id FROM artifact_metadata UNION ALL SELECT trace_id FROM outbox UNION ALL SELECT trace_id FROM evaluation_records) values_with_trace'); expect(traces.rows[0]?.count).toBe('1'); });
});
