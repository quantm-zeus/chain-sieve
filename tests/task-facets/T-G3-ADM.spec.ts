import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { resetAdminStore } from '../../apps/api/src/routes/admin/store.js';
import { resetResearchWorkbenchStores, resetScheduleDraftStore } from '../../apps/api/src/routes/admin/research-workbench.js';

const appFactory = () => createApp({ allowedOrigins: ['http://localhost'], dependencies: [] });

async function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

describe('T-G3-ADM positive: research workbench', () => {
  beforeEach(() => {
    resetAdminStore();
    resetResearchWorkbenchStores();
    resetScheduleDraftStore();
  });

  it('FR-ADM-002: workbench streams reasoning steps and tool timeline with event-time ordering, evidence links, and abort/cancellation visibility', async () => {
    const app = appFactory();
    // create session
    const created = await request(app, '/api/v1/admin/agent/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agentProfileId:'ap_v1', modelProfileId:'mp_v1', promptVersion:'v1', toolProfileVersion:'tp_v1' }) });
    expect(created.status).toBe(201);
    const sid = (created.json as { id:string }).id;
    expect(sid).toMatch(/^wbs_/);

    // get session with timeline
    const got = await request(app, `/api/v1/admin/agent/sessions/${sid}`);
    expect(got.status).toBe(200);
    const sess = (got.json as { session: { events: Array<{ sequence:number; eventTime:string; evidenceLinks:string[]; evidenceIds:string[] }>; toolTimeline: unknown[] }}).session;
    expect(sess.events.length).toBeGreaterThanOrEqual(3);
    // event-time ordering
    for (let i=1;i<sess.events.length;i++) expect(sess.events[i]!.eventTime >= sess.events[i-1]!.eventTime).toBe(true);
    // evidence links present where evidenceIds exist
    const withEvidence = sess.events.find(e=> e.evidenceIds.length>0);
    expect(withEvidence).toBeDefined();
    expect(withEvidence!.evidenceLinks.length).toBe(withEvidence!.evidenceIds.length);
    expect(withEvidence!.evidenceLinks[0]).toContain('/api/v1/admin/evidence/');

    // streaming events endpoint
    const evts = await request(app, `/api/v1/admin/agent/sessions/${sid}/events`);
    expect(evts.status).toBe(200);
    const body = evts.json as { events: unknown[]; orderedBy: string; abortVisible: boolean; cancellationVisible: boolean };
    expect(body.orderedBy).toBe('eventTime');
    expect(body.abortVisible).toBe(false);
    expect(body.cancellationVisible).toBe(false);

    // inject out-of-order event and verify reordering
    await request(app, `/api/v1/admin/agent/sessions/${sid}/events`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'tool_call_progress', eventTime: new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString(), payload:{ toolName:'dex.pairs' }, evidenceIds:['ev_extra'] }) });
    const got2 = await request(app, `/api/v1/admin/agent/sessions/${sid}`);
    const evs2 = (got2.json as { session: { events: Array<{ eventTime:string; sequence:number }> }}).session.events;
    for (let i=1;i<evs2.length;i++) expect(evs2[i]!.eventTime >= evs2[i-1]!.eventTime).toBe(true);

    // cancellation visibility
    const cancel = await request(app, `/api/v1/admin/agent/sessions/${sid}/cancel`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ actor:'admin@example.com', reason:'manual cancel' }) });
    expect(cancel.status).toBe(200);
    const afterCancel = await request(app, `/api/v1/admin/agent/sessions/${sid}`);
    const sessAfter = (afterCancel.json as { session: { cancellation: unknown; status:string }}).session;
    expect(sessAfter.status).toBe('CANCELLED');
    expect(sessAfter.cancellation).not.toBeNull();
    const evtsAfter = await request(app, `/api/v1/admin/agent/sessions/${sid}/events`);
    expect((evtsAfter.json as { cancellationVisible:boolean }).cancellationVisible).toBe(true);

    // abort visibility (new session)
    const created2 = await request(app, '/api/v1/admin/agent/sessions', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ agentProfileId:'ap_v1', modelProfileId:'mp_v1', promptVersion:'v1', toolProfileVersion:'tp_v1' }) });
    const sid2 = (created2.json as { id:string }).id;
    const aborted = await request(app, `/api/v1/admin/agent/sessions/${sid2}/abort`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reason:'deadline', stepIndex:1 }) });
    expect(aborted.status).toBe(200);
    const evtsAbort = await request(app, `/api/v1/admin/agent/sessions/${sid2}/events`);
    expect((evtsAbort.json as { abortVisible:boolean }).abortVisible).toBe(true);
  });

  it('FR-ADM-004: frozen-run investigation renders immutable snapshot with planner envelope, validated claims, evidence IDs, budgets, and re-evaluation diff', async () => {
    const app = appFactory();
    const created = await request(app, '/api/v1/admin/runs', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect([201,200].includes(created.status)).toBe(true);
    const runId = (created.json as { snapshot:{ runId:string }}).snapshot.runId;

    const frozen = await request(app, `/api/v1/admin/runs/${runId}`);
    expect(frozen.status).toBe(200);
    const snap = (frozen.json as { snapshot: { frozenAt:string; immutable:boolean; plannerEnvelope: { version:string; determinismHash:string; steps:unknown[] }; validatedClaims: Array<{ claim:string; evidenceIds:string[] }>; evidenceIds:string[]; budgets: Record<string,unknown>; configHash:string; resolvedConfig:unknown }}).snapshot;
    expect(snap.immutable).toBe(true);
    expect(snap.plannerEnvelope.version).toBeDefined();
    expect(snap.plannerEnvelope.determinismHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.validatedClaims.length).toBeGreaterThan(0);
    expect(snap.evidenceIds.length).toBeGreaterThan(0);
    expect(snap.budgets).toBeDefined();
    expect(snap.configHash).toMatch(/^[a-f0-9]{64}$/);

    const inv = await request(app, `/api/v1/admin/runs/${runId}/investigation`);
    expect(inv.status).toBe(200);
    const investigation = (inv.json as { investigation: { frozenSnapshot: unknown; reEvaluation: unknown; plannerEnvelope: unknown; validatedClaims: unknown; evidenceIds:string[]; budgets:unknown }}).investigation;
    expect(investigation.frozenSnapshot).toBeDefined();
    expect(investigation.plannerEnvelope).toBeDefined();
    expect(investigation.validatedClaims).toBeDefined();
    expect(investigation.reEvaluation).toBeNull();

    // re-evaluate creates diff without mutating frozen fields
    const re = await request(app, `/api/v1/admin/runs/${runId}/re-evaluate`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ evidenceIds:['ev_new_1'], claims:['liquidity improved','new claim'] }) });
    expect(re.status).toBe(201);
    const updated = (re.json as { reEvaluation: { diff:{ added:string[]; removed:string[]; evidenceDiff:{ addedIds:string[] } } }}).reEvaluation;
    expect(updated.diff.added.length).toBeGreaterThan(0);
    expect(updated.diff.evidenceDiff.addedIds).toContain('ev_new_1');

    // frozen fields unchanged
    const frozen2 = await request(app, `/api/v1/admin/runs/${runId}`);
    const snap2 = (frozen2.json as { snapshot: { plannerEnvelope: { determinismHash:string }; frozenAt:string }}).snapshot;
    expect(snap2.plannerEnvelope.determinismHash).toBe(snap.plannerEnvelope.determinismHash);
    expect(snap2.frozenAt).toBe(snap.frozenAt);
  });

  it('FR-ADM-005: candidate radar lists promotion funnel state and why-not-alerted explains gating reason with point-in-time references', async () => {
    const app = appFactory();
    const list = await request(app, '/api/v1/admin/candidates');
    expect(list.status).toBe(200);
    const cands = (list.json as { candidates: Array<{ id:string; funnelStage:string; riskState:string }> }).candidates;
    expect(cands.length).toBeGreaterThanOrEqual(3);
    const stages = cands.map(c=> c.funnelStage);
    expect(stages).toContain('QUALIFIED');
    expect(stages).toContain('REJECTED');

    // gating reason
    const why1 = await request(app, '/api/v1/admin/candidates/cand_1/why-not-alerted');
    expect(why1.status).toBe(200);
    const w1 = why1.json as { whyNotAlerted: { gatingCategory:string; gatingReason:string; funnelStageExited:string; pointInTimeReferences:Array<{ availableAt:string; evidenceId:string }>; hardGate:string|null } };
    expect(w1.whyNotAlerted.gatingCategory).toBe('GATING_REASON');
    expect(w1.whyNotAlerted.funnelStageExited).toBe('QUALIFIED');
    expect(w1.whyNotAlerted.pointInTimeReferences.length).toBeGreaterThan(0);
    expect(typeof w1.whyNotAlerted.pointInTimeReferences[0]!.availableAt).toBe('string');

    // risk block
    const why2 = await request(app, '/api/v1/admin/candidates/cand_2/why-not-alerted');
    expect(why2.status).toBe(200);
    expect((why2.json as { whyNotAlerted:{ gatingCategory:string; riskBlock:string|null }}).whyNotAlerted.gatingCategory).toBe('RISK_BLOCK');
    expect((why2.json as { whyNotAlerted:{ riskBlock:string|null }}).whyNotAlerted.riskBlock).toBeDefined();

    // insufficient data + missing evidence
    const why3 = await request(app, '/api/v1/admin/candidates/cand_3/why-not-alerted');
    expect(why3.status).toBe(200);
    const w3 = why3.json as { whyNotAlerted: { gatingCategory:string; missingEvidence:string[]; insufficientDataReason:string|null } };
    expect(w3.whyNotAlerted.gatingCategory).toBe('INSUFFICIENT_DATA');
    expect(w3.whyNotAlerted.missingEvidence.length).toBeGreaterThan(0);
    expect(w3.whyNotAlerted.insufficientDataReason).toBeDefined();
  });

  it('FR-ADM-008: admin chat creates only validated schedule draft; activation gates enforce resolved-config review, 30-day SCC forecast, explicit approval with re-auth, immutable version', async () => {
    const app = appFactory();

    // invalid natural language must be rejected (422) — only validated drafts are created
    const invalid = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'hello world' }) });
    expect(invalid.status).toBe(422);
    expect((invalid.json as { error:{ code:string }}).error.code).toBe('DRAFT_VALIDATION_FAILED');

    // valid draft
    const valid = await request(app, '/api/v1/admin/schedule-drafts', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ naturalLanguage:'Create a schedule to monitor solana tokens every hour using workflow wf_v1 and agent profile ap_v1' }) });
    expect(valid.status).toBe(201);
    const draftId = (valid.json as { id:string }).id;
    expect((valid.json as { validated:boolean }).validated).toBe(true);

    // resolved-config present
    const rc = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/resolved-config`);
    expect(rc.status).toBe(200);
    expect((rc.json as { resolvedConfig:unknown; configHash:string }).configHash).toMatch(/^[a-f0-9]{64}$/);
    expect((rc.json as { reviewed:boolean }).reviewed).toBe(false);

    // activation must fail before gates pass
    const earlyActivate = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/activate`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true'}, body: JSON.stringify({}) });
    expect(earlyActivate.status).toBe(422);
    const earlyCode = (earlyActivate.json as { error:{ code:string }}).error.code;
    expect(['RESOLVED_CONFIG_NOT_REVIEWED','CAPACITY_FORECAST_REQUIRED','APPROVAL_REQUIRED'].includes(earlyCode)).toBe(true);

    // capacity forecast before review must fail
    const earlyForecast = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/capacity-forecast`, { method:'POST' });
    expect(earlyForecast.status).toBe(400);
    expect((earlyForecast.json as { error:{ code:string }}).error.code).toBe('RESOLVED_CONFIG_NOT_REVIEWED');

    // 1) resolved-config review
    const review = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/review`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ reviewer:'admin@example.com' }) });
    expect(review.status).toBe(200);
    expect((review.json as { draft:{ resolvedConfigReviewed:boolean }}).draft.resolvedConfigReviewed).toBe(true);

    // 2) 30-day capacity forecast via SCC
    const forecast = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/capacity-forecast`, { method:'POST' });
    expect(forecast.status).toBe(200);
    const fc = forecast.json as { forecast:{ horizonDays:number; result:string } };
    expect(fc.forecast.horizonDays).toBe(30);
    expect(fc.forecast.result).toBe('PASS');

    // 3) approval without re-auth must fail
    const noReauth = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/approve`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect(noReauth.status).toBe(401);
    expect((noReauth.json as { error:{ code:string }}).error.code).toBe('REAUTH_REQUIRED');

    // explicit approval with re-auth
    const approve = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/approve`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true'}, body: JSON.stringify({ actor:'admin@example.com' }) });
    expect(approve.status).toBe(200);
    expect((approve.json as { approved:boolean }).approved).toBe(true);

    // 4) activation requires re-auth and creates immutable version
    const noReauthActivate = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/activate`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    expect(noReauthActivate.status).toBe(401);

    const activate = await request(app, `/api/v1/admin/schedule-drafts/${draftId}/activate`, { method:'POST', headers:{'content-type':'application/json','x-reauth-verified':'true'}, body: JSON.stringify({}) });
    expect(activate.status).toBe(200);
    const version = (activate.json as { version:{ versionId:string; configHash:string } }).version;
    expect(version.versionId).toMatch(/^schedver_/);
    expect(version.configHash).toMatch(/^[a-f0-9]{64}$/);

    // verify draft is ACTIVE and immutable version persists
    const after = await request(app, `/api/v1/admin/schedule-drafts/${draftId}`);
    expect((after.json as { draft:{ status:string; immutableVersion:{ versionId:string } }}).draft.status).toBe('ACTIVE');
    expect((after.json as { draft:{ immutableVersion:{ versionId:string } }}).draft.immutableVersion.versionId).toBe(version.versionId);
  });
});
