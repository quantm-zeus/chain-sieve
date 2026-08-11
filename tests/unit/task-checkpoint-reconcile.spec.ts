import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanAtomicTaskCommit,
  reconcileCommittedTaskCheckpoint,
} from '../../tools/agent/lib/task-checkpoint.js';
import { withHostLifecycle } from '../../tools/agent/providers/index.js';
import type {
  AgentProvider,
  CommandOptions,
  CommandResult,
  CommandRunner,
  PayloadBinding,
  ProviderDetection,
  TaskLaunchBinding,
} from '../../tools/agent/lib/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class Runner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options: CommandOptions }> = [];
  private branch: string;

  constructor(
    private readonly common: string,
    private readonly options: {
      dirty?: boolean;
      commitCount?: number;
      branch?: string;
      expectedRef?: string;
    } = {},
  ) {
    this.branch = options.branch ?? 'task/t-rec-01';
  }

  run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): CommandResult {
    this.calls.push({ command, args, options });
    if (command === 'pnpm') {
      if (
        args[1] === 'task:checkpoint-adopt' &&
        this.options.expectedRef &&
        this.options.expectedRef !== 'a'.repeat(40) &&
        this.options.expectedRef !== 'b'.repeat(40)
      )
        return {
          status: 1,
          stdout: '',
          stderr: `TASK_CHECKPOINT_BRANCH_DIVERGED:T-REC-01:${this.options.expectedRef}:${'b'.repeat(40)}`,
        };
      return { status: 0, stdout: 'reviewed', stderr: '' };
    }
    if (command !== 'git')
      return { status: 1, stdout: '', stderr: 'unexpected' };
    if (args.join(' ') === 'rev-parse --git-common-dir')
      return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    if (args.join(' ') === 'status --porcelain=v1')
      return {
        status: 0,
        stdout: this.options.dirty
          ? ' M packages/domain/src/index.ts\n'
          : '',
        stderr: '',
      };
    if (args.join(' ') === 'rev-parse HEAD')
      return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    if (args.join(' ') === 'branch --show-current')
      return { status: 0, stdout: `${this.branch}\n`, stderr: '' };
    if (
      args.join(' ') === 'rev-parse --verify refs/heads/task/t-rec-01'
    ) {
      const value = this.options.expectedRef ?? 'a'.repeat(40);
      return { status: 0, stdout: `${value}\n`, stderr: '' };
    }
    if (
      args[0] === 'switch' &&
      args[1] === '-C' &&
      args[2] === 'task/t-rec-01'
    ) {
      this.branch = 'task/t-rec-01';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-list')
      return {
        status: 0,
        stdout: `${this.options.commitCount ?? 1}\n`,
        stderr: '',
      };
    return { status: 1, stdout: '', stderr: 'unexpected git command' };
  }
}

class CountingProvider implements AgentProvider {
  readonly id = 'muse' as const;
  executions = 0;

  detect(): ProviderDetection {
    return { available: true, mechanism: 'command', detail: 'test provider' };
  }

  generatePayload(): string {
    return 'test-payload';
  }

  copyPayload(): void {}
  openWorkspace(): void {}

  executePayload(): CommandResult {
    this.executions += 1;
    return { status: 0, stdout: 'provider-ran', stderr: '' };
  }

  renderOwnerInstruction(): string {
    return 'done';
  }
}

const binding = (): PayloadBinding =>
  ({
    task: { contract: { id: 'T-REC-01', cluster: 'C-REC' } },
    taskWorkspace: '/tmp/task-worktree',
    baseCommit: 'a'.repeat(40),
    leaseId: 'lease-1',
    holder: 'agent-orchestrator',
    fencingVersion: 3,
    launchReceiptId: 'muse-receipt-1',
    failures: [],
  }) as unknown as PayloadBinding;

const stateRoot = async (
  state: string,
  options: {
    currentSelfReview?: boolean;
    staleSelfReview?: boolean;
  } = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'chainsieve-task-checkpoint-'));
  roots.push(root);
  const runtime = join(root, 'ciag-runtime');
  await mkdir(runtime, { recursive: true });
  const commit = 'b'.repeat(40);
  const tree = 'c'.repeat(40);
  await writeFile(
    join(runtime, 'task-state.json'),
    `${JSON.stringify({
      schemaVersion: '2.0.0',
      tasks: {
        'T-REC-01': {
          taskId: 'T-REC-01',
          state,
          leaseVersion: 3,
          holder: 'agent-orchestrator',
          leaseId: 'lease-1',
          leaseState: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          baseCommit: 'a'.repeat(40),
          branch: 'task/t-rec-01',
          history: [],
          ...(options.currentSelfReview || options.staleSelfReview
            ? {
                commit,
                tree,
                selfReviewEvidence: {
                  status: 'CURRENT',
                  commit: options.staleSelfReview ? 'd'.repeat(40) : commit,
                  tree,
                },
              }
            : {}),
        },
      },
    })}\n`,
  );
  return root;
};

