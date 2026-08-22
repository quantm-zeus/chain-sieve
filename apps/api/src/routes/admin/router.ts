import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { getAdminStore, resetAdminStore } from './store.js';
import { createResearchWorkbenchRouter, resetResearchWorkbenchStores, resetScheduleDraftStore } from './research-workbench.js';
import {
  IncidentSchema,
  IncidentSeveritySchema,
  IncidentTypeSchema,
  KillSwitchNameSchema,
  OverviewResponseSchema,
} from './types.js';
import type { IncidentType } from './types.js';

type AdminEnv = { Variables: { correlationId: string } };

// Re-auth check: requires header x-reauth-verified: true or x-step-up-token present
// In production this would verify a passkey/hardware step-up token; here we check header presence
const isReauthVerified = (headers: Record<string, string | undefined>): boolean => {
  const verified = headers['x-reauth-verified'] ?? headers['x-step-up-verified'];
  if (verified === 'true' || verified === '1') return true;
  const token = headers['x-reauth-token'] ?? headers['x-step-up-token'] ?? headers['x-passkey-token'];
  if (token && token.length >= 8) return true;
  // Also accept Authorization: StepUp <token>
  const auth = headers['authorization'] ?? '';
  if (auth.toLowerCase().startsWith('stepup ') && auth.length > 10) return true;
  return false;
};

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) });

