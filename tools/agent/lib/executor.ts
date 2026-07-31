import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readTaskResult } from '../../task-verifier/verify.js';
import { validateTaskAttestation } from '../../task-verifier/attestation.js';
import { discoverProject } from './discovery.js';
import { decideNextAction } from './engine.js';
import { ZCodeError } from './errors.js';
import { ZCodeProvider } from '../providers/zcode.js';
import {
  classifyPullRequest,
  createClusterPullRequest,
  findClusterPullRequest,
  mergePullRequest,
  refreshPullRequest,
} from './github.js';
import {
  persistGoalAndPayload,
  persistProjectMapping,
  sha256,
  validateLaunchReceipt,
  agentRuntimeRoot,
} from './runtime.js';
import {
  isManagedTaskWorkspace,
  taskBranch,
  taskWorkspacePath,
} from './paths.js';
import type {
  AgentProvider,
  ClusterRecord,
  CommandResult,
  CommandRunner,
  Decision,
  PayloadBinding,
  ProjectInventory,
  TaskRecord,
} from './types.js';

const NEW_TASK_HOLDER = 'agent-orchestrator';
const RENEWAL_WINDOW_MS = 5 * 60 * 1000;

const concise = (value: string): string =>
  value.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 240) ??
  'unknown failure';

const requireSuccess = (
  result: CommandResult,
  code: string,
  command: string,
): string => {
  if (result.status !== 0)
    throw new ZCodeError(
      code,
      command,
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean),
    );
  return result.stdout.trim();
};

const runPnpm = (
  runner: CommandRunner,
  cwd: string,
  args: string[],
  code = 'PNPM_COMMAND_FAILED',
): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], { cwd }),
    code,
    `pnpm ${args.join(' ')}`,
  );

const parseJsonOutput = <T>(value: string, code: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ZCodeError(code, concise(value));
  }
};

export const assertRootControlPlane = (
  inventory: ProjectInventory,
  allowNonMain: boolean,
): void => {
  if (inventory.rootDirty)
    throw new ZCodeError(
      'DIRTY_ROOT_CHECKOUT',
      inventory.root,
      inventory.rootChanges,
    );
  if (!allowNonMain && inventory.rootBranch !== 'main')
    throw new ZCodeError('ROOT_MAIN_REQUIRED', inventory.rootBranch);
};

export const assertClusterWorktree = (cluster: ClusterRecord): void => {
  if (cluster.branch.branch === 'main')
    throw new ZCodeError('IMPLEMENTATION_BRANCH_IS_MAIN');
  if (cluster.worktreeForeign)
    throw new ZCodeError('WRONG_WORKTREE_REPOSITORY', cluster.branch.worktree);
  if (cluster.conflictingWorktree)
    throw new ZCodeError(
      'CLUSTER_BRANCH_ATTACHED_TO_CONFLICTING_WORKTREE',
      cluster.conflictingWorktree,
    );
  if (cluster.branchRemoteState === 'REMOTE_AHEAD')
    throw new ZCodeError(
      'CLUSTER_BRANCH_REMOTE_ADVANCEMENT',
      cluster.branch.branch,
    );
  if (cluster.branchRemoteState === 'DIVERGED')
    throw new ZCodeError(
      'CLUSTER_BRANCH_FORCE_UPDATE_OR_DIVERGENCE',
      cluster.branch.branch,
    );
  if (!cluster.worktreeRegistered)
    throw new ZCodeError(
      'CLUSTER_WORKTREE_NOT_REGISTERED',
      cluster.branch.worktree,
    );
  if (cluster.worktreeBranch !== cluster.branch.branch)
    throw new ZCodeError(
      'WRONG_CLUSTER_BRANCH',
      `${cluster.worktreeBranch ?? 'detached'}:${cluster.branch.branch}`,
    );
  if (cluster.worktreeDirty)
    throw new ZCodeError(
      'DIRTY_CLUSTER_WORKTREE',
      cluster.branch.worktree,
      cluster.worktreeChanges ?? [],
    );
  if (cluster.branchHead && cluster.worktreeHead !== cluster.branchHead)
    throw new ZCodeError(
      'CLUSTER_WORKTREE_HEAD_MISMATCH',
      `${cluster.worktreeHead ?? 'missing'}:${cluster.branchHead}`,
    );
};

const ensureProvider = (provider: AgentProvider): void => {
  const detection = provider.detect();
  if (!detection.available)
    throw new ZCodeError(
      provider.id === 'antigravity'
        ? 'ANTIGRAVITY_MISSING'
        : 'ZCODE_APPLICATION_MISSING',
      detection.detail,
    );
};

