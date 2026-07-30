import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClusterContract, TaskContract } from '@ciag/shared-schemas';
import { describe, expect, it } from 'vitest';
import {
  copyPayload,
  detectZCodeApplication,
  openZCodeWorkspace,
} from '../../tools/zcode/lib/desktop.js';
import { topologicalOrder } from '../../tools/zcode/lib/discovery.js';
import {
  decideNextAction,
  dependencyReadyClusters,
  runnableTasks,
  statusView,
} from '../../tools/zcode/lib/engine.js';
import {
  assertClusterWorktree,
  assertRootControlPlane,
  completionCommandPlan,
  renewalRequired,
  verifyAndIntegrateTask,
} from '../../tools/zcode/lib/executor.js';
import {
  classifyPullRequest,
  createClusterPullRequest,
  findClusterPullRequest,
} from '../../tools/zcode/lib/github.js';
import { findRepositoryRoot } from '../../tools/zcode/lib/paths.js';
import {
  generateGoal,
  generatePayload,
  persistGoalAndPayload,
  validateLaunchReceipt,
} from '../../tools/zcode/lib/runtime.js';
import type {
  ClusterRecord,
  CommandResult,
  CommandRunner,
  PayloadBinding,
  ProjectInventory,
  PullRequestState,
  TaskRecord,
} from '../../tools/zcode/lib/types.js';

const hash = 'a'.repeat(64);
const commit = '1'.repeat(40);
const tree = '2'.repeat(40);
const future = '2099-01-01T00:00:00.000Z';

const contract = (
  id: string,
  group: string,
  cluster: string,
  dependencies: string[] = [],
  lock = `${id}/lock`,
): TaskContract =>
  ({
    schemaVersion: '1.0.0',
    id,
    title: id,
    sourceHashes: { prd: hash, requirements: hash, audit: hash },
    dependencyGroup: group,
    cluster,
    riskLevel: 'HIGH',
    autonomyLevel: 'REVIEW_REQUIRED',
    dependencies,
    requirements: [`FR-${id}`],
    acceptanceCriteria: [`AC-${id}`],
    invariants: ['INV-001'],
    adrs: ['ADR-001'],
    ownerPackages: ['packages/domain'],
    readSet: ['docs/spec/**'],
    writeSet: ['packages/domain/**'],
    allowedPaths: ['packages/domain/**', 'tests/**'],
    forbiddenPaths: ['docs/spec/**'],
    exclusiveLocks: [lock],
    interfaceHashes: { [`${id}:contract`]: hash },
    deliverables: ['implementation'],
    constraints: ['preserve contract'],
    nonGoals: ['no activation'],
    degradedBehavior: 'fail closed',
    rollback: 'revert',
    requiredTests: [`tests/${id}.spec.ts`],
    verificationCommands: [{ command: `pnpm test ${id}`, expected: 'pass' }],
    complexityBudget: {
      maxFiles: 10,
      maxChangedLines: 1000,
      maxCyclomaticComplexity: 10,
    },
    changeBudget: {
      maxMigrations: 0,
      maxPublicInterfaces: 1,
      requiresSplitAboveBudget: true,
    },
    stopConditions: ['stop on drift'],
    completionDefinition: ['verified'],
    sourceReferences: [{ path: 'docs/spec/prd.md', line: 1, id: `FR-${id}` }],
  }) as TaskContract;

const clusterContract = (
  id: string,
  group: string,
  tasks: string[],
  dependencies: string[] = [],
): ClusterContract => ({
  schemaVersion: '1.0.0',
  id,
  group,
  title: id,
  sourceHashes: { prd: hash, requirements: hash, audit: hash },
  dependencies,
  tasks,
  requirements: tasks.map((id) => `FR-${id}`),
  acceptanceCriteria: tasks.map((id) => `AC-${id}`),
  invariants: ['INV-001'],
  entryCriteria: ['dependencies complete'],
  exitCriteria: ['verified'],
  verificationCommands: [
    { command: `pnpm cluster:verify ${id}`, expected: 'pass' },
  ],
  rollback: 'revert',
});

