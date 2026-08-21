import { createHash, randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

type AdminEnv = { Variables: { correlationId: string } };

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }) });

const isReauthVerified = (headers: Record<string, string | undefined>): boolean => {
  const verified = headers['x-reauth-verified'] ?? headers['x-step-up-verified'];
  if (verified === 'true' || verified === '1') return true;
  const token = headers['x-reauth-token'] ?? headers['x-step-up-token'] ?? headers['x-passkey-token'];
  if (token && token.length >= 8) return true;
  const auth = headers['authorization'] ?? '';
  if (auth.toLowerCase().startsWith('stepup ') && auth.length > 10) return true;
  return false;
};

// ---------------------------------------------------------------------------
// Workbench — FR-ADM-002
// ---------------------------------------------------------------------------

export type WorkbenchStatus = 'QUEUED' | 'STREAMING' | 'COMPLETED' | 'CANCELLED' | 'ABORTED' | 'FAILED';

export interface WorkbenchEvent {
  id: string;
  sessionId: string;
  sequence: number;
  eventTime: string;
  observedAt: string;
  availableAt: string;
  type: 'reasoning_step' | 'tool_call_start' | 'tool_call_progress' | 'tool_call_result' | 'evidence_created' | 'approval_required' | 'usage_update' | 'cancellation' | 'final_response' | 'error' | 'abort';
  payload: Record<string, unknown>;
  evidenceIds: string[];
  evidenceLinks: string[];
  latencyMs?: number | undefined;
  provider?: string | undefined;
  cacheHit?: boolean | undefined;
  quotaUnits?: number | undefined;
  costUsd?: number | undefined;
  freshnessMs?: number | undefined;
}

export interface WorkbenchSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: WorkbenchStatus;
  agentProfileId: string;
  agentProfileVersion: string;
  modelProfileId: string;
  promptVersion: string;
  toolProfileVersion: string;
  budget: { maxSteps: number; maxToolCalls: number; maxModelCostUsd: number };
  events: WorkbenchEvent[];
  evidenceIds: string[];
  cancellation: { requestedAt: string; requestedBy: string; reason: string; visible: true } | null;
  abort: { abortedAt: string; reason: string; stepIndex: number | null; visible: true } | null;
  totalLatencyMs: number;
}

export const ReasoningStepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  thought: z.string().min(1),
  eventTime: z.string().datetime(),
  evidenceIds: z.array(z.string()).default([]),
});

export const ToolTimelineEntrySchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  eventTime: z.string().datetime(),
  observedAt: z.string().datetime(),
  availableAt: z.string().datetime(),
  status: z.enum(['STARTED', 'PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABORTED']),
  arguments: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
  evidenceLinks: z.array(z.string()).default([]),
  latencyMs: z.number().nonnegative().optional(),
  provider: z.string().optional(),
  cacheHit: z.boolean().optional(),
  quotaUnits: z.number().nonnegative().optional(),
  costUsd: z.number().optional(),
  freshnessMs: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Frozen run — FR-ADM-004
// ---------------------------------------------------------------------------
export interface FrozenRunSnapshot {
  runId: string;
  frozenAt: string;
  immutable: true;
  plannerEnvelope: {
    version: string;
    determinismHash: string;
    steps: Array<{ stepIndex: number; toolCalls: Array<{ callId: string; toolName: string; arguments: Record<string, unknown> }> }>;
    budget: Record<string, unknown>;
    seedRef: string;
  };
  validatedClaims: Array<{ claim: string; evidenceIds: string[]; confidence: string; validatedAt: string; validatorVersion: string }>;
  evidenceIds: string[];
  budgets: { modelTokens: number; providerCalls: number; costUsd: number; workflowSteps: number };
  configHash: string;
  resolvedConfig: Record<string, unknown>;
  reEvaluation: null | {
    reEvaluatedAt: string;
    currentClaims: Array<{ claim: string; evidenceIds: string[] }>;
    diff: { added: string[]; removed: string[]; changed: string[]; evidenceDiff: { addedIds: string[]; removedIds: string[] } };
  };
}

// ---------------------------------------------------------------------------
// Candidate Radar — FR-ADM-005
// ---------------------------------------------------------------------------
export type FunnelStage = 'DISCOVERED' | 'QUALIFIED' | 'EMERGING' | 'CONFIRMED' | 'MONITORING' | 'DECAYING' | 'REJECTED' | 'ARCHIVED';
export type RiskState = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'CONFLICTING';
export type GatingCategory = 'GATING_REASON' | 'MISSING_EVIDENCE' | 'RISK_BLOCK' | 'INSUFFICIENT_DATA';