const synchronizeRemoteClusterAdvance = async (
  inventory: ProjectInventory,
  decision: Decision,
  runner: CommandRunner,
): Promise<ProjectInventory> => {
  const cluster = decision.cluster ?? decision.task?.cluster;
  if (!cluster || cluster.branchRemoteState !== 'REMOTE_AHEAD')
    return inventory;
  if (
    cluster.worktreeForeign ||
    !cluster.worktreeRegistered ||
    cluster.worktreeDirty ||
    cluster.worktreeBranch !== cluster.branch.branch
  )
    throw new ZCodeError(
      'CLUSTER_REMOTE_ADVANCE_CANNOT_FAST_FORWARD',
      cluster.branch.worktree,
      cluster.worktreeChanges ?? [],
    );
  requireSuccess(
    runner.run(
      'git',
      ['merge', '--ff-only', `refs/remotes/origin/${cluster.branch.branch}`],
      { cwd: cluster.branch.worktree },
    ),
    'CLUSTER_REMOTE_ADVANCE_FAST_FORWARD_FAILED',
    `git merge --ff-only refs/remotes/origin/${cluster.branch.branch}`,
  );
  return discoverProject(inventory.root, runner);
};

interface LeaseOutput {
  taskId: string;
  holder: string;
  leaseId: string;
  fencingVersion: number;
  expiresAt: string;
}

export const renewalRequired = (task: TaskRecord, now = Date.now()): boolean =>
  Boolean(
    task.state.expiresAt &&
    Date.parse(task.state.expiresAt) - now <= RENEWAL_WINDOW_MS,
  );

export const completionCommandPlan = (task: TaskRecord): string[] => {
  if (task.state.state === 'SELF_REVIEWING')
    return [
      'task:verify',
      'merge-queue:add',
      'merge-queue:process',
      'worktree:cleanup',
    ];
  if (task.state.state === 'VERIFIED')
    return ['merge-queue:add', 'merge-queue:process', 'worktree:cleanup'];
  if (task.state.state === 'MERGE_QUEUED')
    return ['merge-queue:process', 'worktree:cleanup'];
  return [];
};

const leaseForTask = async (
  inventory: ProjectInventory,
  task: TaskRecord,
  runner: CommandRunner,
  provider: AgentProvider,
  failures: string[] = [],
): Promise<{ binding: PayloadBinding; payload: string }> => {
  let currentInventory = inventory;
  let currentTask =
    currentInventory.tasks.find(
      (candidate) => candidate.contract.id === task.contract.id,
    ) ?? task;
  if (renewalRequired(currentTask)) {
    const state = currentTask.state;
    if (!state.holder || state.leaseVersion < 1)
      throw new ZCodeError('LEASE_CREDENTIAL_MISSING', task.contract.id);
    runPnpm(
      runner,
      currentTask.workspace!,
      [
        'task:renew',
        task.contract.id,
        '--holder',
        state.holder,
        '--lease-version',
        String(state.leaseVersion),
      ],
      'LEASE_RENEWAL_FAILED',
    );
    currentInventory = await discoverProject(inventory.root, runner);
    currentTask = currentInventory.tasks.find(
      (candidate) => candidate.contract.id === task.contract.id,
    )!;
  }
  const state = currentTask.state;
  if (
    !state.leaseId ||
    !state.holder ||
    !state.expiresAt ||
    !state.baseCommit ||
    state.leaseVersion < 1 ||
    state.leaseState !== 'ACTIVE'
  )
    throw new ZCodeError('ACTIVE_LEASE_BINDING_MISSING', task.contract.id);
  const baseTree = requireSuccess(
    runner.run('git', ['rev-parse', `${state.baseCommit}^{tree}`], {
      cwd: currentTask.workspace,
    }),
    'TASK_BASE_TREE_UNAVAILABLE',
    'git rev-parse base^{tree}',
  );
  return persistGoalAndPayload(inventory.root, runner, {
    task: currentTask,
    release: inventory.release,
    taskWorkspace: currentTask.workspace!,
    leaseId: state.leaseId,
    holder: state.holder,
    fencingVersion: state.leaseVersion,
    expiresAt: state.expiresAt,
    baseCommit: state.baseCommit,
    baseTree,
    contextManifestPath: currentTask.contextManifestPath,
    contextManifestSha256: currentTask.contextManifestSha256,
    ...(currentTask.conformanceManifestPath
      ? { conformanceManifestPath: currentTask.conformanceManifestPath }
      : {}),
    ...(currentTask.conformanceManifestSha256
      ? { conformanceManifestSha256: currentTask.conformanceManifestSha256 }
      : {}),
    failures,
  }, provider.id, (complete) => provider.generatePayload(complete));
};

