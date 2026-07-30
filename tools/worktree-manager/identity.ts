import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const canonicalWorktreePath = (path: string): string => {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...suffix);
};

export const taskBranch = (taskId: string): string =>
  `task/${taskId.toLowerCase()}`;

export const taskWorktreeRoot = (clusterWorktree: string): string =>
  join(canonicalWorktreePath(clusterWorktree), '.worktrees');

export const taskWorkspacePath = (
  clusterWorktree: string,
  taskId: string,
): string => join(taskWorktreeRoot(clusterWorktree), taskId);

export const isManagedTaskWorkspace = (
  clusterWorktree: string,
  candidate: string,
): boolean => {
  const root = taskWorktreeRoot(clusterWorktree);
  return canonicalWorktreePath(candidate).startsWith(`${root}/`);
};