export interface CandidateRecord {
  id: string;
  assetId: string;
  funnelStage: FunnelStage;
  riskState: RiskState;
  score: number | null;
  scoredAt: string | null;
  promotionHistory: Array<{ stage: FunnelStage; enteredAt: string; reason: string; evidenceIds: string[] }>;
  evidenceIds: string[];
  gates: { dataQuality: boolean; security: boolean; execution: boolean; tradability: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface WhyNotAlerted {
  candidateId: string;
  evaluatedAt: string;
  asOf: string;
  funnelStageExited: FunnelStage;
  gatingCategory: GatingCategory;
  gatingReason: string;
  missingEvidence: string[];
  riskBlock: string | null;
  insufficientDataReason: string | null;
  featureValues: Record<string, unknown>;
  featureVersion: string;
  rankingCutoff: number | null;
  agentDecision: string | null;
  policySuppressionReason: string | null;
  whatChangedAfterward: string | null;
  pointInTimeReferences: Array<{ referenceId: string; availableAt: string; evidenceId: string }>;
  hardGate: string | null;
  threshold: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// In-memory stores (singleton)
// ---------------------------------------------------------------------------
class WorkbenchStore {
  sessions = new Map<string, WorkbenchSession>();
  nextSeq = new Map<string, number>();
  now: () => string;
  constructor(now: () => string) { this.now = now; }
  reset(now: () => string) { this.sessions.clear(); this.nextSeq.clear(); this.now = now; }
  create(input: { agentProfileId: string; modelProfileId: string; promptVersion: string; toolProfileVersion: string; budget?: Record<string, unknown> }): WorkbenchSession {
    const id = `wbs_${randomUUID().slice(0, 12)}`;
    const now = this.now();
    const s: WorkbenchSession = {
      id, createdAt: now, updatedAt: now, status: 'QUEUED',
      agentProfileId: input.agentProfileId, agentProfileVersion: 'v1', modelProfileId: input.modelProfileId, promptVersion: input.promptVersion, toolProfileVersion: input.toolProfileVersion,
      budget: { maxSteps: Number(input.budget?.['maxSteps'] ?? 8), maxToolCalls: Number(input.budget?.['maxToolCalls'] ?? 12), maxModelCostUsd: Number(input.budget?.['maxModelCostUsd'] ?? 0.05) },
      events: [], evidenceIds: [], cancellation: null, abort: null, totalLatencyMs: 0,
    };
    // Seed initial reasoning + tool timeline events to demonstrate event-time ordering
    const base = Date.parse(now);
    const seed: Array<Omit<WorkbenchEvent,'id'|'sequence'>> = [
      { sessionId: id, eventTime: new Date(base).toISOString(), observedAt: new Date(base+10).toISOString(), availableAt: new Date(base+10).toISOString(), type: 'reasoning_step', payload: { stepIndex: 0, thought: 'Plan research: verify security, then execution' }, evidenceIds: [], evidenceLinks: [] },
      { sessionId: id, eventTime: new Date(base+50).toISOString(), observedAt: new Date(base+60).toISOString(), availableAt: new Date(base+60).toISOString(), type: 'tool_call_start', payload: { toolName: 'contract.audit', arguments: { address: 'So111...' } }, evidenceIds: [], evidenceLinks: [], provider: 'solana', latencyMs: 0 },
      { sessionId: id, eventTime: new Date(base+120).toISOString(), observedAt: new Date(base+130).toISOString(), availableAt: new Date(base+130).toISOString(), type: 'tool_call_result', payload: { toolName: 'contract.audit', result: { safe: true } }, evidenceIds: ['ev_audit_1'], evidenceLinks: ['/api/v1/admin/evidence/ev_audit_1'], latencyMs: 70, provider: 'solana', cacheHit: false, quotaUnits: 1, costUsd: 0.001 },
      { sessionId: id, eventTime: new Date(base+130).toISOString(), observedAt: new Date(base+140).toISOString(), availableAt: new Date(base+140).toISOString(), type: 'evidence_created', payload: { evidenceId: 'ev_audit_1' }, evidenceIds: ['ev_audit_1'], evidenceLinks: ['/api/v1/admin/evidence/ev_audit_1'] },
    ];
    seed.forEach((e, idx) => {
      s.events.push({ id: `evt_${idx+1}`, sequence: idx, ...e });
      if (e.evidenceIds.length) s.evidenceIds.push(...e.evidenceIds);
    });
    this.nextSeq.set(id, seed.length);
    this.sessions.set(id, s);
    return s;
  }
  get(id: string): WorkbenchSession | undefined { return this.sessions.get(id); }
  list(): WorkbenchSession[] { return [...this.sessions.values()].sort((a,b)=> b.createdAt.localeCompare(a.createdAt)); }
  appendEvent(sessionId: string, input: Omit<WorkbenchEvent,'id'|'sequence'|'sessionId'>): WorkbenchEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    const seq = this.nextSeq.get(sessionId) ?? s.events.length;
    const evt: WorkbenchEvent = { id: `evt_${randomUUID().slice(0,8)}`, sessionId, sequence: seq, ...input };
    s.events.push(evt);
    // ensure event-time ordering
    s.events.sort((a,b)=> a.eventTime.localeCompare(b.eventTime) || a.sequence - b.sequence);
    // re-sequence after sort to preserve global order
    s.events.forEach((e,i)=> e.sequence = i);
    this.nextSeq.set(sessionId, s.events.length);
    if (input.evidenceIds.length) s.evidenceIds.push(...input.evidenceIds);
    s.updatedAt = this.now();
    return evt;
  }
  cancel(id: string, actor: string, reason: string): WorkbenchSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('SESSION_NOT_FOUND'), { code: 'SESSION_NOT_FOUND' });
    if (s.status === 'CANCELLED' || s.status === 'ABORTED' || s.status === 'COMPLETED') throw Object.assign(new Error('SESSION_ALREADY_TERMINAL'), { code: 'SESSION_ALREADY_TERMINAL' });
    const now = this.now();
    s.cancellation = { requestedAt: now, requestedBy: actor, reason, visible: true };
    s.status = 'CANCELLED';
    s.updatedAt = now;
    s.events.push({ id: `evt_${randomUUID().slice(0,8)}`, sessionId: id, sequence: s.events.length, eventTime: now, observedAt: now, availableAt: now, type: 'cancellation', payload: { requestedBy: actor, reason }, evidenceIds: [], evidenceLinks: [] });
    return s;
  }
  abort(id: string, reason: string, stepIndex: number | null): WorkbenchSession {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('SESSION_NOT_FOUND'), { code: 'SESSION_NOT_FOUND' });
    const now = this.now();
    s.abort = { abortedAt: now, reason, stepIndex, visible: true };
    if (s.status !== 'CANCELLED') s.status = 'ABORTED';
    s.updatedAt = now;
    s.events.push({ id: `evt_${randomUUID().slice(0,8)}`, sessionId: id, sequence: s.events.length, eventTime: now, observedAt: now, availableAt: now, type: 'abort', payload: { reason, stepIndex }, evidenceIds: [], evidenceLinks: [] });
    return s;
  }
}

