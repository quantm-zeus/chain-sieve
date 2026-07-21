import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

describe('API shell', () => {
  const app = createApp({ allowedOrigins: ['https://allowed.example'], dependencies: [{ name: 'database', ready: async () => true, detail: 'synthetic' }], now: () => '2026-01-01T00:00:00.000Z' });
  it('separates liveness and readiness', async () => { expect((await app.request('/api/v1/health')).status).toBe(200); const response = await app.request('/api/v1/readiness'); expect(response.status).toBe(200); expect((await response.json()).capabilityMode).toBe('SYNTHETIC_SHADOW'); });
  it('rejects invalid MCP origin before execution', async () => { const response = await app.request('/mcp', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }); expect(response.status).toBe(403); });
  it('serves a read-only MCP tool contract over the official Streamable HTTP transport', async () => { const response = await app.request('/mcp', { method: 'POST', headers: { origin: 'https://allowed.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).toContain('system_readiness'); });
});
