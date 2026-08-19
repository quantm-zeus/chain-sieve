import { z } from 'zod';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { InMemoryScheduleStore, SchedulerService, reconcileSchedules } from '@ciag/scheduler';
import type { ApiEnv } from './app.js';

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

  const externalSchedules: Map<string, { externalId: string; cron: string; timezone: string; paused: boolean; destination: string; scheduleId?: string | null | undefined }> = new Map();

  const mapError = (error: unknown): { code: string; status: number } => {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('NOT_FOUND')) return { code: msg.split(':')[0] ?? 'NOT_FOUND', status: 404 };
    if (msg.includes('VALIDATION_FAILED') || msg.includes('CRON_') || msg.includes('TIMEZONE_') || msg.includes('VERSION_') || msg.includes('BUDGET_') || msg.includes('CONCURRENCY_') || msg.includes('COST_')) return { code: 'VALIDATION_FAILED', status: 422 };
    if (msg.includes('ONLY_') || msg.includes('EDIT_ONLY') || msg.includes('DELETE_ONLY') || msg.includes('ALREADY_')) return { code: 'ILLEGAL_STATE_TRANSITION', status: 409 };
    if (msg === 'SCHEDULE_NAME_REQUIRED') return { code: 'INVALID_INPUT', status: 400 };
    return { code: 'INTERNAL_ERROR', status: 500 };
  };

  // GET /api/v1/admin/schedules
  app.get('/api/v1/admin/schedules', async (c) => {
    const schedules = await store.listSchedules();
    return c.json({ schedules }, 200);
  });

  // POST /api/v1/admin/schedules — CREATE
  app.post('/api/v1/admin/schedules', async (c) => {
    const correlationId = c.get('correlationId');
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid JSON', correlationId } }, 400);
    const parsed = z.object({
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
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.message, correlationId } }, 400);
    try {
      const result = await service.create(parsed.data as Parameters<SchedulerService['create']>[0]);
      return c.json({ schedule: result.schedule, version: result.version }, 201);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as 400);
    }
  });

  // GET /api/v1/admin/schedules/:id
  app.get('/api/v1/admin/schedules/:id', async (c) => {
    const id = c.req.param('id');
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
  app.post('/api/v1/admin/schedules/:id/validate', async (c) => {
    const id = c.req.param('id');
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
  app.post('/api/v1/admin/schedules/:id/enable', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.enable(id);
      if (result.schedule.externalScheduleId) {
        const v = await store.getActiveVersion(id);
        if (v) externalSchedules.set(result.schedule.externalScheduleId, { externalId: result.schedule.externalScheduleId, cron: v.cron, timezone: v.timezone, paused: false, destination: v.destination, scheduleId: id });
      }
      return c.json({ schedule: result.schedule, version: result.version }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/pause
  app.post('/api/v1/admin/schedules/:id/pause', async (c) => {
    const id = c.req.param('id');
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
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/resume
  app.post('/api/v1/admin/schedules/:id/resume', async (c) => {
    const id = c.req.param('id');
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
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/run-now
  app.post('/api/v1/admin/schedules/:id/run-now', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    const body = await c.req.json().catch(() => ({})) as { overrides?: Record<string, unknown> };
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
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/dry-run
  app.post('/api/v1/admin/schedules/:id/dry-run', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    const body = await c.req.json().catch(() => ({})) as { overrides?: Record<string, unknown> };
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
  app.post('/api/v1/admin/schedules/:id/disable', async (c) => {
    const id = c.req.param('id');
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
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // DELETE /api/v1/admin/schedules/:id
  app.delete('/api/v1/admin/schedules/:id', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    try {
      const result = await service.delete(id);
      return c.json({ schedule: result }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/schedules/:id/duplicate
  app.post('/api/v1/admin/schedules/:id/duplicate', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    try {
      const result = await service.duplicate(id, body.name);
      return c.json({ schedule: result.schedule, version: result.version }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code: 'NOT_FOUND', message: msg, correlationId } }, 404);
    }
  });

  // PATCH /api/v1/admin/schedules/:id — EDIT_DRAFT
  app.patch('/api/v1/admin/schedules/:id', async (c) => {
    const id = c.req.param('id');
    const correlationId = c.get('correlationId');
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ error: { code: 'INVALID_INPUT', message: 'Invalid JSON', correlationId } }, 400);
    const parsed = z.object({
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
    }).safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.message, correlationId } }, 400);
    try {
      const result = await service.editDraft(id, parsed.data as Parameters<SchedulerService['editDraft']>[1]);
      return c.json({ schedule: result.schedule, version: result.version }, 200);
    } catch (error) {
      const { code, status } = mapError(error);
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: { code, message: msg, correlationId } }, status as 404);
    }
  });

  // POST /api/v1/admin/scheduler/reconcile
  app.post('/api/v1/admin/scheduler/reconcile', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { repair?: boolean };
    const repair = body.repair === true;
    const externalReader = {
      list: async () => [...externalSchedules.values()].map((e) => ({ externalId: e.externalId, cron: e.cron, timezone: e.timezone, paused: e.paused, destination: e.destination, scheduleId: e.scheduleId ?? null })),
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
  app.get('/api/v1/admin/scheduler/incidents', async (c) => {
    const incidents = await store.listIncidents();
    return c.json({ incidents }, 200);
  });

  return { service, store };
};