class FrozenStore {
  snapshots = new Map<string, FrozenRunSnapshot>();
  now: () => string;
  constructor(now: () => string) { this.now = now; }
  reset(now: () => string) { this.snapshots.clear(); this.now = now; }
  create(runId?: string): FrozenRunSnapshot {
    const id = runId ?? `run_${randomUUID().slice(0,8)}`;
    const frozenAt = this.now();
    const snap: FrozenRunSnapshot = {
      runId: id, frozenAt, immutable: true,
      plannerEnvelope: { version: 'v1', determinismHash: createHash('sha256').update(`planner:${id}:${frozenAt}`).digest('hex'), steps: [{ stepIndex: 0, toolCalls: [{ callId: 'c1', toolName: 'dex.pairs', arguments: {} }] }, { stepIndex: 1, toolCalls: [{ callId: 'c2', toolName: 'contract.audit', arguments: {} }] }], budget: { maxSteps: 8, maxToolCalls: 12 }, seedRef: `seed_${id}` },
      validatedClaims: [{ claim: 'token has no freeze authority', evidenceIds: ['ev_1'], confidence: 'HIGH', validatedAt: frozenAt, validatorVersion: 'v1' }, { claim: 'liquidity > 10k', evidenceIds: ['ev_2'], confidence: 'MEDIUM', validatedAt: frozenAt, validatorVersion: 'v1' }],
      evidenceIds: ['ev_1','ev_2'], budgets: { modelTokens: 3200, providerCalls: 4, costUsd: 0.012, workflowSteps: 5 }, configHash: createHash('sha256').update(`config:${id}`).digest('hex'), resolvedConfig: { workflowVersion: 'wf_v1', agentProfileVersion: 'ap_v1', scheduleVersion: 'sv_1' }, reEvaluation: null,
    };
    this.snapshots.set(id, snap);
    return snap;
  }
  get(id: string): FrozenRunSnapshot | undefined { return this.snapshots.get(id); }
  reEvaluate(id: string, currentEvidenceIds: string[], currentClaims: string[]): FrozenRunSnapshot {
    const snap = this.snapshots.get(id);
    if (!snap) throw Object.assign(new Error('RUN_NOT_FOUND'), { code: 'RUN_NOT_FOUND' });
    const frozenClaims = snap.validatedClaims.map(c=>c.claim);
    const added = currentClaims.filter(c=> !frozenClaims.includes(c));
    const removed = frozenClaims.filter(c=> !currentClaims.includes(c));
    const changed: string[] = [];
    const copy: FrozenRunSnapshot = { ...snap, reEvaluation: { reEvaluatedAt: this.now(), currentClaims: currentClaims.map(c=>({ claim: c, evidenceIds: currentEvidenceIds })), diff: { added, removed, changed, evidenceDiff: { addedIds: currentEvidenceIds.filter(e=> !snap.evidenceIds.includes(e)), removedIds: snap.evidenceIds.filter(e=> !currentEvidenceIds.includes(e)) } } } };
    // do not mutate frozen — store reEvaluation as separate overlay (we replace entry with overlay for retrieval but original frozen fields stay)
    this.snapshots.set(id, copy);
    return copy;
  }
}

class CandidateRadarStore {
  candidates = new Map<string, CandidateRecord>();
  whyNot = new Map<string, WhyNotAlerted>();
  now: () => string;
  constructor(now: () => string) { this.now = now; }
  reset(now: () => string) { this.candidates.clear(); this.whyNot.clear(); this.now = now; }
  seed(): void {
    if (this.candidates.size > 0) return;
    const now = this.now();
    const recs: CandidateRecord[] = [
      { id: 'cand_1', assetId: 'sol:So1111', funnelStage: 'QUALIFIED', riskState: 'LOW', score: 0.62, scoredAt: now, promotionHistory: [{ stage: 'DISCOVERED', enteredAt: now, reason: 'FREE_AGGREGATE_DISCOVERY', evidenceIds: ['ev_disc_1'] }, { stage: 'QUALIFIED', enteredAt: now, reason: 'PASSED_DATA_QUALITY', evidenceIds: ['ev_qual_1'] }], evidenceIds: ['ev_disc_1','ev_qual_1'], gates: { dataQuality: true, security: true, execution: false, tradability: false }, createdAt: now, updatedAt: now },
      { id: 'cand_2', assetId: 'sol:TokenRisk', funnelStage: 'REJECTED', riskState: 'CRITICAL', score: null, scoredAt: null, promotionHistory: [{ stage: 'DISCOVERED', enteredAt: now, reason: 'FIRST_PARTY_EVENT', evidenceIds: ['ev_disc_2'] }], evidenceIds: ['ev_disc_2'], gates: { dataQuality: true, security: false, execution: false, tradability: false }, createdAt: now, updatedAt: now },
      { id: 'cand_3', assetId: 'sol:LowData', funnelStage: 'DISCOVERED', riskState: 'UNKNOWN', score: null, scoredAt: null, promotionHistory: [{ stage: 'DISCOVERED', enteredAt: now, reason: 'FREE_AGGREGATE_DISCOVERY', evidenceIds: [] }], evidenceIds: [], gates: { dataQuality: false, security: false, execution: false, tradability: false }, createdAt: now, updatedAt: now },
    ];
    for (const r of recs) this.candidates.set(r.id, r);
    this.whyNot.set('cand_1', { candidateId: 'cand_1', evaluatedAt: now, asOf: now, funnelStageExited: 'QUALIFIED', gatingCategory: 'GATING_REASON', gatingReason: 'EXECUTION_IMPACT_TOO_HIGH', missingEvidence: [], riskBlock: null, insufficientDataReason: null, featureValues: { liquidityUsd: 12000, priceImpactBps: 850 }, featureVersion: 'feat_v3', rankingCutoff: 0.7, agentDecision: 'ABSTAIN', policySuppressionReason: null, whatChangedAfterward: null, pointInTimeReferences: [{ referenceId: 'feat_1', availableAt: now, evidenceId: 'ev_qual_1' }], hardGate: 'EXECUTION_GATE', threshold: { maxImpactBps: 500 } });
    this.whyNot.set('cand_2', { candidateId: 'cand_2', evaluatedAt: now, asOf: now, funnelStageExited: 'DISCOVERED', gatingCategory: 'RISK_BLOCK', gatingReason: 'CRITICAL_HONEYPOT_RISK', missingEvidence: [], riskBlock: 'HONEYPOT_DETECTED', insufficientDataReason: null, featureValues: { honeypotScore: 0.95 }, featureVersion: 'feat_v3', rankingCutoff: null, agentDecision: null, policySuppressionReason: 'RISK_POLICY_BLOCK', whatChangedAfterward: null, pointInTimeReferences: [{ referenceId: 'risk_1', availableAt: now, evidenceId: 'ev_risk_2' }], hardGate: 'SECURITY_GATE', threshold: null });
    this.whyNot.set('cand_3', { candidateId: 'cand_3', evaluatedAt: now, asOf: now, funnelStageExited: 'DISCOVERED', gatingCategory: 'INSUFFICIENT_DATA', gatingReason: 'INSUFFICIENT_DATA_FOR_SCORING', missingEvidence: ['pool.liquidity','contract.audit'], riskBlock: null, insufficientDataReason: 'MIN_SAMPLE_NOT_MET', featureValues: {}, featureVersion: 'feat_v3', rankingCutoff: null, agentDecision: null, policySuppressionReason: null, whatChangedAfterward: null, pointInTimeReferences: [], hardGate: null, threshold: null });
  }
}