const clusterRecord = (
  value: ClusterContract,
  state: ClusterRecord['state'],
): ClusterRecord => ({
  contract: value,
  contractPath: `clusters/${value.group}/${value.id}.contract.json`,
  goalPath: `clusters/${value.group}/${value.id}.zcode-goal.md`,
  branch: {
    branch: `cluster/${value.group.toLowerCase()}`,
    integrationTarget: 'main',
    worktree: `/tmp/Chain Sieve Worktrees/${value.group.toLowerCase()}`,
  },
  state,
  branchHead: commit,
  worktreeHead: commit,
  worktreeBranch: `cluster/${value.group.toLowerCase()}`,
  worktreeDirty: false,
  worktreeChanges: [],
  worktreeRegistered: true,
  worktreeForeign: false,
});

const taskRecord = (
  value: TaskContract,
  cluster: ClusterRecord,
  state: TaskRecord['state']['state'] = 'READY',
  priority = 0,
): TaskRecord => ({
  contract: value,
  contractPath: `tasks/${value.dependencyGroup}/${value.id}.contract.json`,
  contextPath: `artifacts/context/${value.id}`,
  contextManifestPath: `artifacts/context/${value.id}/context-manifest.json`,
  contextManifestSha256: hash,
  cluster,
  state: { taskId: value.id, state, leaseVersion: 0, history: [] },
  dependencyWave: Number(value.dependencyGroup.slice(1)),
  priority,
  workspace: `${cluster.branch.worktree}/.worktrees/${value.id}`,
  workspaceExists: false,
});

const fixture = (): ProjectInventory => {
  const c0 = clusterRecord(
    clusterContract('C-G0-IMPLEMENTATION', 'G0', ['T-G0-A', 'T-G0-B']),
    'READY',
  );
  const c1 = clusterRecord(
    clusterContract(
      'C-G1-IMPLEMENTATION',
      'G1',
      ['T-G1-A', 'T-G1-B'],
      [c0.contract.id],
    ),
    'UNPREPARED',
  );
  delete c1.branchHead;
  delete c1.worktreeHead;
  c1.worktreeRegistered = false;
  const c2 = clusterRecord(
    clusterContract(
      'C-G2-IMPLEMENTATION',
      'G2',
      ['T-G2-A', 'T-G2-B'],
      [c0.contract.id, c1.contract.id],
    ),
    'UNPREPARED',
  );
  delete c2.branchHead;
  delete c2.worktreeHead;
  c2.worktreeRegistered = false;
  const tasks = [
    taskRecord(contract('T-G0-A', 'G0', c0.contract.id), c0, 'READY', 2),
    taskRecord(contract('T-G0-B', 'G0', c0.contract.id), c0, 'READY', 1),
    taskRecord(
      contract('T-G1-A', 'G1', c1.contract.id, ['T-G0-A', 'T-G0-B']),
      c1,
      'DRAFT',
    ),
    taskRecord(
      contract('T-G1-B', 'G1', c1.contract.id, ['T-G0-A', 'T-G0-B']),
      c1,
      'DRAFT',
      1,
    ),
    taskRecord(
      contract('T-G2-A', 'G2', c2.contract.id, ['T-G1-A', 'T-G1-B']),
      c2,
      'DRAFT',
    ),
    taskRecord(
      contract('T-G2-B', 'G2', c2.contract.id, ['T-G1-A', 'T-G1-B']),
      c2,
      'DRAFT',
      1,
    ),
  ];
  return {
    root: '/tmp/Chain Sieve',
    rootBranch: 'main',
    rootHead: commit,
    rootTree: tree,
    rootDirty: false,
    rootChanges: [],
    worktreeRoot: '/tmp/Chain Sieve Worktrees',
    release: { tag: 'harness-v1.0.1', tagObject: commit, commit, tree },
    clusters: [c0, c1, c2],
    tasks,
    coverage: {
      requirements: { accounted: 6, total: 6, missing: [] },
      acceptanceCriteria: { accounted: 6, total: 6, missing: [] },
    },
    clusterOrder: [c0.contract.id, c1.contract.id, c2.contract.id],
  };
};