export const assertTaskWorkspaceForLaunch = (
  inventory: ProjectInventory,
  task: TaskRecord,
  taskWorkspace: string,
): void => {
  if (
    taskWorkspace === inventory.root ||
    task.cluster.branch.branch === 'main' ||
    !isManagedTaskWorkspace(task.cluster.branch.worktree, taskWorkspace)
  )
    throw new ZCodeError(
      'IMPLEMENTATION_WORKSPACE_NOT_TASK_ISOLATED',
      taskWorkspace,
    );
};

const launchPayload = (
  provider: AgentProvider,
  inventory: ProjectInventory,
  task: TaskRecord,
  taskWorkspace: string,
  payload: string,
): void => {
  assertTaskWorkspaceForLaunch(inventory, task, taskWorkspace);
  provider.copyPayload(payload);
  provider.openWorkspace(taskWorkspace);
};

const initializeCluster = async (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
  runner: CommandRunner,
): Promise<ProjectInventory> => {
  if (cluster.branch.branch === 'main')
    throw new ZCodeError('IMPLEMENTATION_BRANCH_IS_MAIN');
  if (existsSync(cluster.branch.worktree))
    throw new ZCodeError('WORKTREE_PATH_CONFLICT', cluster.branch.worktree);
  await mkdir(dirname(cluster.branch.worktree), { recursive: true });
  const local =
    runner.run(
      'git',
      ['show-ref', '--verify', `refs/heads/${cluster.branch.branch}`],
      { cwd: inventory.root },
    ).status === 0;
  const remote =
    runner.run(
      'git',
      ['show-ref', '--verify', `refs/remotes/origin/${cluster.branch.branch}`],
      { cwd: inventory.root },
    ).status === 0;
  const baseRemote = `refs/remotes/origin/${cluster.branch.integrationTarget}`;
  const base =
    runner.run('git', ['show-ref', '--verify', baseRemote], {
      cwd: inventory.root,
    }).status === 0
      ? baseRemote
      : `refs/heads/${cluster.branch.integrationTarget}`;
  const args = local
    ? ['worktree', 'add', cluster.branch.worktree, cluster.branch.branch]
    : remote
      ? [
          'worktree',
          'add',
          '-b',
          cluster.branch.branch,
          cluster.branch.worktree,
          `refs/remotes/origin/${cluster.branch.branch}`,
        ]
      : [
          'worktree',
          'add',
          '-b',
          cluster.branch.branch,
          cluster.branch.worktree,
          base,
        ];
  requireSuccess(
    runner.run('git', args, { cwd: inventory.root }),
    'CLUSTER_WORKTREE_CREATE_FAILED',
    `git ${args.join(' ')}`,
  );
  runPnpm(
    runner,
    cluster.branch.worktree,
    ['install', '--frozen-lockfile'],
    'PNPM_INSTALL_FAILED',
  );
  let refreshed = await discoverProject(inventory.root, runner);
  const clusterTasks = refreshed.tasks
    .filter((task) => task.contract.cluster === cluster.contract.id)
    .sort((left, right) => left.contract.id.localeCompare(right.contract.id));
  for (const task of clusterTasks) {
    const current = (await discoverProject(inventory.root, runner)).tasks.find(
      (candidate) => candidate.contract.id === task.contract.id,
    )!;
    if (current.state.state === 'DRAFT')
      runPnpm(
        runner,
        cluster.branch.worktree,
        ['task:validate', task.contract.id],
        'TASK_VALIDATION_FAILED',
      );
    const validated = (
      await discoverProject(inventory.root, runner)
    ).tasks.find((candidate) => candidate.contract.id === task.contract.id)!;
    if (validated.state.state === 'VALIDATED')
      runPnpm(
        runner,
        cluster.branch.worktree,
        ['task:mark-ready', task.contract.id],
        'TASK_READY_TRANSITION_FAILED',
      );
  }
  refreshed = await discoverProject(inventory.root, runner);
  await persistProjectMapping(refreshed, runner);
  return refreshed;
};