// global singletons keyed by deps
let workbenchStore: WorkbenchStore | null = null;
let frozenStore: FrozenStore | null = null;
let radarStore: CandidateRadarStore | null = null;
const getWorkbenchStore = (now: () => string) => { if (!workbenchStore) workbenchStore = new WorkbenchStore(now); workbenchStore.now = now; return workbenchStore; };
const getFrozenStore = (now: () => string) => { if (!frozenStore) frozenStore = new FrozenStore(now); frozenStore.now = now; return frozenStore; };
const getRadarStore = (now: () => string) => { if (!radarStore) radarStore = new CandidateRadarStore(now); radarStore.now = now; if (radarStore.candidates.size===0) radarStore.seed(); return radarStore; };

export const resetResearchWorkbenchStores = (now: () => string = () => new Date().toISOString()) => {
  if (workbenchStore) workbenchStore.reset(now); else workbenchStore = new WorkbenchStore(now);
  if (frozenStore) frozenStore.reset(now); else frozenStore = new FrozenStore(now);
  if (radarStore) radarStore.reset(now); else radarStore = new CandidateRadarStore(now);
};

// ---------------------------------------------------------------------------
// Capacity / SCC for schedule drafts (FR-ADM-008)
// ---------------------------------------------------------------------------

export interface SustainableCapacityContract {
  contractId: string; version: string; horizonDays: number; candidateLoad: Record<string, number>; providerEnvelope: Array<{ operationId: string; callsExpected: number; callsStress: number; quotaUnitsExpected: number; retryAllowance: number }>; systemEnvelope: Record<string, number>; minimumHeadroomFraction: number; degradationPolicyVersion: string; verifiedAt: string; expiresAt: string; result: 'PASS'|'FAIL'|'UNVERIFIED';
}

export interface ScheduleDraft {
  id: string; createdAt: string; createdBy: string; source: 'ADMIN_CHAT'; naturalLanguageInput: string;
  parsedSpec: { cron: string; timezone: string; workflowVersion: string; agentProfileVersion: string; toolProfileVersion: string; budgets: Record<string, unknown>; concurrency: number; targetScope: Record<string, unknown>; destination: string };
  validated: boolean; validationIssues: Array<{ code: string; message: string; field?: string }>;
  resolvedConfig: Record<string, unknown> | null; resolvedConfigHash: string | null; resolvedConfigReviewed: boolean; reviewedAt: string | null; reviewedBy: string | null;
  capacityForecast: SustainableCapacityContract | null; capacityForecastComputedAt: string | null;
  approval: { approved: boolean; approvedAt: string | null; approvedBy: string | null; reauthVerified: boolean };
  immutableVersion: { versionId: string; configHash: string; createdAt: string } | null;
  status: 'DRAFT'|'VALIDATED'|'REVIEWED'|'CAPACITY_CHECKED'|'APPROVED'|'ACTIVE';
}

