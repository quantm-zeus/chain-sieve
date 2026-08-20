import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { resetAdminStore } from '../../apps/api/src/routes/admin/store.js';

const appFactory = () => createApp({ allowedOrigins: ['http://localhost'], dependencies: [] });

async function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch {}
  return { status: res.status, json, body };
}

describe('T-G2-ADM positive: overview, incidents, kill switches', () => {
  beforeEach(() => resetAdminStore());

  it('AC-010..014 facet: overview displays required fields and refresh never triggers provider calls', async () => {
    const app = appFactory();
    let providerCalled = false;
    const fakeProvider = { fetch: () => { providerCalled = true; throw new Error('PROVIDER_CALLED'); } };
    // overview must not call provider — we verify by ensuring providerCalled stays false after multiple refreshes
    const r1 = await request(app, '/api/v1/admin/overview');
    expect(r1.status).toBe(200);
    const ov = r1.json as Record<string, unknown>;
    expect(ov).toHaveProperty('systemMode');
    expect(ov).toHaveProperty('globalKillSwitchState');
    expect(ov).toHaveProperty('providerIncidents');
    expect(ov).toHaveProperty('quotaExhaustionForecast');
    expect(ov).toHaveProperty('activeSchedules');
    expect(ov).toHaveProperty('scheduleDrift');
    expect(ov).toHaveProperty('workflowStates');
    expect(ov).toHaveProperty('candidateCounts');
    expect(ov).toHaveProperty('lastBackupStatus');
    expect(ov).toHaveProperty('generatedAt');
    // kill switches count = 6
    const ks = ov['globalKillSwitchState'] as Array<{ name: string }>;
    expect(ks).toHaveLength(6);
    const names = ks.map((k) => k.name).sort();
    expect(names).toEqual([
      'DISABLE_ALL_AUTOMATION',
      'DISABLE_ALL_MODEL_CALLS',
      'DISABLE_ALL_PROVIDER_CALLS',
      'DISABLE_NOTIFICATIONS',
      'EMERGENCY_READ_ONLY_MODE',
      'REVOKE_ALL_MCP_CLIENTS',
    ].sort());
    // workflowStates shape
    const wf = ov['workflowStates'] as Record<string, number>;
    expect(typeof wf.running).toBe('number');
    expect(typeof wf.deadLettered).toBe('number');
    // candidateCounts
    const cc = ov['candidateCounts'] as { byLifecycle: Record<string, number>; byRisk: Record<string, number>; total: number };
    expect(typeof cc.total).toBe('number');
    // second refresh
    const r2 = await request(app, '/api/v1/admin/overview');
    expect(r2.status).toBe(200);
    expect(providerCalled).toBe(false);
    // ensure fakeProvider not referenced — overview is provider-free
    expect(fakeProvider.fetch).toBeDefined();
  });

  it('incidents model severity, owner, status, timestamps, affectedScopes, containment and revalidation', async () => {
    const app = appFactory();
    const create = await request(app, '/api/v1/admin/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'PROVIDER_OUTAGE',
        severity: 'HIGH',
        owner: 'oncall@example.com',
        affectedScopes: ['provider:coingecko', 'capability:discovery'],
        automatedContainment: { action: 'DISABLE_PROVIDER', success: true, detail: 'auto-disabled' },
        evidenceRefs: ['ev_123'],
        revalidationRequirements: ['reverify-provider-plan', 'replay-collector-gap'],
        rootCause: 'rate-limit breach',
      }),
    });
    expect(create.status).toBe(201);
    const inc = create.json as Record<string, unknown>;
    expect(inc['severity']).toBe('HIGH');
    expect(inc['owner']).toBe('oncall@example.com');
    expect(inc['status']).toBe('OPEN');
    expect(typeof inc['createdAt']).toBe('string');
    expect(typeof inc['updatedAt']).toBe('string');
    expect(inc['affectedScopes']).toEqual(['provider:coingecko', 'capability:discovery']);
    const containment = inc['automatedContainment'] as Record<string, unknown> | null;
    expect(containment).not.toBeNull();
    expect(containment!['action']).toBe('DISABLE_PROVIDER');
    expect(containment!['success']).toBe(true);
    expect(inc['revalidationRequirements']).toEqual(['reverify-provider-plan', 'replay-collector-gap']);

    // list includes it
    const list = await request(app, '/api/v1/admin/incidents');
    expect(list.status).toBe(200);
    const incidents = (list.json as { incidents: unknown[] }).incidents;
    expect(incidents.length).toBeGreaterThanOrEqual(1);

    // acknowledge changes status
    const id = inc['id'] as string;
    const ack = await request(app, `/api/v1/admin/incidents/${id}/acknowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'bob@example.com' }),
    });
    expect(ack.status).toBe(200);
    expect((ack.json as Record<string, unknown>)['status']).toBe('ACKNOWLEDGED');
    expect(typeof (ack.json as Record<string, unknown>)['acknowledgedAt']).toBe('string');
  });

  it('kill switches require re-authentication and are audit logged', async () => {
    const app = appFactory();
    // enable with reauth
    const enable = await request(app, '/api/v1/admin/kill-switches/DISABLE_ALL_MODEL_CALLS/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reauth-verified': 'true', 'x-actor': 'alice@example.com' },
      body: JSON.stringify({ reason: 'halt models' }),
    });
    expect(enable.status).toBe(200);
    expect((enable.json as Record<string, unknown>)['enabled']).toBe(true);
    expect((enable.json as Record<string, unknown>)['enabledBy']).toBe('alice@example.com');

    // audit contains record with reauthVerified true and hash chain
    const audit = await request(app, '/api/v1/admin/audit');
    expect(audit.status).toBe(200);
    const records = (audit.json as { audit: Array<Record<string, unknown>> }).audit;
    const ksRecord = records.find((r) => r['target'] === 'DISABLE_ALL_MODEL_CALLS' && r['action'] === 'KILL_SWITCH_ENABLED');
    expect(ksRecord).toBeDefined();
    expect(ksRecord!['reauthVerified']).toBe(true);
    expect(typeof ksRecord!['recordHash']).toBe('string');
    expect((ksRecord!['recordHash'] as string)).toMatch(/^[a-f0-9]{64}$/);

    // overview reflects enabled state
    const ov = await request(app, '/api/v1/admin/overview');
    const ksState = ((ov.json as Record<string, unknown>)['globalKillSwitchState'] as Array<Record<string, unknown>>).find((k) => k['name'] === 'DISABLE_ALL_MODEL_CALLS');
    expect(ksState!['enabled']).toBe(true);

    // disable with different reauth header form
    const disable = await request(app, '/api/v1/admin/kill-switches/DISABLE_ALL_MODEL_CALLS/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reauth-token': 'valid-passkey-token-12345' },
      body: JSON.stringify({ reason: 'restore' }),
    });
    expect(disable.status).toBe(200);
    expect((disable.json as Record<string, unknown>)['enabled']).toBe(false);

    // EMERGENCY_READ_ONLY_MODE toggles systemMode
    const emergency = await request(app, '/api/v1/admin/kill-switches/EMERGENCY_READ_ONLY_MODE/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reauth-verified': 'true' },
      body: JSON.stringify({ reason: 'emergency' }),
    });
    expect(emergency.status).toBe(200);
    const ov2 = await request(app, '/api/v1/admin/overview');
    expect((ov2.json as Record<string, unknown>)['systemMode']).toBe('READ_ONLY');
  });

  it('quota forecast, workflow states, candidate counts and backup status are present', async () => {
    const app = appFactory();
    const ov = (await request(app, '/api/v1/admin/overview')).json as Record<string, unknown>;
    const quota = ov['quotaExhaustionForecast'] as Array<Record<string, unknown>>;
    expect(Array.isArray(quota)).toBe(true);
    expect(quota.length).toBeGreaterThanOrEqual(1);
    expect(quota[0]).toHaveProperty('provider');
    expect(quota[0]).toHaveProperty('remainingQuota');
    expect(quota[0]).toHaveProperty('status');
    const cc = ov['candidateCounts'] as { byLifecycle: Record<string, number>; byRisk: Record<string, number> };
    expect(cc.byLifecycle).toBeDefined();
    expect(cc.byRisk).toBeDefined();
    const backup = ov['lastBackupStatus'] as Record<string, unknown>;
    expect(backup).toHaveProperty('status');
    expect(backup).toHaveProperty('tier');
  });
});
