import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClusterContract, TaskContract } from '@ciag/shared-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskWorktree } from '../../tools/worktree-manager/manager.js';
import { taskWorkspacePath } from '../../tools/worktree-manager/identity.js';
import { ZCodeError } from '../../tools/zcode/lib/errors.js';
import { startTask } from '../../tools/zcode/lib/executor.js';
import type {
  CommandResult,
  CommandRunner,
  ProjectInventory,
  TaskRecord,
} from '../../tools/zcode/lib/types.js';
import {
  copyPayload,
  openZCodeWorkspace,
} from '../../tools/zcode/lib/desktop.js';

vi.mock('../../tools/zcode/lib/desktop.js', () => ({
  detectZCodeApplication: vi.fn(() => '/Applications/ZCode.app'),
  copyPayload: vi.fn(),
  openZCodeWorkspace: vi.fn(),
}));

const temporaryRoots: string[] = [];

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
};

const taskContract = {
  id: 'T-G0-CORE',
  dependencyGroup: 'G0',
  cluster: 'C-G0-IMPLEMENTATION',
  dependencies: [],
  exclusiveLocks: ['packages/core/**'],
} as unknown as TaskContract;

class StartRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  readonly worktreeResults: ReturnType<typeof createTaskWorktree>[] = [];

  run(
    command: string,
    args: string[],
    options: { cwd?: string; input?: string } = {},
  ): CommandResult {
    this.calls.push({
      command,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (
      command === 'pnpm' &&
      args[1] === 'worktree:create' &&
      options.cwd
    ) {
      const result = createTaskWorktree(taskContract, options.cwd);
      this.worktreeResults.push(result);
      return { status: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    if (command === 'pnpm' && args[1] === 'task:acquire')
      return {
        status: 86,
        stdout: '',
        stderr: 'LEASE_MUTATION_BLOCKED_BY_INTEGRATION_TEST',
      };
    const result = spawnSync(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      encoding: 'utf8',
      env: process.env,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
    };
  }
}

afterEach(() => {
  vi.clearAllMocks();
  for (const path of temporaryRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('ZCode START_TASK real Git boundary', () => {
  it('resolves the real task worktree, installs, then reaches authoritative acquisition next', async () => {
    const base = mkdtempSync(join(tmpdir(), 'Chain Sieve ZCode Start '));
    temporaryRoots.push(base);
    const root = join(base, 'root checkout');
    const clusterWorktree = join(base, 'cluster g0 worktree');
    mkdirSync(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'zcode-test@example.com']);
    git(root, ['config', 'user.name', 'ZCode Test']);
    writeFileSync(join(root, '.gitignore'), '.worktrees/\nnode_modules/\n');
    writeFileSync(join(root, 'package.json'), '{"name":"zcode-git-fixture","private":true}\n');
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        '',
        'settings:',
        '  autoInstallPeers: true',
        '  excludeLinksFromLockfile: false',
        '',
        'importers:',
        '',
        '  .: {}',
        '',
      ].join('\n'),
    );
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'fixture baseline']);
    git(root, ['branch', '-M', 'main']);
    git(root, ['branch', 'cluster/g0']);
    git(root, ['worktree', 'add', '-q', clusterWorktree, 'cluster/g0']);
    const head = git(clusterWorktree, ['rev-parse', 'HEAD']);
    const workspace = taskWorkspacePath(clusterWorktree, taskContract.id);
    const clusterContract = {
      id: 'C-G0-IMPLEMENTATION',
      group: 'G0',
      tasks: [taskContract.id],
      dependencies: [],
    } as unknown as ClusterContract;
    const cluster = {
      contract: clusterContract,
      contractPath: 'clusters/G0/C-G0-IMPLEMENTATION.contract.json',
      goalPath: 'clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md',
      branch: {
        branch: 'cluster/g0',
        integrationTarget: 'main',
        worktree: clusterWorktree,
      },
      state: 'READY' as const,
      branchHead: head,
      worktreeHead: head,
      worktreeBranch: 'cluster/g0',
      worktreeDirty: false,
      worktreeChanges: [],
      worktreeRegistered: true,
      worktreeForeign: false,
    };
    const task: TaskRecord = {
      contract: taskContract,
      contractPath: 'tasks/G0/T-G0-CORE.contract.json',
      contextPath: 'artifacts/context/T-G0-CORE',
      contextManifestPath:
        'artifacts/context/T-G0-CORE/context-manifest.json',
      contextManifestSha256: 'a'.repeat(64),
      cluster,
      state: {
        taskId: taskContract.id,
        state: 'READY' as const,
        leaseVersion: 0,
        history: [],
      },
      dependencyWave: 0,
      priority: 0,
      workspace,
      workspaceExists: false,
    };
    const inventory = {
      root,
      rootBranch: 'main',
      rootHead: head,
      rootTree: git(root, ['rev-parse', 'HEAD^{tree}']),
      rootDirty: false,
      rootChanges: [],
      worktreeRoot: base,
      release: {
        tag: 'harness-v1.0.1',
        tagObject: head,
        commit: head,
        tree: git(root, ['rev-parse', 'HEAD^{tree}']),
      },
      clusters: [cluster],
      tasks: [task],
      coverage: {
        requirements: { accounted: 0, total: 0, missing: [] },
        acceptanceCriteria: { accounted: 0, total: 0, missing: [] },
      },
      clusterOrder: [clusterContract.id],
    } as ProjectInventory;
    const runner = new StartRunner();

    let failure: unknown;
    try {
      await startTask(inventory, task, runner);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ZCodeError);
    expect((failure as ZCodeError).code).toBe('TASK_ACQUIRE_FAILED');
    expect(git(workspace, ['branch', '--show-current'])).toBe(
      'task/t-g0-core',
    );
    expect(
      runner.calls.filter((call) => call.command === 'pnpm').map((call) =>
        call.args.slice(1, 2).join(''),
      ),
    ).toEqual(['worktree:create', 'install', 'task:acquire']);
    expect(copyPayload).not.toHaveBeenCalled();
    expect(openZCodeWorkspace).not.toHaveBeenCalled();

    task.workspaceExists = true;
    task.workspaceRegistered = true;
    task.workspaceForeign = false;
    task.workspaceBranch = 'task/t-g0-core';
    task.workspaceHead = head;
    task.workspaceTree = git(workspace, ['rev-parse', 'HEAD^{tree}']);
    task.workspaceDirty = false;
    task.workspaceChanges = [];
    expect(git(workspace, ['status', '--porcelain'])).toBe('');
    const reuseRunner = new StartRunner();
    try {
      await startTask(inventory, task, reuseRunner);
    } catch (error) {
      expect(error).toBeInstanceOf(ZCodeError);
      expect((error as ZCodeError).code).toBe('TASK_ACQUIRE_FAILED');
    }
    expect(reuseRunner.worktreeResults).toMatchObject([{ reused: true }]);
    expect(
      git(root, ['worktree', 'list', '--porcelain']).match(
        /branch refs\/heads\/task\/t-g0-core/g,
      ),
    ).toHaveLength(1);
    expect(copyPayload).not.toHaveBeenCalled();
    expect(openZCodeWorkspace).not.toHaveBeenCalled();
  });
});