export const startTask = async (
  inventory: ProjectInventory,
  task: TaskRecord,
  runner: CommandRunner,
  provider: AgentProvider = new ZCodeProvider(runner),
  initialized = false,
): Promise<void> => {
  ensureProvider(provider);
  assertClusterWorktree(task.cluster);
  if (task.workspaceExists && task.workspaceHead) {
    const expectedBranch = taskBranch(task.contract.id);
    if (task.state.state !== 'READY')
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_STATE_INVALID',
        task.state.state,
      );
    if (
      task.state.leaseState === 'ACTIVE' &&
      task.state.expiresAt &&
      Date.parse(task.state.expiresAt) > Date.now()
    )
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_ACTIVE_LEASE',
        task.contract.id,
      );
    const lockOwner = inventory.tasks.find(
      (candidate) =>
        candidate.contract.id !== task.contract.id &&
        [
          'LEASED',
          'IMPLEMENTING',
          'SELF_REVIEWING',
          'VERIFYING',
          'VERIFIED',
          'MERGE_QUEUED',
        ].includes(candidate.state.state) &&
        candidate.state.leaseState === 'ACTIVE' &&
        candidate.state.expiresAt &&
        Date.parse(candidate.state.expiresAt) > Date.now() &&
        candidate.contract.exclusiveLocks.some((lock) =>
          task.contract.exclusiveLocks.includes(lock),
        ),
    );
    if (lockOwner)
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_PATH_LOCK_CONFLICT',
        lockOwner.contract.id,
      );
    if (task.conflictingWorkspace)
      throw new ZCodeError(
        'TASK_BRANCH_ATTACHED_TO_OTHER_WORKTREE',
        task.conflictingWorkspace,
      );
    if (!task.workspaceRegistered || task.workspaceForeign)
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_REPOSITORY_MISMATCH',
        task.workspace,
      );
    if (task.workspaceBranch !== expectedBranch)
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_BRANCH_MISMATCH',
        `${task.workspaceBranch ?? 'detached'}:${expectedBranch}`,
      );
    if (task.workspaceDirty)
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_DIRTY',
        task.workspace,
        task.workspaceChanges ?? [],
      );
    if (task.workspaceHead !== task.cluster.worktreeHead)
      throw new ZCodeError(
        'TASK_WORKTREE_REUSE_HEAD_MISMATCH',
        `${task.workspaceHead}:${task.cluster.worktreeHead ?? 'missing'}`,
      );
  }
  const worktreeRaw = runPnpm(
    runner,
    inventory.root,
    [
      'worktree:create',
      task.contract.id,
      '--source-worktree',
      task.cluster.branch.worktree,
    ],
    'TASK_WORKTREE_CREATE_FAILED',
  );
  const worktree = parseJsonOutput<{ target: string; reused: boolean }>(
    worktreeRaw,
    'TASK_WORKTREE_OUTPUT_INVALID',
  );
  const expectedWorkspace = taskWorkspacePath(
    task.cluster.branch.worktree,
    task.contract.id,
  );
  if (
    !isManagedTaskWorkspace(task.cluster.branch.worktree, worktree.target) ||
    worktree.target !== expectedWorkspace
  )
    throw new ZCodeError(
      'TASK_WORKTREE_OUTSIDE_CLUSTER_PLANE',
      worktree.target,
    );
  runPnpm(
    runner,
    worktree.target,
    ['install', '--frozen-lockfile'],
    'PNPM_INSTALL_FAILED',
  );
  const leaseRaw = runPnpm(
    runner,
    worktree.target,
    ['task:acquire', task.contract.id, '--holder', NEW_TASK_HOLDER],
    'TASK_ACQUIRE_FAILED',
  );
  const lease = parseJsonOutput<LeaseOutput>(
    leaseRaw,
    'TASK_LEASE_OUTPUT_INVALID',
  );
  if (
    lease.taskId !== task.contract.id ||
    lease.holder !== NEW_TASK_HOLDER ||
    lease.fencingVersion < 1 ||
    !lease.leaseId
  )
    throw new ZCodeError('TASK_LEASE_BINDING_INVALID');
  const refreshed = await discoverProject(inventory.root, runner);
  const selected = refreshed.tasks.find(
    (candidate) => candidate.contract.id === task.contract.id,
  )!;
  const generated = await leaseForTask(refreshed, selected, runner, provider);
  await persistProjectMapping(refreshed, runner);
  launchPayload(
    provider,
    refreshed,
    selected,
    generated.binding.taskWorkspace,
    generated.payload,
  );
  if (initialized) {
    console.log(`Cluster ${task.contract.cluster} initialized.`);
    console.log(`Task ${task.contract.id} is ready.`);
  } else {
    console.log(
      `Task ${task.contract.id} in ${task.contract.cluster} is ready.`,
    );
  }
  console.log(
    provider.renderOwnerInstruction(task.contract.id, task.contract.cluster),
  );
};

const resumeTask = async (
  inventory: ProjectInventory,
  task: TaskRecord,
  runner: CommandRunner,
  provider: AgentProvider,
  continuing: boolean,
  failures: string[] = [],
): Promise<void> => {
  ensureProvider(provider);
  const generated = await leaseForTask(
    inventory,
    task,
    runner,
    provider,
    failures,
  );
  launchPayload(
    provider,
    inventory,
    task,
    generated.binding.taskWorkspace,
    generated.payload,
  );
  if (failures.length > 0) {
    console.log(
      `${task.contract.id} failed verification: ${concise(failures.join(' '))}.`,
    );
    console.log('Correction payload copied.');
  } else if (continuing) {
    console.log(`Continuing ${task.contract.id}.`);
  } else {
    console.log(`Resuming ${task.contract.id} in ${task.contract.cluster}.`);
  }
  console.log(
    provider.renderOwnerInstruction(task.contract.id, task.contract.cluster),
  );
};

