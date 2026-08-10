import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { taskBranch } from './paths.js';
import type { CommandResult, CommandRunner, TaskLaunchBinding } from './types.js';

const git = (
  runner: CommandRunner,
  cwd: string,
  args: string[],
): CommandResult =>
  runner.run('git', args, { cwd, timeoutMilliseconds: 10_000 });

const gitText = (
  runner: CommandRunner,
  cwd: string,
  args: string[],
): string | undefined => {
  const result = git(runner, cwd, args);
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const gitCommonDirectory = (
  runner: CommandRunner,
  workspace: string,
): string | undefined => {
  const value = gitText(runner, workspace, ['rev-parse', '--git-common-dir']);
  if (!value) return undefined;
  return resolve(workspace, isAbsolute(value) ? value : join(workspace, value));
};

const taskStatePath = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => {
  const common = gitCommonDirectory(runner, binding.taskWorkspace);
  return common ? join(common, 'ciag-runtime', 'task-state.json') : undefined;
};

const readLifecycleDocument = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): {
  path: string;
  value: {
    schemaVersion: string;
    tasks: Record<string, Record<string, unknown>>;
  };
} | undefined => {
  const path = taskStatePath(runner, binding);
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: string;
      tasks: Record<string, Record<string, unknown>>;
    };
    if (value.schemaVersion !== '2.0.0' || typeof value.tasks !== 'object')
      return undefined;
    return { path, value };
  } catch {
    return undefined;
  }
};

export const readTaskLifecycleState = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => {
  const document = readLifecycleDocument(runner, binding);
  const state = document?.value.tasks[binding.task.contract.id]?.state;
  return typeof state === 'string' ? state : undefined;
};

export const cleanAtomicTaskCommit = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => {
  const status = gitText(runner, binding.taskWorkspace, [
    'status',
    '--porcelain=v1',
  ]);
  if (status === undefined || status !== '') return undefined;
  const head = gitText(runner, binding.taskWorkspace, ['rev-parse', 'HEAD']);
  if (!head || head === binding.baseCommit) return undefined;
  const count = gitText(runner, binding.taskWorkspace, [
    'rev-list',
    '--count',
    `${binding.baseCommit}..${head}`,
  ]);
  if (Number(count) !== 1) return undefined;
  return head;
};

const ensureCanonicalTaskBranch = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  head: string,
): CommandResult | undefined => {
  const expected = taskBranch(binding.task.contract.id);
  const current = gitText(runner, binding.taskWorkspace, [
    'branch',
    '--show-current',
  ]);
  if (current === expected) return undefined;

  const expectedRef = gitText(runner, binding.taskWorkspace, [
    'rev-parse',
    '--verify',
    `refs/heads/${expected}`,
  ]);
  if (expectedRef && expectedRef !== binding.baseCommit && expectedRef !== head) {
    return {
      status: 1,
      stdout: '',
      stderr: `TASK_CHECKPOINT_BRANCH_DIVERGED:${binding.task.contract.id}:${expectedRef}:${head}`,
    };
  }

  const attach = git(runner, binding.taskWorkspace, [
    'switch',
    '-C',
    expected,
    head,
  ]);
  if (attach.status !== 0) {
    return {
      ...attach,
      stderr: `TASK_CHECKPOINT_BRANCH_REATTACH_FAILED:${binding.task.contract.id}:${attach.stderr || attach.stdout}`,
    };
  }
  console.log(
    `CHAINSIEVE_TASK_BRANCH_REATTACHED:${binding.task.contract.id}:${current || 'detached'}:${expected}:${head}`,
  );
  return undefined;
};

const adoptLeasedAtomicCommit = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  head: string,
): CommandResult | undefined => {
  const document = readLifecycleDocument(runner, binding);
  const target = document?.value.tasks[binding.task.contract.id];
  if (!document || !target || target.state !== 'LEASED') return undefined;

  const expectedBranch = taskBranch(binding.task.contract.id);
  const tree = gitText(runner, binding.taskWorkspace, ['rev-parse', 'HEAD^{tree}']);
  if (!tree)
    return {
      status: 1,
      stdout: '',
      stderr: `TASK_CHECKPOINT_TREE_UNAVAILABLE:${binding.task.contract.id}`,
    };
  if (
    target.holder !== binding.holder ||
    target.leaseId !== binding.leaseId ||
    target.leaseVersion !== binding.fencingVersion ||
    target.leaseState !== 'ACTIVE' ||
    target.branch !== expectedBranch ||
    typeof target.expiresAt !== 'string' ||
    Date.parse(target.expiresAt) <= Date.now()
  )
    return {
      status: 1,
      stdout: '',
      stderr: `TASK_CHECKPOINT_LEASE_BINDING_INVALID:${binding.task.contract.id}`,
    };

  target.state = 'IMPLEMENTING';
  target.worktree = binding.taskWorkspace;
  const history = Array.isArray(target.history) ? target.history : [];
  history.push({
    from: 'LEASED',
    to: 'IMPLEMENTING',
    at: new Date().toISOString(),
    command: 'agent:adopt-committed-checkpoint',
    leaseVersion: binding.fencingVersion,
  });
  target.history = history;

  mkdirSync(dirname(document.path), { recursive: true });
  const temporary = `${document.path}.${process.pid}.checkpoint.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document.value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, document.path);
  console.log(
    `CHAINSIEVE_TASK_COMMIT_ADOPTED:${binding.task.contract.id}:${head}:${tree}`,
  );
  return undefined;
};

export const reconcileCommittedTaskCheckpoint = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  const state = readTaskLifecycleState(runner, binding);
  if (
    state &&
    ['SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED'].includes(
      state,
    )
  ) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_ALREADY_DURABLE:${binding.task.contract.id}:${state}`,
    );
    return { status: 0, stdout: '', stderr: '' };
  }
  if (state !== 'LEASED' && state !== 'IMPLEMENTING') return undefined;

  const head = cleanAtomicTaskCommit(runner, binding);
  if (!head || !binding.launchReceiptId) return undefined;

  const branchFailure = ensureCanonicalTaskBranch(runner, binding, head);
  if (branchFailure) return branchFailure;
  if (state === 'LEASED') {
    const adoptionFailure = adoptLeasedAtomicCommit(runner, binding, head);
    if (adoptionFailure) return adoptionFailure;
  }

  console.log(
    `CHAINSIEVE_TASK_CHECKPOINT_RECONCILE:${binding.task.contract.id}:${head}`,
  );
  const result = runner.run(
    'pnpm',
    [
      '--silent',
      'task:self-review',
      binding.task.contract.id,
      '--holder',
      binding.holder,
      '--lease-version',
      String(binding.fencingVersion),
      '--launch-receipt-id',
      binding.launchReceiptId,
    ],
    {
      cwd: binding.taskWorkspace,
      timeoutMilliseconds: 30 * 60_000,
      streamOutput: true,
    },
  );
  if (result.status === 0) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_RECONCILED:${binding.task.contract.id}:${head}`,
    );
    return result;
  }
  return {
    ...result,
    stderr: `TASK_CHECKPOINT_RECONCILE_FAILED:${binding.task.contract.id}:${result.stderr || result.stdout}`,
  };
};