describe('committed task checkpoint reconciliation', () => {
  it('validates an IMPLEMENTING atomic checkpoint through trusted adoption before self-review', async () => {
    const common = await stateRoot('IMPLEMENTING');
    const runner = new Runner(common);
    const task = binding();

    expect(cleanAtomicTaskCommit(runner, task)).toBe('b'.repeat(40));
    expect(reconcileCommittedTaskCheckpoint(runner, task)).toMatchObject({
      status: 0,
    });

    const lifecycleCalls = runner.calls.filter((call) => call.command === 'pnpm');
    expect(lifecycleCalls.map((call) => call.args[1])).toEqual([
      'task:checkpoint-adopt',
      'task:self-review',
    ]);
    const review = lifecycleCalls[1];
    expect(review?.args).toEqual([
      '--silent',
      'task:self-review',
      'T-REC-01',
      '--holder',
      'agent-orchestrator',
      '--lease-version',
      '3',
      '--launch-receipt-id',
      'muse-receipt-1',
    ]);
  });

  it('delegates LEASED branch repair and adoption to the trusted task runner before self-review', async () => {
    const common = await stateRoot('LEASED');
    const runner = new Runner(common, { branch: '' });

    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 0,
    });
    expect(runner.calls.some((call) => call.args[0] === 'switch')).toBe(false);
    expect(
      runner.calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1]),
    ).toEqual(['task:checkpoint-adopt', 'task:self-review']);
  });

  it('surfaces fail-closed divergence from the trusted checkpoint adoption command', async () => {
    const common = await stateRoot('LEASED');
    const runner = new Runner(common, {
      branch: 'sandbox-branch/t-rec-01',
      expectedRef: 'd'.repeat(40),
    });
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('TASK_CHECKPOINT_BRANCH_DIVERGED'),
    });
    expect(runner.calls.some((call) => call.args[0] === 'switch')).toBe(false);
    expect(
      runner.calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1]),
    ).toEqual(['task:checkpoint-adopt']);
  });

  it('does not pay for another provider call after a proof-bound self-review checkpoint exists', async () => {
    const common = await stateRoot('SELF_REVIEWING', { currentSelfReview: true });
    const runner = new Runner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 0,
    });
    expect(runner.calls.some((call) => call.command === 'pnpm')).toBe(false);
  });

  it('finishes an interrupted self-review instead of treating state alone as durable proof', async () => {
    const common = await stateRoot('SELF_REVIEWING');
    const runner = new Runner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 0,
    });
    expect(
      runner.calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1]),
    ).toEqual(['task:self-review']);
  });

  it('fails closed when self-review evidence exists but is bound to another commit', async () => {
    const common = await stateRoot('SELF_REVIEWING', { staleSelfReview: true });
    const runner = new Runner(common);
    expect(reconcileCommittedTaskCheckpoint(runner, binding())).toMatchObject({
      status: 1,
      stderr: 'TASK_CHECKPOINT_SELF_REVIEW_EVIDENCE_STALE:T-REC-01',
    });
    expect(runner.calls.some((call) => call.command === 'pnpm')).toBe(false);
  });

  it('skips the inner provider entirely when a clean atomic checkpoint already exists', async () => {
    const common = await stateRoot('LEASED');
    const runner = new Runner(common);
    const inner = new CountingProvider();
    const provider = withHostLifecycle(inner, runner);
    const task = binding();
    const payload = provider.generatePayload(task);

    expect(provider.executePayload?.(task.taskWorkspace, payload)).toMatchObject({
      status: 0,
    });
    expect(inner.executions).toBe(0);
    expect(
      runner.calls.filter((call) => call.command === 'pnpm').map((call) => call.args[1]),
    ).toEqual(['task:checkpoint-adopt', 'task:self-review']);
  });

  it('refuses to reconcile dirty or non-atomic implementation work', async () => {
    const common = await stateRoot('IMPLEMENTING');
    expect(
      reconcileCommittedTaskCheckpoint(
        new Runner(common, { dirty: true }),
        binding(),
      ),
    ).toBeUndefined();
    expect(
      reconcileCommittedTaskCheckpoint(
        new Runner(common, { commitCount: 2 }),
        binding(),
      ),
    ).toBeUndefined();
  });
});