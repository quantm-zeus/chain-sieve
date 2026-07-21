import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { HealthSchema, ReadinessSchema } from '@ciag/shared-schemas';
import { validateOrigin } from '@ciag/security';
import { JsonLogger } from '@ciag/observability';

export interface ReadinessDependency { name: string; ready(): Promise<boolean>; detail: string }
export interface ApiDependencies { dependencies: ReadinessDependency[]; allowedOrigins: string[]; logger?: JsonLogger; now?: () => string }
type ApiEnv = { Variables: { correlationId: string } };

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) });
const healthRoute = createRoute({ method: 'get', path: '/api/v1/health', responses: { 200: { description: 'Process is alive', content: { 'application/json': { schema: HealthSchema } } } } });
const readinessRoute = createRoute({ method: 'get', path: '/api/v1/readiness', responses: { 200: { description: 'Dependencies are ready', content: { 'application/json': { schema: ReadinessSchema } } }, 503: { description: 'A dependency is unavailable', content: { 'application/json': { schema: ReadinessSchema } } } } });

export const createMcpServer = (): McpServer => {
  const server = new McpServer({ name: 'crypto-intelligence-agent-gateway', version: '0.1.0' });
  server.registerTool('system_readiness', { description: 'Read-only bootstrap capability status; no market intelligence.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ capabilityMode: 'SYNTHETIC_SHADOW', productCapabilitiesActive: false }) }] }));
  return server;
};

export const createApp = (input: ApiDependencies): OpenAPIHono<ApiEnv> => {
  const app = new OpenAPIHono<ApiEnv>();
  const logger = input.logger ?? new JsonLogger();
  const now = input.now ?? (() => new Date().toISOString());
  app.use('*', async (context, next) => {
    const correlationId = context.req.header('x-correlation-id') ?? randomUUID();
    context.set('correlationId', correlationId);
    context.header('x-correlation-id', correlationId);
    const started = Date.now();
    await next();
    logger.log('info', 'http_request', { correlationId, method: context.req.method, path: context.req.path, status: context.res.status, durationMs: Date.now() - started });
  });
  app.onError((error, context) => {
    const correlationId = context.get('correlationId');
    logger.log('error', 'http_error', { correlationId, error: error.message });
    const code = error.message === 'MCP_ORIGIN_FORBIDDEN' ? 'ORIGIN_FORBIDDEN' : 'INTERNAL_ERROR';
    return context.json(ErrorSchema.parse({ error: { code, message: code === 'INTERNAL_ERROR' ? 'Internal server error' : 'Origin is not allowed', correlationId } }), code === 'ORIGIN_FORBIDDEN' ? 403 : 500);
  });
  app.openapi(healthRoute, (context) => context.json({ status: 'ok', service: 'ciag-api', time: now() }, 200));
  app.openapi(readinessRoute, async (context) => {
    const dependencies = await Promise.all(input.dependencies.map(async (dependency) => ({ name: dependency.name, ready: await dependency.ready(), detail: dependency.detail })));
    const ready = dependencies.every((dependency) => dependency.ready);
    const body = { status: ready ? 'ready' as const : 'not_ready' as const, capabilityMode: 'SYNTHETIC_SHADOW' as const, dependencies };
    return ready ? context.json(body, 200) : context.json(body, 503);
  });
  app.post('/mcp', async (context) => {
    validateOrigin(context.req.header('origin'), input.allowedOrigins);
    if (!context.req.header('content-type')?.toLowerCase().startsWith('application/json')) return context.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'application/json required', correlationId: context.get('correlationId') } }, 415);
    const protocol = context.req.header('mcp-protocol-version');
    if (protocol !== undefined && protocol !== '2025-11-25') return context.json({ error: { code: 'UNSUPPORTED_PROTOCOL_VERSION', message: 'Supported MCP protocol: 2025-11-25', correlationId: context.get('correlationId') } }, 400);
    const transportOptions = { enableJsonResponse: true, allowedOrigins: input.allowedOrigins, enableDnsRebindingProtection: true };
    Object.assign(transportOptions, { sessionIdGenerator: undefined });
    const transport = new WebStandardStreamableHTTPServerTransport(transportOptions);
    const server = createMcpServer();
    await server.connect(transport);
    return transport.handleRequest(context.req.raw);
  });
  return app;
};
