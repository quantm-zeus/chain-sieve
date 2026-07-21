import { readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';
import type { DatabaseAdapter, QueryResult } from '@ciag/provider-contracts';
export * from './schema.js';

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  private readonly sql: Sql;
  constructor(url: string) { this.sql = postgres(url, { max: 10, prepare: false }); }
  async query<T extends Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []): Promise<QueryResult<T>> {
    const rows = await this.sql.unsafe<T[]>(statement, [...parameters] as never[]); return { rows, rowCount: rows.count };
  }
  async transaction<T>(work: (database: DatabaseAdapter) => Promise<T>): Promise<T> { const result = await this.sql.begin(async () => work(this)); return result as T; }
  async ready(): Promise<boolean> { try { await this.sql`select 1`; return true; } catch { return false; } }
  async close(): Promise<void> { await this.sql.end(); }
}

const migratedAdapters = new WeakSet<DatabaseAdapter>();
export const applyBootstrapMigration = async (database: DatabaseAdapter, path = 'infra/migrations/0001_bootstrap_foundation.sql'): Promise<void> => {
  if (migratedAdapters.has(database)) return;
  const sql = await readFile(path, 'utf8');
  await database.query(sql);
  migratedAdapters.add(database);
};
