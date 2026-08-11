import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileCommittedTaskCheckpoint } from '../../tools/agent/lib/task-checkpoint.js';
import type {
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RebindRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

  constructor(
    private readonly authorityCommon: string,
    private readonly taskCommon = authorityCommon,
  ) {}

  run(command: string, args: string[], options?: { cwd?: string }): CommandResult {
    this.calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    if (command === 'pnpm') {
      if (args[1] === 'task:checkpoint-adopt')
        return {
          status: 1,
          stdout: '',
          stderr: '{"status":"FAIL","error":"STALE_LEASE_VERSION"}',
        };
      return { status: 0, stdout: 'ok', stderr: '' };
    }
    if (command !== 'git')
      return { status: 1, stdout: '', stderr: 'unexpected' };
    if (args.join(' ') === 'rev-parse --git-common-dir')
      return {
        status: 0,
        stdout: `${options?.cwd === '/tmp/cluster-worktree' ? this.authorityCommon : this.taskCommon}\n`,
        stderr: '',
      };
    if (args.join(' ') === 'status --porcelain=v1')
      return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ') === 'rev-parse HEAD')
      return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    if (args[0] === 'rev-list')
      return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected git command' };
  }
}

const binding = (fencingVersion = 3, leaseId = 'lease-3'): PayloadBinding =>
  ({
    task: {
      contract: { id: 'T-REC-01', cluster: 'C-REC' },
      cluster: { branch: { worktree: '/tmp/cluster-worktree' } },
    },
    taskWorkspace: '/tmp/task-worktree',
    baseCommit: 'a'.repeat(40),
    leaseId,
    holder: 'agent-orchestrator',
    fencingVersion,
    launchReceiptId: `muse-receipt-${fencingVersion}`,
    failures: [],
  }) as unknown as PayloadBinding;

const writeLifecycle = async (
  common: string,
  leaseVersion: number,
  leaseId: string,
): Promise<void> => {
  const runtime = join(common, 'ciag-runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, 'task-state.json'),
    `${JSON.stringify({
      schemaVersion: '2.0.0',
      tasks: {
        'T-REC-01': {
          taskId: 'T-REC-01',
          state: 'LEASED',
          leaseVersion,
          holder: 'agent-orchestrator',
          leaseId,
          leaseState: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          baseCommit: 'a'.repeat(40),
          branch: 'task/t-rec-01',
          history: [],
        },
      },
    })}\n`,
  );
};

describe('checkpoint reconciliation lease rebinding', () => {
  it('rebinds only when the authoritative fencing version advances', async () => {
    const common = await mkdtemp(join(tmpdir(), 'chainsieve-checkpoint-rebind-'));
    roots.push(common);
    await writeLifecycle(common, 4, 'lease-4');

    const runner = new RebindRunner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('TASK_CHECKPOINT_REBIND_REQUIRED:T-REC-01:3:4'),
    });
    expect(runner.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  it('fails closed when the authoritative lifecycle snapshot regresses behind the launch binding', async () => {
    const common = await mkdtemp(join(tmpdir(), 'chainsieve-checkpoint-regression-'));
    roots.push(common);
    await writeLifecycle(common, 2, 'lease-2');

    const runner = new RebindRunner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding(4, 'lease-4'))).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(
        'TASK_CHECKPOINT_LEASE_SNAPSHOT_REGRESSION:T-REC-01:4:2:lease-4:lease-2',
      ),
    });
    expect(runner.calls.filter((call) => call.command === 'pnpm')).toEqual([]);
  });

  it('ignores a stale task-worktree runtime and reads fencing from cluster authority', async () => {
    const authority = await mkdtemp(join(tmpdir(), 'chainsieve-checkpoint-authority-'));
    const staleTask = await mkdtemp(join(tmpdir(), 'chainsieve-checkpoint-stale-task-'));
    roots.push(authority, staleTask);
    await writeLifecycle(authority, 5, 'lease-5');
    await writeLifecycle(staleTask, 2, 'lease-2');

    const runner = new RebindRunner(authority, staleTask);
    const result = reconcileCommittedTaskCheckpoint(runner, binding(5, 'lease-5'));
    expect(result?.stderr).not.toContain('TASK_CHECKPOINT_LEASE_SNAPSHOT_REGRESSION');
    expect(result?.stderr).toContain('TASK_CHECKPOINT_ADOPT_FAILED');
    expect(
      runner.calls.some(
        (call) =>
          call.command === 'git' &&
          call.args.join(' ') === 'rev-parse --git-common-dir' &&
          call.cwd === '/tmp/cluster-worktree',
      ),
    ).toBe(true);
  });
});
