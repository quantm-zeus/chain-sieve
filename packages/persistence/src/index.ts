import { readFile } from 'node:fs/promises';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import type { DatabaseAdapter, QueryResult } from '@ciag/provider-contracts';
export * from './schema.js';

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  private readonly sql: Sql | TransactionSql;
  private readonly ownsConnection: boolean;
  constructor(url: string);
  constructor(url: Sql | TransactionSql, ownsConnection: false);
  constructor(url: string | Sql | TransactionSql, ownsConnection = true) { this.sql = typeof url === 'string' ? postgres(url, { max: 10, prepare: false }) : url; this.ownsConnection = ownsConnection; }
  async query<T extends Record<string, unknown>>(statement: string, parameters: readonly unknown[] = []): Promise<QueryResult<T>> {
    const rows = await this.sql.unsafe<T[]>(statement, [...parameters] as never[]); return { rows, rowCount: rows.count };
  }
  async transaction<T>(work: (database: DatabaseAdapter) => Promise<T>): Promise<T> { const result = 'begin' in this.sql ? await this.sql.begin(async (transaction) => work(new PostgresDatabaseAdapter(transaction, false))) : await this.sql.savepoint(async (transaction) => work(new PostgresDatabaseAdapter(transaction, false))); return result as T; }
  async ready(): Promise<boolean> { try { const rows = await this.sql<{ ready: boolean }[]>`select exists(select 1 from schema_migrations where version = '0001_bootstrap_foundation') and to_regclass('public.synthetic_observations') is not null and to_regclass('public.artifact_metadata') is not null and to_regclass('public.outbox') is not null and to_regclass('public.evaluation_records') is not null as ready`; return rows[0]?.ready === true; } catch { return false; } }
  async close(): Promise<void> { if (this.ownsConnection && 'end' in this.sql) await this.sql.end(); }
}

export const applyBootstrapMigration = async (database: DatabaseAdapter, path = 'infra/migrations/0001_bootstrap_foundation.sql'): Promise<void> => {
  try { const applied = await database.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version='0001_bootstrap_foundation'"); if (applied.rowCount === 1) return; } catch { /* An empty database has no migration ledger yet. */ }
  const sql = await readFile(path, 'utf8');
  await database.transaction(async (transaction) => { await transaction.query(sql); });
};

export const applyDurableWorkflowMigration = async (database: DatabaseAdapter, path = 'infra/migrations/0002_durable_workflow_core.sql'): Promise<void> => {
  try { const applied = await database.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version='0002_durable_workflow_core'"); if (applied.rowCount === 1) return; } catch { /* table missing yet */ }
  const sql = await readFile(path, 'utf8');
  await database.transaction(async (transaction) => { await transaction.query(sql); });
};
