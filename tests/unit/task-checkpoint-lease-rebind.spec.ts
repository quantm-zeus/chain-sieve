import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileCommittedTaskCheckpoint } from '../../tools/agent/lib/task-checkpoint.js';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RebindRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];

  constructor(private readonly common: string) {}

  run(command: string, args: string[], _options: CommandOptions = {}): CommandResult {
    this.calls.push({ command, args });
    if (command === 'pnpm')
      return { status: 0, stdout: 'ok', stderr: '' };
    if (command !== 'git')
      return { status: 1, stdout: '', stderr: 'unexpected' };
    if (args.join(' ') === 'rev-parse --git-common-dir')
      return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    if (args.join(' ') === 'status --porcelain=v1')
      return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ') === 'rev-parse HEAD')
      return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    if (args[0] === 'rev-list')
      return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected git command' };
  }
}

const binding = (): PayloadBinding =>
  ({
    task: { contract: { id: 'T-REC-01', cluster: 'C-REC' } },
    taskWorkspace: '/tmp/task-worktree',
    baseCommit: 'a'.repeat(40),
    leaseId: 'lease-3',
    holder: 'agent-orchestrator',
    fencingVersion: 3,
    launchReceiptId: 'muse-receipt-3',
    failures: [],
  }) as unknown as PayloadBinding;

describe('checkpoint reconciliation lease rebinding', () => {
  it('returns a zero-touch rebind result before running lifecycle commands when the authoritative lease rotated', async () => {
    const common = await mkdtemp(join(tmpdir(), 'chainsieve-checkpoint-rebind-'));
    roots.push(common);
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
            leaseVersion: 4,
            holder: 'agent-orchestrator',
            leaseId: 'lease-4',
            leaseState: 'ACTIVE',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            baseCommit: 'a'.repeat(40),
            branch: 'task/t-rec-01',
            history: [],
          },
        },
      })}\n`,
    );

    const runner = new RebindRunner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('TASK_CHECKPOINT_REBIND_REQUIRED:T-REC-01:3:4'),
    });
    expect(runner.calls.some((call) => call.command === 'pnpm')).toBe(false);
  });
});
