import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { HealthSchema, ReadinessSchema } from '@ciag/shared-schemas';
import { McpAdapter } from '@ciag/mcp-adapter';
import { ExactMemoryCache } from '@ciag/runtime-cache';
import { ToolCore } from '@ciag/tool-core';
import {
  validateAllowedOriginsConfig,
  validateBearerAuth,
  validateMcpContentType,
  validateMcpProtocol,
  validateOrigin,
} from '@ciag/security';
import { JsonLogger } from '@ciag/observability';

export interface ReadinessDependency { name: string; ready(): Promise<boolean>; detail: string }
export interface ApiDependencies { dependencies: ReadinessDependency[]; allowedOrigins: string[]; logger?: JsonLogger; now?: () => string; nowMs?: () => number; readinessTimeoutMs?: number; mcpAuthToken?: string; mcpMaxBodyBytes?: number; mcpMaxConcurrent?: number; mcpRatePerMinute?: number; mcpMaxTrackedClients?: number; mcpTimeoutMs?: number; mcpTestMode?: boolean; mcpTestSlowToolDelayMs?: number; onMcpTestSideEffect?: () => void }
type ApiEnv = { Variables: { correlationId: string } };

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) });
const healthRoute = createRoute({ method: 'get', path: '/api/v1/health', responses: { 200: { description: 'Process is alive', content: { 'application/json': { schema: HealthSchema } } } } });
const readinessRoute = createRoute({ method: 'get', path: '/api/v1/readiness', responses: { 200: { description: 'Dependencies are ready', content: { 'application/json': { schema: ReadinessSchema } } }, 503: { description: 'A dependency is unavailable', content: { 'application/json': { schema: ReadinessSchema } } } } });