const activate = (
  inventory: ProjectInventory,
  id: string,
  state: TaskRecord['state']['state'],
  options: {
    dirty?: boolean;
    commits?: number;
    expiresAt?: string;
    version?: number;
  } = {},
): TaskRecord => {
  const task = inventory.tasks.find(
    (candidate) => candidate.contract.id === id,
  )!;
  task.state = {
    taskId: id,
    state,
    leaseVersion: options.version ?? 1,
    leaseId: `${id}:lease`,
    holder: 'zcode-orchestrator',
    expiresAt: options.expiresAt ?? future,
    leaseState: 'ACTIVE',
    baseCommit: commit,
    branch: `task/${id.toLowerCase()}`,
    worktree: task.workspace,
    history: [],
  };
  task.workspaceExists = true;
  task.workspaceBranch = `task/${id.toLowerCase()}`;
  task.workspaceHead = options.commits ? '3'.repeat(40) : commit;
  task.workspaceTree = tree;
  task.workspaceDirty = options.dirty ?? false;
  task.workspaceChanges = options.dirty
    ? [' M packages/domain/src/index.ts']
    : [];
  task.commitCountFromBase = options.commits ?? 0;
  inventory.activeTask = task;
  task.cluster.state = 'ACTIVE';
  return task;
};

class FakeRunner implements CommandRunner {
  calls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    input?: string;
  }> = [];
  responses: CommandResult[] = [];

  run(
    command: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): CommandResult {
    this.calls.push({
      command,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    return this.responses.shift() ?? { status: 0, stdout: '', stderr: '' };
  }
}

describe('project-wide ZCode decision engine', () => {
  it('uses one source across a three-cluster cross-dependency fixture and selects the first task', () => {
    const inventory = fixture();
    const decision = decideNextAction(inventory);
    expect(decision.action).toBe('START_TASK');
    expect(decision.task?.contract.id).toBe('T-G0-B');
    expect(decision.task?.workspace).toContain('/tmp/Chain Sieve Worktrees/');
    expect(decision.task?.workspace).not.toContain(
      inventory.root + '/.worktrees',
    );
  });

  it('resumes the active task and never selects another task', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'LEASED');
    const decision = decideNextAction(inventory);
    expect(decision.action).toBe('RESUME_TASK');
    expect(decision.task?.contract.id).toBe('T-G0-A');
  });

  it('continues unfinished implementation with dirty source', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'IMPLEMENTING', { dirty: true });
    expect(decideNextAction(inventory).action).toBe('CONTINUE_TASK');
  });

  it('continues unfinished implementation with an unverified commit', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'IMPLEMENTING', { commits: 1 });
    expect(decideNextAction(inventory).action).toBe('CONTINUE_TASK');
  });

  it('reuses a valid fenced lease', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'LEASED', { version: 4 });
    expect(decideNextAction(inventory).reason).toBe('LEASED_TASK_AWAITS_BEGIN');
  });

  it('renews only within the deterministic renewal window', () => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', 'LEASED', {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(renewalRequired(task)).toBe(true);
    task.state.expiresAt = future;
    expect(renewalRequired(task)).toBe(false);
  });

  it('stops on an expired lease without editing lifecycle state', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'IMPLEMENTING', {
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(decideNextAction(inventory)).toMatchObject({
      action: 'STOP',
      reason: 'LEASE_EXPIRED:AUTHORITATIVE_RECOVERY_REQUIRED',
    });
  });

  it('rejects stale or missing fencing', () => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', 'LEASED', { version: 0 });
    delete task.state.leaseId;
    expect(decideNextAction(inventory).reason).toBe(
      'LEASE_OR_FENCING_BINDING_INVALID',
    );
  });

  it('does not bypass an active path-lock owner', () => {
    const inventory = fixture();
    const active = activate(inventory, 'T-G0-A', 'IMPLEMENTING');
    inventory.tasks[1]!.contract.exclusiveLocks =
      active.contract.exclusiveLocks;
    expect(decideNextAction(inventory).task?.contract.id).toBe(
      active.contract.id,
    );
  });

  it('detects non-atomic completion and generates correction', () => {
    const inventory = fixture();
    activate(inventory, 'T-G0-A', 'SELF_REVIEWING', { commits: 2 });
    expect(decideNextAction(inventory).action).toBe('CORRECT_TASK');
  });

  it('rejects wrong-commit evidence before merge queue admission', () => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', 'VERIFIED', { commits: 1 });
    task.state.commit = commit;
    task.state.tree = tree;
    task.state.taskResultEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'CURRENT',
      commit,
      tree,
    };
    task.state.verificationEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'CURRENT',
      commit,
      tree,
    };
    expect(decideNextAction(inventory).reason).toBe(
      'TASK_RESULT_GENERATED_FOR_ANOTHER_COMMIT',
    );
  });

  it('rejects wrong-tree evidence before merge queue admission', () => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', 'VERIFIED', { commits: 1 });
    const head = task.workspaceHead!;
    const wrongTree = '9'.repeat(40);
    task.state.commit = head;
    task.state.tree = wrongTree;
    task.state.taskResultEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'CURRENT',
      commit: head,
      tree: wrongTree,
    };
    task.state.verificationEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'CURRENT',
      commit: head,
      tree: wrongTree,
    };
    expect(decideNextAction(inventory).reason).toBe(
      'TASK_RESULT_GENERATED_FOR_ANOTHER_TREE',
    );
  });

  it('rejects forged or stale proof references before merge queue admission', () => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', 'VERIFIED', { commits: 1 });
    const head = task.workspaceHead!;
    const headTree = task.workspaceTree!;
    task.state.commit = head;
    task.state.tree = headTree;
    task.state.taskResultEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'STALE',
      commit: head,
      tree: headTree,
    };
    task.state.verificationEvidence = {
      path: 'results/result.json',
      sha256: hash,
      status: 'STALE',
      commit: head,
      tree: headTree,
    };
    expect(decideNextAction(inventory).reason).toBe(
      'TASK_EVIDENCE_MISSING_OR_STALE',
    );
  });

  it.each([
    [
      'SELF_REVIEWING',
      [
        'task:verify',
        'merge-queue:add',
        'merge-queue:process',
        'worktree:cleanup',
      ],
    ],
    [
      'VERIFIED',
      ['merge-queue:add', 'merge-queue:process', 'worktree:cleanup'],
    ],
    ['MERGE_QUEUED', ['merge-queue:process', 'worktree:cleanup']],
  ] as const)('plans real completion commands for %s', (state, expected) => {
    const inventory = fixture();
    const task = activate(inventory, 'T-G0-A', state);
    expect(completionCommandPlan(task)).toEqual(expected);
  });

  it('automatically chooses the next task after a merge', () => {
    const inventory = fixture();
    inventory.tasks.find((task) => task.contract.id === 'T-G0-B')!.state.state =
      'MERGED';
    expect(decideNextAction(inventory).task?.contract.id).toBe('T-G0-A');
  });

  it('moves the final task in a cluster to independent review', () => {
    const inventory = fixture();
    for (const task of inventory.tasks.filter(
      (task) => task.contract.cluster === 'C-G0-IMPLEMENTATION',
    ))
      task.state.state = 'MERGED';
    inventory.clusters[0]!.state = 'REVIEW_REQUIRED';
    expect(decideNextAction(inventory).action).toBe('REVIEW_CLUSTER');
  });

  it('runs cluster verification only after review evidence exists', () => {
    const inventory = fixture();
    for (const task of inventory.tasks.filter(
      (task) => task.contract.cluster === 'C-G0-IMPLEMENTATION',
    ))
      task.state.state = 'MERGED';
    inventory.clusters[0]!.state = 'VERIFYING';
    expect(decideNextAction(inventory).action).toBe('VERIFY_CLUSTER');
  });

  it('discovers the next cluster after dependency completion', () => {
    const inventory = fixture();
    for (const task of inventory.tasks.filter(
      (task) => task.contract.cluster === 'C-G0-IMPLEMENTATION',
    ))
      task.state.state = 'MERGED';
    inventory.clusters[0]!.state = 'COMPLETE';
    const decision = decideNextAction(inventory);
    expect(decision.action).toBe('INITIALIZE_CLUSTER');
    expect(decision.cluster?.contract.id).toBe('C-G1-IMPLEMENTATION');
  });

  it('supports multiple cluster transitions with the same source', () => {
    const inventory = fixture();
    for (const cluster of inventory.clusters.slice(0, 2))
      cluster.state = 'COMPLETE';
    for (const task of inventory.tasks.filter(
      (task) => task.contract.dependencyGroup !== 'G2',
    ))
      task.state.state = 'MERGED';
    expect(
      dependencyReadyClusters(inventory).map((cluster) => cluster.contract.id),
    ).toEqual(['C-G2-IMPLEMENTATION']);
  });

  it('replays three clusters through a failed task, cluster failure, and CI retry without source changes', () => {
    const inventory = fixture();
    expect(decideNextAction(inventory).task?.contract.id).toBe('T-G0-B');

    const failedTask = activate(inventory, 'T-G0-B', 'SELF_REVIEWING', {
      dirty: true,
      commits: 1,
    });
    expect(decideNextAction(inventory).action).toBe('CORRECT_TASK');
    delete inventory.activeTask;
    failedTask.state.state = 'MERGED';
    failedTask.workspaceDirty = false;
    expect(decideNextAction(inventory).task?.contract.id).toBe('T-G0-A');

    inventory.tasks.find((task) => task.contract.id === 'T-G0-A')!.state.state =
      'MERGED';
    inventory.clusters[0]!.state = 'VERIFYING';
    expect(decideNextAction(inventory).action).toBe('VERIFY_CLUSTER');
    expect(decideNextAction(inventory).cluster?.contract.id).toBe(
      'C-G0-IMPLEMENTATION',
    );

    inventory.clusters[0]!.state = 'READY';
    expect(decideNextAction(inventory).action).toBe('CREATE_CLUSTER_PR');
    const pending: PullRequestState & { mergeStateStatus: string } = {
      number: 1,
      url: 'https://example.test/pr/1',
      state: 'OPEN',
      checks: [{ name: 'CI', state: 'PENDING', required: true }],
      mergeStateStatus: 'BLOCKED',
    };
    expect(classifyPullRequest(pending)).toBe('PENDING');
    pending.checks[0]!.state = 'FAIL';
    expect(classifyPullRequest(pending)).toBe('FAILED');
    pending.checks[0]!.state = 'PASS';
    pending.mergeStateStatus = 'CLEAN';
    expect(classifyPullRequest(pending)).toBe('READY');

    inventory.clusters[0]!.state = 'COMPLETE';
    expect(decideNextAction(inventory).cluster?.contract.id).toBe(
      'C-G1-IMPLEMENTATION',
    );
    for (const task of inventory.tasks.filter(
      (task) => task.contract.dependencyGroup === 'G1',
    ))
      task.state.state = 'MERGED';
    inventory.clusters[1]!.state = 'COMPLETE';
    expect(decideNextAction(inventory).cluster?.contract.id).toBe(
      'C-G2-IMPLEMENTATION',
    );
  });

  it('reports all-cluster completion idempotently', () => {
    const inventory = fixture();
    for (const cluster of inventory.clusters) cluster.state = 'COMPLETE';
    for (const task of inventory.tasks) task.state.state = 'MERGED';
    expect(decideNextAction(inventory).action).toBe('COMPLETE_PROJECT');
    expect(decideNextAction(inventory).action).toBe('COMPLETE_PROJECT');
  });

  it('stops on unresolved blocked tasks', () => {
    const inventory = fixture();
    for (const task of inventory.tasks.filter(
      (task) => task.contract.cluster === 'C-G0-IMPLEMENTATION',
    ))
      task.state.state = 'BLOCKED';
    expect(decideNextAction(inventory).reason).toContain(
      'UNRESOLVED_BLOCKED_TASKS',
    );
  });

  it('orders runnable tasks by wave, repository priority, then stable ID', () => {
    const inventory = fixture();
    expect(
      runnableTasks(inventory, inventory.clusters[0]!).map(
        (task) => task.contract.id,
      ),
    ).toEqual(['T-G0-B', 'T-G0-A']);
  });
});

