import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '@ciag/provider-contracts';
import type { DegradedResult } from '@ciag/domain';

// ---------------------------------------------------------------------------
// Lightweight production scheduler adapter (QStash-backed) placeholder
// ---------------------------------------------------------------------------

import type { SchedulerAdapter } from '@ciag/provider-contracts';

export class DisabledProductionScheduler implements SchedulerAdapter {
  async schedule(): Promise<DegradedResult<{ triggerId: string }>> {
    return { status: 'NOT_AVAILABLE', capabilityMode: 'SYNTHETIC_SHADOW', reason: 'BOOTSTRAP_SCHEDULER_DISABLED' };
  }
  async cancel(): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// Scheduling Control Plane — FR-WF-004 / FR-WF-005 / FR-ADM-003
// ---------------------------------------------------------------------------

export type ScheduleState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DEGRADED' | 'DISABLED' | 'DELETED';
export type ConfigLifecycle = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'ACTIVE' | 'DEPRECATED' | 'ROLLED_BACK';

export interface ScheduleVersion {
  id: string;
  scheduleId: string;
  version: number;
  cron: string;
  timezone: string;
  workflowVersion: string;
  agentProfileVersion: string;
  toolProfileVersion: string;
  modelProfileVersion?: string | null | undefined;
  promptVersion?: string | null | undefined;
  outcomeProfileId?: string | null | undefined;
  rankingPolicyId?: string | null | undefined;
  alertPolicyId?: string | null | undefined;
  budgets: Record<string, unknown>;
  concurrency: number;
  destination: string;
  externalId?: string | null | undefined;
  targetScope: Record<string, unknown>;
  lifecycle: ConfigLifecycle;
  configHash: string;
  createdAt: string;
  createdBy: string;
}

export interface Schedule {
  id: string;
  name: string;
  description?: string | null | undefined;
  state: ScheduleState;
  currentVersionId?: string | null | undefined;
  currentVersionNumber?: number | null | undefined;
  externalScheduleId?: string | null | undefined;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedConfig {
  systemDefaults: Record<string, unknown>;
  workflowVersion: Record<string, unknown>;
  agentProfileVersion: Record<string, unknown>;
  scheduleVersionOverrides: Record<string, unknown>;
  explicitRunNowOverrides?: Record<string, unknown> | null | undefined;
  resolved: Record<string, unknown>;
  configHash: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string | undefined;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  costForecast?: {
    estimatedRunsPerDay: number;
    estimatedCostPerDay: number;
    sustainable: boolean;
    constraints?: string[] | undefined;
  } | undefined;
}

export interface ReconciliationIncident {
  type: 'MISSING_EXTERNAL' | 'ORPHAN_EXTERNAL' | 'CRON_MISMATCH' | 'TIMEZONE_MISMATCH' | 'PAUSED_MISMATCH' | 'DESTINATION_MISMATCH' | 'EXTERNAL_ID_MISMATCH';
  scheduleId?: string | undefined;
  externalScheduleId?: string | undefined;
  detail: string;
}

export interface ReconciliationResult {
  incidents: ReconciliationIncident[];
  repaired: number;
}

// Scheduler external view (QStash-like)
export interface ExternalSchedule {
  externalId: string;
  cron: string;
  timezone: string;
  paused: boolean;
  destination: string;
  scheduleId?: string | null | undefined;
}

export interface ExternalSchedulerReader {
  list(): Promise<ExternalSchedule[]>;
}

export interface ExternalSchedulerWriter extends ExternalSchedulerReader {
  create(schedule: { scheduleId: string; cron: string; timezone: string; destination: string }): Promise<{ externalId: string }>;
  update(externalId: string, patch: Partial<Pick<ExternalSchedule, 'cron' | 'timezone' | 'paused' | 'destination'>>): Promise<void>;
  remove(externalId: string): Promise<void>;
  setPaused(externalId: string, paused: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_SCHEDULE_TRANSITIONS: Record<ScheduleState, ScheduleState[]> = {
  DRAFT: ['ACTIVE', 'DISABLED'],
  ACTIVE: ['PAUSED', 'DEGRADED', 'DISABLED'],
  PAUSED: ['ACTIVE', 'DISABLED'],
  DEGRADED: ['ACTIVE', 'PAUSED', 'DISABLED'],
  DISABLED: ['DELETED'],
  DELETED: [],
};

const ALLOWED_CONFIG_TRANSITIONS: Record<ConfigLifecycle, ConfigLifecycle[]> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['APPROVED', 'DRAFT'],
  APPROVED: ['ACTIVE', 'DRAFT'],
  ACTIVE: ['DEPRECATED', 'ROLLED_BACK'],
  DEPRECATED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
};

export const canTransitionSchedule = (from: ScheduleState, to: ScheduleState): boolean =>
  (ALLOWED_SCHEDULE_TRANSITIONS[from] ?? []).includes(to);

export const canTransitionConfig = (from: ConfigLifecycle, to: ConfigLifecycle): boolean =>
  (ALLOWED_CONFIG_TRANSITIONS[from] ?? []).includes(to);

export const hashValue = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

export const hashConfig = (config: Record<string, unknown>): string => hashValue(JSON.stringify(config, Object.keys(config as object).sort()));

const CRON_PART_RE = /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/;

export const validateCron = (cron: string): ValidationIssue | null => {
  const trimmed = cron.trim();
  if (trimmed.length === 0) return { code: 'CRON_REQUIRED', message: 'cron is required', field: 'cron' };
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { code: 'CRON_INVALID', message: 'cron must have 5 fields (minute hour dom month dow)', field: 'cron' };
  for (const part of parts) {
    if (!CRON_PART_RE.test(part)) return { code: 'CRON_INVALID', message: `cron part invalid: ${part}`, field: 'cron' };
  }
  // Basic range checks via split and numeric validation
  const ranges: [number, number][] = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  for (let i=0;i<5;i++) {
    const p = parts[i]!;
    if (p === '*') continue;
    if (p.startsWith('*/')) continue;
    const segments = p.split(',');
    for (const seg of segments) {
      const dash = seg.split('-');
      for (const numStr of dash) {
        const n = Number(numStr);
        if (!Number.isInteger(n) || n < ranges[i]![0] || n > ranges[i]![1]) return { code: 'CRON_INVALID', message: `cron field ${i} out of range: ${seg}`, field: 'cron' };
      }
    }
  }
  return null;
};

export const validateTimezone = (tz: string): ValidationIssue | null => {
  if (!tz || tz.trim().length === 0) return { code: 'TIMEZONE_REQUIRED', message: 'timezone is required', field: 'timezone' };
  try {
    // Intl check for any IANA timezone; fallback to allowlist if Intl unavailable
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    return { code: 'TIMEZONE_INVALID', message: `invalid timezone: ${tz}`, field: 'timezone' };
  }
  return null;
};

export const resolveConfigPrecedence = (input: {
  systemDefaults: Record<string, unknown>;
  workflowVersion: Record<string, unknown>;
  agentProfileVersion: Record<string, unknown>;
  scheduleVersionOverrides: Record<string, unknown>;
  explicitRunNowOverrides?: Record<string, unknown> | null;
}): ResolvedConfig => {
  const resolved: Record<string, unknown> = {
    ...input.systemDefaults,
    ...input.workflowVersion,
    ...input.agentProfileVersion,
    ...input.scheduleVersionOverrides,
    ...(input.explicitRunNowOverrides ?? {}),
  };
  const configHash = hashConfig(resolved);
  return {
    systemDefaults: input.systemDefaults,
    workflowVersion: input.workflowVersion,
    agentProfileVersion: input.agentProfileVersion,
    scheduleVersionOverrides: input.scheduleVersionOverrides,
    explicitRunNowOverrides: input.explicitRunNowOverrides ?? null,
    resolved,
    configHash,
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateScheduleInput {
  version: Pick<ScheduleVersion, 'cron' | 'timezone' | 'workflowVersion' | 'agentProfileVersion' | 'toolProfileVersion' | 'budgets' | 'concurrency' | 'destination'>;
  versionExists?: ((kind: 'workflow' | 'agentProfile' | 'toolProfile' | 'modelProfile' | 'prompt' | 'outcomeProfile' | 'rankingPolicy' | 'alertPolicy', id: string) => Promise<{ exists: boolean; lifecycle?: string | undefined }>) | undefined;
  budgetCheck?: ((budgets: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string | undefined }>) | undefined;
  concurrencyCheck?: ((concurrency: number) => { ok: boolean; reason?: string | undefined }) | undefined;
  costForecast?: ((version: ValidateScheduleInput['version']) => Promise<{ sustainable: boolean; estimatedRunsPerDay: number; estimatedCostPerDay: number; constraints?: string[] | undefined }>) | undefined;
}

export const validateScheduleVersion = async (input: ValidateScheduleInput): Promise<ValidationResult> => {
  const issues: ValidationIssue[] = [];

  const cronIssue = validateCron(input.version.cron);
  if (cronIssue) issues.push(cronIssue);

  const tzIssue = validateTimezone(input.version.timezone);
  if (tzIssue) issues.push(tzIssue);

  // workflow/profile/policy versions must exist and not be deprecated/retired
  if (input.versionExists) {
    const checks: Array<[string, string, string]> = [
      ['workflow', input.version.workflowVersion, 'workflowVersion'],
      ['agentProfile', input.version.agentProfileVersion, 'agentProfileVersion'],
      ['toolProfile', input.version.toolProfileVersion, 'toolProfileVersion'],
    ];
    for (const [kind, id, field] of checks) {
      if (!id || (typeof id === 'string' && id.trim().length === 0)) {
        issues.push({ code: 'VERSION_REQUIRED', message: `${field} is required`, field });
        continue;
      }
      const result = await input.versionExists(kind as never, id);
      if (!result.exists) issues.push({ code: 'VERSION_NOT_FOUND', message: `${kind} version not found: ${id}`, field });
      else if (result.lifecycle === 'DEPRECATED' || result.lifecycle === 'RETIRED' || result.lifecycle === 'ROLLED_BACK') {
        issues.push({ code: 'VERSION_DEPRECATED', message: `${kind} version is deprecated: ${id}`, field });
      }
    }
  }

  if (!input.version.destination || input.version.destination.trim().length === 0) {
    issues.push({ code: 'DESTINATION_REQUIRED', message: 'destination is required', field: 'destination' });
  }

  if (!Number.isInteger(input.version.concurrency) || input.version.concurrency < 1 || input.version.concurrency > 32) {
    issues.push({ code: 'CONCURRENCY_INVALID', message: 'concurrency must be integer 1..32', field: 'concurrency' });
  } else if (input.concurrencyCheck) {
    const cc = input.concurrencyCheck(input.version.concurrency);
    if (!cc.ok) issues.push({ code: 'CONCURRENCY_REJECTED', message: cc.reason ?? 'concurrency rejected', field: 'concurrency' });
  }

  if (input.budgetCheck) {
    const bc = await input.budgetCheck(input.version.budgets as Record<string, unknown>);
    if (!bc.ok) issues.push({ code: 'BUDGET_REJECTED', message: bc.reason ?? 'budget rejected', field: 'budgets' });
  } else {
    // default budget sanity: must be object with at least dailyBudget or maxCostPerRun
    if (typeof input.version.budgets !== 'object' || input.version.budgets === null || Array.isArray(input.version.budgets)) {
      issues.push({ code: 'BUDGET_INVALID', message: 'budgets must be an object', field: 'budgets' });
    }
  }

  let costForecast: ValidationResult['costForecast'];
  if (input.costForecast) {
    costForecast = await input.costForecast(input.version);
    if (!costForecast.sustainable) {
      issues.push({ code: 'COST_FORECAST_EXCEEDED', message: `cost forecast not sustainable: ${(costForecast.constraints ?? []).join(', ') || 'exceeds budget'}`, field: 'budgets' });
    }
  }

  if (costForecast === undefined) return { valid: issues.length === 0, issues };
  return { valid: issues.length === 0, issues, costForecast };
};

// ---------------------------------------------------------------------------
// In-memory service (used for tests and as domain logic); DB-backed variant delegates to adapter
// ---------------------------------------------------------------------------

export interface ScheduleStore {
  getSchedule(id: string): Promise<Schedule | null>;
  listSchedules(): Promise<Schedule[]>;
  putSchedule(schedule: Schedule): Promise<void>;
  getVersion(id: string): Promise<ScheduleVersion | null>;
  listVersions(scheduleId: string): Promise<ScheduleVersion[]>;
  putVersion(version: ScheduleVersion): Promise<void>;
  getActiveVersion(scheduleId: string): Promise<ScheduleVersion | null>;
  createIncident(incident: { type: string; scheduleId?: string | undefined; externalScheduleId?: string | undefined; detail: string; createdAt: string }): Promise<void>;
  listIncidents(): Promise<Array<{ type: string; scheduleId?: string | undefined; externalScheduleId?: string | undefined; detail: string; createdAt: string }>>;
}

export class InMemoryScheduleStore implements ScheduleStore {
  readonly schedules = new Map<string, Schedule>();
  readonly versions = new Map<string, ScheduleVersion>();
  readonly incidents: Array<{ type: string; scheduleId?: string | undefined; externalScheduleId?: string | undefined; detail: string; createdAt: string }> = [];

  async getSchedule(id: string): Promise<Schedule | null> { return this.schedules.get(id) ?? null; }
  async listSchedules(): Promise<Schedule[]> { return [...this.schedules.values()]; }
  async putSchedule(schedule: Schedule): Promise<void> { this.schedules.set(schedule.id, { ...schedule }); }
  async getVersion(id: string): Promise<ScheduleVersion | null> { return this.versions.get(id) ?? null; }
  async listVersions(scheduleId: string): Promise<ScheduleVersion[]> { return [...this.versions.values()].filter(v => v.scheduleId === scheduleId).sort((a,b)=>a.version-b.version); }
  async putVersion(version: ScheduleVersion): Promise<void> { this.versions.set(version.id, { ...version }); }
  async getActiveVersion(scheduleId: string): Promise<ScheduleVersion | null> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule?.currentVersionId) return null;
    return this.versions.get(schedule.currentVersionId) ?? null;
  }
  async createIncident(incident: { type: string; scheduleId?: string | undefined; externalScheduleId?: string | undefined; detail: string; createdAt: string }): Promise<void> { this.incidents.push({ ...incident }); }
  async listIncidents(): Promise<Array<{ type: string; scheduleId?: string | undefined; externalScheduleId?: string | undefined; detail: string; createdAt: string }>> { return [...this.incidents]; }
}

export interface SchedulerServiceDeps {
  store: ScheduleStore;
  externalScheduler?: ExternalSchedulerWriter | null | undefined;
  now?: (() => string) | undefined;
  idGenerator?: (() => string) | undefined;
  versionExists?: ValidateScheduleInput['versionExists'] | undefined;
  budgetCheck?: ValidateScheduleInput['budgetCheck'] | undefined;
  concurrencyCheck?: ValidateScheduleInput['concurrencyCheck'] | undefined;
  costForecast?: ValidateScheduleInput['costForecast'] | undefined;
  // resolved config registries for precedence demo
  systemDefaults?: Record<string, unknown> | undefined;
  workflowRegistry?: Map<string, Record<string, unknown>> | undefined;
  agentProfileRegistry?: Map<string, Record<string, unknown>> | undefined;
}

export class SchedulerService {
  private readonly nowFn: () => string;
  private readonly idGen: () => string;
  constructor(private readonly deps: SchedulerServiceDeps) {
    this.nowFn = deps.now ?? (() => new Date().toISOString());
    this.idGen = deps.idGenerator ?? (() => randomUUID());
  }

