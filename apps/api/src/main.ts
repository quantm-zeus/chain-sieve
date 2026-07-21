import { serve } from '@hono/node-server';
import { loadConfig } from '@ciag/config';
import { FilesystemObjectStore, S3ObjectStore } from '@ciag/object-store';
import { PostgresDatabaseAdapter } from '@ciag/persistence';
import { createApp } from './app.js';

const config = loadConfig();
const database = new PostgresDatabaseAdapter(config.DATABASE_URL);
const objectStore = config.OBJECT_STORE_DRIVER === 's3'
  ? new S3ObjectStore(config.S3_BUCKET as string, { ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}), region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE, credentials: { accessKeyId: config.S3_ACCESS_KEY_ID as string, secretAccessKey: config.S3_SECRET_ACCESS_KEY as string } })
  : new FilesystemObjectStore(config.OBJECT_STORE_ROOT);
const app = createApp({ allowedOrigins: config.MCP_ALLOWED_ORIGINS.split(',').map((value) => value.trim()), mcpAuthToken: config.MCP_BOOTSTRAP_TOKEN, mcpMaxBodyBytes: config.MCP_MAX_BODY_BYTES, mcpMaxConcurrent: config.MCP_MAX_CONCURRENT, mcpRatePerMinute: config.MCP_RATE_PER_MINUTE, dependencies: [{ name: 'postgresql', ready: () => database.ready(), detail: 'migration-complete operational state' }, { name: 'object-store', ready: () => objectStore.ready(), detail: config.OBJECT_STORE_DRIVER }] });
const server = serve({ fetch: app.fetch, hostname: config.API_HOST, port: config.API_PORT }, (info) => console.log(JSON.stringify({ level: 'info', message: 'api_started', address: info.address, port: info.port, capabilityMode: config.CAPABILITY_MODE })));

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => { if (shuttingDown) return; shuttingDown = true; console.log(JSON.stringify({ level: 'info', message: 'api_shutdown', signal })); await new Promise<void>((resolve) => server.close(() => resolve())); await database.close(); };
process.once('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)).catch(() => process.exit(1)); });
process.once('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)).catch(() => process.exit(1)); });
