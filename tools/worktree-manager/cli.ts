import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadTasks } from '../task-verifier/verify.js';

const git = (args: string[], cwd = process.cwd()): string => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`); return result.stdout.trim(); };
const command = process.argv[2] ?? 'status'; const taskId = process.argv[3];
try {
  if (command === 'status') console.log(git(['worktree', 'list', '--porcelain']));
  else {
    const task = (await loadTasks()).find((candidate) => candidate.id === taskId); if (!task) throw new Error('VALID_TASK_ID_REQUIRED'); const root = git(['rev-parse', '--show-toplevel']); const target = resolve(root, '.worktrees', task.id); if (!target.startsWith(`${resolve(root, '.worktrees')}/`)) throw new Error('UNSAFE_WORKTREE_TARGET'); const branch = `task/${task.id.toLowerCase()}`;
    if (command === 'create') { const current = git(['branch', '--show-current']); const expected = `cluster/${task.dependencyGroup.toLowerCase()}`; if (current !== expected) throw new Error(`CLUSTER_BRANCH_REQUIRED:${expected}`); if (git(['status', '--porcelain']) !== '') throw new Error('SOURCE_WORKTREE_NOT_CLEAN'); if (existsSync(target)) throw new Error('WORKTREE_EXISTS'); git(['worktree', 'add', '-b', branch, target, 'HEAD']); console.log(JSON.stringify({ taskId: task.id, branch, baseBranch: current, target })); }
    else if (command === 'cleanup') { if (!existsSync(target)) throw new Error('WORKTREE_NOT_FOUND'); const listed = git(['worktree', 'list', '--porcelain']); if (!listed.includes(`worktree ${target}`) || !listed.includes(`branch refs/heads/${branch}`)) throw new Error('WORKTREE_IDENTITY_MISMATCH'); git(['worktree', 'remove', target]); console.log(JSON.stringify({ taskId: task.id, removed: target, branchRetained: branch })); }
    else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
