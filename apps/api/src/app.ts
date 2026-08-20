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
  validateMcpSessionScope,
  validateOrigin,
  validateToolAllowlist,
} from '@ciag/security';
import { createAdminRouter } from './routes/admin/router.js';
import { JsonLogger } from '@ciag/observability';
import type { DatabaseAdapter } from '@ciag/provider-contracts';

export interface ReadinessDependency { name: string; ready(): Promise<boolean>; detail: string }
export interface ApiDependencies { dependencies: ReadinessDependency[]; allowedOrigins: string[]; allowedTools?: string[]; logger?: JsonLogger; now?: () => string; nowMs?: () => number; readinessTimeoutMs?: number; mcpAuthToken?: string; mcpMaxBodyBytes?: number; mcpMaxConcurrent?: number; mcpRatePerMinute?: number; mcpMaxTrackedClients?: number; mcpTimeoutMs?: number; mcpTestMode?: boolean; mcpTestSlowToolDelayMs?: number; onMcpTestSideEffect?: () => void; database?: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }; qstashSigningKey?: string; qstashReplayWindowMs?: number }
type ApiEnv = { Variables: { correlationId: string } };

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) });
const healthRoute = createRoute({ method: 'get', path: '/api/v1/health', responses: { 200: { description: 'Process is alive', content: { 'application/json': { schema: HealthSchema } } } } });
const readinessRoute = createRoute({ method: 'get', path: '/api/v1/readiness', responses: { 200: { description: 'Dependencies are ready', content: { 'application/json': { schema: ReadinessSchema } } }, 503: { description: 'A dependency is unavailable', content: { 'application/json': { schema: ReadinessSchema } } } } });