const validateVerifiedTask = async (
  inventory: ProjectInventory,
  task: TaskRecord,
  runner: CommandRunner,
): Promise<void> => {
  const state = task.state;
  if (!state.leaseId || state.leaseVersion < 1)
    throw new ZCodeError('VERIFIED_TASK_LEASE_MISSING');
  await validateLaunchReceipt(inventory.root, runner, {
    taskId: task.contract.id,
    clusterId: task.contract.cluster,
    leaseId: state.leaseId,
    fencingVersion: state.leaseVersion,
    contextManifestSha256: task.contextManifestSha256,
    ...(task.conformanceManifestSha256
      ? { conformanceManifestSha256: task.conformanceManifestSha256 }
      : {}),
  });
  if (task.compatibilityMigration === 'LEGACY_ACTIVE_CONTRACT') {
    const compatibilityPath = join(
      agentRuntimeRoot(inventory.root, runner),
      'compatibility',
      task.contract.id,
      `${task.workspaceHead ?? 'uncommitted'}.semantic-conformance.json`,
    );
    if (!existsSync(compatibilityPath))
      throw new ZCodeError(
        'LEGACY_ACTIVE_SEMANTIC_CONFORMANCE_REQUIRED',
        compatibilityPath,
        [
          'An independent reviewer must bind the legacy contract, current commit/tree, AC-001 cluster facet, and AC-245 project facet before integration.',
        ],
      );
  }
  const result = await readTaskResult(task.contract.id, task.workspace);
  await validateTaskAttestation(task.contract, result, {
    cwd: task.workspace,
    currentHeadRequired: true,
    state,
  });
};

export const verifyAndIntegrateTask = async (
  inventory: ProjectInventory,
  task: TaskRecord,
  runner: CommandRunner,
  rediscover: typeof discoverProject = discoverProject,
  provider: AgentProvider = new ZCodeProvider(runner),
): Promise<ProjectInventory> => {
  assertClusterWorktree(task.cluster);
  if (task.state.state === 'VERIFYING')
    throw new ZCodeError(
      'INTERRUPTED_TASK_VERIFICATION_REQUIRES_AUTHORITATIVE_RECOVERY',
    );
  if (task.state.state === 'SELF_REVIEWING') {
    const state = task.state;
    const result = runner.run(
      'pnpm',
      [
        '--silent',
        'task:verify',
        task.contract.id,
        '--holder',
        state.holder!,
        '--lease-version',
        String(state.leaseVersion),
      ],
      { cwd: task.workspace },
    );
    if (result.status !== 0) {
      const refreshed = await rediscover(inventory.root, runner);
      const same = refreshed.tasks.find(
        (candidate) => candidate.contract.id === task.contract.id,
      )!;
      await resumeTask(refreshed, same, runner, provider, false, [
        concise(result.stderr || result.stdout),
      ]);
      return refreshed;
    }
    inventory = await rediscover(inventory.root, runner);
    task = inventory.tasks.find(
      (candidate) => candidate.contract.id === task.contract.id,
    )!;
  }
  if (task.state.state === 'VERIFIED') {
    await validateVerifiedTask(inventory, task, runner);
    runPnpm(
      runner,
      task.cluster.branch.worktree,
      ['merge-queue:add', task.contract.id],
      'MERGE_QUEUE_ADD_FAILED',
    );
    inventory = await rediscover(inventory.root, runner);
    task = inventory.tasks.find(
      (candidate) => candidate.contract.id === task.contract.id,
    )!;
  }
  if (task.state.state !== 'MERGE_QUEUED')
    throw new ZCodeError('TASK_NOT_READY_FOR_MERGE_QUEUE', task.state.state);
  const processRaw = runPnpm(
    runner,
    task.cluster.branch.worktree,
    ['merge-queue:process'],
    'MERGE_QUEUE_PROCESS_FAILED',
  );
  const processed = parseJsonOutput<{ status: string }>(
    processRaw,
    'MERGE_QUEUE_OUTPUT_INVALID',
  );
  if (processed.status !== 'MERGED')
    throw new ZCodeError('TASK_INTEGRATION_FAILED', processed.status);
  runPnpm(
    runner,
    inventory.root,
    [
      'worktree:cleanup',
      task.contract.id,
      '--source-worktree',
      task.cluster.branch.worktree,
    ],
    'TASK_WORKTREE_CLEANUP_FAILED',
  );
  const refreshed = await rediscover(inventory.root, runner);
  await persistProjectMapping(refreshed, runner);
  return refreshed;
};

