import { describe, expect, it } from 'vitest';
import type { TaskContract } from '@ciag/shared-schemas';
import {
  acquire,
  assertLease,
  assertLeaseCredential,
  currentLeaseCredential,
  markReady,
  markValidated,
  renewLease,
  transition,
  type EvidenceReference,
  type LifecycleDocument,
} from '../../tools/task-runner/state.js';
import { loadRepairLeaseContract } from '../../tools/task-runner/repair-contract.js';

const task = (id: string, lock: string, dependencies: string[] = []): TaskContract => ({
  schemaVersion: '1.0.0',
  id,
  title: id,
  sourceHashes: { prd: 'a'.repeat(64), requirements: 'b'.repeat(64), audit: 'c'.repeat(64) },
  dependencyGroup: 'G0',
  cluster: 'C-G0-X',
  riskLevel: 'LOW',
  autonomyLevel: 'AUTONOMOUS',
  dependencies,
  requirements: ['FR-X-001'],
  acceptanceCriteria: [],
  taskAcceptanceFacets: [],
  invariants: ['INV-001'],
  adrs: ['ADR-001'],
  ownerPackages: ['packages/x'],
  readSet: [],
  writeSet: ['packages/x/**'],
  allowedPaths: ['packages/x/**'],
  forbiddenPaths: ['docs/spec/**'],
  exclusiveLocks: [lock],
  interfaceHashes: { x: 'd'.repeat(64) },
  deliverables: ['x'],
  constraints: ['x'],
  nonGoals: ['x'],
  degradedBehavior: 'x',
  rollback: 'x',
  requiredTests: ['tests/x.spec.ts'],
  verificationCommands: [{ command: 'pnpm test', expected: 'exit 0' }],
  complexityBudget: { maxFiles: 1, maxChangedLines: 1, maxCyclomaticComplexity: 1 },
  changeBudget: { maxMigrations: 0, maxPublicInterfaces: 0, requiresSplitAboveBudget: true },
  stopConditions: ['x'],
  completionDefinition: ['x'],
  sourceReferences: [{ path: 'x', line: 1, id: 'FR-X-001' }],
  specificationStatus: 'READY',
  testQualityGate: 'NEGATIVE_CASE',
});

const evidence = (kind: string, commit?: string, tree?: string): EvidenceReference => ({
  path: `${kind}.json`,
  sha256: kind.padEnd(64, 'a').slice(0, 64),
  status: 'CURRENT',
  ...(commit ? { commit } : {}),
  ...(tree ? { tree } : {}),
});

const draftState = (...ids: string[]): LifecycleDocument => ({
  schemaVersion: '2.0.0',
  tasks: Object.fromEntries(ids.map((id) => [id, { taskId: id, state: 'DRAFT', leaseVersion: 0, history: [] }])),
});

