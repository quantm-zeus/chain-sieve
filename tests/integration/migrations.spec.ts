import { beforeEach, describe, expect, it } from 'vitest';
import { applyBootstrapMigration } from '@ciag/persistence';
import { MemoryPostgresAdapter } from '@ciag/test-fixtures';

describe('authoritative bootstrap migration', () => {
  let database: MemoryPostgresAdapter;
  beforeEach(() => { database = new MemoryPostgresAdapter(); });
  it('upgrades an empty database and is rerun-safe', async () => { await applyBootstrapMigration(database); await applyBootstrapMigration(database); const result = await database.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"); expect(result.rows.map((row) => row.table_name)).toContain('synthetic_observations'); });
  it('enforces no-backdating in storage', async () => { await applyBootstrapMigration(database); await expect(database.query(`INSERT INTO synthetic_observations (id,asset_id,stage,payload_json,event_time,observed_at,available_at,idempotency_key,capability_mode) VALUES ('x','a','s','{}','2026-01-02','2026-01-03','2026-01-01','k','SYNTHETIC_SHADOW')`)).rejects.toThrow(); });
});
