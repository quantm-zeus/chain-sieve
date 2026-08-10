import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeWorkingCopyHashes,
  persistLifecycleAuthority,
  readVerificationBaseline,
  validateRecoveryWorkspace,
  validateVerificationBaseline,
} from '../../tools/task-runner/authority.js';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import { TaskContractSchema } from '@ciag/shared-schemas';
import { TASK_VERIFIER_VERSION, VERIFICATION_POLICY_VERSION } from '../../tools/task-verifier/policy.js';
import { executeOrchestration } from '../../tools/agent/lib/executor.js';
import { SystemCommandRunner } from '../../tools/agent/lib/system.js';
import type { AgentProvider } from '../../tools/agent/lib/types.js';
import {
  AGENT_LEASE_TTL_MINUTES,
  acquireLifecycleMutationLock,
  recoverExpiredLease,
  renewValidLease,
  runtimeRoot,
  transition,
  type EvidenceReference,
  type LifecycleDocument,
  type TaskState,
} from '../../tools/task-runner/state.js';

const receipt = { path: 'receipts/request.json', sha256: 'a'.repeat(64), status: 'CURRENT' as const };
const lifecycleBaseCommit = '1'.repeat(40);
const lifecycleBaseTree = '2'.repeat(40);
const implementationCommit = '3'.repeat(40);
const implementationTree = '4'.repeat(40);
const tasks = [
  { id: 'T-G0-CORE', dependencies: [], exclusiveLocks: ['packages/domain/public-api'] },
  { id: 'T-G0-OTHER', dependencies: [], exclusiveLocks: ['packages/other/public-api'] },
];
const expired = (): LifecycleDocument => ({
  schemaVersion: '2.0.0',
  tasks: {
    'T-G0-CORE': {
      taskId: 'T-G0-CORE', state: 'IMPLEMENTING', leaseVersion: 1,
      holder: 'zcode-orchestrator', leaseId: 'T-G0-CORE:1:old',
      acquiredAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-07-30T00:15:00.000Z', leaseState: 'ACTIVE',
      baseCommit: lifecycleBaseCommit, branch: 'task/t-g0-core', worktree: '/tmp/task/T-G0-CORE', history: [],
    },
    'T-G0-OTHER': { taskId: 'T-G0-OTHER', state: 'READY', leaseVersion: 0, history: [] },
  },
});
const recovery = (requestSha256 = 'b'.repeat(64)) => ({
  taskId: 'T-G0-CORE', expectedExpiredLeaseId: 'T-G0-CORE:1:old', expectedFencingVersion: 1,
  expectedHolder: 'zcode-orchestrator', expectedTaskState: 'IMPLEMENTING' as const,
  expectedTaskBranch: 'task/t-g0-core', expectedTaskWorktree: '/tmp/task/T-G0-CORE',
  expectedLifecycleBaseCommit: lifecycleBaseCommit,
  expectedTaskHeadCommit: lifecycleBaseCommit,
  expectedTaskHeadTree: lifecycleBaseTree,
  ttlMinutes: 120,
  requestSha256,
  receipt,
});
const selfReviewing = (): LifecycleDocument => {
  const state = expired();
  const target = state.tasks['T-G0-CORE']!;
  const evidence = {
    path: 'reviews/T-G0-CORE/review.json',
    sha256: 'd'.repeat(64),
    status: 'CURRENT' as const,
    commit: implementationCommit,
    tree: implementationTree,
  };
  target.state = 'SELF_REVIEWING';
  target.commit = implementationCommit;
  target.tree = implementationTree;
  target.implementationEvidence = { ...evidence, path: `git:${implementationCommit}` };
  target.selfReviewEvidence = evidence;
  return state;
};
const postCommitRecovery = (requestSha256 = 'e'.repeat(64)) => ({
  ...recovery(requestSha256),
  expectedTaskState: 'SELF_REVIEWING' as const,
  expectedTaskHeadCommit: implementationCommit,
  expectedTaskHeadTree: implementationTree,
});

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('explicit authoritative lease lifecycle', () => {
  it('renews a valid lease exactly once and returns the same result on retry', () => {
    const state = expired();
    const target = state.tasks['T-G0-CORE']!;
    target.expiresAt = '2026-08-01T00:15:00.000Z';
    const request = { taskId: target.taskId, expectedLeaseId: target.leaseId!, expectedFencingVersion: 1, holder: target.holder!, ttlMinutes: 120, requestSha256: 'c'.repeat(64), receipt };
    const first = renewValidLease(state, request, new Date('2026-08-01T00:00:00.000Z'));
    const second = renewValidLease(state, request, new Date('2026-08-01T00:01:00.000Z'));
    expect(first.leaseId).toBe(second.leaseId);
    expect(second.fencingVersion).toBe(2);
    expect(target.retiredLeases).toEqual([{ leaseId: 'T-G0-CORE:1:old', fencingVersion: 1, state: 'RENEWED', retiredAt: '2026-08-01T00:00:00.000Z' }]);
  });

  it('recovers IMPLEMENTING before any implementation commit', () => {
    const state = expired();
    const lease = recoverExpiredLease(state, tasks, recovery(), new Date('2026-08-01T00:00:00.000Z'));
    expect(lease.fencingVersion).toBe(2);
    expect(state.tasks['T-G0-CORE']!.baseCommit).toBe(lifecycleBaseCommit);
    expect(state.tasks['T-G0-CORE']!.commit).toBeUndefined();
    expect(state.tasks['T-G0-CORE']!.tree).toBeUndefined();
  });

  it('recovers LEASED task with undefined target.worktree and binds expected worktree', () => {
    const state = expired();
    state.tasks['T-G0-CORE']!.state = 'LEASED';
    delete state.tasks['T-G0-CORE']!.worktree;
    const lease = recoverExpiredLease(state, tasks, { ...recovery(), expectedTaskState: 'LEASED' }, new Date('2026-08-01T00:00:00.000Z'));
    expect(lease.fencingVersion).toBe(2);
    expect(state.tasks['T-G0-CORE']!.worktree).toBe('/tmp/task/T-G0-CORE');
  });

  it('recovers SELF_REVIEWING with lifecycle base A and task HEAD/tree B', () => {
    const state = selfReviewing();
    delete state.tasks['T-G0-CORE']!.commit;
    delete state.tasks['T-G0-CORE']!.tree;
    const lease = recoverExpiredLease(state, tasks, postCommitRecovery(), new Date('2026-08-01T00:00:00.000Z'));
    expect(lease.fencingVersion).toBe(2);
    expect(state.tasks['T-G0-CORE']).toMatchObject({
      state: 'SELF_REVIEWING',
      baseCommit: lifecycleBaseCommit,
      commit: implementationCommit,
      tree: implementationTree,
    });
  });

  it('increments fencing exactly once and returns the same result on retry', () => {
    const state = selfReviewing();
    const request = postCommitRecovery();
    const first = recoverExpiredLease(state, tasks, request, new Date('2026-08-01T00:00:00.000Z'));
    const second = recoverExpiredLease(state, tasks, request, new Date('2026-08-01T00:01:00.000Z'));
    expect(second).toEqual(first);
    expect(first.fencingVersion).toBe(2);
    expect(first.leaseId).not.toBe('T-G0-CORE:1:old');
    expect(state.tasks['T-G0-CORE']!.retiredLeases).toHaveLength(1);
  });

  it('binds a 120-minute recovery to the expected expiry', () => {
    expect(AGENT_LEASE_TTL_MINUTES).toEqual({ minimum: 15, maximum: 240, default: 120 });
    const lease = recoverExpiredLease(selfReviewing(), tasks, postCommitRecovery(), new Date('2026-08-01T00:00:00.000Z'));
    expect(lease.expiresAt).toBe('2026-08-01T02:00:00.000Z');
  });

  it('rejects recovery TTL values outside the explicit bounds', () => {
    expect(() => recoverExpiredLease(selfReviewing(), tasks, { ...postCommitRecovery(), ttlMinutes: 14 }, new Date('2026-08-01T00:00:00.000Z'))).toThrow('LEASE_TTL_MINUTES_BELOW_MINIMUM:15');
    expect(() => recoverExpiredLease(selfReviewing(), tasks, { ...postCommitRecovery(), ttlMinutes: 241 }, new Date('2026-08-01T00:00:00.000Z'))).toThrow('LEASE_TTL_MINUTES_ABOVE_MAXIMUM:240');
  });

  it('fails closed when a retry changes the TTL', () => {
    const state = selfReviewing();
    recoverExpiredLease(state, tasks, postCommitRecovery(), new Date('2026-08-01T00:00:00.000Z'));
    expect(() => recoverExpiredLease(state, tasks, { ...postCommitRecovery('f'.repeat(64)), ttlMinutes: 60 }, new Date('2026-08-01T00:01:00.000Z'))).toThrow('RECOVERY_REQUEST_CONFLICT');
  });

  it('never recovers a credential that is still valid', () => {
    const state = expired();
    state.tasks['T-G0-CORE']!.expiresAt = '2099-01-01T00:00:00.000Z';
    expect(() =>
      recoverExpiredLease(state, tasks, recovery(), new Date('2026-08-01T00:00:00.000Z')),
    ).toThrow('RECOVERY_LEASE_NOT_EXPIRED');
  });

  it.each([
    ['wrong lease ID', { expectedExpiredLeaseId: 'wrong' }, 'RECOVERY_EXPECTED_LEASE_MISMATCH'],
    ['wrong fencing', { expectedFencingVersion: 9 }, 'RECOVERY_EXPECTED_FENCING_MISMATCH'],
    ['wrong holder', { expectedHolder: 'other' }, 'RECOVERY_EXPECTED_HOLDER_MISMATCH'],
    ['branch mismatch', { expectedTaskBranch: 'task/wrong' }, 'RECOVERY_EXPECTED_BRANCH_MISMATCH'],
    ['worktree mismatch', { expectedTaskWorktree: '/tmp/wrong' }, 'RECOVERY_EXPECTED_WORKTREE_MISMATCH'],
    ['lifecycle base mismatch', { expectedLifecycleBaseCommit: '9'.repeat(40) }, 'RECOVERY_EXPECTED_LIFECYCLE_BASE_MISMATCH'],
  ])('fails closed for %s', (_name, change, code) => {
    expect(() => recoverExpiredLease(expired(), tasks, { ...recovery(), ...change }, new Date('2026-08-01T00:00:00.000Z'))).toThrow(code);
  });

  it('fails closed for a wrong post-implementation task HEAD or tree', () => {
    expect(() => recoverExpiredLease(selfReviewing(), tasks, { ...postCommitRecovery(), expectedTaskHeadCommit: '8'.repeat(40) }, new Date('2026-08-01T00:00:00.000Z'))).toThrow('RECOVERY_EXPECTED_TASK_HEAD_MISMATCH');
    expect(() => recoverExpiredLease(selfReviewing(), tasks, { ...postCommitRecovery(), expectedTaskHeadTree: '8'.repeat(40) }, new Date('2026-08-01T00:00:00.000Z'))).toThrow('RECOVERY_EXPECTED_TASK_TREE_MISMATCH');
  });

  it('preserves self-review evidence bound to implementation commit/tree B', () => {
    const state = selfReviewing();
    const before = structuredClone(state.tasks['T-G0-CORE']!.selfReviewEvidence);
    recoverExpiredLease(state, tasks, postCommitRecovery(), new Date('2026-08-01T00:00:00.000Z'));
    expect(state.tasks['T-G0-CORE']!.selfReviewEvidence).toEqual(before);
    expect(before).toMatchObject({ commit: implementationCommit, tree: implementationTree });
  });

  it('allows authoritative verification to continue from recovered SELF_REVIEWING', () => {
    const state = selfReviewing();
    recoverExpiredLease(state, tasks, postCommitRecovery(), new Date('2026-08-01T00:00:00.000Z'));
    const target = state.tasks['T-G0-CORE']!;
    const credential = {
      taskId: target.taskId,
      holder: target.holder!,
      leaseId: target.leaseId!,
      fencingVersion: target.leaseVersion,
    };
    transition(target, ['SELF_REVIEWING'], 'VERIFYING', {
      command: 'trusted-root:task:verify',
      credential,
      evidence: target.selfReviewEvidence!,
      currentCommit: implementationCommit,
      currentTree: implementationTree,
      at: new Date('2026-08-01T00:01:00.000Z'),
    });
    expect(target.state).toBe('VERIFYING');
    expect(target.selfReviewEvidence).toMatchObject({ commit: implementationCommit, tree: implementationTree });
  });

  it('rejects a second active task and a conflicting lock owner', () => {
    const active = expired();
    active.tasks['T-G0-OTHER'] = { taskId: 'T-G0-OTHER', state: 'IMPLEMENTING', leaseVersion: 1, holder: 'other', leaseId: 'other:1', expiresAt: '2099-01-01T00:00:00.000Z', leaseState: 'ACTIVE' };
    expect(() => recoverExpiredLease(active, tasks, recovery(), new Date('2026-08-01T00:00:00.000Z'))).toThrow('RECOVERY_MULTIPLE_ACTIVE_TASKS');
    const conflictingTasks = [tasks[0]!, { ...tasks[1]!, exclusiveLocks: ['packages/domain/public-api'] }];
    expect(() => recoverExpiredLease(active, conflictingTasks, recovery(), new Date('2026-08-01T00:00:00.000Z'))).toThrow('RECOVERY_PATH_LOCK_CONFLICT');
  });

  it('does not mistake an independently expired historical credential for an active task', () => {
    const state = expired();
    state.tasks['T-G0-OTHER'] = {
      taskId: 'T-G0-OTHER',
      state: 'IMPLEMENTING',
      leaseVersion: 4,
      holder: 'historical',
      leaseId: 'other:4:expired',
      expiresAt: '2026-07-30T00:00:00.000Z',
      leaseState: 'ACTIVE',
    };
    expect(() =>
      recoverExpiredLease(state, tasks, recovery(), new Date('2026-08-01T00:00:00.000Z')),
    ).not.toThrow();
  });

  it('derives tracked and untracked hashes from byte content in an isolated Git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chain-sieve-work-hash-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    await writeFile(join(root, 'untracked.txt'), 'preserve me\n');
    const first = await computeWorkingCopyHashes(root);
    const second = await computeWorkingCopyHashes(root);
    expect(first).toEqual(second);
    expect(first.tracked).toMatch(/^[a-f0-9]{64}$/);
    expect(first.untracked).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates every recovery workspace binding in an isolated Git repository', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-sieve-recovery-workspace-')));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'task/t-g0-core'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: root });
    const contractPath = 'tasks/G0/T-G0-CORE.contract.json';
    const contextPath = 'artifacts/context/T-G0-CORE/context-manifest.json';
    await mkdir(join(root, 'tasks/G0'), { recursive: true });
    await mkdir(join(root, 'artifacts/context/T-G0-CORE'), { recursive: true });
    const contractText = '{"id":"T-G0-CORE","mode":"legacy"}\n';
    const contextText = '{"taskId":"T-G0-CORE","mode":"legacy"}\n';
    await writeFile(join(root, contractPath), contractText);
    await writeFile(join(root, contextPath), contextText);
    await writeFile(join(root, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
    await writeFile(join(root, 'tracked.txt'), 'preserved dirty work\n');
    await writeFile(join(root, 'untracked.txt'), 'preserved untracked work\n');
    const hashes = await computeWorkingCopyHashes(root);
    const expected = {
      taskWorktree: root,
      expectedBranch: 'task/t-g0-core',
      expectedTaskHeadCommit: base,
      expectedTaskHeadTree: tree,
      expectedTrackedWorkSha256: hashes.tracked,
      expectedUntrackedWorkSha256: hashes.untracked,
      contractPath,
      expectedContractSha256: sha256(contractText),
      contextManifestPath: contextPath,
      expectedContextManifestSha256: sha256(contextText),
    };
    await expect(validateRecoveryWorkspace(expected)).resolves.toMatchObject({ contractText, contextManifestText: contextText });
    await expect(validateRecoveryWorkspace({ ...expected, expectedBranch: 'task/wrong' })).rejects.toThrow('RECOVERY_BRANCH_MISMATCH');
    await expect(validateRecoveryWorkspace({ ...expected, expectedTaskHeadCommit: '1'.repeat(40) })).rejects.toThrow('RECOVERY_TASK_HEAD_MISMATCH');
    await expect(validateRecoveryWorkspace({ ...expected, expectedTaskHeadTree: '1'.repeat(40) })).rejects.toThrow('RECOVERY_TASK_TREE_MISMATCH');
    await expect(validateRecoveryWorkspace({ ...expected, expectedTrackedWorkSha256: '2'.repeat(64) })).rejects.toThrow('RECOVERY_TRACKED_WORK_DRIFT');
    await expect(validateRecoveryWorkspace({ ...expected, expectedUntrackedWorkSha256: '3'.repeat(64) })).rejects.toThrow('RECOVERY_UNTRACKED_WORK_DRIFT');
    await expect(validateRecoveryWorkspace({ ...expected, expectedContractSha256: '4'.repeat(64) })).rejects.toThrow('RECOVERY_LEGACY_CONTRACT_DRIFT');
    await expect(validateRecoveryWorkspace({ ...expected, expectedContextManifestSha256: '5'.repeat(64) })).rejects.toThrow('RECOVERY_LEGACY_CONTEXT_DRIFT');
    await mkdir(join(root, 'nested'), { recursive: true });
    await expect(validateRecoveryWorkspace({ ...expected, taskWorktree: join(root, 'nested') })).rejects.toThrow('RECOVERY_WORKTREE_MISMATCH');
  });

  it('validates recovery workspace when HEAD is detached but matches expected task head commit', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-sieve-detached-recovery-')));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'task/t-g0-core'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: root });
    const contractPath = 'tasks/G0/T-G0-CORE.contract.json';
    const contextPath = 'artifacts/context/T-G0-CORE/context-manifest.json';
    await mkdir(join(root, 'tasks/G0'), { recursive: true });
    await mkdir(join(root, 'artifacts/context/T-G0-CORE'), { recursive: true });
    const contractText = '{"id":"T-G0-CORE","mode":"legacy"}\n';
    const contextText = '{"taskId":"T-G0-CORE","mode":"legacy"}\n';
    await writeFile(join(root, contractPath), contractText);
    await writeFile(join(root, contextPath), contextText);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'detached commit'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '--detach', base], { cwd: root });
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
    const hashes = await computeWorkingCopyHashes(root);
    const expected = {
      taskWorktree: root,
      expectedBranch: 'task/t-g0-core',
      expectedTaskHeadCommit: base,
      expectedTaskHeadTree: tree,
      expectedTrackedWorkSha256: hashes.tracked,
      expectedUntrackedWorkSha256: hashes.untracked,
      contractPath,
      expectedContractSha256: sha256(contractText),
      contextManifestPath: contextPath,
      expectedContextManifestSha256: sha256(contextText),
    };
    await expect(validateRecoveryWorkspace(expected)).resolves.toMatchObject({ contractText, contextManifestText: contextText });
  });

  it('fails when task HEAD changes after recovery preflight', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-sieve-recovery-race-')));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'task/t-g0-core'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: root });
    await mkdir(join(root, 'tasks/G0'), { recursive: true });
    await mkdir(join(root, 'artifacts/context/T-G0-CORE'), { recursive: true });
    const contractPath = 'tasks/G0/T-G0-CORE.contract.json';
    const contextManifestPath = 'artifacts/context/T-G0-CORE/context-manifest.json';
    const contractText = '{}\n';
    const contextText = '{}\n';
    await writeFile(join(root, contractPath), contractText);
    await writeFile(join(root, contextManifestPath), contextText);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'preflight'], { cwd: root });
    const expectedTaskHeadCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const expectedTaskHeadTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
    const hashes = await computeWorkingCopyHashes(root);
    const expected = {
      taskWorktree: root,
      expectedBranch: 'task/t-g0-core',
      expectedTaskHeadCommit,
      expectedTaskHeadTree,
      expectedTrackedWorkSha256: hashes.tracked,
      expectedUntrackedWorkSha256: hashes.untracked,
      contractPath,
      expectedContractSha256: sha256(contractText),
      contextManifestPath,
      expectedContextManifestSha256: sha256(contextText),
    };
    await expect(validateRecoveryWorkspace(expected)).resolves.toBeDefined();
    await writeFile(join(root, 'changed.txt'), 'changed after preflight\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'changed HEAD'], { cwd: root });
    await expect(validateRecoveryWorkspace(expected)).rejects.toThrow('RECOVERY_TASK_HEAD_MISMATCH');
  });

  it('binds CLI recovery TTL into the request, immutable receipt, expiry, and idempotent result', async () => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'chain-sieve-recovery-cli-')));
    temporary.push(fixtureRoot);
    const trustedRoot = join(fixtureRoot, 'trusted');
    const sourceRoot = process.cwd();
    execFileSync('git', ['clone', '--quiet', '--no-local', sourceRoot, trustedRoot]);
    await writeFile(join(trustedRoot, '.git/info/exclude'), 'node_modules\n', { flag: 'a' });
    await symlink(join(sourceRoot, 'node_modules'), join(trustedRoot, 'node_modules'));
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: trustedRoot });
    execFileSync('git', ['config', 'user.name', 'Lifecycle Test'], { cwd: trustedRoot });
    const lifecycleBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: trustedRoot, encoding: 'utf8' }).trim();
    const taskWorktree = join(fixtureRoot, 'task');
    execFileSync('git', ['branch', 'task/t-g0-core', lifecycleBase], { cwd: trustedRoot });
    execFileSync('git', ['worktree', 'add', '--quiet', taskWorktree, 'task/t-g0-core'], { cwd: trustedRoot });
    await writeFile(join(taskWorktree, 'post-commit-recovery-fixture.txt'), 'implementation commit\n');
    execFileSync('git', ['add', 'post-commit-recovery-fixture.txt'], { cwd: taskWorktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'implementation fixture'], { cwd: taskWorktree });
    const taskHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: taskWorktree, encoding: 'utf8' }).trim();
    const taskTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: taskWorktree, encoding: 'utf8' }).trim();
    const contractText = await readFile(join(taskWorktree, 'tasks/G0/T-G0-CORE.contract.json'), 'utf8');
    const contextText = await readFile(join(taskWorktree, 'artifacts/context/T-G0-CORE/context-manifest.json'), 'utf8');
    const evidence = {
      path: `reviews/T-G0-CORE/${taskHead}.review.json`,
      sha256: '7'.repeat(64),
      status: 'CURRENT' as const,
      commit: taskHead,
      tree: taskTree,
    };
    const state: LifecycleDocument = {
      schemaVersion: '2.0.0',
      tasks: {
        'T-G0-CORE': {
          taskId: 'T-G0-CORE',
          state: 'SELF_REVIEWING',
          leaseVersion: 1,
          holder: 'zcode-orchestrator',
          leaseId: 'T-G0-CORE:1:expired',
          acquiredAt: '2026-07-30T00:00:00.000Z',
          expiresAt: '2026-07-30T00:15:00.000Z',
          leaseState: 'ACTIVE',
          baseCommit: lifecycleBase,
          branch: 'task/t-g0-core',
          worktree: taskWorktree,
          commit: taskHead,
          tree: taskTree,
          implementationEvidence: { ...evidence, path: `git:${taskHead}` },
          selfReviewEvidence: evidence,
          history: [],
        },
      },
    };
    const generatedTask = TaskContractSchema.parse(JSON.parse(contractText));
    const generatedAuthority = await persistLifecycleAuthority({
      trustedRoot, taskRoot: taskWorktree, task: generatedTask,
      state: state.tasks['T-G0-CORE']!, contractPath: 'tasks/G0/T-G0-CORE.contract.json',
      contextManifestPath: 'artifacts/context/T-G0-CORE/context-manifest.json', contractMode: 'GENERATED',
    });
    state.tasks['T-G0-CORE']!.lifecycleBinding = generatedAuthority.binding;
    state.tasks['T-G0-CORE']!.verificationBaseline = generatedAuthority.baseline;
    await mkdir(runtimeRoot(trustedRoot), { recursive: true });
    await writeFile(join(runtimeRoot(trustedRoot), 'task-state.json'), `${JSON.stringify(state, null, 2)}\n`);
    const emptyHash = sha256('');
    const args = [
      join(sourceRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(sourceRoot, 'tools/agent/lifecycle.ts'),
      'recover', '--', 'T-G0-CORE',
      '--expected-expired-lease-id', 'T-G0-CORE:1:expired',
      '--expected-fencing-version', '1',
      '--holder', 'zcode-orchestrator',
      '--expected-task-state', 'SELF_REVIEWING',
      '--expected-task-branch', 'task/t-g0-core',
      '--expected-task-worktree', taskWorktree,
      '--expected-lifecycle-base-commit', lifecycleBase,
      '--expected-task-head-commit', taskHead,
      '--expected-task-head-tree', taskTree,
      '--expected-tracked-work-sha256', emptyHash,
      '--expected-untracked-work-sha256', emptyHash,
      '--expected-legacy-contract-sha256', sha256(contractText),
      '--expected-legacy-context-sha256', sha256(contextText),
      '--ttl-minutes', '120',
    ];
    const first = JSON.parse(execFileSync(process.execPath, args, { cwd: trustedRoot, encoding: 'utf8' })) as {
      idempotentRequest: string;
      ttlMinutes: number;
      expiresAt: string;
      lease: { leaseId: string; expiresAt: string };
      receipt: EvidenceReference;
    };
    const second = JSON.parse(execFileSync(process.execPath, args, { cwd: trustedRoot, encoding: 'utf8' })) as typeof first;
    expect(second).toEqual(first);
    expect(first.ttlMinutes).toBe(120);
    expect(JSON.parse(await readFile(join(runtimeRoot(trustedRoot), generatedAuthority.binding.path), 'utf8'))).toMatchObject({ contractMode: 'GENERATED' });
    expect(Date.parse(first.expiresAt) - Date.parse(JSON.parse(await readFile(join(runtimeRoot(trustedRoot), first.receipt.path), 'utf8')).operationAt as string)).toBe(120 * 60_000);
    const receiptDocument = JSON.parse(await readFile(join(runtimeRoot(trustedRoot), first.receipt.path), 'utf8')) as Record<string, unknown>;
    expect(receiptDocument).toMatchObject({
      requestSha256: first.idempotentRequest,
      ttlMinutes: 120,
      ttlMilliseconds: 120 * 60_000,
      expiresAt: first.lease.expiresAt,
    });
    const recoveredState = await readFile(join(runtimeRoot(trustedRoot), 'task-state.json'), 'utf8');
    const runner = new SystemCommandRunner();
    await executeOrchestration(trustedRoot, runner, {
      dryRun: true,
      provider: { id: 'zcode' } as AgentProvider,
    });
    await executeOrchestration(trustedRoot, runner, {
      dryRun: true,
      provider: { id: 'antigravity' } as AgentProvider,
    });
    expect(await readFile(join(runtimeRoot(trustedRoot), 'task-state.json'), 'utf8')).toBe(recoveredState);
    const conflictingArgs = args.map((value, index) => args[index - 1] === '--ttl-minutes' ? '60' : value);
    const conflicting = spawnSync(process.execPath, conflictingArgs, { cwd: trustedRoot, encoding: 'utf8' });
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toContain('RECOVERY_REQUEST_CONFLICT');
    expect(await readdir(join(runtimeRoot(trustedRoot), 'recoveries/T-G0-CORE'))).toHaveLength(1);
  });

  it('persists a recovery-capable baseline with explicit trusted verifier and policy versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chain-sieve-versioned-baseline-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Baseline Test'], { cwd: root });
    const task = TaskContractSchema.parse(JSON.parse(await readFile('tasks/G0/T-G0-CORE.contract.json', 'utf8')));
    const required = [
      'tasks/G0/T-G0-CORE.contract.json',
      'artifacts/context/T-G0-CORE/context-manifest.json',
      'docs/spec/SHA256SUMS',
      'tasks/generated/interface-hashes.json',
      'artifacts/spec/acceptance-partition.json',
      'tools/task-verifier/cli.ts',
      'tools/task-verifier/verify.ts',
      'tools/task-verifier/attestation.ts',
      'tools/task-verifier/policy.ts',
      'tools/task-verifier/conformance.ts',
      'tools/task-verifier/trusted-execution.ts',
      'tools/architecture-verifier/verify.ts',
      'tools/architecture-verifier/cli.ts',
    ];
    for (const path of required) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), await readFile(path));
    }
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'trusted baseline'], { cwd: root });
    execFileSync('git', ['tag', 'harness-v1.0.1'], { cwd: root });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const state: TaskState = { taskId: task.id, state: 'IMPLEMENTING', leaseVersion: 1, baseCommit };
    const authority = await persistLifecycleAuthority({
      trustedRoot: root,
      taskRoot: root,
      task,
      state,
      contractPath: 'tasks/G0/T-G0-CORE.contract.json',
      contextManifestPath: 'artifacts/context/T-G0-CORE/context-manifest.json',
      contractMode: 'LEGACY',
    });
    state.lifecycleBinding = authority.binding;
    state.verificationBaseline = authority.baseline;
    const baseline = await validateVerificationBaseline(root, state);
    expect(baseline).toMatchObject({
      schemaVersion: '1.1.0',
      verifierVersion: TASK_VERIFIER_VERSION,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      controlPlaneCommit: baseCommit,
    });
  });

  it.each([
    ['missing verifier version', { verificationPolicyVersion: VERIFICATION_POLICY_VERSION }, 'VERIFICATION_BASELINE_VERIFIER_VERSION_MISSING'],
    ['empty verifier version', { verifierVersion: '', verificationPolicyVersion: VERIFICATION_POLICY_VERSION }, 'VERIFICATION_BASELINE_VERIFIER_VERSION_MISSING'],
    ['missing policy version', { verifierVersion: TASK_VERIFIER_VERSION }, 'VERIFICATION_BASELINE_POLICY_VERSION_MISSING'],
    ['empty policy version', { verifierVersion: TASK_VERIFIER_VERSION, verificationPolicyVersion: '' }, 'VERIFICATION_BASELINE_POLICY_VERSION_MISSING'],
  ])('rejects a baseline with %s', async (_name, fields, error) => {
    const root = await mkdtemp(join(tmpdir(), 'chain-sieve-invalid-baseline-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    const text = `${JSON.stringify({ schemaVersion: '1.1.0', taskId: 'T-G0-CORE', ...fields })}\n`;
    const path = join(root, '.git/ciag-runtime/verification-baselines/T-G0-CORE/baseline.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
    const state = expired().tasks['T-G0-CORE']!;
    state.verificationBaseline = { path: 'verification-baselines/T-G0-CORE/baseline.json', sha256: sha256(text), status: 'CURRENT' };
    await expect(readVerificationBaseline(root, state)).rejects.toThrow(error);
  });

  it.each([
    ['wrong verifier version', { verifierVersion: 'wrong', verificationPolicyVersion: VERIFICATION_POLICY_VERSION }, 'VERIFICATION_BASELINE_VERIFIER_VERSION_MISMATCH'],
    ['wrong policy version', { verifierVersion: TASK_VERIFIER_VERSION, verificationPolicyVersion: 'wrong' }, 'VERIFICATION_BASELINE_POLICY_VERSION_MISMATCH'],
  ])('rejects a baseline with %s', async (_name, fields, error) => {
    const root = await mkdtemp(join(tmpdir(), 'chain-sieve-wrong-baseline-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    const text = `${JSON.stringify({ schemaVersion: '1.1.0', taskId: 'T-G0-CORE', ...fields })}\n`;
    const path = join(root, '.git/ciag-runtime/verification-baselines/T-G0-CORE/baseline.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
    const state = expired().tasks['T-G0-CORE']!;
    state.lifecycleBinding = { path: 'binding.json', sha256: 'a'.repeat(64), status: 'CURRENT' };
    state.verificationBaseline = { path: 'verification-baselines/T-G0-CORE/baseline.json', sha256: sha256(text), status: 'CURRENT' };
    await expect(validateVerificationBaseline(root, state)).rejects.toThrow(error);
  });

  it('serializes authoritative mutations and permits a retry after lock release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chain-sieve-lifecycle-lock-'));
    temporary.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    const release = await acquireLifecycleMutationLock(root);
    await expect(acquireLifecycleMutationLock(root)).rejects.toThrow('LIFECYCLE_MUTATION_IN_PROGRESS');
    await release();
    await symlink('999999999:0', join(runtimeRoot(root), 'lifecycle-mutation.lock'));
    const retryRelease = await acquireLifecycleMutationLock(root);
    await retryRelease();
  });

  it('preserves one immutable legacy contract/context authority through every protected transition', () => {
    const state = expired();
    const target = state.tasks['T-G0-CORE']!;
    target.expiresAt = '2099-01-01T00:00:00.000Z';
    target.lifecycleBinding = { path: 'lifecycle-bindings/core.json', sha256: '1'.repeat(64), status: 'CURRENT' };
    target.verificationBaseline = { path: 'verification-baselines/core.json', sha256: '2'.repeat(64), status: 'CURRENT' };
    const credential = { taskId: target.taskId, holder: target.holder!, leaseId: target.leaseId!, fencingVersion: 1 };
    const commit = '3'.repeat(40);
    const tree = '4'.repeat(40);
    const evidence = { path: 'evidence.json', sha256: '5'.repeat(64), status: 'CURRENT' as const, commit, tree };
    const expected = { lifecycleBinding: structuredClone(target.lifecycleBinding), verificationBaseline: structuredClone(target.verificationBaseline) };
    transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING', { command: 'task:self-review', credential, evidence });
    target.selfReviewEvidence = evidence;
    expect(target).toMatchObject(expected);
    transition(target, ['SELF_REVIEWING'], 'VERIFYING', { command: 'trusted-root:task:verify', credential, evidence, currentCommit: commit, currentTree: tree });
    expect(target).toMatchObject(expected);
    target.taskResultEvidence = evidence;
    transition(target, ['VERIFYING'], 'VERIFIED', { command: 'trusted-root:task:verify:proof-carrying', credential, evidence, currentCommit: commit, currentTree: tree });
    target.commit = commit;
    target.tree = tree;
    expect(target).toMatchObject(expected);
    transition(target, ['VERIFIED'], 'MERGE_QUEUED', { command: 'merge-queue:add', credential, currentCommit: commit, currentTree: tree });
    expect(target).toMatchObject(expected);
    transition(target, ['MERGE_QUEUED'], 'MERGED', { command: 'merge-queue:process', credential, mergeQueueProcessed: true });
    expect(target).toMatchObject(expected);
  });
});