  private async nextVersionNumber(scheduleId: string): Promise<number> {
    const versions = await this.deps.store.listVersions(scheduleId);
    return versions.length === 0 ? 1 : Math.max(...versions.map(v=>v.version)) + 1;
  }

  // CREATE
  async create(input: {
    name: string; description?: string | null | undefined;
    cron: string; timezone: string;
    workflowVersion: string; agentProfileVersion: string; toolProfileVersion: string;
    modelProfileVersion?: string | null | undefined; promptVersion?: string | null | undefined;
    outcomeProfileId?: string | null | undefined; rankingPolicyId?: string | null | undefined; alertPolicyId?: string | null | undefined;
    budgets: Record<string, unknown>; concurrency: number;
    destination: string; targetScope?: Record<string, unknown> | undefined;
    createdBy?: string | undefined;
  }): Promise<{ schedule: Schedule; version: ScheduleVersion }> {
    if (!input.name || input.name.trim().length === 0) throw new Error('SCHEDULE_NAME_REQUIRED');
    const cronIssue = validateCron(input.cron);
    if (cronIssue) throw new Error(cronIssue.code);
    const tzIssue = validateTimezone(input.timezone);
    if (tzIssue) throw new Error(tzIssue.code);

    const scheduleId = this.idGen();
    const versionId = this.idGen();
    const now = this.nowFn();
    const configHash = hashConfig({ cron: input.cron, timezone: input.timezone, workflowVersion: input.workflowVersion, agentProfileVersion: input.agentProfileVersion, toolProfileVersion: input.toolProfileVersion, budgets: input.budgets, concurrency: input.concurrency, destination: input.destination, targetScope: input.targetScope });

    const version: ScheduleVersion = {
      id: versionId, scheduleId, version: 1,
      cron: input.cron, timezone: input.timezone,
      workflowVersion: input.workflowVersion, agentProfileVersion: input.agentProfileVersion, toolProfileVersion: input.toolProfileVersion,
      modelProfileVersion: input.modelProfileVersion ?? null, promptVersion: input.promptVersion ?? null,
      outcomeProfileId: input.outcomeProfileId ?? null, rankingPolicyId: input.rankingPolicyId ?? null, alertPolicyId: input.alertPolicyId ?? null,
      budgets: input.budgets, concurrency: input.concurrency,
      destination: input.destination, externalId: null,
      targetScope: input.targetScope ?? {},
      lifecycle: 'DRAFT',
      configHash, createdAt: now, createdBy: input.createdBy ?? 'system',
    };
    const schedule: Schedule = {
      id: scheduleId, name: input.name, description: input.description ?? null,
      state: 'DRAFT', currentVersionId: versionId, currentVersionNumber: 1,
      externalScheduleId: null, paused: false,
      createdAt: now, updatedAt: now,
    };
    await this.deps.store.putVersion(version);
    await this.deps.store.putSchedule(schedule);
    return { schedule, version };
  }

