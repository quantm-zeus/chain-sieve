import { serve } from '@hono/node-server';
import { loadConfig } from '@ciag/config';
import { FilesystemObjectStore } from '@ciag/object-store';
import { PostgresDatabaseAdapter } from '@ciag/persistence';
import { createApp } from './app.js';

const config = loadConfig();
const database = new PostgresDatabaseAdapter(config.DATABASE_URL);
const objectStore = new FilesystemObjectStore(config.OBJECT_STORE_ROOT);
const app = createApp({ allowedOrigins: config.MCP_ALLOWED_ORIGINS.split(',').map((value) => value.trim()), dependencies: [{ name: 'postgresql', ready: () => database.ready(), detail: 'operational state' }, { name: 'object-store', ready: () => objectStore.ready(), detail: config.OBJECT_STORE_DRIVER }] });
const server = serve({ fetch: app.fetch, hostname: config.API_HOST, port: config.API_PORT }, (info) => console.log(JSON.stringify({ level: 'info', message: 'api_started', address: info.address, port: info.port, capabilityMode: config.CAPABILITY_MODE })));

const shutdown = async (signal: string): Promise<void> => { console.log(JSON.stringify({ level: 'info', message: 'api_shutdown', signal })); server.close(); await database.close(); };
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
