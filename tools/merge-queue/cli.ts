import { loadTasks } from '../task-verifier/verify.js';
import { readState } from '../task-runner/state.js';
import { enqueueTask, processMergeQueue, readQueue } from './processor.js';

const command = process.argv[2] ?? 'add';
const taskId = process.argv[3];
try {
  const tasks = await loadTasks();
  if (command === 'add') {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('VALID_TASK_ID_REQUIRED');
    const state = await readState(tasks);
    const queue = await readQueue();
    const item = await enqueueTask(task, tasks, state, queue);
    console.log(JSON.stringify({ status: 'QUEUED', item }, null, 2));
  } else if (command === 'process') {
    console.log(JSON.stringify(await processMergeQueue(tasks), null, 2));
  } else throw new Error(`UNKNOWN_COMMAND:${command}`);
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
