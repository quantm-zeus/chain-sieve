import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { InMemoryScheduleStore, SchedulerService, reconcileSchedules } from '@ciag/scheduler';
import type { ApiEnv } from './app.js';

const ScheduleStateSchema = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'DEGRADED', 'DISABLED', 'DELETED']);
const ConfigLifecycleSchema = z.enum(['DRAFT', 'VALIDATED', 'APPROVED', 'ACTIVE', 'DEPRECATED', 'ROLLED_BACK']);

const ScheduleVersionSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  version: z.number(),
  cron: z.string(),
  timezone: z.string(),
  workflowVersion: z.string(),
  agentProfileVersion: z.string(),
  toolProfileVersion: z.string(),
  budgets: z.record(z.string(), z.unknown()),
  concurrency: z.number(),
  destination: z.string(),
  lifecycle: ConfigLifecycleSchema,
  configHash: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
});

const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  state: ScheduleStateSchema,
  currentVersionId: z.string().nullable(),
  currentVersionNumber: z.number().nullable(),
  externalScheduleId: z.string().nullable(),
  paused: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ResolvedConfigSchema = z.object({
  resolved: z.record(z.string(), z.unknown()),
  configHash: z.string(),
  precedence: z.array(z.string()),
});

export interface SchedulerRouteDeps {
  schedulerService?: SchedulerService | undefined;
  store?: InMemoryScheduleStore | undefined;
  now?: (() => string) | undefined;
}

