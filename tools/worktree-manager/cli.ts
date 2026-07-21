import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadTasks } from '../task-verifier/verify.js';

const git = (args: string[], cwd = process.cwd()): string => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`GIT_FAILED:${args[0]}:${result.stderr.trim()}`); return result.stdout.trim(); };
const command = process.argv[2] ?? 'status'; const taskId = process.argv[3];
try {
  if (command === 'status') console.log(git(['worktree', 'list', '--porcelain']));
  else { if (!taskId || !(await loadTasks()).some((task) => task.id === taskId)) throw new Error('VALID_TASK_ID_REQUIRED'); const target = join(process.cwd(), '.worktrees', taskId); const branch = `task/${taskId.toLowerCase()}`;
    if (command === 'create') { if (existsSync(target)) throw new Error('WORKTREE_EXISTS'); git(['worktree', 'add', '-b', branch, target, 'bootstrap/agent-harness-and-codebase']); console.log(JSON.stringify({ taskId, branch, target })); }
    else if (command === 'cleanup') { if (!existsSync(target)) throw new Error('WORKTREE_NOT_FOUND'); git(['worktree', 'remove', target]); console.log(JSON.stringify({ taskId, removed: target, branchRetained: branch })); }
    else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
