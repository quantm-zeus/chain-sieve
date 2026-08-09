import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitCommonDirectory } from '../agent/lib/runtime.js';
import type { CommandResult, CommandRunner } from '../agent/lib/types.js';

const FRAMEWORK_TASK_ID = 'T-FW-AUTOPILOT';
const FRAMEWORK_CLUSTER_HEAD = 'd99c600f0aba57bfb1554591381139482a8b3862';
const FRAMEWORK_MERGE_COMMIT = '805a7a163816908febe24fdbaa479952d0ad32c8';
const G0_BRANCH = 'cluster/g0';
const STATE_FILE = 'task-state.json';

type LifecycleState = {
  taskId: string;
  state: string;
  leaseVersion?: number;
  leaseState?: string;
  leaseId?: string;
  holder?: string;
  history?: unknown[];
  [key: string]: unknown;
};

type LifecycleStore = {
  schemaVersion: '2.0.0';
  tasks: Record<string, LifecycleState>;
};

const detail = (result: CommandResult): string =>
  (result.stderr || result.stdout || 'no-command-output').trim();

const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0) throw new Error(`${code}:${detail(result)}`);
  return result.stdout.trim();
};

const git = (runner: CommandRunner, root: string, args: string[]): string =>
  requireSuccess(
    runner.run('git', args, { cwd: root, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_BOOTSTRAP_MIGRATION_GIT_FAILED:${args.join(':')}`,
  );

const optionalGit = (
  runner: CommandRunner,
  root: string,
  args: string[],
): string | undefined => {
  const result = runner.run('git', args, {
    cwd: root,
    timeoutMilliseconds: 120_000,
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
};

const isAncestor = (
  runner: CommandRunner,
  root: string,
  ancestor: string,
  descendant: string,
): boolean =>
  runner.run('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
    timeoutMilliseconds: 120_000,
  }).status === 0;

const lifecyclePath = (root: string, runner: CommandRunner): string =>
  join(gitCommonDirectory(root, runner), 'ciag-runtime', STATE_FILE);

const readLifecycleStore = async (
  root: string,
  runner: CommandRunner,
): Promise<LifecycleStore> => {
  try {
    const parsed = JSON.parse(
      await readFile(lifecyclePath(root, runner), 'utf8'),
    ) as LifecycleStore;
    if (parsed.schemaVersion !== '2.0.0' || !parsed.tasks)
      throw new Error('PRODUCT_FACTORY_BOOTSTRAP_LIFECYCLE_STATE_INVALID');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: '2.0.0', tasks: {} };
    if (
      error instanceof Error &&
      error.message === 'PRODUCT_FACTORY_BOOTSTRAP_LIFECYCLE_STATE_INVALID'
    )
      throw error;
    throw new Error('PRODUCT_FACTORY_BOOTSTRAP_LIFECYCLE_STATE_INVALID');
  }
};

const writeLifecycleStore = async (
  root: string,
  runner: CommandRunner,
  state: LifecycleStore,
): Promise<void> => {
  const path = lifecyclePath(root, runner);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const frameworkStateCanBeRestored = (
  state: LifecycleState | undefined,
): boolean =>
  !state ||
  (['DRAFT', 'VALIDATED', 'READY'].includes(state.state) &&
    !state.leaseId &&
    !state.holder &&
    (state.leaseVersion ?? 0) === 0);

const restoreFrameworkCompletion = async (
  root: string,
  runner: CommandRunner,
  store: LifecycleStore,
): Promise<boolean> => {
  const current = store.tasks[FRAMEWORK_TASK_ID];
  if (current?.state === 'MERGED') return false;
  if (!frameworkStateCanBeRestored(current)) return false;

  const head = git(runner, root, ['rev-parse', 'HEAD']);
  if (
    !isAncestor(runner, root, FRAMEWORK_CLUSTER_HEAD, head) ||
    !isAncestor(runner, root, FRAMEWORK_MERGE_COMMIT, head)
  )
    throw new Error(
      `PRODUCT_FACTORY_FRAMEWORK_BOOTSTRAP_EVIDENCE_MISSING:${FRAMEWORK_MERGE_COMMIT}`,
    );

  store.tasks[FRAMEWORK_TASK_ID] = {
    taskId: FRAMEWORK_TASK_ID,
    state: 'MERGED',
    leaseVersion: 0,
    history: [
      {
        at: new Date().toISOString(),
        command: 'compatibility:restore-framework-pr-30',
        from: current?.state ?? 'DRAFT',
        to: 'MERGED',
      },
    ],
  };
  await writeLifecycleStore(root, runner, store);
  console.log(
    `CHAINSIEVE_BOOTSTRAP_MIGRATION:FRAMEWORK_MERGED:${FRAMEWORK_MERGE_COMMIT}`,
  );
  return true;
};

const g0LifecycleIsPristine = (store: LifecycleStore): boolean => {
  const states = Object.values(store.tasks).filter((state) =>
    state.taskId.startsWith('T-G0-'),
  );
  return states.every(
    (state) =>
      ['DRAFT', 'VALIDATED', 'READY'].includes(state.state) &&
      !state.leaseId &&
      !state.holder &&
      (state.leaseVersion ?? 0) === 0,
  );
};

const branchAttachedToWorktree = (
  runner: CommandRunner,
  root: string,
  branch: string,
): boolean => {
  const listing = git(runner, root, ['worktree', 'list', '--porcelain']);
  return listing
    .split(/\r?\n/)
    .some((line) => line.trim() === `branch refs/heads/${branch}`);
};

const archiveRef = (
  runner: CommandRunner,
  root: string,
  sha: string,
  suffix: string,
): string => {
  const branch = `archive/pre-autopilot/${suffix}-${sha.slice(0, 12)}`;
  if (!optionalGit(runner, root, ['show-ref', '--verify', `refs/heads/${branch}`]))
    git(runner, root, ['branch', branch, sha]);
  git(runner, root, [
    'push',
    'origin',
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  return branch;
};

const normalizeLegacyG0Branch = (
  root: string,
  runner: CommandRunner,
  store: LifecycleStore,
): boolean => {
  if (!g0LifecycleIsPristine(store)) return false;
  if (branchAttachedToWorktree(runner, root, G0_BRANCH))
    throw new Error('PRODUCT_FACTORY_BOOTSTRAP_MIGRATION_G0_WORKTREE_ACTIVE');

  git(runner, root, ['fetch', 'origin', '--prune']);
  const head = git(runner, root, ['rev-parse', 'HEAD']);
  const local = optionalGit(runner, root, [
    'rev-parse',
    '--verify',
    `refs/heads/${G0_BRANCH}`,
  ]);
  const remote = optionalGit(runner, root, [
    'rev-parse',
    '--verify',
    `refs/remotes/origin/${G0_BRANCH}`,
  ]);

  const legacy = remote ?? local;
  if (!legacy || (legacy === head && (!local || local === head))) return false;

  if (remote && remote !== head)
    archiveRef(runner, root, remote, 'cluster-g0-remote');
  if (local && local !== head && local !== remote)
    archiveRef(runner, root, local, 'cluster-g0-local');

  if (local) git(runner, root, ['branch', '-f', G0_BRANCH, head]);
  else git(runner, root, ['branch', G0_BRANCH, head]);

  if (remote)
    git(runner, root, [
      'push',
      `--force-with-lease=refs/heads/${G0_BRANCH}:${remote}`,
      'origin',
      `refs/heads/${G0_BRANCH}:refs/heads/${G0_BRANCH}`,
    ]);
  else
    git(runner, root, [
      'push',
      '-u',
      'origin',
      `refs/heads/${G0_BRANCH}:refs/heads/${G0_BRANCH}`,
    ]);

  console.log(
    `CHAINSIEVE_BOOTSTRAP_MIGRATION:G0_BASELINE:${legacy}->${head}`,
  );
  return true;
};

export const runBootstrapCompatibilityMigrations = async (
  root: string,
  runner: CommandRunner,
): Promise<void> => {
  const branch = git(runner, root, ['branch', '--show-current']);
  if (branch !== 'main')
    throw new Error(`PRODUCT_FACTORY_BOOTSTRAP_MIGRATION_MAIN_REQUIRED:${branch}`);
  const dirty = git(runner, root, ['status', '--porcelain=v1']);
  if (dirty)
    throw new Error(`PRODUCT_FACTORY_BOOTSTRAP_MIGRATION_ROOT_DIRTY:${dirty}`);

  const store = await readLifecycleStore(root, runner);
  await restoreFrameworkCompletion(root, runner, store);
  normalizeLegacyG0Branch(root, runner, store);
};