describe('complete task lifecycle and fenced leases', () => {
  it('loads the exact content-addressed lifecycle repair contract', async () => {
    await expect(loadRepairLeaseContract('HARNESS-V1.0.1-LIFECYCLE-REPAIR')).resolves.toMatchObject({
      approvedBranch: 'fix/harness-v1.0.1-lifecycle',
      contractSha256: 'f9ab4b031f7a853619cc53045d4d0be39464bd7b216b19b1d7b56d69cc19a7cb',
    });
  });

  it('enforces every mandatory state in order with evidence and a current fence', () => {
    const contract = task('T-G0-A', 'a');
    const state = draftState(contract.id);
    const target = state.tasks[contract.id]!;
    markValidated(target, evidence('validation'), new Date('2026-01-01T00:00:00Z'));
    markReady(state, [contract], contract.id, new Date('2026-01-01T00:00:01Z'));
    acquire(
      state,
      [contract],
      contract.id,
      'worker',
      new Date('2026-01-01T00:00:02Z'),
      60_000,
      '1'.repeat(40),
      'task/t-g0-a',
    );
    const credential = currentLeaseCredential(target);
    transition(target, ['LEASED'], 'IMPLEMENTING', {
      command: 'task:begin',
      credential,
      worktreeValid: true,
      at: new Date('2026-01-01T00:00:03Z'),
    });
    transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING', {
      command: 'task:self-review',
      credential,
      evidence: evidence('implementation'),
      at: new Date('2026-01-01T00:00:04Z'),
    });
    const commit = '2'.repeat(40);
    const tree = '3'.repeat(40);
    transition(target, ['SELF_REVIEWING'], 'VERIFYING', {
      command: 'task:verify',
      credential,
      evidence: evidence('review', commit, tree),
      currentCommit: commit,
      currentTree: tree,
      at: new Date('2026-01-01T00:00:05Z'),
    });
    target.taskResultEvidence = evidence('result', commit, tree);
    target.commit = commit;
    target.tree = tree;
    transition(target, ['VERIFYING'], 'VERIFIED', {
      command: 'task:verify:proof-carrying',
      credential,
      evidence: evidence('verification', commit, tree),
      at: new Date('2026-01-01T00:00:06Z'),
    });
    transition(target, ['VERIFIED'], 'MERGE_QUEUED', {
      command: 'merge-queue:add',
      credential,
      currentCommit: commit,
      currentTree: tree,
      at: new Date('2026-01-01T00:00:07Z'),
    });
    transition(target, ['MERGE_QUEUED'], 'MERGED', {
      command: 'merge-queue:process',
      credential,
      mergeQueueProcessed: true,
      at: new Date('2026-01-01T00:00:08Z'),
    });
    expect(['DRAFT', ...(target.history ?? []).map((entry) => entry.to)]).toEqual([
      'DRAFT',
      'VALIDATED',
      'READY',
      'LEASED',
      'IMPLEMENTING',
      'SELF_REVIEWING',
      'VERIFYING',
      'VERIFIED',
      'MERGE_QUEUED',
      'MERGED',
    ]);
  });

  it('renews by increasing the fence and invalidating the old credential', () => {
    const contract = task('T-G0-A', 'a');
    const state = draftState(contract.id);
    markValidated(state.tasks[contract.id]!, evidence('validation'));
    markReady(state, [contract], contract.id);
    acquire(state, [contract], contract.id, 'worker', new Date('2026-01-01T00:00:00Z'), 60_000);
    const oldCredential = currentLeaseCredential(state.tasks[contract.id]!);
    const renewed = renewLease(state, oldCredential, new Date('2026-01-01T00:00:01Z'), 60_000);
    expect(renewed.fencingVersion).toBe(2);
    expect(() => assertLeaseCredential(state, oldCredential, new Date('2026-01-01T00:00:02Z'))).toThrow(
      'STALE_LEASE_VERSION',
    );
    expect(() =>
      assertLease(state, contract.id, renewed.fencingVersion, 'worker', new Date('2026-01-01T00:00:02Z')),
    ).not.toThrow();
  });

  it('rejects path conflicts, wrong tasks, wrong owners, lost and expired leases deterministically', () => {
    const tasks = [task('T-G0-A', 'same'), task('T-G0-B', 'same')];
    const state = draftState(...tasks.map((item) => item.id));
    for (const item of tasks) {
      markValidated(state.tasks[item.id]!, evidence(`validation-${item.id}`));
      markReady(state, tasks, item.id);
    }
    acquire(state, tasks, tasks[0]!.id, 'one', new Date('2026-01-01T00:00:00Z'), 1_000);
    expect(() => acquire(state, tasks, tasks[1]!.id, 'two', new Date('2026-01-01T00:00:00Z'))).toThrow(
      'PATH_LOCK_CONFLICT',
    );
    const credential = currentLeaseCredential(state.tasks[tasks[0]!.id]!);
    expect(() =>
      assertLeaseCredential(state, { ...credential, taskId: 'missing' }, new Date('2026-01-01T00:00:00Z')),
    ).toThrow('WRONG_LEASE_TASK');
    expect(() =>
      assertLeaseCredential(state, { ...credential, holder: 'other' }, new Date('2026-01-01T00:00:00Z')),
    ).toThrow('WRONG_LEASE_OWNER');
    expect(() =>
      assertLeaseCredential(state, { ...credential, leaseId: 'lost' }, new Date('2026-01-01T00:00:00Z')),
    ).toThrow('LOST_LEASE');
    expect(() => assertLeaseCredential(state, credential, new Date('2026-01-01T00:00:02Z'))).toThrow(
      'LEASE_EXPIRED',
    );
  });
});
