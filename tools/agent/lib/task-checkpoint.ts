import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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

export const readTaskLifecycleState = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => {
  const common = gitCommonDirectory(runner, binding.taskWorkspace);
  if (!common) return undefined;
  const path = join(common, 'ciag-runtime', 'task-state.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks?: Record<string, { state?: string }>;
    };
    return parsed.tasks?.[binding.task.contract.id]?.state;
  } catch {
    return undefined;
  }
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

const runLifecycle = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  args: string[],
): CommandResult =>
  runner.run('pnpm', ['--silent', ...args], {
    cwd: binding.taskWorkspace,
    timeoutMilliseconds: 30 * 60_000,
    streamOutput: true,
  });

export const reconcileCommittedTaskCheckpoint = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  const state = readTaskLifecycleState(runner, binding);
  const durable = Boolean(
    state &&
      ['SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED'].includes(
        state,
      ),
  );
  if (state !== 'LEASED' && state !== 'IMPLEMENTING' && !durable)
    return undefined;

  const head = cleanAtomicTaskCommit(runner, binding);
  if (head && state !== 'LEASED') {
    const branchFailure = ensureCanonicalTaskBranch(runner, binding, head);
    if (branchFailure) return branchFailure;
  }

  if (durable) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_ALREADY_DURABLE:${binding.task.contract.id}:${state}`,
    );
    return { status: 0, stdout: '', stderr: '' };
  }
  if (!head || !binding.launchReceiptId) return undefined;

  if (state === 'LEASED') {
    const adopted = runLifecycle(runner, binding, [
      'task:checkpoint-adopt',
      binding.task.contract.id,
      '--holder',
      binding.holder,
      '--lease-version',
      String(binding.fencingVersion),
    ]);
    if (adopted.status !== 0)
      return {
        ...adopted,
        stderr: `TASK_CHECKPOINT_ADOPT_FAILED:${binding.task.contract.id}:${adopted.stderr || adopted.stdout}`,
      };
  }

  console.log(
    `CHAINSIEVE_TASK_CHECKPOINT_RECONCILE:${binding.task.contract.id}:${head}`,
  );
  const reviewed = runLifecycle(runner, binding, [
    'task:self-review',
    binding.task.contract.id,
    '--holder',
    binding.holder,
    '--lease-version',
    String(binding.fencingVersion),
    '--launch-receipt-id',
    binding.launchReceiptId,
  ]);
  if (reviewed.status === 0) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_RECONCILED:${binding.task.contract.id}:${head}`,
    );
    return reviewed;
  }
  return {
    ...reviewed,
    stderr: `TASK_CHECKPOINT_RECONCILE_FAILED:${binding.task.contract.id}:${reviewed.stderr || reviewed.stdout}`,
  };
};
