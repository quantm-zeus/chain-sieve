import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import {
  assertEvidenceCurrent,
  invalidateRebaseEvidence,
  registerCurrentEvidence,
} from '../../tools/task-runner/evidence-ledger.js';
import {
  transition,
  type EvidenceReference,
  type TaskState,
} from '../../tools/task-runner/state.js';
import { validateTaskAttestation } from '../../tools/task-verifier/attestation.js';
import { runtimeRoot } from '../../tools/task-runner/state.js';
import { deriveLifecycleVerdict } from '../../tools/merge-queue/lifecycle-manifest.js';
import { createAttestationFixture } from './attestation-fixture.js';
import { validLifecycleManifest } from './git-lifecycle.spec.js';

const current = (name: string, commit = '1'.repeat(40), tree = '2'.repeat(40)): EvidenceReference => ({
  path: `${name}.json`,
  sha256: sha256(name),
  status: 'CURRENT',
  commit,
  tree,
});

describe('lifecycle attestation regressions', () => {
  it.each([
    ['DRAFT', 'LIFECYCLE_REQUIRED_STATE_MISSING:DRAFT'],
    ['VALIDATED', 'LIFECYCLE_REQUIRED_STATE_MISSING:VALIDATED'],
  ])('rejects a lifecycle missing %s', (state, reason) => {
    const manifest = validLifecycleManifest();
    manifest.scenarios[0]!.stateTransitionsObserved = manifest.scenarios[0]!.stateTransitionsObserved.filter(
      (item) => item !== state,
    );
    expect(() => deriveLifecycleVerdict(manifest)).toThrow(reason);
  });

  it('rejects a lifecycle that omits lease renewal', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'B')!.leaseVersions = [1];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LEASE_RENEWAL_NOT_OBSERVED');
  });

  it('rejects a lifecycle that accepts the old lease after renewal', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'B')!.commandsExecuted = [];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('OLD_LEASE_REJECTION_NOT_OBSERVED');
  });

  it('rejects a simulation that bypasses the real merge queue', () => {
    const manifest = validLifecycleManifest();
    manifest.harness = 'production-lifecycle';
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'D')!.queueOperations = [];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('REAL_POST_REBASE_TASK_VERIFY_MISSING');
  });

  it('marks and rejects pre-rebase self-review, task-result and verification evidence', async () => {
    const fixture = await createAttestationFixture();
    try {
      const state: TaskState = {
        ...fixture.state,
        state: 'MERGE_QUEUED',
        selfReviewEvidence: current('review', fixture.head, fixture.result.bindings.headTreeSha),
        taskResultEvidence: current('result', fixture.head, fixture.result.bindings.headTreeSha),
        verificationEvidence: current('verification', fixture.head, fixture.result.bindings.headTreeSha),
      };
      await registerCurrentEvidence(fixture.task.id, 'SELF_REVIEW', state.selfReviewEvidence!, fixture.root);
      await registerCurrentEvidence(fixture.task.id, 'TASK_RESULT', state.taskResultEvidence!, fixture.root);
      await registerCurrentEvidence(fixture.task.id, 'VERIFICATION', state.verificationEvidence!, fixture.root);
      const old = structuredClone(state);
      await invalidateRebaseEvidence(state, fixture.root, new Date('2026-07-28T00:00:00Z'));
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'SELF_REVIEW', old.selfReviewEvidence!, fixture.root),
      ).rejects.toThrow('STALE_SELF_REVIEW_EVIDENCE');
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'TASK_RESULT', old.taskResultEvidence!, fixture.root),
      ).rejects.toThrow('STALE_TASK_RESULT_EVIDENCE');
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'VERIFICATION', old.verificationEvidence!, fixture.root),
      ).rejects.toThrow('STALE_VERIFICATION_EVIDENCE');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a post-rebase review bound to the wrong commit', () => {
    const target: TaskState = {
      taskId: 'T',
      state: 'SELF_REVIEWING',
      leaseVersion: 1,
      holder: 'worker',
      leaseId: 'T:1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    expect(() =>
      transition(target, ['SELF_REVIEWING'], 'VERIFYING', {
        command: 'task:verify',
        credential: { taskId: 'T', holder: 'worker', leaseId: 'T:1', fencingVersion: 1 },
        evidence: current('review', '1'.repeat(40), '2'.repeat(40)),
        currentCommit: '3'.repeat(40),
        currentTree: '2'.repeat(40),
      }),
    ).toThrow('SELF_REVIEW_BINDING_MISMATCH');
  });

  it('rejects a post-rebase result bound to the wrong tree', () => {
    const target: TaskState = {
      taskId: 'T',
      state: 'VERIFIED',
      leaseVersion: 1,
      holder: 'worker',
      leaseId: 'T:1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      taskResultEvidence: current('result'),
      verificationEvidence: current('verification'),
    };
    expect(() =>
      transition(target, ['VERIFIED'], 'MERGE_QUEUED', {
        command: 'merge-queue:add',
        credential: { taskId: 'T', holder: 'worker', leaseId: 'T:1', fencingVersion: 1 },
        currentCommit: '1'.repeat(40),
        currentTree: '3'.repeat(40),
      }),
    ).toThrow('MERGE_QUEUE_BINDING_MISMATCH');
  });

  it('rejects a merge queue that skips post-rebase task:verify', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'D')!.queueOperations = [
      'generated-post-rebase-self-review',
    ];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('REAL_POST_REBASE_TASK_VERIFY_MISSING');
  });

  it('rejects a task result generated before its fresh self-review', async () => {
    const fixture = await createAttestationFixture();
    try {
      const reviewPath = join(runtimeRoot(fixture.root), fixture.result.bindings.selfReviewPath);
      const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { reviewedAt: string };
      review.reviewedAt = '2026-07-22T00:00:00.000Z';
      const text = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, text);
      fixture.result.bindings.selfReviewSha256 = sha256(text);
      await expect(
        validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, state: fixture.state }),
      ).rejects.toThrow('TASK_RESULT_PREDATES_FRESH_SELF_REVIEW');
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts observed cluster advance only with fresh evidence and real verification', () => {
    expect(deriveLifecycleVerdict(validLifecycleManifest()).status).toBe('PASS');
  });

  it('rejects integration failure without an automatic revert', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'G')!.revertResult = 'MISSING';
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('AUTOMATIC_REVERT_MISSING');
  });

  it('rejects a lifecycle manifest that omits a required command', () => {
    const manifest = validLifecycleManifest();
    for (const scenario of manifest.scenarios)
      scenario.commandsExecuted = scenario.commandsExecuted.filter((item) => item.command !== 'task:self-review');
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LIFECYCLE_REQUIRED_COMMAND_MISSING:task:self-review');
  });

  it('rejects a manually claimed PASS with a missing phase', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios = manifest.scenarios.filter((scenario) => scenario.scenarioId !== 'H');
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LIFECYCLE_SCENARIO_MISSING:H');
  });
});
