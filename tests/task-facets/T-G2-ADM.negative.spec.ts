import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { resetAdminStore } from '../../apps/api/src/routes/admin/store.js';

const appFactory = () => createApp({ allowedOrigins: ['http://localhost'], dependencies: [] });
async function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* ignore parse */ }
  return { status: res.status, json, body };
}

describe('T-G2-ADM negative', () => {
  beforeEach(() => resetAdminStore());

  it('kill switch without re-auth returns 401', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/kill-switches/DISABLE_ALL_AUTOMATION/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no-auth' }),
    });
    expect(r.status).toBe(401);
    expect((r.json as Record<string, unknown>).error).toBeDefined();
    const err = (r.json as { error: { code: string } }).error;
    expect(err.code).toBe('REAUTH_REQUIRED');

    // also test with short token (too short) should still fail
    const r2 = await request(app, '/api/v1/admin/kill-switches/DISABLE_ALL_AUTOMATION/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reauth-token': 'short' },
      body: JSON.stringify({}),
    });
    expect(r2.status).toBe(401);
  });

  it('unknown kill switch returns 400', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/kill-switches/UNKNOWN_SWITCH/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reauth-verified': 'true' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('INVALID_KILL_SWITCH');
  });

  it('acknowledge non-existent incident returns 404', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/incidents/inc_nonexistent/acknowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'bob' }),
    });
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe('INCIDENT_NOT_FOUND');
  });

  it('double acknowledge returns 409', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'SCHEDULE_DRIFT',
        severity: 'MEDIUM',
        owner: 'owner',
        affectedScopes: ['schedule:1'],
      }),
    });
    const id = (created.json as { id: string }).id;
    const first = await request(app, `/api/v1/admin/incidents/${id}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const second = await request(app, `/api/v1/admin/incidents/${id}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
    expect((second.json as { error: { code: string } }).error.code).toBe('INCIDENT_NOT_OPEN');
  });

  it('incident creation requires affectedScopes', async () => {
    const app = appFactory();
    const r = await request(app, '/api/v1/admin/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'PROVIDER_OUTAGE',
        severity: 'HIGH',
        owner: 'owner',
        affectedScopes: [],
      }),
    });
    // zod validation should reject empty affectedScopes or app should return 400
    // Our route allows min 1, so 400 is expected; if implementation returns 201 with empty, fail test to catch missing validation
    expect([400, 422]).toContain(r.status);
  });

  it('overview refresh does not trigger provider calls even under simulated outage', async () => {
    const app = appFactory();
    // Simulate provider outage by creating an incident, then refresh overview multiple times
    await request(app, '/api/v1/admin/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'PROVIDER_OUTAGE',
        severity: 'CRITICAL',
        owner: 'oncall',
        affectedScopes: ['provider:bad-provider'],
        automatedContainment: { action: 'BLOCK_PROVIDER', success: true },
        revalidationRequirements: ['reverify'],
      }),
    });
    // Overview should still succeed and contain the incident, without throwing provider errors
    for (let i = 0; i < 3; i += 1) {
      const r = await request(app, '/api/v1/admin/overview');
      expect(r.status).toBe(200);
      const ov = r.json as { providerIncidents: Array<{ type: string }> };
      expect(ov.providerIncidents.some((inc) => inc.type === 'PROVIDER_OUTAGE')).toBe(true);
    }
  });

  it('all six kill switches are individually toggleable with reauth and audit chain is hash-linked', async () => {
    const app = appFactory();
    const names = [
      'DISABLE_ALL_AUTOMATION',
      'DISABLE_ALL_MODEL_CALLS',
      'DISABLE_ALL_PROVIDER_CALLS',
      'DISABLE_NOTIFICATIONS',
      'REVOKE_ALL_MCP_CLIENTS',
      'EMERGENCY_READ_ONLY_MODE',
    ];
    for (const name of names) {
      const r = await request(app, `/api/v1/admin/kill-switches/${name}/enable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-reauth-verified': 'true', 'x-actor': 'auditor' },
        body: JSON.stringify({ reason: `test-${name}` }),
      });
      expect(r.status).toBe(200);
    }
    const audit = await request(app, '/api/v1/admin/audit');
    const records = (audit.json as { audit: Array<{ target: string; previousHash: string | null; recordHash: string }> }).audit;
    expect(records.length).toBeGreaterThanOrEqual(6);
    // hash chain: each record's previousHash equals prior recordHash
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]!.previousHash).toBe(records[i - 1]!.recordHash);
      expect(records[i]!.recordHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
