import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { resetAdminStore } from '../../apps/api/src/routes/admin/store.js';
import { resetResearchWorkbenchStores, resetScheduleDraftStore } from '../../apps/api/src/routes/admin/research-workbench.js';

const appFactory = () => createApp({ allowedOrigins: ['http://localhost'], dependencies: [] });

async function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const text = await res.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

describe('T-G3-ADM negative: fail-closed and degraded behavior', () => {
  beforeEach(() => { resetAdminStore(); resetResearchWorkbenchStores(); resetScheduleDraftStore(); });

  it('unknown workbench session returns 404, not fabricated success', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/agent/sessions/not_exist');
    expect(r.status).toBe(404);
    expect((r.json as { error:{ code:string }}).error.code).toBe('SESSION_NOT_FOUND');
  });

  it('cancelled/aborted already-terminal session returns 409', async () => {
    const app = appFactory();
    const c = await request(app, '/api/v1/admin/agent/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agentProfileId:'ap_v1', modelProfileId:'mp_v1', promptVersion:'v1', toolProfileVersion:'tp_v1' }) });
    const id = (c.json as { id:string }).id;
    await request(app, `/api/v1/admin/agent/sessions/${id}/cancel`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reason:'x'}) });
    const second = await request(app, `/api/v1/admin/agent/sessions/${id}/cancel`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reason:'y'}) });
    expect(second.status).toBe(409);
  });

  it('unknown frozen run returns 404', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/runs/does_not_exist');
    expect(r.status).toBe(404);
    expect((r.json as { error:{code:string}}).error.code).toBe('RUN_NOT_FOUND');
  });

  it('re-evaluate unknown run returns 404', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/runs/nope/re-evaluate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ claims:['x'] }) });
    expect(r.status).toBe(404);
  });

  it('unknown candidate why-not-alerted returns 404, not empty success', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/candidates/unknown_999/why-not-alerted');
    expect(r.status).toBe(404);
    expect((r.json as { error:{code:string}}).error.code).toBe('CANDIDATE_NOT_FOUND');
  });

  it('schedule draft activation without resolved-config review fails closed with explicit code', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1' }) });
    const id = (created.json as { id:string }).id;
    // skip review, try approve
    const approve = await request(app, `/api/v1/admin/schedule-drafts/${id}/approve`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true'}, body: JSON.stringify({}) });
    expect(approve.status).toBe(400);
    expect((approve.json as { error:{code:string}}).error.code).toBe('CAPACITY_FORECAST_REQUIRED');
  });

  it('schedule draft approve without re-auth fails with 401 REAUTH_REQUIRED', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1' }) });
    const id = (created.json as { id:string }).id;
    await request(app, `/api/v1/admin/schedule-drafts/${id}/review`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    await request(app, `/api/v1/admin/schedule-drafts/${id}/capacity-forecast`, { method:'POST' });
    const approve = await request(app, `/api/v1/admin/schedule-drafts/${id}/approve`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect(approve.status).toBe(401);
    expect((approve.json as { error:{code:string}}).error.code).toBe('REAUTH_REQUIRED');
  });

  it('schedule draft activation without re-auth fails with 401', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1' }) });
    const id = (created.json as { id:string }).id;
    await request(app, `/api/v1/admin/schedule-drafts/${id}/review`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    await request(app, `/api/v1/admin/schedule-drafts/${id}/capacity-forecast`, { method:'POST' });
    await request(app, `/api/v1/admin/schedule-drafts/${id}/approve`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true'}, body: JSON.stringify({}) });
    const activate = await request(app, `/api/v1/admin/schedule-drafts/${id}/activate`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect(activate.status).toBe(401);
    expect((activate.json as { error:{code:string}}).error.code).toBe('REAUTH_REQUIRED');
  });

  it('unknown schedule draft returns 404', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/schedule-drafts/nope');
    expect(r.status).toBe(404);
    expect((r.json as { error:{code:string}}).error.code).toBe('DRAFT_NOT_FOUND');
  });

  it('invalid natural language draft is not silently created as validated — returns 422 with issues', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'hello' }) });
    expect(r.status).toBe(422);
    expect((r.json as { error:{ code:string }}).error.code).toBe('DRAFT_VALIDATION_FAILED');
    expect((r.json as { error:{ code:string; issues: unknown[] }}).error).toBeDefined();
  });

  it('capacity forecast without resolved-config review returns explicit error, not PASS', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1' }) });
    const id = (created.json as { id:string }).id;
    const fc = await request(app, `/api/v1/admin/schedule-drafts/${id}/capacity-forecast`, { method:'POST' });
    expect(fc.status).toBe(400);
    expect((fc.json as { error:{code:string}}).error.code).toBe('RESOLVED_CONFIG_NOT_REVIEWED');
  });
});