class ScheduleDraftStore {
  drafts = new Map<string, ScheduleDraft>();
  now: () => string;
  constructor(now: () => string) { this.now = now; }
  reset(now: () => string) { this.drafts.clear(); this.now = now; }
  parseNaturalLanguage(input: string): ScheduleDraft['parsedSpec'] | null {
    // Minimal deterministic parser: expects keywords, otherwise fail
    const lower = input.toLowerCase();
    if (!lower.includes('schedule') && !lower.includes('run') && !lower.includes('monitor')) return null;
    // Extract cron-like or default
    return {
      cron: input.match(/\d+\s+\*\s+\*\s+\*\s+\*/)?.[0] ?? '0 * * * *',
      timezone: 'UTC',
      workflowVersion: 'wf_v1',
      agentProfileVersion: 'ap_v1',
      toolProfileVersion: 'tp_v1',
      budgets: { dailyBudgetUsd: 0.5, maxCostPerRunUsd: 0.05 },
      concurrency: 2,
      targetScope: { chains: ['solana'], narrative: 'general' },
      destination: 'workflow://research',
    };
  }
  validateSpec(spec: ScheduleDraft['parsedSpec']): Array<{ code: string; message: string; field?: string }> {
    const issues: Array<{code:string;message:string;field?:string}> = [];
    const parts = spec.cron.trim().split(/\s+/);
    if (parts.length !== 5) issues.push({ code: 'CRON_INVALID', message: 'cron must have 5 fields', field: 'cron' });
    if (!spec.workflowVersion) issues.push({ code: 'WORKFLOW_REQUIRED', message: 'workflowVersion required', field: 'workflowVersion' });
    if (!spec.toolProfileVersion) issues.push({ code: 'TOOL_PROFILE_REQUIRED', message: 'toolProfileVersion required', field: 'toolProfileVersion' });
    if (spec.concurrency <1 || spec.concurrency>32) issues.push({ code: 'CONCURRENCY_INVALID', message: 'concurrency 1..32', field: 'concurrency' });
    if (!spec.destination) issues.push({ code: 'DESTINATION_REQUIRED', message: 'destination required', field: 'destination' });
    return issues;
  }
  create(input: { naturalLanguage: string; createdBy: string }): ScheduleDraft {
    const spec = this.parseNaturalLanguage(input.naturalLanguage);
    const id = `draft_${randomUUID().slice(0,8)}`;
    const now = this.now();
    if (!spec) {
      const d: ScheduleDraft = { id, createdAt: now, createdBy: input.createdBy, source: 'ADMIN_CHAT', naturalLanguageInput: input.naturalLanguage, parsedSpec: { cron:'', timezone:'UTC', workflowVersion:'', agentProfileVersion:'', toolProfileVersion:'', budgets:{}, concurrency:0, targetScope:{}, destination:'' }, validated: false, validationIssues: [{ code:'PARSE_FAILED', message:'Unable to parse schedule from natural language', field: 'naturalLanguage' }], resolvedConfig: null, resolvedConfigHash: null, resolvedConfigReviewed: false, reviewedAt: null, reviewedBy: null, capacityForecast: null, capacityForecastComputedAt: null, approval: { approved:false, approvedAt:null, approvedBy:null, reauthVerified:false }, immutableVersion: null, status:'DRAFT' };
      this.drafts.set(id,d); return d;
    }
    const issues = this.validateSpec(spec);
    const validated = issues.length===0;
    const resolved = validated ? { systemDefaults: { mode: 'SYNTHETIC_SHADOW' }, workflowVersion: { id: spec.workflowVersion }, agentProfileVersion: { id: spec.agentProfileVersion }, scheduleVersionOverrides: { cron: spec.cron, timezone: spec.timezone, budgets: spec.budgets, concurrency: spec.concurrency, targetScope: spec.targetScope }, resolved: { cron: spec.cron, workflowVersion: spec.workflowVersion, agentProfileVersion: spec.agentProfileVersion } } : null;
    const hash = validated ? createHash('sha256').update(JSON.stringify(resolved!.resolved)).digest('hex') : null;
    const d: ScheduleDraft = { id, createdAt: now, createdBy: input.createdBy, source: 'ADMIN_CHAT', naturalLanguageInput: input.naturalLanguage, parsedSpec: spec, validated, validationIssues: issues, resolvedConfig: resolved, resolvedConfigHash: hash, resolvedConfigReviewed: false, reviewedAt: null, reviewedBy: null, capacityForecast: null, capacityForecastComputedAt: null, approval: { approved:false, approvedAt:null, approvedBy:null, reauthVerified:false }, immutableVersion: null, status: validated ? 'VALIDATED' : 'DRAFT' };
    this.drafts.set(id,d); return d;
  }
  get(id:string): ScheduleDraft | undefined { return this.drafts.get(id); }
  list(): ScheduleDraft[] { return [...this.drafts.values()]; }
  markReviewed(id:string, reviewer:string): ScheduleDraft {
    const d = this.drafts.get(id); if (!d) throw Object.assign(new Error('DRAFT_NOT_FOUND'),{code:'DRAFT_NOT_FOUND'});
    if (!d.validated) throw Object.assign(new Error('DRAFT_NOT_VALIDATED'),{code:'DRAFT_NOT_VALIDATED'});
    if (!d.resolvedConfig) throw Object.assign(new Error('RESOLVED_CONFIG_MISSING'),{code:'RESOLVED_CONFIG_MISSING'});
    d.resolvedConfigReviewed = true; d.reviewedAt = this.now(); d.reviewedBy = reviewer; d.status='REVIEWED'; return d;
  }
  computeCapacityForecast(id:string): ScheduleDraft {
    const d = this.drafts.get(id); if (!d) throw Object.assign(new Error('DRAFT_NOT_FOUND'),{code:'DRAFT_NOT_FOUND'});
    if (!d.resolvedConfigReviewed) throw Object.assign(new Error('RESOLVED_CONFIG_NOT_REVIEWED'),{code:'RESOLVED_CONFIG_NOT_REVIEWED'});
    const now = this.now();
    const horizonDays = 30;
    // deterministic PASS unless budgets exceed threshold
    const dailyBudget = Number((d.parsedSpec.budgets as Record<string,unknown>)['dailyBudgetUsd'] ?? 0.5);
    const result: 'PASS'|'FAIL' = dailyBudget <= 5 ? 'PASS' : 'FAIL';
    const contract: SustainableCapacityContract = {
      contractId: `scc_${id}`, version: 'v1', horizonDays,
      candidateLoad: { newAssetsPerDayExpected: 100, newAssetsPerDayStress: 300, cheapMonitorRowsPerDay: 1000, promotedCandidatesPerDay: 20, activeRiskCandidatesPerDay: 50, highResolutionOutcomeCasesPerDay: 5, interactiveInvestigationsPerDay: 10 },
      providerEnvelope: [{ operationId: 'dex.pairs', callsExpected: 200, callsStress: 600, quotaUnitsExpected: 200, retryAllowance: 20 }],
      systemEnvelope: { modelInputTokens: 50000, modelOutputTokens: 20000, modelSpendUsd: dailyBudget * horizonDays, workflowSteps: 1000, schedulerMessages: 720, databaseReads: 5000, databaseWrites: 2000, databaseStorageBytes: 10_000_000, objectOperations: 500, objectStorageBytes: 50_000_000, egressBytes: 10_000_000, notificationSends: 100 },
      minimumHeadroomFraction: 0.2, degradationPolicyVersion: 'v1', verifiedAt: now, expiresAt: new Date(Date.parse(now)+horizonDays*86400000).toISOString(), result,
    };
    d.capacityForecast = contract; d.capacityForecastComputedAt = now; d.status = result==='PASS' ? 'CAPACITY_CHECKED' : 'REVIEWED';
    if (result==='FAIL') throw Object.assign(new Error('CAPACITY_FORECAST_FAILED'),{code:'CAPACITY_FORECAST_FAILED', detail: contract});
    return d;
  }
  approve(id:string, actor:string, reauthVerified:boolean): ScheduleDraft {
    const d = this.drafts.get(id); if (!d) throw Object.assign(new Error('DRAFT_NOT_FOUND'),{code:'DRAFT_NOT_FOUND'});
    if (!d.capacityForecast || d.capacityForecast.result!=='PASS') throw Object.assign(new Error('CAPACITY_FORECAST_REQUIRED'),{code:'CAPACITY_FORECAST_REQUIRED'});
    if (d.capacityForecast.horizonDays <30) throw Object.assign(new Error('CAPACITY_HORIZON_INSUFFICIENT'),{code:'CAPACITY_HORIZON_INSUFFICIENT'});
    if (!reauthVerified) throw Object.assign(new Error('REAUTH_REQUIRED'),{code:'REAUTH_REQUIRED'});
    d.approval = { approved:true, approvedAt: this.now(), approvedBy: actor, reauthVerified:true }; d.status='APPROVED'; return d;
  }
  activate(id:string, actor:string, reauthVerified:boolean): ScheduleDraft {
    const d = this.drafts.get(id); if (!d) throw Object.assign(new Error('DRAFT_NOT_FOUND'),{code:'DRAFT_NOT_FOUND'});
    if (!d.validated) throw Object.assign(new Error('DRAFT_NOT_VALIDATED'),{code:'DRAFT_NOT_VALIDATED'});
    if (!d.resolvedConfigReviewed) throw Object.assign(new Error('RESOLVED_CONFIG_NOT_REVIEWED'),{code:'RESOLVED_CONFIG_NOT_REVIEWED'});
    if (!d.capacityForecast || d.capacityForecast.result!=='PASS') throw Object.assign(new Error('CAPACITY_FORECAST_REQUIRED'),{code:'CAPACITY_FORECAST_REQUIRED'});
    if (!d.approval.approved || !d.approval.reauthVerified) throw Object.assign(new Error('APPROVAL_REQUIRED'),{code:'APPROVAL_REQUIRED'});
    if (!reauthVerified) throw Object.assign(new Error('REAUTH_REQUIRED'),{code:'REAUTH_REQUIRED'});
    // second re-auth for activation
    const versionId = `schedver_${randomUUID().slice(0,8)}`;
    d.immutableVersion = { versionId, configHash: d.resolvedConfigHash!, createdAt: this.now() };
    d.status='ACTIVE';
    void actor;
    return d;
  }
}

