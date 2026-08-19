import { describe, it, expect } from 'vitest';
import { MemoryPostgresAdapter, VirtualClock } from '@ciag/test-fixtures';
import { applyBootstrapMigration } from '@ciag/persistence';
import {
  insertTriggerInbox,
  handleTriggerInboxRequest,
  createWorkflowRun,
  createWorkflowStep,
  getWorkflowSteps,
  resumeFromCheckpoint,
  acquireLease,
  commitStepWithFencing,
  classifyRetry,
  recordStepFailure,
  listDeadLetters,
  retryDeadLetterFromCheckpoint,
} from '@ciag/workflow-runtime';
import { createApp } from '../../apps/api/src/app.js';

describe('durable workflow core — FR-WF-001/002/003/007', () => {
  it('trigger inbox canonicalizes external_message_id and is idempotent (202)', async () => {
    const db = new MemoryPostgresAdapter();
    await applyBootstrapMigration(db);
    const clock = new VirtualClock();
    const r1 = await insertTriggerInbox(db, {
      source: 'qstash',
      externalMessageId: 'msg-123 ',
      payloadHash: 'abc',
      receivedAt: clock.now(),
    });
    expect(r1.inserted).toBe(true);
    const r2 = await insertTriggerInbox(db, {
      source: 'qstash',
      externalMessageId: ' msg-123',
      payloadHash: 'abc',
      receivedAt: clock.now(),
    });
    expect(r2.isDuplicate).toBe(true);
    expect(r2.inboxId).toBe(r1.inboxId);
    const t1 = await handleTriggerInboxRequest(db, {
      source: 'qstash',
      externalMessageId: 'msg-xyz',
      scheduleId: 'sched-1',
      payload: { a: 1 },
      receivedAt: clock.now(),
    });
    expect(t1.status).toBe(202);
    const t2 = await handleTriggerInboxRequest(db, {
      source: 'qstash',
      externalMessageId: 'msg-xyz',
      scheduleId: 'sched-1',
      payload: { a: 1 },
      receivedAt: clock.now(),
    });
    expect(t2.isDuplicate).toBe(true);
    expect(t2.runId).toBe(t1.runId);
    const runs = await db.query<{ c: string }>('SELECT count(*)::text as c FROM workflow_runs');
    expect(runs.rows[0]?.c).toBe('1');
  });

  it('workflow steps persist required fields and resume from last checkpoint after crash', async () => {
    const db = new MemoryPostgresAdapter();
    await applyBootstrapMigration(db);
    const clock = new VirtualClock();
    const runId = 'run-test-1';
    await createWorkflowRun(db, { id: runId, workflowName: 'discovery', now: clock.now() });
    await createWorkflowStep(db, {
      stepId: `${runId}--step-001`,
      runId,
      stepType: 'discover',
      idempotencyKey: `${runId}:discover`,
      inputHash: 'h1',
      now: clock.now(),
    });
    await createWorkflowStep(db, {
      stepId: `${runId}--step-002`,
      runId,
      stepType: 'rank',
      idempotencyKey: `${runId}:rank`,
      inputHash: 'h2',
      now: clock.now(),
    });
    // Simulate crash after first step completed
    await db.query(`UPDATE workflow_steps SET status='COMPLETED', output_hash='out1', completed_at=$1 WHERE step_id=$2`, [
      clock.now(),
      `${runId}--step-001`,
    ]);
    const resume = await resumeFromCheckpoint(db, runId);
    expect(resume.completed.length).toBe(1);
    expect(resume.next?.step_id).toBe(`${runId}--step-002`);
    // Verify persisted columns
    const steps = await getWorkflowSteps(db, runId);
    for (const s of steps) {
      expect(s.step_id).toBeDefined();
      expect(s.run_id).toBe(runId);
      expect(s.idempotency_key).toBeDefined();
      expect(s.input_hash).toBeDefined();
      // lease fields exist (may be null)
      expect(Object.prototype.hasOwnProperty.call(s, 'lease_owner')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(s, 'lease_version')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(s, 'lease_expires_at')).toBe(true);
    }
  });

  it('lease acquisition uses monotonically increasing fencing token; stale commit rejected', async () => {
    const db = new MemoryPostgresAdapter();
    await applyBootstrapMigration(db);
    const clock = new VirtualClock();
    const l1 = await acquireLease(db, 'lease-run-1', 'worker-a', 60000, clock.now());
    expect(l1.acquired).toBe(true);
    expect(l1.version).toBe(1);
    const l2 = await acquireLease(db, 'lease-run-1', 'worker-b', 60000, clock.now());
    expect(l2.acquired).toBe(false);
    clock.advance(61_000);
    const l3 = await acquireLease(db, 'lease-run-1', 'worker-b', 60000, clock.now());
    expect(l3.acquired).toBe(true);
    expect(l3.version).toBe(2);
    const runId = 'run-lease-test';
    await createWorkflowRun(db, { id: runId, workflowName: 'discovery', now: clock.now() });
    await createWorkflowStep(db, {
      stepId: `${runId}--step-001`,
      runId,
      stepType: 'fetch',
      idempotencyKey: `${runId}:fetch`,
      inputHash: 'h',
      now: clock.now(),
    });
    await db.query(`UPDATE workflow_steps SET lease_owner='worker-a', lease_version=1 WHERE step_id=$1`, [
      `${runId}--step-001`,
    ]);
    await db.query(`UPDATE workflow_steps SET lease_owner='worker-b', lease_version=2 WHERE step_id=$1`, [
      `${runId}--step-001`,
    ]);
    const stale = await commitStepWithFencing(db, `${runId}--step-001`, 'worker-a', 1, 'out-hash', clock.now());
    expect(stale.committed).toBe(false);
    expect(stale.stale).toBe(true);
    const fresh = await commitStepWithFencing(db, `${runId}--step-001`, 'worker-b', 2, 'out-hash', clock.now());
    expect(fresh.committed).toBe(true);
  });

  it('retry taxonomy: no retry for auth/invalid, bounded 5xx/timeout, single repair for model format, requeue for serialization conflict', () => {
    expect(classifyRetry('AUTH_ERROR', 0).retryable).toBe(false);
    expect(classifyRetry('INVALID_INPUT', 0).retryable).toBe(false);
    expect(classifyRetry('HTTP_5XX', 0).retryable).toBe(true);
    expect(classifyRetry('HTTP_5XX', 0).maxAttempts).toBe(5);
    expect(classifyRetry('TIMEOUT', 0).retryable).toBe(true);
    expect(classifyRetry('MODEL_FORMAT_ERROR', 0).retryable).toBe(true);
    expect(classifyRetry('MODEL_FORMAT_ERROR', 1).retryable).toBe(false);
    expect(classifyRetry('SERIALIZATION_CONFLICT', 0).retryable).toBe(true);
    expect(classifyRetry('SCHEMA_DRIFT', 0).retryable).toBe(false);
    expect(classifyRetry('BUDGET_EXCEEDED', 0).retryable).toBe(false);
  });

  it('exhausted steps transition to DEAD_LETTERED with error_class, retryable flag and admin retry from checkpoint', async () => {
    const db = new MemoryPostgresAdapter();
    await applyBootstrapMigration(db);
    const clock = new VirtualClock();
    const runId = 'run-dl-1';
    await createWorkflowRun(db, { id: runId, workflowName: 'discovery', now: clock.now() });
    await createWorkflowStep(db, {
      stepId: `${runId}--step-001`,
      runId,
      stepType: 'fetch',
      idempotencyKey: `${runId}:fetch`,
      inputHash: 'h',
      now: clock.now(),
    });
    for (let i = 0; i < 5; i++) {
      await recordStepFailure(db, `${runId}--step-001`, 'HTTP_5XX', 'server error', clock.now());
      clock.advance(1000);
    }
    const steps = await getWorkflowSteps(db, runId);
    expect(steps[0]?.status).toBe('DEAD_LETTERED');
    expect(steps[0]?.error_class).toBe('HTTP_5XX');
    expect(steps[0]?.retryable).toBe(false);
    const dls = await listDeadLetters(db, runId);
    expect(dls.length).toBe(1);
    expect(dls[0]?.error_class).toBe('HTTP_5XX');
    expect(dls[0]?.retryable).toBe(false);
    const retry = await retryDeadLetterFromCheckpoint(db, dls[0]!.id, clock.now());
    expect(retry.retried).toBe(true);
    const steps2 = await getWorkflowSteps(db, runId);
    expect(steps2[0]?.status).toBe('PENDING');
  });

  it('API returns 202 without duplicate workflow creation for duplicate external_message_id', async () => {
    const db = new MemoryPostgresAdapter();
    await applyBootstrapMigration(db);
    const clock = new VirtualClock();
    const app = createApp({
      allowedOrigins: ['https://allowed.example'],
      dependencies: [],
      now: () => clock.now(),
      database: db as unknown as { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> },
    });
    const resp1 = await app.request('/api/v1/internal/schedules/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ external_message_id: 'api-msg-1', source: 'qstash', payload: { x: 1 } }),
    });
    expect(resp1.status).toBe(202);
    const j1 = (await resp1.json()) as { isDuplicate: boolean; runId: string };
    expect(j1.isDuplicate).toBe(false);
    const resp2 = await app.request('/api/v1/internal/schedules/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ external_message_id: 'api-msg-1', source: 'qstash', payload: { x: 1 } }),
    });
    expect(resp2.status).toBe(202);
    const j2 = (await resp2.json()) as { isDuplicate: boolean; runId: string };
    expect(j2.isDuplicate).toBe(true);
    expect(j2.runId).toBe(j1.runId);
  });
});
