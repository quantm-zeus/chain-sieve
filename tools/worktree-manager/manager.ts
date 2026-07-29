import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';

const git = (args: string[], cwd: string): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`WORKTREE_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};

export interface ManagedWorktree {
  taskId: string;
  branch: string;
  baseBranch: string;
  target: string;
}

export const createTaskWorktree = (task: TaskContract, cwd = process.cwd()): ManagedWorktree => {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const target = resolve(root, '.worktrees', task.id);
  const worktreeRoot = resolve(root, '.worktrees');
  if (!target.startsWith(`${worktreeRoot}/`)) throw new Error('UNSAFE_WORKTREE_TARGET');
  const branch = `task/${task.id.toLowerCase()}`;
  const current = git(['branch', '--show-current'], cwd);
  const expected = `cluster/${task.dependencyGroup.toLowerCase()}`;
  if (current !== expected) throw new Error(`CLUSTER_BRANCH_REQUIRED:${expected}`);
  if (git(['status', '--porcelain'], cwd) !== '') throw new Error('SOURCE_WORKTREE_NOT_CLEAN');
  if (existsSync(target)) throw new Error('WORKTREE_EXISTS');
  git(['worktree', 'add', '-b', branch, target, 'HEAD'], cwd);
  return { taskId: task.id, branch, baseBranch: current, target };
};

export const cleanupTaskWorktree = (
  task: TaskContract,
  cwd = process.cwd(),
): { taskId: string; removed: string; deletedBranch: string } => {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const target = resolve(root, '.worktrees', task.id);
  const branch = `task/${task.id.toLowerCase()}`;
  if (!existsSync(target)) throw new Error('WORKTREE_NOT_FOUND');
  const listed = git(['worktree', 'list', '--porcelain'], cwd);
  if (!listed.includes(`worktree ${target}`) || !listed.includes(`branch refs/heads/${branch}`))
    throw new Error('WORKTREE_IDENTITY_MISMATCH');
  if (git(['status', '--porcelain'], target) !== '') throw new Error('TASK_WORKTREE_NOT_CLEAN');
  git(['worktree', 'remove', target], cwd);
  git(['branch', '-d', branch], cwd);
  return { taskId: task.id, removed: target, deletedBranch: branch };
};

export const worktreeStatus = (cwd = process.cwd()): string => git(['worktree', 'list', '--porcelain'], cwd);
