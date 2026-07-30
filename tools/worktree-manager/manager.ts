import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';
import type { LifecycleDocument, TaskState } from '../task-runner/state.js';
import {
  isManagedTaskWorkspace,
  canonicalWorktreePath,
  taskBranch,
  taskWorkspacePath,
} from './identity.js';

const protectedStates = new Set([
  'LEASED',
  'IMPLEMENTING',
  'SELF_REVIEWING',
  'VERIFYING',
  'VERIFIED',
  'MERGE_QUEUED',
]);
const lifecycleStates = new Set([
  'DRAFT',
  'VALIDATED',
  'READY',
  ...protectedStates,
  'MERGED',
  'BLOCKED',
  'INTEGRATION_FAILED',
  'REVERTED_AFTER_INTEGRATION_FAILURE',
]);
const leaseStates = new Set(['ACTIVE', 'RELEASED', 'EXPIRED', 'COMPLETED']);

export class WorktreeManagerError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly details: string[] = [],
  ) {
    super(message ? `${code}:${message}` : code);
    this.name = 'WorktreeManagerError';
  }
}

const git = (
  args: string[],
  cwd: string,
  allowFailure = false,
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const value = {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? result.error?.message ?? '').trim(),
  };
  if (value.status !== 0 && !allowFailure)
    throw new WorktreeManagerError(
      'WORKTREE_GIT_FAILED',
      `git ${args.join(' ')}`,
      [value.stderr].filter(Boolean),
    );
  return value;
};

interface WorktreeRegistration {
  path: string;
  branch?: string;
  head?: string;
}

const canonicalPath = canonicalWorktreePath;

const registrations = (cwd: string): WorktreeRegistration[] =>
  git(['worktree', 'list', '--porcelain'], cwd).stdout
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const path = lines
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length);
      if (!path) throw new WorktreeManagerError('WORKTREE_LIST_INVALID');
      const head = lines
        .find((line) => line.startsWith('HEAD '))
        ?.slice('HEAD '.length);
      const branch = lines
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length);
      return {
        path,
        ...(head ? { head } : {}),
        ...(branch ? { branch } : {}),
      };
    });

const commonDirectory = (cwd: string): string => {
  const raw = git(['rev-parse', '--git-common-dir'], cwd).stdout;
  return canonicalPath(isAbsolute(raw) ? raw : resolve(cwd, raw));
};

const lifecycle = (cwd: string): LifecycleDocument | undefined => {
  const path = join(commonDirectory(cwd), 'ciag-runtime', 'task-state.json');
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== '2.0.0' ||
      !('tasks' in value) ||
      !value.tasks ||
      typeof value.tasks !== 'object' ||
      Array.isArray(value.tasks)
    )
      throw new Error('invalid lifecycle schema');
    const tasks: Record<string, TaskState> = {};
    for (const [taskId, raw] of Object.entries(value.tasks)) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !('taskId' in raw) ||
        raw.taskId !== taskId ||
        !('state' in raw) ||
        typeof raw.state !== 'string' ||
        !lifecycleStates.has(raw.state) ||
        !('leaseVersion' in raw) ||
        !Number.isInteger(raw.leaseVersion) ||
        Number(raw.leaseVersion) < 0
      )
        throw new Error(`invalid task lifecycle:${taskId}`);
      const optionalStrings = [
        'holder',
        'leaseId',
        'acquiredAt',
        'renewedAt',
        'expiresAt',
        'baseCommit',
        'branch',
        'worktree',
      ];
      if (
        optionalStrings.some(
          (key) =>
            key in raw &&
            raw[key as keyof typeof raw] !== undefined &&
            typeof raw[key as keyof typeof raw] !== 'string',
        ) ||
        ('leaseState' in raw &&
          raw.leaseState !== undefined &&
          (typeof raw.leaseState !== 'string' ||
            !leaseStates.has(raw.leaseState)))
      )
        throw new Error(`invalid task lifecycle fields:${taskId}`);
      tasks[taskId] = raw as TaskState;
    }
    return { schemaVersion: '2.0.0', tasks };
  } catch (error) {
    throw new WorktreeManagerError(
      'TASK_STATE_INVALID',
      path,
      [error instanceof Error ? error.message : String(error)],
    );
  }
};

const activeLease = (state: TaskState | undefined, now = Date.now()): boolean =>
  Boolean(
    state &&
      protectedStates.has(state.state) &&
      state.leaseState === 'ACTIVE' &&
      Number.isInteger(state.leaseVersion) &&
      state.leaseVersion >= 1 &&
      state.holder &&
      state.holder.trim() &&
      state.leaseId &&
      state.leaseId.trim() &&
      state.acquiredAt &&
      Number.isFinite(Date.parse(state.acquiredAt)) &&
      state.expiresAt &&
      Date.parse(state.expiresAt) > now,
  );

