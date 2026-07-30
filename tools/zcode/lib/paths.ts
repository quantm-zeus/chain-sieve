import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZCodeError } from './errors.js';

const hasRepositoryMarkers = (path: string): boolean =>
  existsSync(join(path, 'package.json')) &&
  existsSync(join(path, 'tasks/generated/graph.json')) &&
  existsSync(join(path, 'clusters'));

export const findRepositoryRoot = (start?: string): string => {
  const candidates = [
    start ? resolve(start) : undefined,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    let current = candidate;
    while (true) {
      if (hasRepositoryMarkers(current)) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new ZCodeError('ROOT_REPOSITORY_NOT_FOUND');
};

export const defaultWorktreeRoot = (root: string): string =>
  process.env.CHAINSIEVE_WORKTREE_ROOT ?? `${root}-worktrees`;

export const taskWorkspacePath = (
  clusterWorktree: string,
  taskId: string,
): string => join(clusterWorktree, '.worktrees', taskId);