  // EDIT_DRAFT — creates new immutable version; only allowed in DRAFT
  async editDraft(scheduleId: string, patch: Partial<Pick<ScheduleVersion, 'cron' | 'timezone' | 'workflowVersion' | 'agentProfileVersion' | 'toolProfileVersion' | 'budgets' | 'concurrency' | 'destination' | 'targetScope'>> & { name?: string | undefined; description?: string | null | undefined }, actor?: string | undefined): Promise<{ schedule: Schedule; version: ScheduleVersion }> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'DRAFT') throw new Error('EDIT_ONLY_IN_DRAFT');
    const current = await this.deps.store.getActiveVersion(scheduleId);
    if (!current) throw new Error('VERSION_NOT_FOUND');

    const nextVersionNum = await this.nextVersionNumber(scheduleId);
    const versionId = this.idGen();
    const now = this.nowFn();
    const merged: ScheduleVersion = {
      ...current,
      id: versionId,
      version: nextVersionNum,
      cron: patch.cron ?? current.cron,
      timezone: patch.timezone ?? current.timezone,
      workflowVersion: patch.workflowVersion ?? current.workflowVersion,
      agentProfileVersion: patch.agentProfileVersion ?? current.agentProfileVersion,
      toolProfileVersion: patch.toolProfileVersion ?? current.toolProfileVersion,
      budgets: (patch.budgets ?? current.budgets) as Record<string, unknown>,
      concurrency: patch.concurrency ?? current.concurrency,
      destination: patch.destination ?? current.destination,
      targetScope: (patch.targetScope ?? current.targetScope) as Record<string, unknown>,
      lifecycle: 'DRAFT',
      configHash: hashConfig({ cron: patch.cron ?? current.cron, timezone: patch.timezone ?? current.timezone, workflowVersion: patch.workflowVersion ?? current.workflowVersion }),
      createdAt: now,
      createdBy: actor ?? 'system',
    };
    // Preserve prior immutable versions; update schedule pointer to new version
    await this.deps.store.putVersion(merged);
    const updatedSchedule: Schedule = {
      ...schedule,
      name: patch.name ?? schedule.name,
      description: patch.description !== undefined ? patch.description : schedule.description,
      currentVersionId: versionId,
      currentVersionNumber: nextVersionNum,
      updatedAt: now,
    };
    await this.deps.store.putSchedule(updatedSchedule);
    return { schedule: updatedSchedule, version: merged };
  }