const reviewPackagePath = async (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
  runner: CommandRunner,
): Promise<string> => {
  const runtime = agentRuntimeRoot(inventory.root, runner);
  const path = join(
    runtime,
    'cluster-reviews',
    `${cluster.contract.id}.review-instructions.md`,
  );
  const text = `# Independent review package: ${cluster.contract.id}

Review the complete diff on \`${cluster.branch.branch}\` against \`${cluster.branch.integrationTarget}\`.
Verify every task result, requirement, acceptance criterion, invariant, dependency interface, migration, security boundary, rollback path, degraded behavior, and capability state.

Write the independent review to:

\`artifacts/reviews/clusters/${cluster.contract.id}.review.json\`

The file must conform to \`docs/schemas/cluster-review.schema.json\`, name this cluster, and record \`PASS\` only when there is no release-blocking P0/P1 finding. Commit that review artifact atomically on the cluster branch. Do not modify product source. Then run \`pnpm agent\` again from the root repository.
`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  return path;
};

const verifyCluster = async (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
  runner: CommandRunner,
): Promise<ProjectInventory> => {
  assertClusterWorktree(cluster);
  runPnpm(
    runner,
    cluster.branch.worktree,
    ['cluster:verify', cluster.contract.id],
    'CLUSTER_VERIFICATION_FAILED',
  );
  runPnpm(
    runner,
    cluster.branch.worktree,
    ['cluster:report', cluster.contract.id],
    'CLUSTER_REPORT_FAILED',
  );
  return discoverProject(inventory.root, runner);
};

