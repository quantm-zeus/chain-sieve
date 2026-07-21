import { loadConfig } from '@ciag/config';
import { applyBootstrapMigration, PostgresDatabaseAdapter } from '@ciag/persistence';

const config = loadConfig(); const database = new PostgresDatabaseAdapter(config.DATABASE_URL);
try { await applyBootstrapMigration(database); if (!await database.ready()) throw new Error('MIGRATION_DID_NOT_REACH_READY_STATE'); console.log(JSON.stringify({ status: 'PASS', migration: '0001_bootstrap_foundation' })); }
catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
finally { await database.close(); }