  // VALIDATE
  async validate(scheduleId: string): Promise<ValidationResult> {
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');
    const result = await validateScheduleVersion({
      version,
      versionExists: this.deps.versionExists,
      budgetCheck: this.deps.budgetCheck,
      concurrencyCheck: this.deps.concurrencyCheck,
      costForecast: this.deps.costForecast,
    });
    if (result.valid) {
      // transition lifecycle DRAFT->VALIDATED if applicable
      if (version.lifecycle === 'DRAFT') {
        const updated: ScheduleVersion = { ...version, lifecycle: 'VALIDATED' };
        await this.deps.store.putVersion(updated);
      }
    }
    return result;
  }

  // ENABLE — validates then moves DRAFT->ACTIVE and creates external schedule
  async enable(scheduleId: string): Promise<{ schedule: Schedule; version: ScheduleVersion }> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'DRAFT') throw new Error('ENABLE_ONLY_FROM_DRAFT');
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');

    const validation = await validateScheduleVersion({
      version,
      versionExists: this.deps.versionExists,
      budgetCheck: this.deps.budgetCheck,
      concurrencyCheck: this.deps.concurrencyCheck,
      costForecast: this.deps.costForecast,
    });
    if (!validation.valid) throw new Error(`VALIDATION_FAILED:${validation.issues.map(i=>i.code).join(',')}`);

