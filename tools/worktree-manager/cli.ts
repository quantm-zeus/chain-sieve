import { loadTasks } from '../task-verifier/verify.js';
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  WorktreeManagerError,
  worktreeStatus,
} from './manager.js';

const command = process.argv[2] ?? 'status';
const taskId = process.argv[3];
const sourceOption = process.argv.indexOf('--source-worktree');
const sourceWorktree =
  sourceOption >= 0 ? process.argv[sourceOption + 1] : process.cwd();
try {
  if (command === 'status') console.log(worktreeStatus());
  else {
    const task = (await loadTasks()).find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('VALID_TASK_ID_REQUIRED');
    if (!sourceWorktree) throw new Error('SOURCE_WORKTREE_REQUIRED');
    if (command === 'create')
      console.log(JSON.stringify(createTaskWorktree(task, sourceWorktree)));
    else if (command === 'cleanup')
      console.log(JSON.stringify(cleanupTaskWorktree(task, sourceWorktree)));
    else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'FAIL',
      error: error instanceof WorktreeManagerError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error),
      ...(error instanceof WorktreeManagerError && error.details.length > 0
        ? { details: error.details }
        : {}),
    }),
  );
  process.exitCode = 1;
}
