import { loadTasks } from '../task-verifier/verify.js';
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  WorktreeManagerError,
  worktreeStatus,
} from './manager.js';

const command = process.argv[2] ?? 'status';
const taskId = process.argv[3];
try {
  if (command === 'status') console.log(worktreeStatus());
  else {
    const task = (await loadTasks()).find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('VALID_TASK_ID_REQUIRED');
    if (command === 'create') console.log(JSON.stringify(createTaskWorktree(task)));
    else if (command === 'cleanup') console.log(JSON.stringify(cleanupTaskWorktree(task)));
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