const recordCompletedCluster = async (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
  runner: CommandRunner,
  pullRequest: string,
): Promise<ProjectInventory> => {
  requireSuccess(
    runner.run('git', ['fetch', 'origin', '--prune'], { cwd: inventory.root }),
    'POST_MERGE_FETCH_FAILED',
    'git fetch origin --prune',
  );
  requireSuccess(
    runner.run(
      'git',
      ['pull', '--ff-only', 'origin', cluster.branch.integrationTarget],
      { cwd: inventory.root },
    ),
    'POST_MERGE_FAST_FORWARD_FAILED',
    `git pull --ff-only origin ${cluster.branch.integrationTarget}`,
  );
  const complete = await discoverProject(inventory.root, runner);
  const completedCluster = complete.clusters.find(
    (candidate) => candidate.contract.id === cluster.contract.id,
  );
  if (completedCluster?.state !== 'COMPLETE')
    throw new ZCodeError(
      'CLUSTER_INTEGRATION_COMMIT_NOT_VERIFIED',
      cluster.contract.id,
    );
  const evidencePath = join(
    agentRuntimeRoot(inventory.root, runner),
    'cluster-completions',
    `${cluster.contract.id}.json`,
  );
  const evidence = {
    schemaVersion: '1.0.0',
    clusterId: cluster.contract.id,
    pullRequest,
    integrationCommit: complete.rootHead,
    integrationTree: complete.rootTree,
    taskIds: cluster.contract.tasks,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  return complete;
};

const integrateCluster = async (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
  runner: CommandRunner,
): Promise<ProjectInventory | undefined> => {
  assertClusterWorktree(cluster);
  runPnpm(
    runner,
    cluster.branch.worktree,
    ['cluster:report', cluster.contract.id],
    'CLUSTER_RESULT_OR_REVIEW_STALE',
  );
  requireSuccess(
    runner.run('git', ['push', 'origin', cluster.branch.branch], {
      cwd: cluster.branch.worktree,
    }),
    'CLUSTER_PUSH_FAILED',
    `git push origin ${cluster.branch.branch}`,
  );
  let pr = findClusterPullRequest(runner, inventory.root, cluster);
  if (!pr) {
    pr = createClusterPullRequest(runner, inventory.root, cluster);
    console.log(
      `Cluster ${cluster.contract.id} pull request created: ${pr.url}`,
    );
    console.log('CI is pending. Run pnpm agent again after checks update.');
    return undefined;
  }
  if (pr.state === 'MERGED') {
    return recordCompletedCluster(inventory, cluster, runner, pr.url);
  }
  if (pr.state !== 'OPEN')
    throw new ZCodeError('CLUSTER_PR_CLOSED_WITHOUT_MERGE', pr.url);
  const refreshed = refreshPullRequest(runner, inventory.root, pr.number);
  const classification = classifyPullRequest(refreshed);
  if (classification === 'CLOSED')
    throw new ZCodeError('CLUSTER_PR_CLOSED_WITHOUT_MERGE', refreshed.url);
  if (classification === 'MERGED') {
    return recordCompletedCluster(inventory, cluster, runner, refreshed.url);
  }
  const failed = refreshed.checks.filter(
    (check) => check.required && check.state === 'FAIL',
  );
  if (classification === 'FAILED') {
    console.log(
      `Cluster ${cluster.contract.id} CI failed: ${failed.map((check) => check.name).join(', ')}.`,
    );
    console.log(
      `Inspect ${refreshed.url}, repair only the exact failures, then run pnpm agent again.`,
    );
    return undefined;
  }
  const pending = refreshed.checks.filter(
    (check) => check.required && check.state === 'PENDING',
  );
  if (classification === 'PENDING' || pending.length > 0) {
    console.log(`Cluster ${cluster.contract.id} CI is pending.`);
    console.log('Run pnpm agent again after checks update.');
    return undefined;
  }
  mergePullRequest(runner, inventory.root, refreshed.number);
  return recordCompletedCluster(inventory, cluster, runner, refreshed.url);
};

const finalVerification = async (
  inventory: ProjectInventory,
  runner: CommandRunner,
): Promise<void> => {
  if (
    inventory.tasks.some((task) => task.state.state !== 'MERGED') ||
    inventory.clusters.some((cluster) => cluster.state !== 'COMPLETE') ||
    inventory.coverage.requirements.accounted !==
      inventory.coverage.requirements.total ||
    inventory.coverage.acceptanceCriteria.accounted !==
      inventory.coverage.acceptanceCriteria.total
  )
    throw new ZCodeError('PROJECT_COMPLETION_OMISSION_DETECTED');
  const partition = JSON.parse(
    await readFile(
      join(inventory.root, 'artifacts/spec/acceptance-partition.json'),
      'utf8',
    ),
  ) as { assignments: Array<{ acceptanceId: string; level: string }> };
  const specification = JSON.parse(
    await readFile(
      join(
        inventory.root,
        'docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json',
      ),
      'utf8',
    ),
  ) as {
    acceptanceCriteria: Array<{
      id: string;
      positiveTestRef: string;
      negativeOrFailureTestRef: string;
    }>;
  };
  const projectIds = new Set(
    partition.assignments
      .filter((item) => item.level === 'PROJECT')
      .map((item) => item.acceptanceId),
  );
  const projectTests = [
    ...new Set(
      specification.acceptanceCriteria
        .filter((item) => projectIds.has(item.id))
        .flatMap((item) => [
          item.positiveTestRef,
          item.negativeOrFailureTestRef,
        ]),
    ),
  ];
  const commands: string[][] = [
    ...(projectTests.length > 0
      ? [['exec', 'vitest', 'run', ...projectTests]]
      : []),
    ['build'],
    ['lint'],
    ['typecheck'],
    ['test'],
    ['spec:verify'],
    ['prd:drift-check'],
    ['requirements:coverage'],
    ['architecture:verify'],
    ['placeholders:scan'],
    ['prohibited-capabilities:scan'],
    ['migration:verify'],
    ['harness:verify'],
  ];
  const evidence: Array<{ command: string; outputSha256: string }> = [];
  for (const args of commands) {
    const output = runPnpm(
      runner,
      inventory.root,
      args,
      'FINAL_PROJECT_VERIFICATION_FAILED',
    );
    evidence.push({
      command: `pnpm ${args.join(' ')}`,
      outputSha256: sha256(output),
    });
  }
  const path = join(
    agentRuntimeRoot(inventory.root, runner),
    'final',
    `${inventory.rootHead}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        commit: inventory.rootHead,
        tree: inventory.rootTree,
        taskCount: inventory.tasks.length,
        clusterCount: inventory.clusters.length,
        coverage: inventory.coverage,
        evidence,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
};

export const renderDryRun = (
  inventory: ProjectInventory,
  decision: Decision,
  provider = 'antigravity',
): string => {
  const task = decision.task ?? decision.nextTask;
  const cluster = decision.cluster ?? decision.nextCluster;
  return [
    'Agent dry run (zero mutation)',
    `Provider: ${provider}`,
    `Project state: ${decision.reason}`,
    `Next action: ${decision.action}`,
    `Current cluster: ${inventory.activeTask?.contract.cluster ?? 'none'}`,
    `Current task: ${inventory.activeTask?.contract.id ?? 'none'}`,
    `Selected cluster: ${cluster?.contract.id ?? 'none'}`,
    `Selected branch: ${cluster?.branch.branch ?? 'none'}`,
    `Selected worktree: ${cluster?.branch.worktree ?? 'none'}`,
    `Selected task: ${task?.contract.id ?? 'none'}`,
    `Context manifest: ${task?.contextManifestPath ?? 'none'}`,
    `Context hash: ${task?.contextManifestSha256 ?? 'none'}`,
  ].join('\n');
};

export const executeOrchestration = async (
  root: string,
  runner: CommandRunner,
  options: { dryRun: boolean; provider: AgentProvider },
): Promise<void> => {
  let inventory = await discoverProject(root, runner);
  assertRootControlPlane(inventory, options.dryRun);
  let decision = decideNextAction(inventory);
  if (options.dryRun) {
    console.log(renderDryRun(inventory, decision, options.provider.id));
    return;
  }
  requireSuccess(
    runner.run('git', ['fetch', 'origin', '--prune', '--tags'], {
      cwd: inventory.root,
    }),
    'ROOT_FETCH_FAILED',
    'git fetch origin --prune --tags',
  );
  requireSuccess(
    runner.run('git', ['pull', '--ff-only', 'origin', 'main'], {
      cwd: inventory.root,
    }),
    'ROOT_FAST_FORWARD_FAILED',
    'git pull --ff-only origin main',
  );
  runPnpm(runner, inventory.root, ['spec:verify'], 'SPEC_VERIFICATION_FAILED');
  runPnpm(
    runner,
    inventory.root,
    ['prd:drift-check'],
    'GENERATED_CONTRACT_DRIFT',
  );
  inventory = await discoverProject(root, runner);
  assertRootControlPlane(inventory, false);
  decision = decideNextAction(inventory);
  inventory = await synchronizeRemoteClusterAdvance(
    inventory,
    decision,
    runner,
  );
  decision = decideNextAction(inventory);
  await persistProjectMapping(inventory, runner);
  if (decision.action === 'RESUME_TASK' && decision.task) {
    await resumeTask(
      inventory,
      decision.task,
      runner,
      options.provider,
      false,
    );
    return;
  }
  if (decision.action === 'CONTINUE_TASK' && decision.task) {
    await resumeTask(inventory, decision.task, runner, options.provider, true);
    return;
  }
  if (decision.action === 'CORRECT_TASK' && decision.task) {
    await resumeTask(
      inventory,
      decision.task,
      runner,
      options.provider,
      false,
      decision.failures ?? [decision.reason],
    );
    return;
  }
  if (decision.action === 'START_TASK' && decision.task) {
    await startTask(inventory, decision.task, runner, options.provider);
    return;
  }
  if (decision.action === 'INITIALIZE_CLUSTER' && decision.cluster) {
    inventory = await initializeCluster(inventory, decision.cluster, runner);
    decision = decideNextAction(inventory);
    if (decision.action !== 'START_TASK' || !decision.task)
      throw new ZCodeError(
        'INITIALIZED_CLUSTER_HAS_NO_RUNNABLE_TASK',
        decision.reason,
      );
    await startTask(inventory, decision.task, runner, options.provider, true);
    return;
  }
  if (decision.action === 'VERIFY_TASK' && decision.task) {
    inventory = await verifyAndIntegrateTask(
      inventory,
      decision.task,
      runner,
      discoverProject,
      options.provider,
    );
    decision = decideNextAction(inventory);
    if (decision.action === 'START_TASK' && decision.task) {
      await startTask(inventory, decision.task, runner, options.provider);
      return;
    }
  }
  if (decision.action === 'REVIEW_CLUSTER' && decision.cluster) {
    assertClusterWorktree(decision.cluster);
    const path = await reviewPackagePath(inventory, decision.cluster, runner);
    console.log(`Independent cluster review required: ${path}`);
    console.log(
      'Record and commit PASS review evidence, then run pnpm agent again.',
    );
    return;
  }
  if (decision.action === 'VERIFY_CLUSTER' && decision.cluster) {
    inventory = await verifyCluster(inventory, decision.cluster, runner);
    decision = decideNextAction(inventory);
  }
  if (decision.action === 'CREATE_CLUSTER_PR' && decision.cluster) {
    const integrated = await integrateCluster(
      inventory,
      decision.cluster,
      runner,
    );
    if (!integrated) return;
    inventory = integrated;
    decision = decideNextAction(inventory);
    if (decision.action === 'INITIALIZE_CLUSTER' && decision.cluster) {
      inventory = await initializeCluster(inventory, decision.cluster, runner);
      const next = decideNextAction(inventory);
      if (next.action !== 'START_TASK' || !next.task)
        throw new ZCodeError('NEXT_CLUSTER_HAS_NO_RUNNABLE_TASK', next.reason);
      await startTask(inventory, next.task, runner, options.provider, true);
      return;
    }
    if (decision.action === 'START_TASK' && decision.task) {
      await startTask(inventory, decision.task, runner, options.provider);
      return;
    }
  }
  if (decision.action === 'COMPLETE_PROJECT') {
    await finalVerification(inventory, runner);
    console.log(
      'All ChainSieve implementation clusters are complete and verified.',
    );
    console.log('No implementation-agent task remains.');
    return;
  }
  if (decision.action === 'STOP')
    throw new ZCodeError('ORCHESTRATION_STOPPED', decision.reason);
  throw new ZCodeError(
    'UNHANDLED_ORCHESTRATION_STATE',
    `${decision.action}:${decision.reason}`,
  );
};