describe('graph, omission, and safety safeguards', () => {
  it('rejects cyclic task and cluster graphs', () => {
    expect(() =>
      topologicalOrder(
        ['a', 'b'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
        'TASK_GRAPH',
      ),
    ).toThrow('TASK_GRAPH_CYCLIC');
  });

  it('rejects graph task omission and unknown nodes', () => {
    expect(() =>
      topologicalOrder(['a'], [{ from: 'a', to: 'missing' }], 'TASK_GRAPH'),
    ).toThrow('TASK_GRAPH_UNKNOWN_NODE');
  });

  it('retains dynamic requirement and acceptance totals in status', () => {
    const inventory = fixture();
    const status = statusView(inventory);
    expect(status.totalTasks).toBe(6);
    expect(inventory.coverage.requirements).toEqual({
      accounted: 6,
      total: 6,
      missing: [],
    });
    expect(inventory.coverage.acceptanceCriteria).toEqual({
      accounted: 6,
      total: 6,
      missing: [],
    });
  });

  it('rejects a dirty root checkout and lists its changes', () => {
    const inventory = fixture();
    inventory.rootDirty = true;
    inventory.rootChanges = [' M package.json'];
    expect(() => assertRootControlPlane(inventory, false)).toThrow(
      'DIRTY_ROOT_CHECKOUT',
    );
  });

  it('allows a clean tooling branch only for dry-run', () => {
    const inventory = fixture();
    inventory.rootBranch = 'tooling/project-zcode-orchestrator';
    expect(() => assertRootControlPlane(inventory, true)).not.toThrow();
    expect(() => assertRootControlPlane(inventory, false)).toThrow(
      'ROOT_MAIN_REQUIRED',
    );
  });

  it.each([
    [
      'dirty worktree',
      (cluster: ClusterRecord) => (cluster.worktreeDirty = true),
      'DIRTY_CLUSTER_WORKTREE',
    ],
    [
      'wrong branch',
      (cluster: ClusterRecord) => (cluster.worktreeBranch = 'main'),
      'WRONG_CLUSTER_BRANCH',
    ],
    [
      'wrong worktree',
      (cluster: ClusterRecord) => (cluster.worktreeForeign = true),
      'WRONG_WORKTREE_REPOSITORY',
    ],
  ])('rejects %s', (_name, mutate, code) => {
    const cluster = fixture().clusters[0]!;
    mutate(cluster);
    expect(() => assertClusterWorktree(cluster)).toThrow(code);
  });

  it('resolves the root safely from a different current directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'zcode-root-'));
    mkdirSync(join(root, 'tasks/generated'), { recursive: true });
    mkdirSync(join(root, 'clusters'), { recursive: true });
    mkdirSync(join(root, 'nested/path'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'tasks/generated/graph.json'), '{}\n');
    expect(findRepositoryRoot(join(root, 'nested/path'))).toBe(root);
  });
});

