import { loadTasks } from '../task-verifier/verify.js';
import { readState } from '../task-runner/state.js';
import {
  enqueueTask,
  processMergeQueue,
  readQueue,
  retryRevertedIntegration,
} from './processor.js';
import { readBoundTaskContract } from '../task-runner/authority.js';

const command = process.argv[2] ?? 'add';
const taskId = process.argv[3];
try {
  const generatedTasks = await loadTasks();
  const lifecycle = await readState(generatedTasks);
  const tasks = await Promise.all(
    generatedTasks.map(async (task) => {
      const target = lifecycle.tasks[task.id];
      return (
        (target?.lifecycleBinding
          ? await readBoundTaskContract(process.cwd(), target)
          : undefined) ?? task
      );
    }),
  );
  if (command === 'add') {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('VALID_TASK_ID_REQUIRED');
    const state = lifecycle;
    const queue = await readQueue();
    const item = await enqueueTask(task, tasks, state, queue);
    console.log(JSON.stringify({ status: 'QUEUED', item }, null, 2));
  } else if (command === 'process') {
    console.log(JSON.stringify(await processMergeQueue(tasks), null, 2));
  } else if (command === 'retry-integration') {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('VALID_TASK_ID_REQUIRED');
    console.log(
      JSON.stringify(await retryRevertedIntegration(task, tasks), null, 2),
    );
  } else throw new Error(`UNKNOWN_COMMAND:${command}`);
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
