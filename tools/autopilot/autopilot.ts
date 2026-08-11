import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProject } from '../agent/lib/discovery.js';
import { decideNextAction } from '../agent/lib/engine.js';
import { errorCode } from '../agent/lib/errors.js';
import {
  executeOrchestration,
  leaseForTask,
  renderDryRun,
} from '../agent/lib/executor.js';
import {
  agentRuntimeRoot,
  listLaunchReceiptCandidates,
} from '../agent/lib/runtime.js';
import type {
  AgentProvider,
  AgentProviderId,
  ClusterRecord,
  CommandResult,
  CommandRunner,
  ProjectInventory,
  TaskRecord,
} from '../agent/lib/types.js';
import { createProvider } from '../agent/providers/index.js';
import { computeAutopilotWorkspaceHashes } from '../agent/lib/workspace-hash.js';
import { acquireAutopilotLock } from './lock.js';
import { loadAutonomyPolicy, type AutonomyPolicy } from './policy.js';

export const DEFAULT_AUTONOMOUS_PROVIDER = 'antigravity' as const;
export const MAX_PRODUCT_CORRECTION_ROUNDS = 3;
export const ANTIGRAVITY_MODEL_STATUS =
  'GEMINI_3_6_FLASH_HIGH_ENFORCED_BY_CLI' as const;
const AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
const CI_WAIT_TIMEOUT_MS = 90 * 60_000;
const SPEC_ALLOWED_PREFIXES = [
  'docs/spec/',
  'docs/adr/',
  'tasks/',
  'clusters/',
  'artifacts/context/',
  'artifacts/spec/',
];
const CONTROL_PLANE_PREFIXES = [
  '.github/',
  'config/',
  'tools/autopilot/',
  'tools/agent/',
  'tools/task-runner/',
  'tools/task-verifier/',
  'tools/cluster-verifier/',
  'tools/merge-queue/',
  'tools/worktree-manager/',
  'docs/schemas/',
];
const CORRECTION_RECEIPT_PROVIDERS = new Set<AgentProviderId>([
  'antigravity',
  'claude-deepseek',
  'codex',
  'muse',
  'zcode',
]);
const NON_RETRYABLE_INFRASTRUCTURE_MARKERS = [
  'AUTH_FAILED',
  'AUTHENTICATION',
  'PERMISSION_DENIED',
  'PR_CLOSED',
  'AUTONOMOUS_MERGE_DISABLED',
  'PROHIBITED_CAPABILITY',
  'SECRET_EXPOSURE',
] as const;
const RETRYABLE_INFRASTRUCTURE_MARKERS = [
  'GITHUB_FAILED',
  'GIT_FAILED',
  'CI_TIMEOUT',
  'FINAL_MAIN_CI_TIMEOUT',
  'NETWORK',
  'DNS',
  'ORIGIN_REACHABLE',
  'COULD NOT RESOLVE',
  'CONNECTION RESET',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'TEMPORARILY UNAVAILABLE',
  'HIGH TRAFFIC',
  'TRY AGAIN',
] as const;

export const correctionRoundAllowed = (completedRounds: number): boolean =>
  completedRounds + 1 <= MAX_PRODUCT_CORRECTION_ROUNDS;