let draftStore: ScheduleDraftStore | null = null;
const getDraftStore = (now: () => string) => { if (!draftStore) draftStore = new ScheduleDraftStore(now); draftStore.now = now; return draftStore; };
export const resetScheduleDraftStore = (now: () => string = () => new Date().toISOString()) => { if (draftStore) draftStore.reset(now); else draftStore = new ScheduleDraftStore(now); };

// ---------------------------------------------------------------------------
// Router mounting
// ---------------------------------------------------------------------------
export const createResearchWorkbenchRouter = (deps?: { now?: () => string }): OpenAPIHono<AdminEnv> => {
  const app = new OpenAPIHono<AdminEnv>();
  const nowFn = deps?.now ?? (() => new Date().toISOString());

  // --- Workbench ---
  const createSessionRoute = createRoute({
    method: 'post', path: '/api/v1/admin/agent/sessions',
    request: { body: { content: { 'application/json': { schema: z.object({ agentProfileId: z.string().min(1), modelProfileId: z.string().min(1), promptVersion: z.string().min(1), toolProfileVersion: z.string().min(1), budget: z.record(z.string(), z.unknown()).optional(), candidateId: z.string().optional() }) } } } },
    responses: { 201: { description: 'Session created', content: { 'application/json': { schema: z.object({ id: z.string(), status: z.string(), createdAt: z.string() }) } } }, 400: { description: 'Invalid', content: { 'application/json': { schema: ErrorSchema } } } },
  });
  app.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid('json');
    const store = getWorkbenchStore(nowFn);
    const s = store.create({ agentProfileId: body.agentProfileId, modelProfileId: body.modelProfileId, promptVersion: body.promptVersion, toolProfileVersion: body.toolProfileVersion, budget: body.budget });
    return c.json({ id: s.id, status: s.status, createdAt: s.createdAt, session: s }, 201);
  });

  app.get('/api/v1/admin/agent/sessions', (c) => {
    const store = getWorkbenchStore(nowFn);
    return c.json({ sessions: store.list().map(s=> ({ id: s.id, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt })) }, 200);
  });

  app.get('/api/v1/admin/agent/sessions/:id', (c) => {
    const id = c.req.param('id');
    const store = getWorkbenchStore(nowFn);
    const s = store.get(id);
    if (!s) return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    // return events sorted by eventTime + sequence
    const ordered = [...s.events].sort((a,b)=> a.eventTime.localeCompare(b.eventTime) || a.sequence - b.sequence);
    return c.json({ session: { ...s, events: ordered, toolTimeline: ordered.filter(e=> e.type.startsWith('tool_')).map(e=> ({ sequence: e.sequence, eventTime: e.eventTime, type: e.type, toolName: (e.payload as Record<string,unknown>)['toolName'] ?? e.type, evidenceIds: e.evidenceIds, evidenceLinks: e.evidenceLinks, latencyMs: e.latencyMs, provider: e.provider, cacheHit: e.cacheHit, quotaUnits: e.quotaUnits })) } }, 200);
  });

  // streaming events (SSE-like JSON array with cursor)
  app.get('/api/v1/admin/agent/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    const cursor = c.req.query('cursor');
    const store = getWorkbenchStore(nowFn);
    const s = store.get(id);
    if (!s) return c.json({ error: { code: 'SESSION_NOT_FOUND', message: `Session ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    const ordered = [...s.events].sort((a,b)=> a.eventTime.localeCompare(b.eventTime) || a.sequence - b.sequence);
    const start = cursor ? Number(cursor) : 0;
    const slice = ordered.slice(start);
    return c.json({ sessionId: id, events: slice, nextCursor: String(ordered.length), orderedBy: 'eventTime', abortVisible: s.abort !== null, cancellationVisible: s.cancellation !== null }, 200);
  });

  app.post('/api/v1/admin/agent/sessions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(()=> ({}))) as { actor?: string; reason?: string };
    const store = getWorkbenchStore(nowFn);
    try {
      const s = store.cancel(id, body.actor ?? c.req.header('x-actor') ?? 'admin', body.reason ?? 'user requested');
      return c.json({ session: s, cancelled: true }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code;
      const correlationId = c.get('correlationId');
      if (code==='SESSION_NOT_FOUND') return c.json({ error: { code, message: String((e as Error).message), correlationId } }, 404);
      if (code==='SESSION_ALREADY_TERMINAL') return c.json({ error: { code, message: 'Session already terminal', correlationId } }, 409);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String((e as Error).message), correlationId } }, 500);
    }
  });

  // For testing abort visibility
  app.post('/api/v1/admin/agent/sessions/:id/abort', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(()=> ({}))) as { reason?: string; stepIndex?: number };
    const store = getWorkbenchStore(nowFn);
    try {
      const s = store.abort(id, body.reason ?? 'deadline exceeded', body.stepIndex ?? null);
      return c.json({ session: s, aborted: true }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code;
      const correlationId = c.get('correlationId');
      if (code==='SESSION_NOT_FOUND') return c.json({ error: { code, message: String((e as Error).message), correlationId } }, 404);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String((e as Error).message), correlationId } }, 500);
    }
  });

  // Append event (for tool timeline simulation)
  app.post('/api/v1/admin/agent/sessions/:id/events', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(()=> null)) as { type?: string; eventTime?: string; payload?: Record<string, unknown>; evidenceIds?: string[] } | null;
    if (!body?.type) return c.json({ error: { code: 'INVALID_INPUT', message: 'type required', correlationId: c.get('correlationId') } }, 400);
    const store = getWorkbenchStore(nowFn);
    const now = nowFn();
    const eventTime = body.eventTime ?? now;
    const ev = store.appendEvent(id, { eventTime, observedAt: now, availableAt: now, type: body.type as WorkbenchEvent['type'], payload: body.payload ?? {}, evidenceIds: body.evidenceIds ?? [], evidenceLinks: (body.evidenceIds ?? []).map(e=> `/api/v1/admin/evidence/${e}`) });
    return c.json({ event: ev }, 201);
  });

  // --- Frozen runs ---
  app.post('/api/v1/admin/runs', async (c) => {
    const body = (await c.req.json().catch(()=> ({}))) as { runId?: string };
    const store = getFrozenStore(nowFn);
    const snap = store.create(body.runId);
    return c.json({ snapshot: snap }, 201);
  });
  app.get('/api/v1/admin/runs/:id', (c) => {
    const id = c.req.param('id');
    const store = getFrozenStore(nowFn);
    const snap = store.get(id);
    if (!snap) return c.json({ error: { code: 'RUN_NOT_FOUND', message: `Run ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    // Return immutable snapshot; reEvaluation separate
    return c.json({ snapshot: snap, frozen: true, immutable: true }, 200);
  });
  app.get('/api/v1/admin/runs/:id/investigation', (c) => {
    const id = c.req.param('id');
    const store = getFrozenStore(nowFn);
    const snap = store.get(id);
    if (!snap) return c.json({ error: { code: 'RUN_NOT_FOUND', message: `Run ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    return c.json({ investigation: { frozenSnapshot: snap, reEvaluation: snap.reEvaluation, plannerEnvelope: snap.plannerEnvelope, validatedClaims: snap.validatedClaims, evidenceIds: snap.evidenceIds, budgets: snap.budgets, configHash: snap.configHash, resolvedConfig: snap.resolvedConfig } }, 200);
  });
  app.post('/api/v1/admin/runs/:id/re-evaluate', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(()=> ({}))) as { evidenceIds?: string[]; claims?: string[] };
    const store = getFrozenStore(nowFn);
    try {
      const updated = store.reEvaluate(id, body.evidenceIds ?? ['ev_new_1'], body.claims ?? ['new claim']);
      return c.json({ snapshot: updated, reEvaluation: updated.reEvaluation }, 201);
    } catch (e) {
      const code = (e as {code?:string}).code;
      const correlationId = c.get('correlationId');
      if (code==='RUN_NOT_FOUND') return c.json({ error: { code, message: String((e as Error).message), correlationId } }, 404);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String((e as Error).message), correlationId } }, 500);
    }
  });

  // --- Candidate Radar ---
  app.get('/api/v1/admin/candidates', (c) => {
    const store = getRadarStore(nowFn);
    const funnel = c.req.query('funnelStage');
    const all = [...store.candidates.values()];
    const filtered = funnel ? all.filter(r=> r.funnelStage===funnel) : all;
    return c.json({ candidates: filtered, total: filtered.length }, 200);
  });
  app.get('/api/v1/admin/candidates/:id', (c) => {
    const id = c.req.param('id');
    const store = getRadarStore(nowFn);
    const rec = store.candidates.get(id);
    if (!rec) return c.json({ error: { code: 'CANDIDATE_NOT_FOUND', message: `Candidate ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    return c.json({ candidate: rec }, 200);
  });
  app.get('/api/v1/admin/candidates/:id/why-not-alerted', (c) => {
    const id = c.req.param('id');
    const store = getRadarStore(nowFn);
    // allow unknown candidates to return INSUFFICIENT_DATA with point-in-time refs empty
    const rec = store.candidates.get(id);
    const w = store.whyNot.get(id);
    if (w) return c.json({ whyNotAlerted: w }, 200);
    if (rec) {
      // fallback generic gating reason
      const now = nowFn();
      return c.json({ whyNotAlerted: { candidateId: id, evaluatedAt: now, asOf: now, funnelStageExited: rec.funnelStage, gatingCategory: 'INSUFFICIENT_DATA' as GatingCategory, gatingReason: 'INSUFFICIENT_DATA_UNKNOWN', missingEvidence: [], riskBlock: null, insufficientDataReason: 'NO_WHY_RECORD', featureValues: {}, featureVersion: 'feat_v3', rankingCutoff: null, agentDecision: null, policySuppressionReason: null, whatChangedAfterward: null, pointInTimeReferences: [], hardGate: null, threshold: null } }, 200);
    }
    return c.json({ error: { code: 'CANDIDATE_NOT_FOUND', message: `Candidate ${id} not found`, correlationId: c.get('correlationId') } }, 404);
  });

  // --- Admin chat schedule drafts (FR-ADM-008) ---
  const draftCreateRoute = createRoute({
    method: 'post', path: '/api/v1/admin/schedule-drafts',
    request: { body: { content: { 'application/json': { schema: z.object({ naturalLanguage: z.string().min(1), createdBy: z.string().min(1).optional() }) } } } },
    responses: { 201: { description: 'Draft created', content: { 'application/json': { schema: z.object({ id: z.string(), validated: z.boolean() }) } } }, 400: { description: 'Invalid', content: { 'application/json': { schema: ErrorSchema } } } },
  });
  app.openapi(draftCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const store = getDraftStore(nowFn);
    const draft = store.create({ naturalLanguage: body.naturalLanguage, createdBy: body.createdBy ?? c.req.header('x-actor') ?? 'admin-chat' });
    // Only validated drafts are creatable does not mean failure: return 201 even if validated false but mark issues
    // However spec says admin chat creates only validated schedule draft — reject invalid as 422
    if (!draft.validated) {
      return c.json({ error: { code: 'DRAFT_VALIDATION_FAILED', message: draft.validationIssues.map(i=>i.message).join('; '), correlationId: c.get('correlationId'), issues: draft.validationIssues, draft } } as unknown as Record<string,unknown>, 422);
    }
    return c.json({ id: draft.id, validated: draft.validated, draft }, 201);
  });

  app.get('/api/v1/admin/schedule-drafts', (c) => {
    const store = getDraftStore(nowFn);
    return c.json({ drafts: store.list() }, 200);
  });
  app.get('/api/v1/admin/schedule-drafts/:id', (c) => {
    const id = c.req.param('id');
    const store = getDraftStore(nowFn);
    const d = store.get(id);
    if (!d) return c.json({ error: { code: 'DRAFT_NOT_FOUND', message: `Draft ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    return c.json({ draft: d }, 200);
  });
  app.get('/api/v1/admin/schedule-drafts/:id/resolved-config', (c) => {
    const id = c.req.param('id');
    const store = getDraftStore(nowFn);
    const d = store.get(id);
    if (!d) return c.json({ error: { code: 'DRAFT_NOT_FOUND', message: `Draft ${id} not found`, correlationId: c.get('correlationId') } }, 404);
    if (!d.resolvedConfig) return c.json({ error: { code: 'RESOLVED_CONFIG_MISSING', message: 'Resolved config not available', correlationId: c.get('correlationId') } }, 404);
    return c.json({ resolvedConfig: d.resolvedConfig, configHash: d.resolvedConfigHash, reviewed: d.resolvedConfigReviewed }, 200);
  });
  app.post('/api/v1/admin/schedule-drafts/:id/review', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(()=> ({}))) as { reviewer?: string };
    const store = getDraftStore(nowFn);
    try {
      const d = store.markReviewed(id, body.reviewer ?? c.req.header('x-actor') ?? 'admin');
      return c.json({ draft: d }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code ?? 'INTERNAL_ERROR';
      const status = code==='DRAFT_NOT_FOUND'?404 : code==='DRAFT_NOT_VALIDATED'?422 : 400;
      return c.json({ error: { code, message: String((e as Error).message), correlationId: c.get('correlationId') } }, status as 400);
    }
  });
  app.post('/api/v1/admin/schedule-drafts/:id/capacity-forecast', async (c) => {
    const id = c.req.param('id');
    const store = getDraftStore(nowFn);
    try {
      const d = store.computeCapacityForecast(id);
      return c.json({ draft: d, forecast: d.capacityForecast }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code ?? 'INTERNAL_ERROR';
      const correlationId = c.get('correlationId');
      const detail = (e as {detail?: unknown}).detail;
      if (code==='CAPACITY_FORECAST_FAILED') return c.json({ error: { code, message: 'Capacity forecast failed: horizon or headroom not met', correlationId, forecast: detail } }, 422);
      const status = code==='DRAFT_NOT_FOUND'?404 : 400;
      return c.json({ error: { code, message: String((e as Error).message), correlationId } }, status as 400);
    }
  });
  app.post('/api/v1/admin/schedule-drafts/:id/approve', async (c) => {
    const id = c.req.param('id');
    const headers: Record<string,string|undefined> = {
      'x-reauth-verified': c.req.header('x-reauth-verified'),
      'x-step-up-verified': c.req.header('x-step-up-verified'),
      'x-reauth-token': c.req.header('x-reauth-token'),
      'x-step-up-token': c.req.header('x-step-up-token'),
      'x-passkey-token': c.req.header('x-passkey-token'),
      authorization: c.req.header('authorization'),
    };
    const reauth = isReauthVerified(headers);
    const body = (await c.req.json().catch(()=> ({}))) as { actor?: string };
    const store = getDraftStore(nowFn);
    try {
      const d = store.approve(id, body.actor ?? c.req.header('x-actor') ?? 'admin', reauth);
      return c.json({ draft: d, approved: true }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code ?? 'INTERNAL_ERROR';
      const correlationId = c.get('correlationId');
      if (code==='REAUTH_REQUIRED') return c.json({ error: { code, message: 'Explicit approval requires re-authentication', correlationId } }, 401);
      const status = code==='DRAFT_NOT_FOUND'?404 : 400;
      return c.json({ error: { code, message: String((e as Error).message), correlationId } }, status as 400);
    }
  });
  app.post('/api/v1/admin/schedule-drafts/:id/activate', async (c) => {
    const id = c.req.param('id');
    const headers: Record<string,string|undefined> = {
      'x-reauth-verified': c.req.header('x-reauth-verified'),
      'x-step-up-verified': c.req.header('x-step-up-verified'),
      'x-reauth-token': c.req.header('x-reauth-token'),
      'x-step-up-token': c.req.header('x-step-up-token'),
      'x-passkey-token': c.req.header('x-passkey-token'),
      authorization: c.req.header('authorization'),
    };
    const reauth = isReauthVerified(headers);
    const body = (await c.req.json().catch(()=> ({}))) as { actor?: string };
    const store = getDraftStore(nowFn);
    try {
      const d = store.activate(id, body.actor ?? c.req.header('x-actor') ?? 'admin', reauth);
      return c.json({ draft: d, activated: true, version: d.immutableVersion }, 200);
    } catch (e) {
      const code = (e as {code?:string}).code ?? 'INTERNAL_ERROR';
      const correlationId = c.get('correlationId');
      if (code==='REAUTH_REQUIRED') return c.json({ error: { code, message: 'Activation requires re-authentication', correlationId } }, 401);
      const status = code==='DRAFT_NOT_FOUND'?404 : 422;
      return c.json({ error: { code, message: String((e as Error).message), correlationId } }, status as 400);
    }
  });

  // Evidence stub (for links)
  app.get('/api/v1/admin/evidence/:id', (c) => {
    const id = c.req.param('id');
    return c.json({ evidenceId: id, availableAt: nowFn(), fetchedAt: nowFn(), provenance: 'synthetic', quality: 'VALID', links: { self: `/api/v1/admin/evidence/${id}` } }, 200);
  });
  app.get('/api/v1/admin/resources/:id', (c) => {
    const id = c.req.param('id');
    return c.json({ resourceId: id, evidenceRef: id, fetchedAt: nowFn() }, 200);
  });

  return app;
};
