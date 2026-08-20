import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { getTableName } from 'drizzle-orm';
import { applyBootstrapMigration } from '@ciag/persistence';
import * as schema from '../../packages/persistence/src/schema.js';
import { MemoryPostgresAdapter } from '@ciag/test-fixtures';

describe('authoritative bootstrap migration', () => {
  let database: MemoryPostgresAdapter;
  beforeEach(() => { database = new MemoryPostgresAdapter(); });
  it('upgrades an empty database and is rerun-safe', async () => { await applyBootstrapMigration(database); await applyBootstrapMigration(database); const result = await database.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"); expect(result.rows.map((row) => row.table_name)).toContain('synthetic_observations'); const ledger = await database.query<{ version: string }>('SELECT version FROM schema_migrations'); expect(ledger.rows).toEqual([{ version: '0001_bootstrap_foundation' }]); });
  it('enforces no-backdating in storage', async () => { await applyBootstrapMigration(database); await expect(database.query(`INSERT INTO synthetic_observations (id,asset_id,stage,payload_json,event_time,observed_at,available_at,idempotency_key,capability_mode,trace_id) VALUES ('x','a','s','{}','2026-01-02','2026-01-03','2026-01-01','k','SYNTHETIC_SHADOW','trace')`)).rejects.toThrow(); });
  it('keeps authoritative SQL table names mirrored by Drizzle without speculative production schema', async () => {
    const sql1 = await readFile('infra/migrations/0001_bootstrap_foundation.sql', 'utf8');
    const sql2 = await readFile('infra/migrations/0002_durable_workflow_core.sql', 'utf8');
    const sql3 = await readFile('infra/migrations/0003_alert_lifecycle_and_outbox.sql', 'utf8');
    const sql4 = await readFile('infra/migrations/0004_scheduling_control_plane.sql', 'utf8');
    const sql5 = await readFile('infra/migrations/0005_durable_recovery_continuity.sql', 'utf8');
    const sqlTables = [...(sql1 + sql2 + sql3 + sql4 + sql5).matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map((match) => match[1]).sort();
    const drizzleTables = Object.values(schema).map((table) => getTableName(table)).sort();
    expect(drizzleTables).toEqual(sqlTables);
    expect(sqlTables).toHaveLength(29);
  });
});
