import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  WorktreeManagerError,
} from '../../tools/worktree-manager/manager.js';
import {
  taskBranch,
  taskWorkspacePath,
} from '../../tools/worktree-manager/identity.js';

const temporaryRoots: string[] = [];

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
};

const task = {
  id: 'T-G0-CORE',
  dependencyGroup: 'G0',
} as TaskContract;

const fixture = (): {
  base: string;
  root: string;
  cluster: string;
  taskTarget: string;
  head: string;
} => {
  const base = mkdtempSync(join(tmpdir(), 'Chain Sieve Git Fixture '));
  temporaryRoots.push(base);
  const root = join(base, 'root checkout');
  const cluster = join(base, 'cluster g0 worktree');
  mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'zcode-test@example.com']);
  git(root, ['config', 'user.name', 'ZCode Test']);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'fixture baseline']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['branch', 'cluster/g0']);
  git(root, ['worktree', 'add', '-q', cluster, 'cluster/g0']);
  return {
    base,
    root,
    cluster,
    taskTarget: taskWorkspacePath(cluster, task.id),
    head: git(cluster, ['rev-parse', 'HEAD']),
  };
};

const managerError = (operation: () => unknown): WorktreeManagerError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorktreeManagerError);
    return error as WorktreeManagerError;
  }
  throw new Error('expected WorktreeManagerError');
};

afterEach(() => {
  for (const path of temporaryRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('real Git task worktree lifecycle', () => {
  it('creates a fresh task branch under a repository path containing spaces', () => {
    const value = fixture();
    const result = createTaskWorktree(task, value.cluster);

    expect(result).toMatchObject({
      branch: taskBranch(task.id),
      target: value.taskTarget,
      reused: false,
    });
    expect(git(value.taskTarget, ['rev-parse', 'HEAD'])).toBe(value.head);
    expect(git(value.taskTarget, ['branch', '--show-current'])).toBe(
      taskBranch(task.id),
    );
  });

  it('attaches an existing compatible task branch without recreating it', () => {
    const value = fixture();
    git(value.root, ['branch', taskBranch(task.id), 'cluster/g0']);

    const result = createTaskWorktree(task, value.cluster);

    expect(result.reused).toBe(true);
    expect(git(value.taskTarget, ['rev-parse', 'HEAD'])).toBe(value.head);
  });

  it('reuses an already registered compatible clean task worktree', () => {
    const value = fixture();
    createTaskWorktree(task, value.cluster);

    const result = createTaskWorktree(task, value.cluster);

    expect(result.reused).toBe(true);
    expect(result.target).toBe(value.taskTarget);
  });

  it('removes only an empty unregistered partial target before creating', () => {
    const value = fixture();
    mkdirSync(value.taskTarget, { recursive: true });

    const result = createTaskWorktree(task, value.cluster);

    expect(result.recoveredPartialTarget).toBe(true);
    expect(git(value.taskTarget, ['branch', '--show-current'])).toBe(
      taskBranch(task.id),
    );
  });

  it('rejects a nonempty unregistered target without deleting user files', () => {
    const value = fixture();
    mkdirSync(value.taskTarget, { recursive: true });
    const marker = join(value.taskTarget, 'do-not-delete.txt');
    writeFileSync(marker, 'user data\n');

    const error = managerError(() =>
      createTaskWorktree(task, value.cluster),
    );

    expect(error.code).toBe('UNREGISTERED_TASK_WORKTREE_PATH_CONFLICT');
    expect(existsSync(marker)).toBe(true);
  });

  it('rejects a task branch attached to another worktree', () => {
    const value = fixture();
    const other = join(value.base, 'other task worktree');
    git(value.root, ['worktree', 'add', '-q', '-b', taskBranch(task.id), other]);

    const error = managerError(() =>
      createTaskWorktree(task, value.cluster),
    );

    expect(error.code).toBe('TASK_BRANCH_ATTACHED_TO_OTHER_WORKTREE');
    expect(error.message).toContain(other);
  });

  it('rejects an unclaimed task branch with unique commits and reports them', () => {
    const value = fixture();
    const other = join(value.base, 'commit staging worktree');
    git(value.root, ['worktree', 'add', '-q', '-b', taskBranch(task.id), other]);
    writeFileSync(join(other, 'implementation.txt'), 'do not lose\n');
    git(other, ['add', 'implementation.txt']);
    git(other, ['commit', '-q', '-m', 'unique implementation']);
    const unique = git(other, ['rev-parse', 'HEAD']);
    git(value.root, ['worktree', 'remove', other]);

    const error = managerError(() =>
      createTaskWorktree(task, value.cluster),
    );

    expect(error.code).toBe('UNCLAIMED_TASK_BRANCH_HAS_COMMITS');
    expect(error.details.join('\n')).toContain(unique);
    expect(git(value.root, ['rev-parse', taskBranch(task.id)])).toBe(unique);
  });

  it('rejects a dirty cluster source worktree', () => {
    const value = fixture();
    writeFileSync(join(value.cluster, 'seed.txt'), 'dirty\n');

    expect(
      managerError(() => createTaskWorktree(task, value.cluster)).code,
    ).toBe('SOURCE_WORKTREE_NOT_CLEAN');
  });

  it('rejects creation from the wrong cluster branch', () => {
    const value = fixture();

    expect(managerError(() => createTaskWorktree(task, value.root)).code).toBe(
      'CLUSTER_BRANCH_REQUIRED',
    );
  });

  it('cleans up a created task worktree and is idempotent afterward', () => {
    const value = fixture();
    createTaskWorktree(task, value.cluster);

    const first = cleanupTaskWorktree(task, value.cluster);
    const second = cleanupTaskWorktree(task, value.cluster);

    expect(first.deletedBranch).toBe(taskBranch(task.id));
    expect(second.alreadyRemoved).toBe(true);
    expect(existsSync(value.taskTarget)).toBe(false);
  });

  it('preserves a task branch containing unmerged implementation commits', () => {
    const value = fixture();
    createTaskWorktree(task, value.cluster);
    writeFileSync(join(value.taskTarget, 'implementation.txt'), 'preserve\n');
    git(value.taskTarget, ['add', 'implementation.txt']);
    git(value.taskTarget, ['commit', '-q', '-m', 'unmerged implementation']);
    const unique = git(value.taskTarget, ['rev-parse', 'HEAD']);

    const error = managerError(() =>
      cleanupTaskWorktree(task, value.cluster),
    );

    expect(error.code).toBe('TASK_BRANCH_HAS_UNMERGED_COMMITS');
    expect(git(value.root, ['rev-parse', taskBranch(task.id)])).toBe(unique);
  });
});
