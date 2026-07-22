import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

const headers = {
  origin: 'https://allowed.example',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

describe('deterministic MCP timeout cancellation', () => {
  it('aborts a controllably slow test-only tool before its side effect', async () => {
    let sideEffects = 0;
    const app = createApp({
      allowedOrigins: ['https://allowed.example'],
      dependencies: [],
      mcpTimeoutMs: 10,
      mcpTestMode: true,
      mcpTestSlowToolDelayMs: 100,
      onMcpTestSideEffect: () => {
        sideEffects += 1;
      },
    });
    const response = await app.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: '__test_slow', arguments: {} },
      }),
    });
    expect(response.status).toBe(504);
    expect(response.headers.get('x-correlation-id')).toBeTruthy();
    expect((await response.json()).error.code).toBe('MCP_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sideEffects).toBe(0);
  });

  it('does not expose the synthetic slow tool outside test mode', async () => {
    const app = createApp({ allowedOrigins: ['https://allowed.example'], dependencies: [] });
    const response = await app.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = JSON.stringify(await response.json());
    expect(body).toContain('system_readiness');
    expect(body).not.toContain('__test_slow');
  });

  it('returns a correlated concurrency-limit response while a slow tool occupies the only slot', async () => {
    const app = createApp({
      allowedOrigins: ['https://allowed.example'],
      dependencies: [],
      mcpMaxConcurrent: 1,
      mcpTimeoutMs: 20,
      mcpTestMode: true,
      mcpTestSlowToolDelayMs: 100,
    });
    const first = app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, 'x-mcp-client-id': 'first' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: '__test_slow', arguments: {} },
      }),
    });
    await Promise.resolve();
    const second = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, 'x-mcp-client-id': 'second' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('x-correlation-id')).toBeTruthy();
    await first;
  });
});