describe('payload, receipt, desktop, GitHub, CI, and no-mutation adapters', () => {
  const binding = (
    inventory: ProjectInventory,
    task: TaskRecord,
  ): PayloadBinding => ({
    task,
    release: inventory.release,
    taskWorkspace: task.workspace,
    leaseId: 'lease-1',
    holder: 'zcode-orchestrator',
    fencingVersion: 3,
    expiresAt: future,
    baseCommit: commit,
    baseTree: tree,
    goalPath: '/tmp/Chain Sieve Goal.md',
    goalSha256: hash,
    contextManifestPath: task.contextManifestPath,
    contextManifestSha256: task.contextManifestSha256,
    failures: [],
  });

  it('includes every proof-carrying task binding and paths containing spaces', () => {
    const inventory = fixture();
    const value = binding(inventory, inventory.tasks[0]!);
    const goal = generateGoal(value);
    const payload = generatePayload(value);
    for (const expected of [
      value.task.contract.id,
      value.task.contract.cluster,
      value.task.cluster.branch.branch,
      value.taskWorkspace,
      value.release.commit,
      value.leaseId,
      String(value.fencingVersion),
      value.contextManifestSha256,
      value.task.contract.requirements[0]!,
      value.task.contract.acceptanceCriteria[0]!,
      'exactly one atomic',
      'merge queue',
    ])
      expect(`${goal}\n${payload}`).toContain(expected);
  });

  it('persists and validates immutable goal/context/lease receipts', async () => {
    const inventory = fixture();
    const root = mkdtempSync(join(tmpdir(), 'zcode-receipt-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const runner = new FakeRunner();
    runner.responses.push(
      { status: 0, stdout: '.git\n', stderr: '' },
      { status: 0, stdout: '.git\n', stderr: '' },
    );
    const task = inventory.tasks[0]!;
    const value = binding(inventory, task);
    const { binding: stored } = await persistGoalAndPayload(root, runner, {
      ...value,
      failures: [],
    });
    expect(readFileSync(stored.goalPath, 'utf8')).toContain(task.contract.id);
    await expect(
      validateLaunchReceipt(root, runner, {
        taskId: task.contract.id,
        clusterId: task.contract.cluster,
        leaseId: value.leaseId,
        fencingVersion: value.fencingVersion,
        contextManifestSha256: value.contextManifestSha256,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects forged or stale launch evidence', async () => {
    const inventory = fixture();
    const root = mkdtempSync(join(tmpdir(), 'zcode-forged-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const runner = new FakeRunner();
    runner.responses.push(
      { status: 0, stdout: '.git\n', stderr: '' },
      { status: 0, stdout: '.git\n', stderr: '' },
    );
    const task = inventory.tasks[0]!;
    const value = binding(inventory, task);
    const stored = await persistGoalAndPayload(root, runner, value);
    writeFileSync(stored.binding.goalPath, 'forged\n');
    await expect(
      validateLaunchReceipt(root, runner, {
        taskId: task.contract.id,
        clusterId: task.contract.cluster,
        leaseId: value.leaseId,
        fencingVersion: value.fencingVersion,
        contextManifestSha256: value.contextManifestSha256,
      }),
    ).rejects.toThrow('LAUNCH_RECEIPT_GOAL_HASH_MISMATCH');
  });

  it('mocks clipboard and ZCode opening without starting the application', () => {
    const runner = new FakeRunner();
    copyPayload(runner, '/goal test');
    openZCodeWorkspace(
      runner,
      '/Applications/ZCode.app',
      '/tmp/Path With Spaces',
    );
    expect(runner.calls).toEqual([
      { command: 'pbcopy', args: [], input: '/goal test' },
      {
        command: 'open',
        args: ['-a', '/Applications/ZCode.app', '/tmp/Path With Spaces'],
      },
    ]);
  });

  it('fails deterministically on clipboard errors', () => {
    const runner = new FakeRunner();
    runner.responses.push({
      status: 1,
      stdout: '',
      stderr: 'clipboard unavailable',
    });
    expect(() => copyPayload(runner, '/goal test')).toThrow('CLIPBOARD_FAILED');
  });

  it('detects a missing ZCode application without launching anything', () => {
    expect(
      detectZCodeApplication(['/definitely/missing/ZCode.app']),
    ).toBeUndefined();
  });

  it('mocks cluster PR creation', () => {
    const runner = new FakeRunner();
    runner.responses.push(
      { status: 0, stdout: 'https://example.test/pr/1\n', stderr: '' },
      {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 1,
            url: 'https://example.test/pr/1',
            state: 'OPEN',
            statusCheckRollup: [],
          },
        ]),
        stderr: '',
      },
    );
    const pr = createClusterPullRequest(
      runner,
      '/tmp/repo',
      fixture().clusters[0]!,
    );
    expect(pr.url).toBe('https://example.test/pr/1');
    expect(runner.calls[0]?.args.slice(0, 2)).toEqual(['pr', 'create']);
  });

  it('invokes the real repository merge-queue and cleanup scripts', async () => {
    const inventory = fixture();
    const root = mkdtempSync(join(tmpdir(), 'zcode-merge-queue-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    inventory.root = root;
    const task = activate(inventory, 'T-G0-A', 'MERGE_QUEUED');
    const runner = new FakeRunner();
    runner.responses.push(
      { status: 0, stdout: JSON.stringify({ status: 'MERGED' }), stderr: '' },
      {
        status: 0,
        stdout: JSON.stringify({ removed: task.workspace }),
        stderr: '',
      },
      { status: 0, stdout: '.git\n', stderr: '' },
    );
    await verifyAndIntegrateTask(
      inventory,
      task,
      runner,
      async () => inventory,
    );
    expect(runner.calls.slice(0, 2).map((call) => call.args)).toEqual([
      ['--silent', 'merge-queue:process'],
      [
        '--silent',
        'worktree:cleanup',
        task.contract.id,
        '--source-worktree',
        task.cluster.branch.worktree,
      ],
    ]);
    expect(runner.calls[1]?.cwd).toBe(root);
  });

  it('mocks existing PR lookup', () => {
    const runner = new FakeRunner();
    runner.responses.push({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 2,
          url: 'https://example.test/pr/2',
          state: 'OPEN',
          statusCheckRollup: [
            { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        },
      ]),
      stderr: '',
    });
    expect(
      findClusterPullRequest(runner, '/tmp/repo', fixture().clusters[0]!)
        ?.checks[0]?.state,
    ).toBe('PASS');
  });

  it.each([
    ['PENDING', [{ name: 'CI', state: 'PENDING', required: true }], 'PENDING'],
    ['FAIL', [{ name: 'CI', state: 'FAIL', required: true }], 'FAILED'],
    ['SUCCESS', [{ name: 'CI', state: 'PASS', required: true }], 'READY'],
  ] as const)(
    'classifies CI %s without weakening checks',
    (_name, checks, expected) => {
      const pr: PullRequestState & { mergeStateStatus: string } = {
        number: 1,
        url: 'https://example.test/pr/1',
        state: 'OPEN',
        checks: checks.map((check) => ({ ...check })),
        mergeStateStatus: expected === 'READY' ? 'CLEAN' : 'BLOCKED',
      };
      expect(classifyPullRequest(pr)).toBe(expected);
    },
  );

  it('keeps a new PR pending until at least one required check is observed', () => {
    expect(
      classifyPullRequest({
        number: 1,
        url: 'https://example.test/pr/1',
        state: 'OPEN',
        checks: [],
        mergeStateStatus: 'CLEAN',
      }),
    ).toBe('PENDING');
  });

  it('keeps dry-run and status decisions free of adapter calls', () => {
    const inventory = fixture();
    const runner = new FakeRunner();
    const before = JSON.stringify(inventory);
    decideNextAction(inventory);
    statusView(inventory);
    expect(JSON.stringify(inventory)).toBe(before);
    expect(runner.calls).toHaveLength(0);
  });
});
