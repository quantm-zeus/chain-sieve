import { describe, expect, it } from 'vitest';
import {
  InMemoryScheduleStore,
  SchedulerService,
  reconcileSchedules,
  resolveConfigPrecedence,
  validateCron,
  validateTimezone,
  validateScheduleVersion,
} from '../../packages/scheduler/src/index.js';

describe('Scheduling Control Plane (FR-WF-004, FR-WF-005, FR-ADM-003)', () => {
  it('validates cron and timezone formats strictly', () => {
    expect(validateCron('* * * * *')).toBeNull();
    expect(validateCron('*/5 * * * *')).toBeNull();
    expect(validateCron('0 0 1 1 0')).toBeNull();
    expect(validateCron('')?.code).toBe('CRON_REQUIRED');
    expect(validateCron('* * * *')?.code).toBe('CRON_INVALID');
    expect(validateCron('60 * * * *')?.code).toBe('CRON_INVALID');

    expect(validateTimezone('UTC')).toBeNull();
    expect(validateTimezone('America/New_York')).toBeNull();
    expect(validateTimezone('')?.code).toBe('TIMEZONE_REQUIRED');
    expect(validateTimezone('Invalid/Zone')?.code).toBe('TIMEZONE_INVALID');
  });

  it('implements full schedule lifecycle: CREATE, EDIT_DRAFT, VALIDATE, ENABLE, PAUSE, RESUME, RUN_NOW, DRY_RUN, DUPLICATE, DISABLE, DELETE', async () => {
    const store = new InMemoryScheduleStore();
    const service = new SchedulerService({
      store,
      systemDefaults: { maxConcurrency: 10, defaultTimeout: 300 },
      workflowRegistry: new Map([['wf-v1', { stepTimeout: 60 }]]),
      agentProfileRegistry: new Map([['agent-v1', { model: 'gpt-4o' }]]),
      versionExists: async () => ({ exists: true, lifecycle: 'ACTIVE' }),
      budgetCheck: async () => ({ ok: true }),
      concurrencyCheck: () => ({ ok: true }),
      costForecast: async () => ({ sustainable: true, estimatedRunsPerDay: 24, estimatedCostPerDay: 0.2 }),
    });

    // 1. CREATE
    const { schedule, version } = await service.create({
      name: 'Alpha Scan',
      cron: '0 * * * *',
      timezone: 'UTC',
      workflowVersion: 'wf-v1',
      agentProfileVersion: 'agent-v1',
      toolProfileVersion: 'tool-v1',
      budgets: { dailyMax: 10 },
      concurrency: 2,
      destination: 'https://internal.local/workflow',
    });
    expect(schedule.state).toBe('DRAFT');
    expect(version.lifecycle).toBe('DRAFT');
    expect(version.version).toBe(1);

    // 2. EDIT_DRAFT — creates immutable version 2
    const edited = await service.editDraft(schedule.id, { cron: '*/30 * * * *' });
    expect(edited.version.version).toBe(2);
    expect(edited.version.cron).toBe('*/30 * * * *');
    const allVersions = await service.listVersions(schedule.id);
    expect(allVersions).toHaveLength(2);

    // 3. VALIDATE
    const validation = await service.validate(schedule.id);
    expect(validation.valid).toBe(true);
    expect((await store.getActiveVersion(schedule.id))?.lifecycle).toBe('VALIDATED');

    // 4. ENABLE
    const enabled = await service.enable(schedule.id);
    expect(enabled.schedule.state).toBe('ACTIVE');
    expect(enabled.version.lifecycle).toBe('ACTIVE');

    // 5. PAUSE
    const paused = await service.pause(schedule.id);
    expect(paused.state).toBe('PAUSED');
    expect(paused.paused).toBe(true);

    // 6. RESUME
    const resumed = await service.resume(schedule.id);
    expect(resumed.state).toBe('ACTIVE');
    expect(resumed.paused).toBe(false);

    // 7. RUN_NOW — retains resolved version snapshot
    const run = await service.runNow(schedule.id, { temporaryBoost: true });
    expect(run.runId).toMatch(/^run-[a-f0-9]{16}$/);
    expect(run.resolvedConfig.resolved).toMatchObject({
      maxConcurrency: 10,
      stepTimeout: 60,
      model: 'gpt-4o',
      temporaryBoost: true,
    });

    // 8. DRY_RUN — validates without modifying schedule state
    const dry = await service.dryRun(schedule.id);
    expect(dry.validation.valid).toBe(true);
    expect(dry.resolvedConfig.configHash).toBeTruthy();

    // 9. DUPLICATE — creates independent DRAFT clone
    const dup = await service.duplicate(schedule.id, 'Alpha Scan Clone');
    expect(dup.schedule.id).not.toBe(schedule.id);
    expect(dup.schedule.state).toBe('DRAFT');
    expect(dup.version.version).toBe(1);

    // 10. DISABLE
    const disabled = await service.disable(schedule.id);
    expect(disabled.state).toBe('DISABLED');

    // 11. DELETE
    const deleted = await service.delete(schedule.id);
    expect(deleted.state).toBe('DELETED');
  });

  it('evaluates configuration precedence correctly', () => {
    const resolved = resolveConfigPrecedence({
      systemDefaults: { level: 'system', timeout: 30, concurrency: 1 },
      workflowVersion: { level: 'workflow', timeout: 60 },
      agentProfileVersion: { level: 'agent', temperature: 0.7 },
      scheduleVersionOverrides: { level: 'schedule', concurrency: 4 },
      explicitRunNowOverrides: { level: 'runNow' },
    });
    expect(resolved.resolved).toEqual({
      level: 'runNow',
      timeout: 60,
      concurrency: 4,
      temperature: 0.7,
    });
    expect(resolved.configHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reconciles active database schedules with external QStash state and repairs discrepancies', async () => {
    const store = new InMemoryScheduleStore();
    const service = new SchedulerService({
      store,
      versionExists: async () => ({ exists: true, lifecycle: 'ACTIVE' }),
      budgetCheck: async () => ({ ok: true }),
      concurrencyCheck: () => ({ ok: true }),
      costForecast: async () => ({ sustainable: true, estimatedRunsPerDay: 24, estimatedCostPerDay: 0.2 }),
    });

    const { schedule } = await service.create({
      name: 'Reconciliation Test',
      cron: '0 * * * *',
      timezone: 'UTC',
      workflowVersion: 'wf-1',
      agentProfileVersion: 'ap-1',
      toolProfileVersion: 'tp-1',
      budgets: { max: 1 },
      concurrency: 1,
      destination: 'https://dest.local',
    });
    await service.enable(schedule.id);

    const externalState = new Map([
      ['ext-orphan', { externalId: 'ext-orphan', cron: '* * * * *', timezone: 'UTC', paused: false, destination: 'https://other.local', scheduleId: null }],
    ]);

    const externalReader = {
      list: async () => [...externalState.values()],
    };
    const externalWriter = {
      ...externalReader,
      create: async (s: { scheduleId: string; cron: string; timezone: string; destination: string }) => {
        const externalId = `ext-${s.scheduleId}`;
        externalState.set(externalId, { externalId, cron: s.cron, timezone: s.timezone, paused: false, destination: s.destination, scheduleId: s.scheduleId });
        return { externalId };
      },
      update: async (id: string, patch: any) => {
        const cur = externalState.get(id);
        if (cur) externalState.set(id, { ...cur, ...patch });
      },
      remove: async (id: string) => { externalState.delete(id); },
      setPaused: async (id: string, paused: boolean) => {
        const cur = externalState.get(id);
        if (cur) externalState.set(id, { ...cur, paused });
      },
    };

    // First reconciliation without repair
    const report1 = await reconcileSchedules({ store, externalReader, repair: false });
    expect(report1.incidents.length).toBeGreaterThan(0);
    expect(report1.repaired).toBe(0);

    // Second reconciliation with repair
    const report2 = await reconcileSchedules({ store, externalReader, externalWriter, repair: true });
    expect(report2.repaired).toBeGreaterThan(0);

    // Third reconciliation: all in sync
    const report3 = await reconcileSchedules({ store, externalReader });
    expect(report3.incidents).toHaveLength(0);
  });
});