const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0)
    throw new Error(
      `${code}:${result.timedOut ? 'TIMEOUT:' : ''}${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
};
export const formatPnpmCommandTag = (args: string[]): string => {
  const first = args.find((a) => a !== '--');
  return first ?? 'unknown';
};

export const isTransientInfrastructureFailure = (error: unknown): boolean => {
  const normalized = errorCode(error).toUpperCase();
  if (
    NON_RETRYABLE_INFRASTRUCTURE_MARKERS.some((marker) =>
      normalized.includes(marker),
    )
  )
    return false;
  return RETRYABLE_INFRASTRUCTURE_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
};

export const infrastructureRetryKey = (
  controlPlaneVersion: string,
  action: string,
  targetId: string,
  targetVersion: string,
): string =>
  `orchestration:v2:${controlPlaneVersion}:${action}:${targetId}:${targetVersion}`;

export const infrastructureRetryStartAttempt = (
  consumedAttempts: number,
  persistAcrossRuns: boolean,
): number => (persistAcrossRuns ? consumedAttempts : 0);

export const assertInfrastructureRetryBudget = (
  key: string,
  consumedAttempts: number,
  limit: number,
): void => {
  if (consumedAttempts >= limit)
    throw new Error(
      `AUTOPILOT_INFRASTRUCTURE_RETRY_EXHAUSTED:${key}:${consumedAttempts}/${limit}`,
    );
};

const pnpm = (runner: CommandRunner, root: string, args: string[]): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], {
      cwd: root,
      timeoutMilliseconds: AGENT_TIMEOUT_MS,
    }),
    `AUTOPILOT_COMMAND_FAILED:${formatPnpmCommandTag(args)}`,
  );
const git = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('git', args, { cwd, timeoutMilliseconds: 120_000 }),
    `AUTOPILOT_GIT_FAILED:${args.join(':')}`,
  );
const gh = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('gh', args, { cwd, timeoutMilliseconds: 120_000 }),
    `AUTOPILOT_GITHUB_FAILED:${args.join(':')}`,
  );

interface PersistentAutopilotState {
  schemaVersion: '1.0.0';
  ciRepairRounds: Record<string, number>;
  infrastructureFailures: Record<string, number>;
}

const statePath = (root: string, runner: CommandRunner): string =>
  join(agentRuntimeRoot(root, runner), 'autopilot-state.json');
const readPersistentState = async (
  root: string,
  runner: CommandRunner,
): Promise<PersistentAutopilotState> => {
  try {
    const parsed = JSON.parse(
      await readFile(statePath(root, runner), 'utf8'),
    ) as PersistentAutopilotState;
    if (
      parsed.schemaVersion !== '1.0.0' ||
      !parsed.ciRepairRounds ||
      !parsed.infrastructureFailures
    )
      throw new Error('invalid');
    return parsed;
  } catch {
    return {
      schemaVersion: '1.0.0',
      ciRepairRounds: {},
      infrastructureFailures: {},
    };
  }
};
const writePersistentState = async (
  root: string,
  runner: CommandRunner,
  state: PersistentAutopilotState,
): Promise<void> => {
  await mkdir(agentRuntimeRoot(root, runner), { recursive: true });
  await writeFile(statePath(root, runner), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
};
const withInfrastructureRetry = async <T>(
  root: string,
  runner: CommandRunner,
  policy: AutonomyPolicy,
  state: PersistentAutopilotState,
  key: string,
  persistAcrossRuns: boolean,
  operation: () => Promise<T>,
): Promise<T> => {
  const startAttempt = infrastructureRetryStartAttempt(
    state.infrastructureFailures[key] ?? 0,
    persistAcrossRuns,
  );
  if (persistAcrossRuns)
    assertInfrastructureRetryBudget(
      key,
      startAttempt,
      policy.limits.infrastructureRetryRounds,
    );
  let last: unknown;
  for (
    let attempt = startAttempt;
    attempt < policy.limits.infrastructureRetryRounds;
    attempt += 1
  ) {
    try {
      const value = await operation();
      if (persistAcrossRuns && state.infrastructureFailures[key] !== undefined) {
        delete state.infrastructureFailures[key];
        await writePersistentState(root, runner, state);
      }
      return value;
    } catch (error) {
      if (!isTransientInfrastructureFailure(error)) {
        if (persistAcrossRuns && state.infrastructureFailures[key] !== undefined) {
          delete state.infrastructureFailures[key];
          await writePersistentState(root, runner, state);
        }
        throw error;
      }
      last = error;
      if (persistAcrossRuns) {
        state.infrastructureFailures[key] = attempt + 1;
        await writePersistentState(root, runner, state);
      }
      if (attempt + 1 < policy.limits.infrastructureRetryRounds)
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
    }
  }
  if (last instanceof Error) throw last;
  throw new Error(
    `AUTOPILOT_INFRASTRUCTURE_RETRY_FAILED:${key}:${String(last)}`,
  );
};

const changedPaths = (runner: CommandRunner, cwd: string): string[] =>
  git(runner, cwd, ['status', '--porcelain=v1'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(' -> ').at(-1)!)
    .filter(Boolean)
    .sort();
const assertOnlyPaths = (
  paths: string[],
  allowed: (path: string) => boolean,
  code: string,
): void => {
  const invalid = paths.filter((path) => !allowed(path));
  if (paths.length === 0) throw new Error(`${code}:NO_CHANGES`);
  if (invalid.length > 0) throw new Error(`${code}:${invalid.join(',')}`);
};
const executeAgent = (
  provider: AgentProvider,
  workspace: string,
  prompt: string,
  code: string,
): void => {
  if (!provider.executePayload) throw new Error(`${code}:NO_HEADLESS_EXECUTOR`);
  requireSuccess(provider.executePayload(workspace, prompt), code);
};

const ensureLease = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
): Promise<void> => {
  const state = task.state;
  if (
    !state.expiresAt ||
    !state.leaseId ||
    !state.holder ||
    !state.baseCommit ||
    !state.branch
  )
    return;
  const remaining = Date.parse(state.expiresAt) - Date.now();
  if (remaining > 20 * 60_000) return;
  if (remaining > 0) {
    const alreadyRenewed =
      state.renewal?.resultingLeaseId === state.leaseId &&
      state.renewal.resultingFencingVersion === state.leaseVersion;
    if (!alreadyRenewed) {
      pnpm(runner, root, [
        'agent:renew',
        '--',
        task.contract.id,
        '--expected-lease-id',
        state.leaseId,
        '--expected-fencing-version',
        String(state.leaseVersion),
        '--holder',
        state.holder,
        '--ttl-minutes',
        '120',
      ]);
      return;
    }
    await sleep(remaining + 1_000);
  }
  const workspace = task.workspace;
  const hashes = await computeAutopilotWorkspaceHashes(workspace);
  const head = git(runner, workspace, ['rev-parse', 'HEAD']);
  const tree = git(runner, workspace, ['rev-parse', 'HEAD^{tree}']);
  const contractPath = `tasks/${task.contract.dependencyGroup}/${task.contract.id}.contract.json`;
  const contextPath = `artifacts/context/${task.contract.id}/context-manifest.json`;
  pnpm(runner, root, [
    'agent:recover',
    '--',
    task.contract.id,
    '--expected-expired-lease-id',
    state.leaseId,
    '--expected-fencing-version',
    String(state.leaseVersion),
    '--holder',
    state.holder,
    '--expected-task-state',
    state.state,
    '--expected-task-branch',
    state.branch,
    '--expected-task-worktree',
    workspace,
    '--expected-lifecycle-base-commit',
    state.baseCommit,
    '--expected-task-head-commit',
    head,
    '--expected-task-head-tree',
    tree,
    '--expected-tracked-work-sha256',
    hashes.tracked,
    '--expected-untracked-work-sha256',
    hashes.untracked,
    '--expected-legacy-contract-sha256',
    hash(await readFile(join(workspace, contractPath))),
    '--expected-legacy-context-sha256',
    hash(await readFile(join(workspace, contextPath))),
    '--ttl-minutes',
    '120',
  ]);
};

export const correctionReceiptMatches = (
  value: Record<string, unknown>,
  binding: {
    taskId?: string;
    holder?: string;
    leaseId?: string;
    fencingVersion?: number;
    worktree?: string;
    previousCommit?: string;
    failureCode?: string;
  } = {},
): boolean => {
  const correction = value.correction as
    | { previousCommit?: unknown; failureCodes?: unknown }
    | undefined;
  return (
    CORRECTION_RECEIPT_PROVIDERS.has(String(value.provider) as AgentProviderId) &&
    typeof correction?.previousCommit === 'string' &&
    Array.isArray(correction.failureCodes) &&
    (!binding.taskId || value.taskId === binding.taskId) &&
    (!binding.holder || value.holder === binding.holder) &&
    (!binding.leaseId || value.leaseId === binding.leaseId) &&
    (!binding.fencingVersion || value.fencingVersion === binding.fencingVersion) &&
    (!binding.worktree || value.taskWorktree === binding.worktree) &&
    (!binding.previousCommit || correction.previousCommit === binding.previousCommit) &&
    (!binding.failureCode || correction.failureCodes.includes(binding.failureCode))
  );
};
const correctionReceipts = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
) =>
  (await listLaunchReceiptCandidates(root, runner, task.contract.id)).filter(
    ({ value }) =>
      correctionReceiptMatches(value, {
        taskId: task.contract.id,
        holder: task.state.holder!,
        leaseId: task.state.leaseId!,
        fencingVersion: task.state.leaseVersion,
        worktree: task.workspace,
      }),
  );
const bindCompletedCorrection = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
): Promise<boolean> => {
  const previous = task.state.commit;
  if (
    task.state.state !== 'SELF_REVIEWING' ||
    !previous ||
    !task.workspaceHead ||
    previous === task.workspaceHead
  )
    return false;
  const receipts = await correctionReceipts(root, runner, task);
  const candidate = receipts.find(({ value }) =>
    correctionReceiptMatches(value, { previousCommit: previous }),
  );
  const failureCode = (
    candidate?.value.correction as { failureCodes?: string[] } | undefined
  )?.failureCodes?.[0];
  if (!failureCode) throw new Error('AUTOPILOT_CORRECTION_RECEIPT_MISSING');
  pnpm(runner, root, [
    'task:self-review-correct',
    task.contract.id,
    '--holder',
    task.state.holder!,
    '--lease-version',
    String(task.state.leaseVersion),
    '--target-worktree',
    task.workspace,
    '--expected-previous-commit',
    previous,
    '--failure-code',
    failureCode,
  ]);
  return true;
};

interface PullRequestCheck {
  name?: string;
  context?: string;
  conclusion?: string;
  state?: string;
  status?: string;
}
interface PullRequestProbe {
  number: number;
  url: string;
  state?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: PullRequestCheck[];
}
const checkValue = (check: PullRequestCheck): string =>
  String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase();
const failedChecks = (pr: PullRequestProbe): string[] =>
  (pr.statusCheckRollup ?? [])
    .filter((check) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(
        checkValue(check),
      ),
    )
    .map((check) => check.name ?? check.context ?? 'unnamed-check');
const pendingChecks = (pr: PullRequestProbe): boolean =>
  (pr.statusCheckRollup ?? []).length === 0 ||
  (pr.statusCheckRollup ?? []).some(
    (check) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(checkValue(check)),
  );
const findPullRequest = (
  runner: CommandRunner,
  root: string,
  head: string,
  base: string,
  state = 'open',
): PullRequestProbe | undefined => {
  const values = JSON.parse(
    gh(runner, root, [
      'pr',
      'list',
      '--head',
      head,
      '--base',
      base,
      '--state',
      state,
      '--limit',
      '1',
      '--json',
      'number,url,state,mergeStateStatus,statusCheckRollup',
    ]),
  ) as PullRequestProbe[];
  return values[0];
};
const waitForPullRequest = async (
  runner: CommandRunner,
  root: string,
  number: number,
  pollMilliseconds: number,
): Promise<PullRequestProbe> => {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  for (;;) {
    const pr = JSON.parse(
      gh(runner, root, [
        'pr',
        'view',
        String(number),
        '--json',
        'number,url,state,mergeStateStatus,statusCheckRollup',
      ]),
    ) as PullRequestProbe;
    if (pr.state === 'MERGED') return pr;
    if (pr.state === 'CLOSED') throw new Error(`AUTOPILOT_PR_CLOSED:${pr.url}`);
    if (failedChecks(pr).length > 0 || !pendingChecks(pr)) return pr;
    if (Date.now() >= deadline) throw new Error(`AUTOPILOT_CI_TIMEOUT:${pr.url}`);
    await sleep(pollMilliseconds);
  }
};

const repairClusterCi = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  cluster: ClusterRecord,
  failure: { number: number; url: string; failures: string[] },
  round: number,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  const resultPath = join(runtime, 'cluster-results', `${cluster.contract.id}.result.json`);
  if (!existsSync(resultPath)) throw new Error('AUTOPILOT_CLUSTER_RESULT_REQUIRED_FOR_REPAIR');
  const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
    headCommitSha: string;
    headTreeSha: string;
  };
  const remoteHead = git(runner, root, [
    'rev-parse',
    `refs/remotes/origin/${cluster.branch.branch}`,
  ]);
  git(runner, cluster.branch.worktree, ['reset', '--hard', result.headCommitSha]);
  await rm(
    join(
      cluster.branch.worktree,
      'artifacts',
      'reviews',
      'clusters',
      `${cluster.contract.id}.review.json`,
    ),
    { force: true },
  );
  await rm(resultPath, { force: true });
  const sessionId = randomUUID();
  const directory = join(runtime, 'ci-repair-sessions');
  await mkdir(directory, { recursive: true });
  const core = {
    schemaVersion: '2.0.0',
    sessionId,
    provider: provider.id,
    clusterId: cluster.contract.id,
    pullRequest: failure.url,
    failedChecks: failure.failures,
    round,
    frozenProductCommit: result.headCommitSha,
    frozenProductTree: result.headTreeSha,
    expectedRemoteHead: remoteHead,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    join(directory, `${cluster.contract.id}.${sessionId}.json`),
    `${JSON.stringify({ ...core, receiptHash: hash(JSON.stringify(core)) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  executeAgent(
    provider,
    cluster.branch.worktree,
    `You are isolated CI repair session ${sessionId}. Inspect pull request ${failure.url} and complete logs for ${failure.failures.join(', ')}. Modify only the minimum product source or product tests needed. Do not modify control-plane, workflow, policy, verifier, specification, generated contract, review, or runtime evidence. Do not run git reset, git commit, git push, or gh. Leave valid changes uncommitted and stop.`,
    'AUTOPILOT_CLUSTER_CI_REPAIR_FAILED',
  );
  const paths = changedPaths(runner, cluster.branch.worktree);
  assertOnlyPaths(
    paths,
    (path) => !CONTROL_PLANE_PREFIXES.some((prefix) => path.startsWith(prefix)),
    'AUTOPILOT_CLUSTER_CI_REPAIR_SCOPE',
  );
  pnpm(runner, cluster.branch.worktree, ['lint']);
  pnpm(runner, cluster.branch.worktree, ['typecheck']);
  git(runner, cluster.branch.worktree, ['add', '--', ...paths]);
  git(runner, cluster.branch.worktree, [
    'commit',
    '-m',
    `fix(${cluster.contract.id}): repair CI round ${round}`,
  ]);
  git(runner, cluster.branch.worktree, [
    'push',
    `--force-with-lease=${cluster.branch.branch}:${remoteHead}`,
    'origin',
    `HEAD:${cluster.branch.branch}`,
  ]);
};

const reviewCluster = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  inventory: ProjectInventory,
  cluster: ClusterRecord,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  const productCommit = cluster.worktreeHead ?? cluster.branchHead;
  if (!productCommit) throw new Error('AUTOPILOT_REVIEW_PRODUCT_COMMIT_MISSING');
  const productTree = git(runner, cluster.branch.worktree, [
    'rev-parse',
    `${productCommit}^{tree}`,
  ]);
  const sessionId = randomUUID();
  const identity = `${provider.id}-independent-${sessionId}`;
  const holders = cluster.contract.tasks
    .map((id) => inventory.tasks.find((task) => task.contract.id === id)?.state.holder)
    .filter((holder): holder is string => Boolean(holder));
  const directory = join(runtime, 'review-sessions');
  await mkdir(directory, { recursive: true });
  const core = {
    schemaVersion: '2.0.0',
    sessionId,
    reviewerIdentity: identity,
    provider: provider.id,
    clusterId: cluster.contract.id,
    productCommit,
    productTree,
    implementationHolders: holders,
    createdAt: new Date().toISOString(),
  };
  const receiptPath = join(directory, `${cluster.contract.id}.${sessionId}.json`);
  await writeFile(
    receiptPath,
    `${JSON.stringify({ ...core, receiptHash: hash(JSON.stringify(core)) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const instructions = join(
    runtime,
    'cluster-reviews',
    `${cluster.contract.id}.review-instructions.md`,
  );
  executeAgent(
    provider,
    cluster.branch.worktree,
    `Read and obey ${instructions}. Independent review session ${sessionId}; reviewerIdentity ${identity}. Review frozen commit ${productCommit} and tree ${productTree}. Create only the review JSON artifact and leave it uncommitted. Do not modify product, tests, contracts, manifests, result, policy, workflow or verifier. Do not invoke git commit, git push or gh. Receipt: ${receiptPath}.`,
    'AUTOPILOT_CLUSTER_REVIEW_FAILED',
  );
  const expected = `artifacts/reviews/clusters/${cluster.contract.id}.review.json`;
  const paths = changedPaths(runner, cluster.branch.worktree);
  assertOnlyPaths(paths, (path) => path === expected, 'AUTOPILOT_CLUSTER_REVIEW_SCOPE');
  git(runner, cluster.branch.worktree, ['add', '--', expected]);
  git(runner, cluster.branch.worktree, [
    'commit',
    '-m',
    `review(${cluster.contract.id}): independent machine review`,
  ]);
};

const resolveSpecificationGap = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  inventory: ProjectInventory,
  policy: AutonomyPolicy,
  pollMilliseconds: number,
): Promise<boolean> => {
  if (!policy.allowAutonomousSpecificationResolution) return false;
  const task = inventory.tasks.find(
    (candidate) =>
      candidate.state.state === 'BLOCKED' &&
      candidate.contract.specificationStatus === 'SPECIFICATION_GAP',
  );
  if (!task) return false;
  const slug = task.contract.id.toLowerCase();
  const branch = `autonomy/spec-${slug}`;
  const worktree = join(inventory.worktreeRoot, `spec-${slug}`);
  if (!existsSync(worktree)) {
    await mkdir(inventory.worktreeRoot, { recursive: true });
    const exists =
      runner.run('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
        cwd: root,
      }).status === 0;
    git(
      runner,
      root,
      exists
        ? ['worktree', 'add', worktree, branch]
        : ['worktree', 'add', '-b', branch, worktree, 'main'],
    );
  }
  pnpm(runner, worktree, ['install', '--frozen-lockfile']);
  executeAgent(
    provider,
    worktree,
    `Resolve only specification gap ${task.contract.id} for cluster ${task.contract.cluster}. Choose the narrowest reversible specification consistent with existing sources. Never enable live trading, external writes, secrets or irreversible migrations. Modify only specification/ADR sources and deterministic generated tasks, clusters, contexts and spec artifacts. Do not modify product source, workflow, policy, package scripts, verifier or control plane. Do not run git commit, git push or gh. Leave changes uncommitted and stop.`,
    'AUTOPILOT_SPECIFICATION_RESOLUTION_FAILED',
  );
  const paths = changedPaths(runner, worktree);
  assertOnlyPaths(
    paths,
    (path) => SPEC_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)),
    'AUTOPILOT_SPECIFICATION_SCOPE',
  );
  for (const args of [
    ['prd:compile'],
    ['spec:verify'],
    ['prd:drift-check'],
    ['requirements:coverage'],
    ['architecture:verify'],
  ])
    pnpm(runner, worktree, args);
  git(runner, worktree, ['add', '--', ...changedPaths(runner, worktree)]);
  git(runner, worktree, [
    'commit',
    '-m',
    `spec(${task.contract.id}): resolve specification gap`,
  ]);
  git(runner, worktree, ['push', '-u', 'origin', branch]);
  let pr = findPullRequest(runner, root, branch, 'main');
  if (!pr) {
    gh(runner, root, [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      'main',
      '--title',
      `spec(${task.contract.id}): resolve autonomous gap`,
      '--body',
      `Machine-generated reversible specification amendment for ${task.contract.id}.`,
    ]);
    pr = findPullRequest(runner, root, branch, 'main');
  }
  if (!pr) throw new Error('AUTOPILOT_SPECIFICATION_PR_MISSING');
  const completed = await waitForPullRequest(runner, root, pr.number, pollMilliseconds);
  const failures = failedChecks(completed);
  if (failures.length > 0)
    throw new Error(`AUTOPILOT_SPECIFICATION_CI_FAILED:${failures.join(',')}`);
  if (completed.mergeStateStatus !== 'CLEAN')
    throw new Error(
      `AUTOPILOT_SPECIFICATION_PR_NOT_CLEAN:${completed.mergeStateStatus ?? 'UNKNOWN'}`,
    );
  if (!policy.allowAutonomousMerge)
    throw new Error('AUTOPILOT_AUTONOMOUS_MERGE_DISABLED');
  gh(runner, root, [
    'pr',
    'merge',
    String(pr.number),
    '--merge',
    '--delete-branch=false',
  ]);
  git(runner, root, ['fetch', 'origin', '--prune']);
  git(runner, root, ['pull', '--ff-only', 'origin', 'main']);
  git(runner, task.cluster.branch.worktree, [
    'merge',
    '--no-edit',
    'refs/remotes/origin/main',
  ]);
  git(runner, task.cluster.branch.worktree, ['push', 'origin', task.cluster.branch.branch]);
  pnpm(runner, task.cluster.branch.worktree, ['task:validate', task.contract.id]);
  pnpm(runner, task.cluster.branch.worktree, ['task:mark-ready', task.contract.id]);
  git(runner, root, ['worktree', 'remove', '--force', worktree]);
  return true;
};

const waitForMainCi = async (
  root: string,
  runner: CommandRunner,
  commit: string,
  pollMilliseconds: number,
): Promise<void> => {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  for (;;) {
    const runs = JSON.parse(
      gh(runner, root, [
        'run',
        'list',
        '--commit',
        commit,
        '--workflow',
        'CI',
        '--limit',
        '1',
        '--json',
        'databaseId,status,conclusion,url',
      ]),
    ) as Array<{ databaseId: number; status: string; conclusion?: string }>;
    const run = runs[0];
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success')
        throw new Error(
          `AUTOPILOT_FINAL_MAIN_CI_FAILED:${run.databaseId}:${run.conclusion}`,
        );
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(`AUTOPILOT_FINAL_MAIN_CI_TIMEOUT:${commit}`);
    await sleep(pollMilliseconds);
  }
};

export interface AutopilotOptions {
  dryRun?: boolean;
  issueReceiptOnly?: boolean;
  maxCycles?: number;
  pollMilliseconds?: number;
  providerId?: AgentProviderId;
  persistInfrastructureRetryState?: boolean;
}

export const runAutopilot = async (
  root: string,
  runner: CommandRunner,
  options: AutopilotOptions = {},
): Promise<string> => {
  const policy = await loadAutonomyPolicy(root);
  const provider = createProvider(
    options.providerId ?? DEFAULT_AUTONOMOUS_PROVIDER,
    runner,
  );
  let inventory = await discoverProject(root, runner);
  let decision = decideNextAction(inventory);
  if (options.dryRun) return renderDryRun(inventory, decision, provider.id);
  const release = await acquireAutopilotLock(root, runner);
  const persistent = await readPersistentState(root, runner);
  const pollMilliseconds = options.pollMilliseconds ?? 15_000;
  const persistInfrastructureRetryState =
    options.persistInfrastructureRetryState !== false;
  try {
    if (options.issueReceiptOnly) {
      const task = inventory.activeTask;
      if (!task) throw new Error('AUTOPILOT_ACTIVE_TASK_REQUIRED');
      const generated = await leaseForTask(inventory, task, runner, provider);
      return generated.binding.launchReceiptId!;
    }
    const detection = provider.detect();
    if (!detection.available || !provider.executePayload)
      throw new Error(
        `AUTONOMOUS_PROVIDER_UNAVAILABLE:${provider.id}:${detection.detail}`,
      );
    for (
      let cycle = 0;
      cycle < (options.maxCycles ?? Number.POSITIVE_INFINITY);
      cycle += 1
    ) {
      inventory = await discoverProject(root, runner);
      if (inventory.activeTask) {
        await ensureLease(root, runner, inventory.activeTask);
        inventory = await discoverProject(root, runner);
        if (
          inventory.activeTask &&
          (await bindCompletedCorrection(root, runner, inventory.activeTask))
        )
          continue;
      }
      decision = decideNextAction(inventory);
      if (
        decision.action === 'STOP' &&
        decision.reason.startsWith('UNRESOLVED_BLOCKED_TASKS:') &&
        (await resolveSpecificationGap(
          root,
          runner,
          provider,
          inventory,
          policy,
          pollMilliseconds,
        ))
      )
        continue;
      if (decision.action === 'CORRECT_TASK' && decision.task) {
        const rounds = (await correctionReceipts(root, runner, decision.task)).length;
        if (rounds >= policy.limits.taskCorrectionRounds)
          throw new Error(
            `AUTOPILOT_CORRECTION_LIMIT:${decision.task.contract.id}:${rounds}`,
          );
      }
      if (decision.action === 'CREATE_CLUSTER_PR' && !policy.allowAutonomousMerge)
        throw new Error('AUTOPILOT_AUTONOMOUS_MERGE_DISABLED');
      const reviewing =
        decision.action === 'REVIEW_CLUSTER' ? decision.cluster : undefined;
      const integrating =
        decision.action === 'CREATE_CLUSTER_PR' ? decision.cluster : undefined;
      const retryTask = decision.task ?? decision.nextTask;
      const retryCluster =
        decision.cluster ?? decision.nextCluster ?? retryTask?.cluster;
      const retryTarget =
        retryTask?.contract.id ?? retryCluster?.contract.id ?? 'project';
      const retryVersion =
        retryTask?.workspaceHead ??
        retryCluster?.worktreeHead ??
        retryCluster?.branchHead ??
        inventory.rootHead;
      await withInfrastructureRetry(
        root,
        runner,
        policy,
        persistent,
        infrastructureRetryKey(
          inventory.rootHead,
          decision.action,
          retryTarget,
          retryVersion,
        ),
        persistInfrastructureRetryState,
        async () => {
          await executeOrchestration(root, runner, { dryRun: false, provider });
        },
      );
      if (reviewing)
        await reviewCluster(root, runner, provider, inventory, reviewing);
      if (integrating && policy.allowAutonomousCiRepair) {
        const pr = findPullRequest(
          runner,
          root,
          integrating.branch.branch,
          integrating.branch.integrationTarget,
        );
        if (pr) {
          const failures = failedChecks(pr);
          if (failures.length > 0) {
            const round =
              (persistent.ciRepairRounds[integrating.contract.id] ?? 0) + 1;
            if (round > policy.limits.clusterCiCorrectionRounds)
              throw new Error(
                `AUTOPILOT_CLUSTER_CI_REPAIR_LIMIT:${integrating.contract.id}:${round - 1}`,
              );
            persistent.ciRepairRounds[integrating.contract.id] = round;
            await writePersistentState(root, runner, persistent);
            await repairClusterCi(
              root,
              runner,
              provider,
              integrating,
              { number: pr.number, url: pr.url, failures },
              round,
            );
            continue;
          }
        }
      }
      if (decision.action === 'COMPLETE_PROJECT') {
        const head = git(runner, root, ['rev-parse', 'HEAD']);
        await waitForMainCi(root, runner, head, pollMilliseconds);
        return 'AUTOPILOT_COMPLETE';
      }
      if (decision.action === 'CREATE_CLUSTER_PR') await sleep(pollMilliseconds);
    }
    return 'AUTOPILOT_CYCLE_LIMIT';
  } finally {
    await release();
  }
};