const bootstrapMcpAdapter = (): McpAdapter => new McpAdapter(new ToolCore(new ExactMemoryCache(), { authorize: async () => ({ status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: 0 } }) }));
const waitForAbortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => { if (signal.aborted) { reject(new Error('MCP_OPERATION_ABORTED')); return; } const timer = setTimeout(resolve, milliseconds); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('MCP_OPERATION_ABORTED')); }, { once: true }); });
export const createMcpServer = (adapter: McpAdapter = bootstrapMcpAdapter(), test?: { enabled: boolean; slowToolDelayMs: number; onSideEffect?: () => void }): McpServer => {
  const server = new McpServer({ name: 'crypto-intelligence-agent-gateway', version: '0.1.0' });
  server.registerTool('system_readiness', { description: adapter.listTools()[0]?.description ?? 'Synthetic readiness only.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(adapter.systemReadiness()) }] }));
  if (test?.enabled) server.registerTool('__test_slow', { description: 'Controllably slow synthetic tool for timeout regression only.', inputSchema: {} }, async (_input, extra) => { await waitForAbortableDelay(test.slowToolDelayMs, extra.signal); if (extra.signal.aborted) throw new Error('MCP_OPERATION_ABORTED'); test.onSideEffect?.(); return { content: [{ type: 'text', text: 'completed' }] }; });
  return server;
};

export const createApp = (input: ApiDependencies): OpenAPIHono<ApiEnv> => {
  // Validate allowedOrigins configuration at deploy/startup time
  if (Array.isArray(input.allowedOrigins)) {
    validateAllowedOriginsConfig(input.allowedOrigins);
  }

  const app = new OpenAPIHono<ApiEnv>();
  const logger = input.logger ?? new JsonLogger();
  const now = input.now ?? (() => new Date().toISOString());
  const nowMs = input.nowMs ?? Date.now;
  const readinessTimeoutMs = input.readinessTimeoutMs ?? 2_000;
  const mcpMaxBodyBytes = input.mcpMaxBodyBytes ?? 65_536;
  const mcpMaxConcurrent = input.mcpMaxConcurrent ?? 4;
  const mcpRatePerMinute = input.mcpRatePerMinute ?? 60;
  const mcpMaxTrackedClients = input.mcpMaxTrackedClients ?? 1_000;
  const mcpTimeoutMs = input.mcpTimeoutMs ?? 5_000;
  let activeMcpRequests = 0;
  const rateWindows = new Map<string, { startedAt: number; count: number }>();
  app.use('*', async (context, next) => {
    const incomingCorrelationId = context.req.header('x-correlation-id');
    const correlationId = incomingCorrelationId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(incomingCorrelationId) ? incomingCorrelationId : randomUUID();
    context.set('correlationId', correlationId);
    const started = Date.now();
    try { await next(); }
    finally { context.res.headers.set('x-correlation-id', correlationId); logger.log('info', 'http_request', { correlationId, method: context.req.method, path: context.req.path, status: context.res.status, durationMs: Date.now() - started }); }
  });
  app.onError((error, context) => {
    const correlationId = context.get('correlationId');
    logger.log('error', 'http_error', { correlationId, error: error.message });
    const originError = error.message === 'MCP_ORIGIN_FORBIDDEN' || error.message === 'MCP_ORIGIN_REQUIRED' || error.message === 'MCP_ORIGIN_MALFORMED';
    const code = originError ? 'ORIGIN_FORBIDDEN' : 'INTERNAL_ERROR';
    return context.json(ErrorSchema.parse({ error: { code, message: code === 'INTERNAL_ERROR' ? 'Internal server error' : 'Origin is not allowed', correlationId } }), originError ? 403 : 500);
  });
  app.openapi(healthRoute, (context) => context.json({ status: 'ok', service: 'ciag-api', time: now() }, 200));
  app.openapi(readinessRoute, async (context) => {
    const dependencies = await Promise.all(input.dependencies.map(async (dependency) => {
      try { const ready = await Promise.race([dependency.ready(), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), readinessTimeoutMs))]); return { name: dependency.name, ready, detail: ready ? dependency.detail : `${dependency.detail}: unavailable-or-timeout` }; }
      catch { return { name: dependency.name, ready: false, detail: `${dependency.detail}: check-failed` }; }
    }));
    const ready = dependencies.every((dependency) => dependency.ready);
    const body = { status: ready ? 'ready' as const : 'not_ready' as const, capabilityMode: 'SYNTHETIC_SHADOW' as const, dependencies };
    return ready ? context.json(body, 200) : context.json(body, 503);
  });
  app.post('/mcp', async (context) => {
    validateOrigin(context.req.header('origin'), input.allowedOrigins);
    if (input.mcpTestMode === true && context.req.header('x-mcp-test-internal-error') === '1') throw new Error('MCP_TEST_INTERNAL_ERROR');
    if (input.mcpAuthToken) {
      try {
        validateBearerAuth(context.req.header('authorization'), input.mcpAuthToken);
      } catch {
        return context.json({ error: { code: 'UNAUTHORIZED', message: 'Valid bearer authentication is required', correlationId: context.get('correlationId') } }, 401);
      }
    }
    try {
      validateMcpContentType(context.req.header('content-type'));
    } catch {
      return context.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'application/json required', correlationId: context.get('correlationId') } }, 415);
    }
    const declaredLength = Number(context.req.header('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > mcpMaxBodyBytes) return context.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'MCP request exceeds configured limit', correlationId: context.get('correlationId') } }, 413);
    const bodySize = (await context.req.raw.clone().arrayBuffer()).byteLength;
    if (bodySize > mcpMaxBodyBytes) return context.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'MCP request exceeds configured limit', correlationId: context.get('correlationId') } }, 413);
    const protocol = context.req.header('mcp-protocol-version');
    try {
      validateMcpProtocol(protocol, ['2025-11-25'], { allowMissing: true });
    } catch {
      return context.json({ error: { code: 'UNSUPPORTED_PROTOCOL_VERSION', message: 'Supported MCP protocol: 2025-11-25', correlationId: context.get('correlationId') } }, 400);
    }
    const rawClientId = context.req.header('x-mcp-client-id') ?? context.req.header('x-forwarded-for') ?? 'anonymous';
    if (rawClientId.length > 128) return context.json({ error: { code: 'INVALID_CLIENT_ID', message: 'MCP client identifier is invalid', correlationId: context.get('correlationId') } }, 400);
    const current = nowMs();
    if (rateWindows.size >= mcpMaxTrackedClients) {
      for (const [key, value] of rateWindows) {
        if (current - value.startedAt >= 60_000) rateWindows.delete(key);
      }
    }
    const previous = rateWindows.get(rawClientId);
    if (!previous && rateWindows.size >= mcpMaxTrackedClients) {
      return context.json({ error: { code: 'MCP_LIMIT_EXCEEDED', message: 'MCP request limit exceeded', correlationId: context.get('correlationId') } }, 429);
    }
    const window = !previous || current - previous.startedAt >= 60_000 ? { startedAt: current, count: 0 } : previous;
    window.count += 1;
    rateWindows.set(rawClientId, window);
    if (window.count > mcpRatePerMinute || activeMcpRequests >= mcpMaxConcurrent) return context.json({ error: { code: 'MCP_LIMIT_EXCEEDED', message: 'MCP request limit exceeded', correlationId: context.get('correlationId') } }, 429);
    const transportOptions = { enableJsonResponse: true, allowedOrigins: input.allowedOrigins, enableDnsRebindingProtection: true };
    Object.assign(transportOptions, { sessionIdGenerator: undefined });
    const transport = new WebStandardStreamableHTTPServerTransport(transportOptions);
    const server = createMcpServer(undefined, { enabled: input.mcpTestMode === true, slowToolDelayMs: input.mcpTestSlowToolDelayMs ?? 100, ...(input.onMcpTestSideEffect ? { onSideEffect: input.onMcpTestSideEffect } : {}) });
    activeMcpRequests += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    try { await server.connect(transport); const request = new Request(context.req.raw, { signal: abortController.signal }); return await Promise.race([transport.handleRequest(request), new Promise<Response>((resolve) => { timeout = setTimeout(() => { resolve(context.json({ error: { code: 'MCP_TIMEOUT', message: 'MCP request timed out', correlationId: context.get('correlationId') } }, 504)); abortController.abort(); }, mcpTimeoutMs); })]); }
    finally { if (timeout) clearTimeout(timeout); abortController.abort(); activeMcpRequests -= 1; await server.close().catch(() => undefined); }
  });
  return app;
};