export const createSchedulerRoutes = (app: OpenAPIHono<ApiEnv>, deps: SchedulerRouteDeps = {}): { service: SchedulerService; store: InMemoryScheduleStore } => {
  const store = deps.store ?? new InMemoryScheduleStore();
  const service = deps.schedulerService ?? new SchedulerService({
    store,
    now: deps.now,
    versionExists: async () => ({ exists: true, lifecycle: 'ACTIVE' }),
    budgetCheck: async () => ({ ok: true }),
    concurrencyCheck: () => ({ ok: true }),
    costForecast: async () => ({ sustainable: true, estimatedRunsPerDay: 24, estimatedCostPerDay: 0.5 }),
    systemDefaults: { scheduleDefaults: 'system' },
    workflowRegistry: new Map([['wf-v1', { workflow: 'wf-v1-defaults' }]]),
    agentProfileRegistry: new Map([['agent-v1', { agent: 'agent-v1-defaults' }]]),
  });

  // In-memory external scheduler reader for reconciliation demo
  const externalSchedules: Map<string, { externalId: string; cron: string; timezone: string; paused: boolean; destination: string; scheduleId?: string | null | undefined }> = new Map();

  // Helpers
  const mapError = (error: unknown): { code: string; status: number } => {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('NOT_FOUND')) return { code: msg.split(':')[0] ?? 'NOT_FOUND', status: 404 };
    if (msg.includes('VALIDATION_FAILED') || msg.includes('CRON_') || msg.includes('TIMEZONE_') || msg.includes('VERSION_') || msg.includes('BUDGET_') || msg.includes('CONCURRENCY_') || msg.includes('COST_')) return { code: 'VALIDATION_FAILED', status: 422 };
    if (msg.includes('ONLY_') || msg.includes('EDIT_ONLY') || msg.includes('DELETE_ONLY') || msg.includes('ALREADY_')) return { code: 'ILLEGAL_STATE_TRANSITION', status: 409 };
    if (msg === 'SCHEDULE_NAME_REQUIRED') return { code: 'INVALID_INPUT', status: 400 };
    return { code: 'INTERNAL_ERROR', status: 500 };
  };

  // GET /api/v1/admin/schedules
  const listRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/schedules',
    responses: {
      200: { description: 'Schedules', content: { 'application/json': { schema: z.object({ schedules: z.array(ScheduleSchema) }) } } },
    },
  });
  app.openapi(listRoute, async (c) => {
    const schedules = await store.listSchedules();
    return c.json({ schedules }, 200);
  });

  // POST /api/v1/admin/schedules  — CREATE
  const createRouteDef = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1),
              description: z.string().nullable().optional(),
              cron: z.string().min(1),
              timezone: z.string().min(1),
              workflowVersion: z.string().min(1),
              agentProfileVersion: z.string().min(1),
              toolProfileVersion: z.string().min(1),
              budgets: z.record(z.string(), z.unknown()).default({ dailyBudget: 100 }),
              concurrency: z.number().int().min(1).max(32).default(1),
              destination: z.string().min(1).default('https://example.com/trigger'),
              targetScope: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema, version: ScheduleVersionSchema }) } } },
      400: { description: 'Invalid', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      422: { description: 'Validation failed', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      500: { description: 'Internal error', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(createRouteDef, async (c) => {
    const body = c.req.valid('json');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.create(body);
      return c.json({ schedule: result.schedule, version: result.version }, 201);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // GET /api/v1/admin/schedules/:id
  const getRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/schedules/{id}',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Schedule', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema, version: ScheduleVersionSchema.nullable(), versions: z.array(ScheduleVersionSchema), resolvedConfig: ResolvedConfigSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    const schedule = await store.getSchedule(id);
    if (!schedule) return c.json({ error: { code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found', correlationId } }, 404);
    const version = await store.getActiveVersion(id);
    const versions = await store.listVersions(id);
    let resolved: { resolved: Record<string, unknown>; configHash: string } | null = null;
    try { resolved = await service.getResolvedConfig(id); } catch { resolved = null; }
    return c.json({
      schedule,
      version: version ?? null,
      versions,
      resolvedConfig: resolved ? { resolved: resolved.resolved, configHash: resolved.configHash, precedence: ['system defaults', 'workflow version', 'agent profile version', 'schedule version overrides', 'explicit run-now overrides'] } : { resolved: {}, configHash: '', precedence: [] },
    }, 200);
  });

  // POST /api/v1/admin/schedules/:id/validate
  const validateRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/validate',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Validation', content: { 'application/json': { schema: z.object({ valid: z.boolean(), issues: z.array(z.object({ code: z.string(), message: z.string(), field: z.string().optional() })), costForecast: z.record(z.string(), z.unknown()).optional() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(validateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.validate(id);
      return c.json({ valid: result.valid, issues: result.issues, costForecast: result.costForecast as unknown as Record<string, unknown> | undefined }, 200);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('VERSION_NOT_FOUND') || msg.includes('SCHEDULE_NOT_FOUND')) return c.json({ error: { code: 'NOT_FOUND', message: msg, correlationId } }, 404);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: msg, correlationId } }, 500);
    }
  });

  // POST /api/v1/admin/schedules/:id/enable
  const enableRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/enable',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Enabled', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema, version: ScheduleVersionSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      422: { description: 'Validation failed', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(enableRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.enable(id);
      if (result.schedule.externalScheduleId) {
        externalSchedules.set(result.schedule.externalScheduleId, {
          externalId: result.schedule.externalScheduleId,
          cron: result.version.cron,
          timezone: result.version.timezone,
          paused: false,
          destination: result.version.destination,
          scheduleId: id,
        });
      }
      return c.json({ schedule: result.schedule, version: result.version }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/pause
  const pauseRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/pause',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Paused', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(pauseRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const schedule = await service.pause(id);
      if (schedule.externalScheduleId) {
        const ext = externalSchedules.get(schedule.externalScheduleId);
        if (ext) externalSchedules.set(schedule.externalScheduleId, { ...ext, paused: true });
      }
      return c.json({ schedule }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/resume
  const resumeRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/resume',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Resumed', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(resumeRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const schedule = await service.resume(id);
      if (schedule.externalScheduleId) {
        const ext = externalSchedules.get(schedule.externalScheduleId);
        if (ext) externalSchedules.set(schedule.externalScheduleId, { ...ext, paused: false });
      }
      return c.json({ schedule }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/run-now
  const runNowRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/run-now',
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: { content: { 'application/json': { schema: z.object({ overrides: z.record(z.string(), z.unknown()).optional() }).optional() } } },
    },
    responses: {
      200: { description: 'Run created', content: { 'application/json': { schema: z.object({ runId: z.string(), resolvedConfig: ResolvedConfigSchema, schedule: ScheduleSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(runNowRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = (await c.req.json().catch(() => ({}))) as { overrides?: Record<string, unknown> };
    const correlationId = c.get('correlationId');
    try {
      const result = await service.runNow(id, body.overrides);
      return c.json({
        runId: result.runId,
        resolvedConfig: { resolved: result.resolvedConfig.resolved, configHash: result.resolvedConfig.configHash, precedence: ['system defaults', 'workflow version', 'agent profile version', 'schedule version overrides', 'explicit run-now overrides'] },
        schedule: result.schedule,
      }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/dry-run
  const dryRunRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/dry-run',
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: { content: { 'application/json': { schema: z.object({ overrides: z.record(z.string(), z.unknown()).optional() }).optional() } } },
    },
    responses: {
      200: { description: 'Dry run', content: { 'application/json': { schema: z.object({ validation: z.object({ valid: z.boolean(), issues: z.array(z.object({ code: z.string(), message: z.string(), field: z.string().optional() })) }), resolvedConfig: ResolvedConfigSchema, forecast: z.record(z.string(), z.unknown()).optional() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(dryRunRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = (await c.req.json().catch(() => ({}))) as { overrides?: Record<string, unknown> };
    const correlationId = c.get('correlationId');
    try {
      const result = await service.dryRun(id, body.overrides);
      return c.json({
        validation: { valid: result.validation.valid, issues: result.validation.issues },
        resolvedConfig: { resolved: result.resolvedConfig.resolved, configHash: result.resolvedConfig.configHash, precedence: ['system defaults', 'workflow version', 'agent profile version', 'schedule version overrides', 'explicit run-now overrides'] },
        forecast: result.forecast as unknown as Record<string, unknown> | undefined,
      }, 200);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code: 'NOT_FOUND', message: msg, correlationId } }, 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/disable
  const disableRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/disable',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Disabled', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(disableRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const schedule = await store.getSchedule(id);
      const prevExternal = schedule?.externalScheduleId;
      const result = await service.disable(id);
      if (prevExternal) externalSchedules.delete(prevExternal);
      return c.json({ schedule: result }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // DELETE /api/v1/admin/schedules/:id
  const deleteRoute = createRoute({
    method: 'delete',
    path: '/api/v1/admin/schedules/{id}',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.delete(id);
      return c.json({ schedule: result }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/duplicate
  const duplicateRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/schedules/{id}/duplicate',
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).optional() }).optional() } } },
    },
    responses: {
      201: { description: 'Duplicated', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema, version: ScheduleVersionSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(duplicateRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const correlationId = c.get('correlationId');
    try {
      const result = await service.duplicate(id, body.name);
      return c.json({ schedule: result.schedule, version: result.version }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code: 'NOT_FOUND', message: msg, correlationId } }, 404);
    }
  });

  // PATCH /api/v1/admin/schedules/:id — EDIT_DRAFT
  const editRoute = createRoute({
    method: 'patch',
    path: '/api/v1/admin/schedules/{id}',
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).optional(),
              description: z.string().nullable().optional(),
              cron: z.string().optional(),
              timezone: z.string().optional(),
              workflowVersion: z.string().optional(),
              agentProfileVersion: z.string().optional(),
              toolProfileVersion: z.string().optional(),
              budgets: z.record(z.string(), z.unknown()).optional(),
              concurrency: z.number().int().min(1).max(32).optional(),
              destination: z.string().optional(),
              targetScope: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Edited', content: { 'application/json': { schema: z.object({ schedule: ScheduleSchema, version: ScheduleVersionSchema }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) }) } } },
    },
  });
  app.openapi(editRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.editDraft(id, body);
      return c.json({ schedule: result.schedule, version: result.version }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as unknown as 404);
    }
  });

  // POST /api/v1/admin/scheduler/reconcile
  const reconcileRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/scheduler/reconcile',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ repair: z.boolean().optional().default(false) }).optional(),
          },
        },
      },
    },
    responses: {
      200: { description: 'Reconciliation', content: { 'application/json': { schema: z.object({ incidents: z.array(z.object({ type: z.string(), scheduleId: z.string().optional(), externalScheduleId: z.string().optional(), detail: z.string() })), repaired: z.number() }) } } },
    },
  });
  app.openapi(reconcileRoute, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { repair?: boolean };
    const repair = body.repair === true;
    const externalReader = {
      list: async () => [...externalSchedules.values()].map(e => ({ externalId: e.externalId, cron: e.cron, timezone: e.timezone, paused: e.paused, destination: e.destination, scheduleId: e.scheduleId ?? null })),
    };
    const externalWriter = {
      ...externalReader,
      create: async (s: { scheduleId: string; cron: string; timezone: string; destination: string }) => {
        const externalId = `qstash-${s.scheduleId}-${Date.now()}`;
        externalSchedules.set(externalId, { externalId, cron: s.cron, timezone: s.timezone, paused: false, destination: s.destination, scheduleId: s.scheduleId });
        return { externalId };
      },
      update: async (externalId: string, patch: Partial<{ cron: string; timezone: string; paused: boolean; destination: string }>) => {
        const existing = externalSchedules.get(externalId);
        if (existing) externalSchedules.set(externalId, { ...existing, ...patch });
      },
      remove: async (externalId: string) => { externalSchedules.delete(externalId); },
      setPaused: async (externalId: string, paused: boolean) => {
        const existing = externalSchedules.get(externalId);
        if (existing) externalSchedules.set(externalId, { ...existing, paused });
      },
    };
    const result = await reconcileSchedules({ store, externalReader, ...(repair ? { repair: true as const, externalWriter } : { repair: false as const }) });
    return c.json({ incidents: result.incidents, repaired: result.repaired }, 200);
  });

  // GET /api/v1/admin/scheduler/incidents
  const incidentsRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/scheduler/incidents',
    responses: {
      200: { description: 'Incidents', content: { 'application/json': { schema: z.object({ incidents: z.array(z.object({ type: z.string(), scheduleId: z.string().optional(), externalScheduleId: z.string().optional(), detail: z.string(), createdAt: z.string() })) }) } } },
    },
  });
  app.openapi(incidentsRoute, async (c) => {
    const incidents = await store.listIncidents();
    return c.json({ incidents }, 200);
  });

  return { service, store };
};