    // lifecycle VALIDATED->APPROVED->ACTIVE
    let lifecycle: ConfigLifecycle = version.lifecycle;
    if (lifecycle === 'DRAFT') lifecycle = 'VALIDATED';
    if (lifecycle === 'VALIDATED') lifecycle = 'APPROVED';
    if (lifecycle === 'APPROVED') lifecycle = 'ACTIVE';

    const updatedVersion: ScheduleVersion = { ...version, lifecycle };
    await this.deps.store.putVersion(updatedVersion);

    let externalId: string | null = schedule.externalScheduleId ?? null;
    if (this.deps.externalScheduler) {
      const created = await this.deps.externalScheduler.create({ scheduleId, cron: version.cron, timezone: version.timezone, destination: version.destination });
      externalId = created.externalId;
    }

    const now = this.nowFn();
    const updatedSchedule: Schedule = { ...schedule, state: 'ACTIVE', externalScheduleId: externalId, paused: false, updatedAt: now, currentVersionId: updatedVersion.id };
    await this.deps.store.putSchedule(updatedSchedule);
    return { schedule: updatedSchedule, version: updatedVersion };
  }

  // PAUSE
  async pause(scheduleId: string): Promise<Schedule> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'ACTIVE' && schedule.state !== 'DEGRADED') throw new Error('PAUSE_ONLY_FROM_ACTIVE_OR_DEGRADED');
    if (this.deps.externalScheduler && schedule.externalScheduleId) {
      await this.deps.externalScheduler.setPaused(schedule.externalScheduleId, true);
    }
    const updated: Schedule = { ...schedule, state: 'PAUSED', paused: true, updatedAt: this.nowFn() };
    await this.deps.store.putSchedule(updated);
    return updated;
  }

  // RESUME
  async resume(scheduleId: string): Promise<Schedule> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'PAUSED') throw new Error('RESUME_ONLY_FROM_PAUSED');
    if (this.deps.externalScheduler && schedule.externalScheduleId) {
      await this.deps.externalScheduler.setPaused(schedule.externalScheduleId, false);
    }
    const updated: Schedule = { ...schedule, state: 'ACTIVE', paused: false, updatedAt: this.nowFn() };
    await this.deps.store.putSchedule(updated);
    return updated;
  }

  // RUN_NOW — active runs retain resolved version (returns resolved config snapshot)
  async runNow(scheduleId: string, overrides?: Record<string, unknown>): Promise<{ schedule: Schedule; resolvedConfig: ResolvedConfig; runId: string }> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'ACTIVE' && schedule.state !== 'PAUSED' && schedule.state !== 'DEGRADED') throw new Error('RUN_NOW_ONLY_WHEN_ACTIVE_OR_PAUSED');
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');

    const systemDefaults = this.deps.systemDefaults ?? {};
    const workflowVersion = this.deps.workflowRegistry?.get(version.workflowVersion) ?? {};
    const agentProfileVersion = this.deps.agentProfileRegistry?.get(version.agentProfileVersion) ?? {};
    const scheduleOverrides: Record<string, unknown> = { cron: version.cron, timezone: version.timezone, destination: version.destination, budgets: version.budgets, concurrency: version.concurrency, ...version.targetScope };

    const resolved = resolveConfigPrecedence({
      systemDefaults,
      workflowVersion,
      agentProfileVersion,
      scheduleVersionOverrides: scheduleOverrides,
      explicitRunNowOverrides: overrides ?? null,
    });

    // runId is durable workflow run identifier; retains resolved version hash
    const runId = `run-${hashValue(`${scheduleId}:${version.id}:${resolved.configHash}:${this.nowFn()}`).slice(0,16)}`;
    return { schedule, resolvedConfig: resolved, runId };
  }

  // DRY_RUN — validates and simulates without external side effects
  async dryRun(scheduleId: string, overrides?: Record<string, unknown>): Promise<{ validation: ValidationResult; resolvedConfig: ResolvedConfig; forecast?: ValidationResult['costForecast'] }> {
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');
    const validation = await validateScheduleVersion({
      version: { ...version, ...(overrides as Partial<ScheduleVersion> ?? {}) } as ValidateScheduleInput['version'],
      versionExists: this.deps.versionExists,
      budgetCheck: this.deps.budgetCheck,
      concurrencyCheck: this.deps.concurrencyCheck,
      costForecast: this.deps.costForecast,
    });
    const systemDefaults = this.deps.systemDefaults ?? {};
    const workflowVersion = this.deps.workflowRegistry?.get(version.workflowVersion) ?? {};
    const agentProfileVersion = this.deps.agentProfileRegistry?.get(version.agentProfileVersion) ?? {};
    const resolved = resolveConfigPrecedence({
      systemDefaults, workflowVersion, agentProfileVersion,
      scheduleVersionOverrides: { cron: version.cron, timezone: version.timezone, destination: version.destination, budgets: version.budgets, concurrency: version.concurrency, ...version.targetScope },
      explicitRunNowOverrides: overrides ?? null,
    });
    return { validation, resolvedConfig: resolved, forecast: validation.costForecast };
  }

  // DUPLICATE — clones as new DRAFT schedule with new immutable version
  async duplicate(scheduleId: string, newName?: string): Promise<{ schedule: Schedule; version: ScheduleVersion }> {
    const original = await this.deps.store.getSchedule(scheduleId);
    if (!original) throw new Error('SCHEDULE_NOT_FOUND');
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');
    const now = this.nowFn();
    const newScheduleId = this.idGen();
    const newVersionId = this.idGen();
    const newVersion: ScheduleVersion = {
      ...version,
      id: newVersionId, scheduleId: newScheduleId, version: 1,
      lifecycle: 'DRAFT',
      createdAt: now, createdBy: 'system',
    };
    const newSchedule: Schedule = {
      id: newScheduleId, name: newName ?? `${original.name} (copy)`, description: original.description,
      state: 'DRAFT', currentVersionId: newVersionId, currentVersionNumber: 1,
      externalScheduleId: null, paused: false,
      createdAt: now, updatedAt: now,
    };
    await this.deps.store.putVersion(newVersion);
    await this.deps.store.putSchedule(newSchedule);
    return { schedule: newSchedule, version: newVersion };
  }

  // DISABLE
  async disable(scheduleId: string): Promise<Schedule> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state === 'DISABLED' || schedule.state === 'DELETED') throw new Error('ALREADY_DISABLED_OR_DELETED');
    if (!['DRAFT','ACTIVE','PAUSED','DEGRADED'].includes(schedule.state)) throw new Error('DISABLE_NOT_ALLOWED_FROM_STATE');
    if (this.deps.externalScheduler && schedule.externalScheduleId) {
      await this.deps.externalScheduler.remove(schedule.externalScheduleId);
    }
    // mark current version as DEPRECATED if it was ACTIVE
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (version && version.lifecycle === 'ACTIVE') {
      await this.deps.store.putVersion({ ...version, lifecycle: 'DEPRECATED' });
    }
    const updated: Schedule = { ...schedule, state: 'DISABLED', paused: false, externalScheduleId: null, updatedAt: this.nowFn() };
    await this.deps.store.putSchedule(updated);
    return updated;
  }

  // DELETE — only from DISABLED, tombstone
  async delete(scheduleId: string): Promise<Schedule> {
    const schedule = await this.deps.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('SCHEDULE_NOT_FOUND');
    if (schedule.state !== 'DISABLED') throw new Error('DELETE_ONLY_FROM_DISABLED');
    const updated: Schedule = { ...schedule, state: 'DELETED', updatedAt: this.nowFn() };
    await this.deps.store.putSchedule(updated);
    return updated;
  }

  // Resolved config for a schedule (without run-now overrides)
  async getResolvedConfig(scheduleId: string): Promise<ResolvedConfig> {
    const version = await this.deps.store.getActiveVersion(scheduleId);
    if (!version) throw new Error('VERSION_NOT_FOUND');
    const systemDefaults = this.deps.systemDefaults ?? {};
    const workflowVersion = this.deps.workflowRegistry?.get(version.workflowVersion) ?? {};
    const agentProfileVersion = this.deps.agentProfileRegistry?.get(version.agentProfileVersion) ?? {};
    return resolveConfigPrecedence({
      systemDefaults, workflowVersion, agentProfileVersion,
      scheduleVersionOverrides: { cron: version.cron, timezone: version.timezone, destination: version.destination, budgets: version.budgets, concurrency: version.concurrency, ...version.targetScope },
    });
  }

  // List versions (immutable history)
  async listVersions(scheduleId: string): Promise<ScheduleVersion[]> {
    return this.deps.store.listVersions(scheduleId);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export const reconcileSchedules = async (input: {
  store: ScheduleStore;
  externalReader: ExternalSchedulerReader;
  repair?: boolean;
  externalWriter?: ExternalSchedulerWriter;
  now?: () => string;
}): Promise<ReconciliationResult> => {
  const now = input.now ?? (() => new Date().toISOString());
  const dbSchedules = (await input.store.listSchedules()).filter(s => s.state === 'ACTIVE' || s.state === 'PAUSED');
  const external = await input.externalReader.list();

  const dbByExternal = new Map<string, Schedule>();
  const dbById = new Map<string, Schedule>();
  for (const s of dbSchedules) {
    dbById.set(s.id, s);
    if (s.externalScheduleId) dbByExternal.set(s.externalScheduleId, s);
  }
  const extByExternal = new Map<string, ExternalSchedule>();
  const extBySchedule = new Map<string, ExternalSchedule>();
  for (const e of external) {
    extByExternal.set(e.externalId, e);
    if (e.scheduleId) extBySchedule.set(e.scheduleId, e);
  }

  const incidents: ReconciliationIncident[] = [];
  let repaired = 0;

  // For each active DB schedule, check external exists and fields match
  for (const db of dbSchedules) {
    const version = await input.store.getActiveVersion(db.id);
    if (!version) continue;

    const extId = db.externalScheduleId;
    const ext = extId ? extByExternal.get(extId) : extBySchedule.get(db.id) ?? null;

    if (!ext) {
      const incident: ReconciliationIncident = { type: 'MISSING_EXTERNAL', scheduleId: db.id, externalScheduleId: extId ?? undefined, detail: `active DB schedule ${db.id} missing in QStash` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
      if (input.repair && input.externalWriter) {
        const created = await input.externalWriter.create({ scheduleId: db.id, cron: version.cron, timezone: version.timezone, destination: version.destination });
        // update DB external id
        const updated: Schedule = { ...db, externalScheduleId: created.externalId, updatedAt: now() };
        await input.store.putSchedule(updated);
        repaired++;
      }
      continue;
    }

    // Compare fields
    if (ext.cron !== version.cron) {
      const incident: ReconciliationIncident = { type: 'CRON_MISMATCH', scheduleId: db.id, externalScheduleId: ext.externalId, detail: `cron mismatch db=${version.cron} external=${ext.cron}` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
      if (input.repair && input.externalWriter) { await input.externalWriter.update(ext.externalId, { cron: version.cron }); repaired++; }
    }
    if (ext.timezone !== version.timezone) {
      const incident: ReconciliationIncident = { type: 'TIMEZONE_MISMATCH', scheduleId: db.id, externalScheduleId: ext.externalId, detail: `timezone mismatch db=${version.timezone} external=${ext.timezone}` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
      if (input.repair && input.externalWriter) { await input.externalWriter.update(ext.externalId, { timezone: version.timezone }); repaired++; }
    }
    const dbPaused = db.state === 'PAUSED';
    if (ext.paused !== dbPaused) {
      const incident: ReconciliationIncident = { type: 'PAUSED_MISMATCH', scheduleId: db.id, externalScheduleId: ext.externalId, detail: `paused mismatch db=${dbPaused} external=${ext.paused}` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
      if (input.repair && input.externalWriter) { await input.externalWriter.setPaused(ext.externalId, dbPaused); repaired++; }
    }
    if (ext.destination !== version.destination) {
      const incident: ReconciliationIncident = { type: 'DESTINATION_MISMATCH', scheduleId: db.id, externalScheduleId: ext.externalId, detail: `destination mismatch db=${version.destination} external=${ext.destination}` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
      if (input.repair && input.externalWriter) { await input.externalWriter.update(ext.externalId, { destination: version.destination }); repaired++; }
    }
    if (ext.scheduleId && ext.scheduleId !== db.id) {
      const incident: ReconciliationIncident = { type: 'EXTERNAL_ID_MISMATCH', scheduleId: db.id, externalScheduleId: ext.externalId, detail: `externalId schedule mismatch db=${db.id} external.scheduleId=${ext.scheduleId}` };
      incidents.push(incident);
      await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
    }
  }

  // Orphan externals (external exists but no active DB schedule)
  for (const ext of external) {
    const linked = ext.scheduleId ? dbById.get(ext.scheduleId) : (ext.externalId ? dbByExternal.get(ext.externalId) : undefined);
    const hasActiveDb = linked && (linked.state === 'ACTIVE' || linked.state === 'PAUSED');
    if (!hasActiveDb) {
      // Check if any DB schedule claims this externalId
      const claimed = [...dbByExternal.values()].some(s => s.externalScheduleId === ext.externalId);
      if (!claimed && !ext.scheduleId) {
        // Only report if truly orphan (no DB references it)
        const isOrphan = !dbByExternal.has(ext.externalId) && !ext.scheduleId;
        if (isOrphan) {
          const incident: ReconciliationIncident = { type: 'ORPHAN_EXTERNAL', externalScheduleId: ext.externalId, detail: `orphan QStash schedule ${ext.externalId} with no active DB schedule` };
          incidents.push(incident);
          await input.store.createIncident({ type: incident.type, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
          if (input.repair && input.externalWriter) { await input.externalWriter.remove(ext.externalId); repaired++; }
        }
      } else if (ext.scheduleId && !hasActiveDb) {
        const incident: ReconciliationIncident = { type: 'ORPHAN_EXTERNAL', scheduleId: ext.scheduleId, externalScheduleId: ext.externalId, detail: `QStash schedule ${ext.externalId} references inactive/missing DB schedule ${ext.scheduleId}` };
        incidents.push(incident);
        await input.store.createIncident({ type: incident.type, scheduleId: incident.scheduleId, externalScheduleId: incident.externalScheduleId, detail: incident.detail, createdAt: now() });
        if (input.repair && input.externalWriter) { await input.externalWriter.remove(ext.externalId); repaired++; }
      }
    }
  }

  return { incidents, repaired };
};

// ---------------------------------------------------------------------------
// Database-backed store (uses DatabaseAdapter)
// ---------------------------------------------------------------------------

export class DatabaseScheduleStore implements ScheduleStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async getSchedule(id: string): Promise<Schedule | null> {
    const result = await this.db.query<Schedule & Record<string, unknown>>('SELECT id, name, description, state, current_version_id as "currentVersionId", current_version_number as "currentVersionNumber", external_schedule_id as "externalScheduleId", paused, created_at as "createdAt", updated_at as "updatedAt" FROM schedules WHERE id=$1', [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as unknown as Schedule;
    // Normalize timestamp fields to ISO strings
    return { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) } as Schedule;
  }

  async listSchedules(): Promise<Schedule[]> {
    const result = await this.db.query<Record<string, unknown>>('SELECT id, name, description, state, current_version_id as "currentVersionId", current_version_number as "currentVersionNumber", external_schedule_id as "externalScheduleId", paused, created_at as "createdAt", updated_at as "updatedAt" FROM schedules WHERE state != \'DELETED\' ORDER BY created_at');
    return result.rows.map(r => ({ ...r, createdAt: toIso((r as unknown as Schedule).createdAt), updatedAt: toIso((r as unknown as Schedule).updatedAt) } as unknown as Schedule));
  }

  async putSchedule(schedule: Schedule): Promise<void> {
    await this.db.query(
      `INSERT INTO schedules (id, name, description, state, current_version_id, current_version_number, external_schedule_id, paused, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, state=EXCLUDED.state, current_version_id=EXCLUDED.current_version_id, current_version_number=EXCLUDED.current_version_number, external_schedule_id=EXCLUDED.external_schedule_id, paused=EXCLUDED.paused, updated_at=EXCLUDED.updated_at`,
      [schedule.id, schedule.name, schedule.description ?? null, schedule.state, schedule.currentVersionId ?? null, schedule.currentVersionNumber ?? null, schedule.externalScheduleId ?? null, schedule.paused, schedule.createdAt, schedule.updatedAt],
    );
  }

  async getVersion(id: string): Promise<ScheduleVersion | null> {
    const result = await this.db.query<Record<string, unknown>>('SELECT id, schedule_id as "scheduleId", version, cron, timezone, workflow_version as "workflowVersion", agent_profile_version as "agentProfileVersion", tool_profile_version as "toolProfileVersion", model_profile_version as "modelProfileVersion", prompt_version as "promptVersion", outcome_profile_id as "outcomeProfileId", ranking_policy_id as "rankingPolicyId", alert_policy_id as "alertPolicyId", budgets, concurrency, destination, external_id as "externalId", target_scope as "targetScope", lifecycle, config_hash as "configHash", created_at as "createdAt", created_by as "createdBy" FROM schedule_versions WHERE id=$1', [id]);
    if (result.rows.length === 0) return null;
    const r = result.rows[0] as unknown as ScheduleVersion;
    return { ...r, budgets: parseJson(r.budgets), targetScope: parseJson(r.targetScope), createdAt: toIso(r.createdAt) } as ScheduleVersion;
  }

  async listVersions(scheduleId: string): Promise<ScheduleVersion[]> {
    const result = await this.db.query<Record<string, unknown>>('SELECT id, schedule_id as "scheduleId", version, cron, timezone, workflow_version as "workflowVersion", agent_profile_version as "agentProfileVersion", tool_profile_version as "toolProfileVersion", model_profile_version as "modelProfileVersion", prompt_version as "promptVersion", outcome_profile_id as "outcomeProfileId", ranking_policy_id as "rankingPolicyId", alert_policy_id as "alertPolicyId", budgets, concurrency, destination, external_id as "externalId", target_scope as "targetScope", lifecycle, config_hash as "configHash", created_at as "createdAt", created_by as "createdBy" FROM schedule_versions WHERE schedule_id=$1 ORDER BY version', [scheduleId]);
    return result.rows.map(r => {
      const v = r as unknown as ScheduleVersion;
      return { ...v, budgets: parseJson(v.budgets), targetScope: parseJson(v.targetScope), createdAt: toIso(v.createdAt) } as ScheduleVersion;
    });
  }

  async putVersion(version: ScheduleVersion): Promise<void> {
    await this.db.query(
      `INSERT INTO schedule_versions (id, schedule_id, version, cron, timezone, workflow_version, agent_profile_version, tool_profile_version, model_profile_version, prompt_version, outcome_profile_id, ranking_policy_id, alert_policy_id, budgets, concurrency, destination, external_id, target_scope, lifecycle, config_hash, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle, config_hash=EXCLUDED.config_hash`,
      [version.id, version.scheduleId, version.version, version.cron, version.timezone, version.workflowVersion, version.agentProfileVersion, version.toolProfileVersion, version.modelProfileVersion ?? null, version.promptVersion ?? null, version.outcomeProfileId ?? null, version.rankingPolicyId ?? null, version.alertPolicyId ?? null, JSON.stringify(version.budgets), version.concurrency, version.destination, version.externalId ?? null, JSON.stringify(version.targetScope), version.lifecycle, version.configHash, version.createdAt, version.createdBy],
    );
  }

  async getActiveVersion(scheduleId: string): Promise<ScheduleVersion | null> {
    const schedule = await this.getSchedule(scheduleId);
    if (!schedule?.currentVersionId) return null;
    return this.getVersion(schedule.currentVersionId);
  }

  async createIncident(incident: { type: string; scheduleId?: string; externalScheduleId?: string; detail: string; createdAt: string }): Promise<void> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO schedule_incidents (id, type, schedule_id, external_schedule_id, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, incident.type, incident.scheduleId ?? null, incident.externalScheduleId ?? null, incident.detail, incident.createdAt],
    );
  }

  async listIncidents(): Promise<Array<{ type: string; scheduleId?: string; externalScheduleId?: string; detail: string; createdAt: string }>> {
    const result = await this.db.query<Record<string, unknown>>('SELECT type, schedule_id as "scheduleId", external_schedule_id as "externalScheduleId", detail, created_at as "createdAt" FROM schedule_incidents ORDER BY created_at');
    return result.rows.map(r => ({ type: r.type as string, scheduleId: r.scheduleId as string | undefined ?? undefined, externalScheduleId: r.externalScheduleId as string | undefined ?? undefined, detail: r.detail as string, createdAt: toIso(r.createdAt as string) }));
  }
}

const toIso = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};
const parseJson = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') try { return JSON.parse(value); } catch { return {}; }
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  return {};
};

// Re-export for convenience
export { InMemoryScheduleStore as FakeScheduleStore };