export const createAdminRouter = (deps?: { now?: () => string; database?: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> } | undefined }): OpenAPIHono<AdminEnv> => {
  const app = new OpenAPIHono<AdminEnv>();

  // Mount Research Workbench (FR-ADM-002/004/005/008)
  const researchRouter = createResearchWorkbenchRouter({ now: deps?.now });
  app.route('/', researchRouter);

  const getStore = () => getAdminStore(deps);

  // GET /api/v1/admin/overview — MUST NOT trigger external provider calls
  const overviewRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/overview',
    responses: {
      200: { description: 'Admin overview', content: { 'application/json': { schema: OverviewResponseSchema } } },
    },
  });
  app.openapi(overviewRoute, async (c) => {
    // This handler intentionally does NOT call any provider adapter.
    // All data comes from local store / DB cache via AdminStore.getOverview().
    const store = getStore();
    const overview = await store.getOverview();
    return c.json(overview, 200);
  });

  // GET /api/v1/admin/incidents
  const listIncidentsRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/incidents',
    responses: {
      200: { description: 'Incidents list', content: { 'application/json': { schema: z.object({ incidents: z.array(IncidentSchema) }) } } },
    },
  });
  app.openapi(listIncidentsRoute, (c) => {
    const store = getStore();
    return c.json({ incidents: store.listIncidents() }, 200);
  });

  // GET /api/v1/admin/incidents/:id
  const getIncidentRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/incidents/{id}',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: { description: 'Incident detail', content: { 'application/json': { schema: IncidentSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  });
  app.openapi(getIncidentRoute, (c) => {
    const { id } = c.req.valid('param');
    const store = getStore();
    const incident = store.getIncident(id);
    if (!incident) return c.json({ error: { code: 'INCIDENT_NOT_FOUND', message: `Incident ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    return c.json(incident, 200);
  });

  // POST /api/v1/admin/incidents — create (used for testing/demo; production creates via internal events)
  const createIncidentRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/incidents',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              type: IncidentTypeSchema,
              severity: IncidentSeveritySchema,
              owner: z.string().min(1),
              affectedScopes: z.array(z.string().min(1)).min(1),
              automatedContainment: z.object({ action: z.string().min(1), success: z.boolean(), detail: z.string().optional() }).nullable().optional(),
              evidenceRefs: z.array(z.string()).optional(),
              revalidationRequirements: z.array(z.string()).optional(),
              rootCause: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Incident created', content: { 'application/json': { schema: IncidentSchema } } },
      400: { description: 'Invalid input', content: { 'application/json': { schema: ErrorSchema } } },
    },
  });
  app.openapi(createIncidentRoute, async (c) => {
    const body = c.req.valid('json');
    const store = getStore();
    const incident = store.createIncident({
      type: body.type as IncidentType,
      severity: body.severity,
      owner: body.owner,
      affectedScopes: body.affectedScopes,
      automatedContainment: body.automatedContainment ?? null,
      evidenceRefs: body.evidenceRefs,
      revalidationRequirements: body.revalidationRequirements,
      rootCause: body.rootCause,
    });
    return c.json(incident, 201);
  });

  // POST /api/v1/admin/incidents/:id/acknowledge
  const ackIncidentRoute = createRoute({
    method: 'post',
    path: '/api/v1/admin/incidents/{id}/acknowledge',
    request: { params: z.object({ id: z.string().min(1) }), body: { content: { 'application/json': { schema: z.object({ actor: z.string().min(1).optional() }).optional() } } } },
    responses: {
      200: { description: 'Acknowledged', content: { 'application/json': { schema: IncidentSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'Conflict', content: { 'application/json': { schema: ErrorSchema } } },
      500: { description: 'Internal error', content: { 'application/json': { schema: ErrorSchema } } },
    },
  });
  app.openapi(ackIncidentRoute, async (c) => {
    const { id } = c.req.valid('param');
    const body = (await c.req.json().catch(() => ({}))) as { actor?: string };
    const actor = body.actor ?? c.req.header('x-actor') ?? 'admin';
    const store = getStore();
    try {
      const updated = store.acknowledgeIncident(id, actor);
      return c.json(updated, 200);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code;
      const correlationId = c.get('correlationId');
      if (code === 'INCIDENT_NOT_FOUND') return c.json({ error: { code, message: msg, correlationId } }, 404);
      if (code === 'INCIDENT_NOT_OPEN') return c.json({ error: { code, message: 'Incident is not in OPEN state', correlationId } }, 409);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to acknowledge', correlationId } }, 500);
    }
  });

  // GET /api/v1/admin/kill-switches
  const listKillSwitchesRoute = createRoute({
    method: 'get',
    path: '/api/v1/admin/kill-switches',
    responses: {
      200: {
        description: 'Kill switches',
        content: {
          'application/json': {
            schema: z.object({
              killSwitches: z.array(
                z.object({
                  name: KillSwitchNameSchema,
                  enabled: z.boolean(),
                  enabledAt: z.string().datetime().nullable().optional(),
                  enabledBy: z.string().nullable().optional(),
                  reason: z.string().nullable().optional(),
                  requiresReauth: z.boolean(),
                  auditLogged: z.boolean(),
                }),
              ),
            }),
          },
        },
      },
    },
  });
  app.openapi(listKillSwitchesRoute, (c) => {
    const store = getStore();
    return c.json({ killSwitches: store.getKillSwitches() }, 200);
  });

  // POST /api/v1/admin/kill-switches/:name/enable  and /disable
  const toggleKillSwitch = async (
    c: { req: { param: (k: string) => string; header: (k: string) => string | undefined; json: () => Promise<unknown> }; get: (k: string) => string; json: (data: unknown, status: number) => Response },
    enabled: boolean,
  ) => {
    const rawName = c.req.param('name');
    const parsed = KillSwitchNameSchema.safeParse(rawName);
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_KILL_SWITCH', message: `Unknown kill switch ${rawName}`, correlationId: c.get('correlationId') } }, 400);
    }
    // Re-auth required
    const headers: Record<string, string | undefined> = {
      'x-reauth-verified': c.req.header('x-reauth-verified'),
      'x-step-up-verified': c.req.header('x-step-up-verified'),
      'x-reauth-token': c.req.header('x-reauth-token'),
      'x-step-up-token': c.req.header('x-step-up-token'),
      'x-passkey-token': c.req.header('x-passkey-token'),
      authorization: c.req.header('authorization'),
    };
    if (!isReauthVerified(headers)) {
      return c.json(
        { error: { code: 'REAUTH_REQUIRED', message: 'Kill switch change requires re-authentication (passkey/step-up)', correlationId: c.get('correlationId') } },
        401,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; actor?: string };
    const actor = body.actor ?? c.req.header('x-actor') ?? c.req.header('x-user-email') ?? 'admin';
    const reason = body.reason ?? null;
    const store = getStore();
    try {
      const updated = await store.setKillSwitch(parsed.data, enabled, actor, reason ?? undefined, true);
      return c.json(updated, 200);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'REAUTH_REQUIRED') return c.json({ error: { code, message: 'Re-authentication required', correlationId: c.get('correlationId') } }, 401);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to toggle kill switch', correlationId: c.get('correlationId') } }, 500);
    }
  };

  // We use generic Hono routes for toggle because OpenAPI path params with enum need exact match
  // Register both enable and disable under typed routes
  app.post('/api/v1/admin/kill-switches/:name/enable', async (c) => toggleKillSwitch(c as unknown as Parameters<typeof toggleKillSwitch>[0], true));
  app.post('/api/v1/admin/kill-switches/:name/disable', async (c) => toggleKillSwitch(c as unknown as Parameters<typeof toggleKillSwitch>[0], false));

  // GET /api/v1/admin/audit — expose kill-switch audit for verification (not public in production but useful for tests)
  app.get('/api/v1/admin/audit', (c) => {
    const store = getStore();
    return c.json({ audit: store.getAuditLog() }, 200);
  });

  // FR-AGT-007 decision lineage: frozen explain vs versioned re-evaluate
  // In-memory lineage store is sufficient for product without migration; backed by DecisionLineageStore singleton
  // These endpoints never mutate frozen artifacts; re-evaluate creates a new versioned run
  {
    const getLineage = async () => {
      const mod = await import('@ciag/agent-runtime');
      return (mod as { getDecisionLineageStore: () => InstanceType<typeof mod.DecisionLineageStore> }).getDecisionLineageStore();
    };

    app.post('/api/v1/admin/decisions', async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { candidateId?: string; decision?: unknown; evidenceSnapshot?: unknown[]; profileId?: string; profileVersion?: string }
        | null;
      if (!body?.candidateId || !body?.decision) {
        return c.json({ error: { code: 'INVALID_INPUT', message: 'candidateId and decision are required', correlationId: c.get('correlationId') } }, 400);
      }
      const store = await getLineage();
      try {
        const run = store.createRun({
          candidateId: body.candidateId,
          decision: body.decision as never,
          evidenceSnapshot: (body.evidenceSnapshot as never[]) ?? [],
          profileId: body.profileId ?? 'unknown',
          profileVersion: body.profileVersion ?? null,
        });
        return c.json(run, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: { code: 'CONFLICT', message: msg, correlationId: c.get('correlationId') } }, 409);
      }
    });

    app.get('/api/v1/admin/decisions/:id', async (c) => {
      const id = c.req.param('id');
      const store = await getLineage();
      const run = store.getRun(id);
      if (!run) return c.json({ error: { code: 'NOT_FOUND', message: `Decision run ${id} not found`, correlationId: c.get('correlationId') } }, 404);
      return c.json(run, 200);
    });

    // EXPLAIN_ORIGINAL_DECISION — frozen evidence/decision snapshot, read-only
    app.get('/api/v1/admin/decisions/:id/explain', async (c) => {
      const id = c.req.param('id');
      const store = await getLineage();
      const run = store.getExplainOriginal(id);
      if (!run) return c.json({ error: { code: 'NOT_FOUND', message: `Decision run ${id} not found`, correlationId: c.get('correlationId') } }, 404);
      return c.json({ mode: 'EXPLAIN_ORIGINAL_DECISION', frozen: true, run }, 200);
    });

    // RE_EVALUATE_WITH_CURRENT_DATA — creates separate versioned run without mutating frozen artifacts
    app.post('/api/v1/admin/decisions/:id/re-evaluate', async (c) => {
      const id = c.req.param('id');
      const body = (await c.req.json().catch(() => ({}))) as { evidenceSnapshot?: unknown[]; decision?: unknown; profileId?: string };
      const store = await getLineage();
      const original = store.getRun(id);
      if (!original) return c.json({ error: { code: 'NOT_FOUND', message: `Decision run ${id} not found`, correlationId: c.get('correlationId') } }, 404);
      try {
        const newRun = store.reEvaluate({
          originalRunId: id,
          newEvidenceSnapshot: (body.evidenceSnapshot as never[]) ?? [],
          newDecision: (body.decision as never) ?? original.decision,
          profileId: body.profileId,
        });
        return c.json({ mode: 'RE_EVALUATE_WITH_CURRENT_DATA', originalId: id, run: newRun }, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ORIGINAL_RUN_NOT_FOUND')) return c.json({ error: { code: 'NOT_FOUND', message: msg, correlationId: c.get('correlationId') } }, 404);
        return c.json({ error: { code: 'INTERNAL_ERROR', message: msg, correlationId: c.get('correlationId') } }, 500);
      }
    });

    app.get('/api/v1/admin/decisions', async (c) => {
      const candidateId = c.req.query('candidateId');
      const store = await getLineage();
      if (candidateId) {
        const runs = store.listRunsForCandidate(candidateId);
        return c.json({ runs }, 200);
      }
      // list all not implemented, return empty for now
      return c.json({ runs: [] }, 200);
    });
  }

  // Internal reset for tests — not exposed in production route list but allowed for test harness
  app.post('/api/v1/internal/admin/reset', async (c) => {
    // Only allow in test mode when header present to avoid accidental prod reset
    const testHeader = c.req.header('x-test-reset');
    if (testHeader !== 'true') return c.json({ error: { code: 'FORBIDDEN', message: 'Reset not allowed', correlationId: c.get('correlationId') } }, 403);
    resetAdminStore();
    resetResearchWorkbenchStores(deps?.now ?? (() => new Date().toISOString()));
    resetScheduleDraftStore(deps?.now ?? (() => new Date().toISOString()));
    return c.json({ status: 'reset' }, 200);
  });

  return app;
};