const lifecycleOwnsCommittedBranch = (
  state: TaskState | undefined,
  expectedBranch: string,
  revision: string,
  target: string,
  clusterHead: string,
  gitCwd: string,
): boolean =>
  Boolean(
    activeLease(state) &&
      state?.branch === expectedBranch &&
      state.worktree &&
      canonicalPath(state.worktree) === canonicalPath(target) &&
      state.baseCommit &&
      git(
        ['merge-base', '--is-ancestor', state.baseCommit, revision],
        gitCwd,
        true,
      ).status === 0 &&
      git(
        ['merge-base', '--is-ancestor', clusterHead, revision],
        gitCwd,
        true,
      ).status === 0,
  );

const uniqueCommits = (
  cwd: string,
  baseBranch: string,
  branch: string,
): string[] => {
  const output = git(
    ['log', '--format=%H %s', `${baseBranch}..${branch}`],
    cwd,
  ).stdout;
  return output ? output.split('\n') : [];
};

const assertSource = (
  task: TaskContract,
  cwd: string,
): {
  root: string;
  branch: string;
  baseBranch: string;
  clusterHead: string;
  target: string;
} => {
  const root = git(['rev-parse', '--show-toplevel'], cwd).stdout;
  const branch = taskBranch(task.id);
  const baseBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  const current = git(['branch', '--show-current'], cwd).stdout;
  if (current !== baseBranch)
    throw new WorktreeManagerError('CLUSTER_BRANCH_REQUIRED', baseBranch);
  if (git(['status', '--porcelain'], cwd).stdout !== '')
    throw new WorktreeManagerError('SOURCE_WORKTREE_NOT_CLEAN');
  const target = taskWorkspacePath(root, task.id);
  if (!isManagedTaskWorkspace(root, target))
    throw new WorktreeManagerError('UNSAFE_WORKTREE_TARGET', target);
  return {
    root,
    branch,
    baseBranch,
    clusterHead: git(['rev-parse', 'HEAD'], cwd).stdout,
    target,
  };
};

const removeSafePartialTarget = (
  root: string,
  target: string,
  registered: boolean,
  document: LifecycleDocument | undefined,
): boolean => {
  if (!existsSync(target)) return false;
  const referenced = Object.values(document?.tasks ?? {}).some(
    (state) =>
      state.worktree &&
      canonicalPath(state.worktree) === canonicalPath(target),
  );
  const safe =
    isManagedTaskWorkspace(root, target) &&
    lstatSync(target).isDirectory() &&
    readdirSync(target).length === 0 &&
    !registered &&
    !referenced;
  if (!safe)
    throw new WorktreeManagerError(
      'UNREGISTERED_TASK_WORKTREE_PATH_CONFLICT',
      target,
    );
  rmdirSync(target);
  return true;
};

export interface ManagedWorktree {
  taskId: string;
  branch: string;
  baseBranch: string;
  target: string;
  reused: boolean;
  recoveredPartialTarget?: boolean;
}