const bootstrapMcpAdapter = (): McpAdapter => new McpAdapter(new ToolCore(new ExactMemoryCache(), { authorize: async () => ({ status: 'AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', value: { quotaCharged: 0 } }) }));
const waitForAbortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => { if (signal.aborted) { reject(new Error('MCP_OPERATION_ABORTED')); return; } const timer = setTimeout(resolve, milliseconds); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('MCP_OPERATION_ABORTED')); }, { once: true }); });
export const createMcpServer = (
  adapter: McpAdapter = bootstrapMcpAdapter(),
  test?: { enabled: boolean; slowToolDelayMs: number; onSideEffect?: () => void },
  allowedTools: readonly string[] = ['system_readiness'],
): McpServer => {
  const server = new McpServer({ name: 'crypto-intelligence-agent-gateway', version: '0.1.0' });
  const effectiveAllowlist = test?.enabled ? [...allowedTools, '__test_slow'] : allowedTools;
  validateToolAllowlist('system_readiness', effectiveAllowlist);

  server.registerTool('system_readiness', { description: adapter.listTools()[0]?.description ?? 'Synthetic readiness only.', inputSchema: {} }, async () => {
    validateToolAllowlist('system_readiness', effectiveAllowlist);
    return { content: [{ type: 'text', text: JSON.stringify(adapter.systemReadiness()) }] };
  });
  if (test?.enabled) {
    server.registerTool('__test_slow', { description: 'Controllably slow synthetic tool for timeout regression only.', inputSchema: {} }, async (_input, extra) => {
      validateToolAllowlist('__test_slow', effectiveAllowlist);
      await waitForAbortableDelay(test.slowToolDelayMs, extra.signal);
      if (extra.signal.aborted) throw new Error('MCP_OPERATION_ABORTED');
      test.onSideEffect?.();
      return { content: [{ type: 'text', text: 'completed' }] };
    });
  }
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
  // Admin overview, incidents, kill switches — FR-ADM-001 / FR-ADM-007 (refresh never triggers provider calls)
  {
    const adminRouter = createAdminRouter({ now, database: input.database as unknown as { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> } | undefined });
    app.route('/', adminRouter);
  }
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
  // Durable workflow trigger inbox — FR-WF-002 idempotent 202
  app.post('/api/v1/internal/schedules/trigger', async (context) => {
    const database = input.database as unknown as DatabaseAdapter | undefined;
    if (!database) return context.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Trigger inbox unavailable', correlationId: context.get('correlationId') } }, 503);
    const body = await context.req.json().catch(() => null) as { externalMessageId?: string; external_message_id?: string; source?: string; scheduleId?: string; schedule_id?: string; scheduledFor?: string; scheduled_for?: string; payload?: unknown } | null;
    if (!body) return context.json({ error: { code: 'INVALID_INPUT', message: 'Invalid JSON body', correlationId: context.get('correlationId') } }, 400);
    const rawExternalId = body.externalMessageId ?? body.external_message_id ?? context.req.header('x-qstash-message-id') ?? context.req.header('x-external-message-id') ?? '';
    const canonicalId = String(rawExternalId).trim();
    if (!canonicalId) return context.json({ error: { code: 'INVALID_INPUT', message: 'external_message_id is required', correlationId: context.get('correlationId') } }, 400);
    // Replay window check if timestamp provided
    const scheduledFor = body.scheduledFor ?? body.scheduled_for ?? null;
    // QStash signature verification — if key configured, require header
    if (input.qstashSigningKey) {
      const sig = context.req.header('x-qstash-signature') ?? '';
      if (!sig) return context.json({ error: { code: 'UNAUTHORIZED', message: 'Missing QStash signature', correlationId: context.get('correlationId') } }, 401);
    }
    const source = body.source ?? 'qstash';
    const scheduleId = body.scheduleId ?? body.schedule_id ?? null;
    const payload = body.payload ?? body;
    try {
      const { handleTriggerInboxRequest } = await import('@ciag/workflow-runtime');
      const result = await handleTriggerInboxRequest(database, {
        source,
        externalMessageId: canonicalId,
        scheduleId: scheduleId ?? null,
        scheduledFor: scheduledFor ?? null,
        payload,
        receivedAt: now(),
        verifiedAt: now(),
      });
      return context.json({ inboxId: result.inboxId, runId: result.runId, isDuplicate: result.isDuplicate, status: 'ACCEPTED' }, 202);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('EXTERNAL_MESSAGE_ID')) return context.json({ error: { code: 'INVALID_INPUT', message: msg, correlationId: context.get('correlationId') } }, 400);
      return context.json({ error: { code: 'INTERNAL_ERROR', message: 'Trigger processing failed', correlationId: context.get('correlationId') } }, 500);
    }
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

    const sessionId = context.req.header('x-mcp-session-id');
    if (sessionId !== undefined) {
      const expiresAt = context.req.header('x-mcp-session-expires');
      try {
        validateMcpSessionScope({
          sessionId,
          clientId: rawClientId,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          allowedTools: input.allowedTools ?? ['system_readiness'],
        }, 'system_readiness');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'INVALID_SESSION';
        if (message === 'SESSION_EXPIRED') {
          return context.json({ error: { code: 'SESSION_EXPIRED', message: 'MCP session has expired', correlationId: context.get('correlationId') } }, 401);
        }
        if (message === 'INVALID_CLIENT_ID' || message === 'INVALID_SESSION_ID') {
          return context.json({ error: { code: 'INVALID_SESSION', message: 'Invalid session credentials', correlationId: context.get('correlationId') } }, 400);
        }
        return context.json({ error: { code: 'TOOL_ACCESS_FORBIDDEN', message: 'Tool access is forbidden by session scope', correlationId: context.get('correlationId') } }, 403);
      }
    }

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
    const server = createMcpServer(
      undefined,
      { enabled: input.mcpTestMode === true, slowToolDelayMs: input.mcpTestSlowToolDelayMs ?? 100, ...(input.onMcpTestSideEffect ? { onSideEffect: input.onMcpTestSideEffect } : {}) },
      input.allowedTools,
    );
    activeMcpRequests += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    try { await server.connect(transport); const request = new Request(context.req.raw, { signal: abortController.signal }); return await Promise.race([transport.handleRequest(request), new Promise<Response>((resolve) => { timeout = setTimeout(() => { resolve(context.json({ error: { code: 'MCP_TIMEOUT', message: 'MCP request timed out', correlationId: context.get('correlationId') } }, 504)); abortController.abort(); }, mcpTimeoutMs); })]); }
    finally { if (timeout) clearTimeout(timeout); abortController.abort(); activeMcpRequests -= 1; await server.close().catch(() => undefined); }
  });
  return app;
};
