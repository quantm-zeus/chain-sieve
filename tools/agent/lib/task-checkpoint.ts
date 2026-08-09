import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
  if (state !== 'IMPLEMENTING') return undefined;
  const head = cleanAtomicTaskCommit(runner, binding);
  if (!head || !binding.launchReceiptId) return undefined;

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
