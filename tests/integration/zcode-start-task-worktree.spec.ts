import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskWorkspacePath } from '../../tools/worktree-manager/identity.js';
import { discoverProject } from '../../tools/zcode/lib/discovery.js';
import { decideNextAction } from '../../tools/zcode/lib/engine.js';
import { ZCodeError } from '../../tools/zcode/lib/errors.js';
import { startTask } from '../../tools/zcode/lib/executor.js';
import { SystemCommandRunner } from '../../tools/zcode/lib/system.js';
import type {
  CommandResult,
  CommandRunner,
} from '../../tools/zcode/lib/types.js';
import {
  copyPayload,
  openZCodeWorkspace,
} from '../../tools/agent/providers/zcode-desktop.js';

vi.mock('../../tools/agent/providers/zcode-desktop.js', () => ({
  detectZCodeApplication: vi.fn(() => '/Applications/ZCode.app'),
  copyPayload: vi.fn(),
  openZCodeWorkspace: vi.fn(),
}));

const temporaryRoots: string[] = [];
const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));

const command = (cwd: string, executable: string, args: string[]): string => {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
};

const git = (cwd: string, args: string[]): string => command(cwd, 'git', args);

class LeaseBlockingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  readonly worktreeOutputs: Array<{ target: string; reused: boolean }> = [];
  private readonly system = new SystemCommandRunner();

  run(
    executable: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): CommandResult {
    this.calls.push({
      command: executable,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (executable === 'pnpm' && args[1] === 'task:acquire')
      return {
        status: 86,
        stdout: '',
        stderr: 'LEASE_MUTATION_BLOCKED_BY_INTEGRATION_TEST',
      };
    const result = this.system.run(executable, args, options);
    if (
      result.status === 0 &&
      executable === 'pnpm' &&
      args[1] === 'worktree:create'
    )
      this.worktreeOutputs.push(
        JSON.parse(result.stdout) as { target: string; reused: boolean },
      );
    return result;
  }
}

const createFixture = (): {
  root: string;
  cluster: string;
  workspace: string;
  head: string;
} => {
  const base = mkdtempSync(join(tmpdir(), 'Chain Sieve ZCode Start '));
  temporaryRoots.push(base);
  const root = join(base, 'root checkout');
  command(base, 'git', ['clone', '-q', '--no-local', sourceRoot, root]);
  git(root, ['config', 'user.email', 'zcode-test@example.com']);
  git(root, ['config', 'user.name', 'ZCode Test']);
  git(root, ['switch', '-C', 'main']);
  git(root, [
    'update-ref',
    'refs/remotes/origin/main',
    git(root, ['rev-parse', 'HEAD']),
  ]);
  git(root, ['tag', '-f', 'harness-v999.0.0', 'HEAD']);
  git(root, ['update-ref', '-d', 'refs/remotes/origin/task/t-g0-disc']);
  git(root, ['update-ref', '-d', 'refs/remotes/origin/cluster/g0']);
  cpSync(
    join(sourceRoot, 'tools', 'worktree-manager'),
    join(root, 'tools', 'worktree-manager'),
    { recursive: true },
  );
  if (git(root, ['status', '--porcelain']) !== '') {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'fixture: current worktree manager']);
  }
  git(root, [
    'update-ref',
    'refs/remotes/origin/main',
    git(root, ['rev-parse', 'HEAD']),
  ]);
  git(root, ['branch', '-f', 'cluster/g0', 'HEAD']);
  git(root, ['branch', '-f', 'cluster/fw', 'HEAD']);
  const cluster = `${root}-worktrees/g0`;
  mkdirSync(dirname(cluster), { recursive: true });
  git(root, ['worktree', 'add', '-q', cluster, 'cluster/g0']);
  command(root, 'pnpm', ['install', '--frozen-lockfile']);
  const runtime = join(root, '.git', 'ciag-runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    join(runtime, 'task-state.json'),
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        tasks: {
          'T-FW-AUTOPILOT': {
            taskId: 'T-FW-AUTOPILOT',
            state: 'MERGED',
            leaseVersion: 0,
            history: [],
          },
          'T-G0-DISC': {
            taskId: 'T-G0-DISC',
            state: 'READY',
            leaseVersion: 0,
            history: [],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    root,
    cluster,
    workspace: taskWorkspacePath(cluster, 'T-G0-DISC'),
    head: git(cluster, ['rev-parse', 'HEAD']),
  };
};

const pnpmActions = (runner: LeaseBlockingRunner): string[] =>
  runner.calls
    .filter((call) => call.command === 'pnpm')
    .map((call) => call.args[1] ?? '');

afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('ZCode START_TASK real discovery and Git boundary', () => {
  it('resolves the real task worktree through the CLI before acquisition', async () => {
    const value = createFixture();
    const runner = new LeaseBlockingRunner();
    const inventory = await discoverProject(value.root, runner);
    const decision = decideNextAction(inventory);

    expect(decision.action).toBe('START_TASK');
    expect(decision.task?.contract.id).toBe('T-G0-DISC');

    let failure: unknown;
    try {
      await startTask(inventory, decision.task!, runner);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ZCodeError);
    expect((failure as ZCodeError).code).toBe('TASK_ACQUIRE_FAILED');
    expect(runner.worktreeOutputs).toMatchObject([{ reused: false }]);
    expect(git(value.workspace, ['branch', '--show-current'])).toBe(
      'task/t-g0-disc',
    );
    expect(git(value.workspace, ['rev-parse', 'HEAD'])).toBe(value.head);
    expect(pnpmActions(runner)).toEqual([
      'worktree:create',
      'install',
      'task:acquire',
    ]);
    expect(copyPayload).not.toHaveBeenCalled();
    expect(openZCodeWorkspace).not.toHaveBeenCalled();

    const reuseRunner = new LeaseBlockingRunner();
    const refreshed = await discoverProject(value.root, reuseRunner);
    const reuseDecision = decideNextAction(refreshed);
    expect(reuseDecision.action).toBe('START_TASK');
    try {
      await startTask(refreshed, reuseDecision.task!, reuseRunner);
    } catch (error) {
      expect(error).toBeInstanceOf(ZCodeError);
      expect((error as ZCodeError).code).toBe('TASK_ACQUIRE_FAILED');
    }
    expect(reuseRunner.worktreeOutputs).toMatchObject([{ reused: true }]);
    expect(pnpmActions(reuseRunner)).toEqual([
      'worktree:create',
      'install',
      'task:acquire',
    ]);
    expect(
      git(value.root, ['worktree', 'list', '--porcelain']).match(
        /branch refs\/heads\/task\/t-g0-disc/g,
      ),
    ).toHaveLength(1);
    expect(copyPayload).not.toHaveBeenCalled();
    expect(openZCodeWorkspace).not.toHaveBeenCalled();
  }, 40_000);
});