export const createTaskWorktree = (
  task: TaskContract,
  cwd = process.cwd(),
): ManagedWorktree => {
  const { root, branch, baseBranch, clusterHead, target } = assertSource(
    task,
    cwd,
  );
  const records = registrations(cwd);
  const expectedPath = canonicalPath(target);
  const targetRegistration = records.find(
    (record) => canonicalPath(record.path) === expectedPath,
  );
  const branchRegistration = records.find(
    (record) => record.branch === branch,
  );
  if (
    branchRegistration &&
    canonicalPath(branchRegistration.path) !== expectedPath
  )
    throw new WorktreeManagerError(
      'TASK_BRANCH_ATTACHED_TO_OTHER_WORKTREE',
      branchRegistration.path,
    );
  const document = lifecycle(cwd);
  const state = document?.tasks[task.id];
  if (targetRegistration) {
    if (targetRegistration.branch !== branch)
      throw new WorktreeManagerError(
        'WORKTREE_IDENTITY_MISMATCH',
        `${targetRegistration.branch ?? 'detached'}:${branch}`,
      );
    if (commonDirectory(target) !== commonDirectory(cwd))
      throw new WorktreeManagerError('WORKTREE_REPOSITORY_MISMATCH', target);
    const status = git(['status', '--porcelain'], target).stdout;
    if (status !== '')
      throw new WorktreeManagerError(
        'TASK_WORKTREE_NOT_CLEAN',
        target,
        status.split('\n'),
      );
    const head = git(['rev-parse', 'HEAD'], target).stdout;
    if (head !== clusterHead) {
      const commits = uniqueCommits(cwd, baseBranch, branch);
      if (
        commits.length === 0 ||
        !lifecycleOwnsCommittedBranch(
          state,
          branch,
          branch,
          target,
          clusterHead,
          target,
        )
      )
        throw new WorktreeManagerError(
          commits.length > 0
            ? 'UNCLAIMED_TASK_BRANCH_HAS_COMMITS'
            : 'TASK_BRANCH_BASE_MISMATCH',
          branch,
          commits,
        );
    }
    return { taskId: task.id, branch, baseBranch, target, reused: true };
  }

  const localBranch =
    git(
      ['show-ref', '--verify', `refs/heads/${branch}`],
      cwd,
      true,
    ).status === 0;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteBranch =
    git(['show-ref', '--verify', remoteRef], cwd, true).status === 0;
  if (localBranch && remoteBranch) {
    const localHead = git(['rev-parse', branch], cwd).stdout;
    const remoteHead = git(['rev-parse', remoteRef], cwd).stdout;
    if (localHead !== remoteHead)
      throw new WorktreeManagerError(
        'TASK_BRANCH_REMOTE_DIVERGENCE',
        branch,
        [`local ${localHead}`, `origin ${remoteHead}`],
      );
  }
  const revision = localBranch ? branch : remoteBranch ? remoteRef : undefined;
  if (revision) {
    const head = git(['rev-parse', revision], cwd).stdout;
    const commits = uniqueCommits(cwd, baseBranch, revision);
    if (head !== clusterHead) {
      if (
        commits.length === 0 ||
        !lifecycleOwnsCommittedBranch(
          state,
          branch,
          revision,
          target,
          clusterHead,
          cwd,
        )
      )
        throw new WorktreeManagerError(
          commits.length > 0
            ? 'UNCLAIMED_TASK_BRANCH_HAS_COMMITS'
            : 'TASK_BRANCH_BASE_MISMATCH',
          branch,
          commits,
        );
    } else if (activeLease(state)) {
      throw new WorktreeManagerError(
        'TASK_BRANCH_HAS_ACTIVE_LEASE',
        task.id,
      );
    }
    const recoveredPartialTarget = removeSafePartialTarget(
      root,
      target,
      false,
      document,
    );
    if (!localBranch) git(['branch', branch, remoteRef], cwd);
    git(['worktree', 'add', target, branch], cwd);
    return {
      taskId: task.id,
      branch,
      baseBranch,
      target,
      reused: true,
      ...(recoveredPartialTarget ? { recoveredPartialTarget: true } : {}),
    };
  }

  const recoveredPartialTarget = removeSafePartialTarget(
    root,
    target,
    false,
    document,
  );
  git(['worktree', 'add', '-b', branch, target, 'HEAD'], cwd);
  return {
    taskId: task.id,
    branch,
    baseBranch,
    target,
    reused: false,
    ...(recoveredPartialTarget ? { recoveredPartialTarget: true } : {}),
  };
};

export interface CleanupResult {
  taskId: string;
  removed: string;
  deletedBranch?: string;
  alreadyRemoved: boolean;
  preservedBranch?: string;
}

export const cleanupTaskWorktree = (
  task: TaskContract,
  cwd = process.cwd(),
): CleanupResult => {
  const { root, branch, baseBranch, target } = assertSource(task, cwd);
  const records = registrations(cwd);
  const expectedPath = canonicalPath(target);
  const targetRegistration = records.find(
    (record) => canonicalPath(record.path) === expectedPath,
  );
  const branchRegistration = records.find(
    (record) => record.branch === branch,
  );
  if (
    branchRegistration &&
    canonicalPath(branchRegistration.path) !== expectedPath
  )
    throw new WorktreeManagerError(
      'TASK_BRANCH_ATTACHED_TO_OTHER_WORKTREE',
      branchRegistration.path,
    );
  if (targetRegistration && targetRegistration.branch !== branch)
    throw new WorktreeManagerError('WORKTREE_IDENTITY_MISMATCH', target);
  const document = lifecycle(cwd);
  const state = document?.tasks[task.id];
  if (activeLease(state))
    throw new WorktreeManagerError(
      'TASK_WORKTREE_HAS_ACTIVE_LEASE',
      task.id,
    );
  if (targetRegistration && commonDirectory(target) !== commonDirectory(cwd))
    throw new WorktreeManagerError('WORKTREE_REPOSITORY_MISMATCH', target);
  const localBranch =
    git(
      ['show-ref', '--verify', `refs/heads/${branch}`],
      cwd,
      true,
    ).status === 0;
  if (localBranch) {
    const commits = uniqueCommits(cwd, baseBranch, branch);
    if (commits.length > 0)
      throw new WorktreeManagerError(
        'TASK_BRANCH_HAS_UNMERGED_COMMITS',
        branch,
        commits,
      );
  }
  if (targetRegistration) {
    const status = git(['status', '--porcelain'], target).stdout;
    if (status !== '')
      throw new WorktreeManagerError(
        'TASK_WORKTREE_NOT_CLEAN',
        target,
        status.split('\n'),
      );
    git(['worktree', 'remove', target], cwd);
  } else {
    removeSafePartialTarget(root, target, false, document);
  }

  if (!localBranch)
    return {
      taskId: task.id,
      removed: target,
      alreadyRemoved: !targetRegistration,
    };
  git(['branch', '-d', branch], cwd);
  return {
    taskId: task.id,
    removed: target,
    deletedBranch: branch,
    alreadyRemoved: !targetRegistration,
  };
};

export const worktreeStatus = (cwd = process.cwd()): string =>
  git(['worktree', 'list', '--porcelain'], cwd).stdout;
