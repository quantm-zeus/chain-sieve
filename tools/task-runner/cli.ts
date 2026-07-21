import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskContractSchema, type TaskContract } from '@ciag/shared-schemas';
import { acquire, assertLease, readState, refreshReady, writeState } from './state.js';

const loadTasks = async (): Promise<TaskContract[]> => { const tasks: TaskContract[] = []; for (let index = 0; index <= 7; index += 1) { const root = join(process.cwd(), `tasks/G${index}`); for (const file of await readdir(root)) if (file.endsWith('.contract.json')) tasks.push(TaskContractSchema.parse(JSON.parse(await readFile(join(root, file), 'utf8')))); } return tasks.sort((a, b) => a.id.localeCompare(b.id)); };
const option = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const command = process.argv[2] ?? 'list'; const taskId = process.argv[3]; const holder = option('--holder') ?? process.env.USER ?? 'local-agent';
try {
  const tasks = await loadTasks(); const state = await readState(tasks); refreshReady(state, tasks);
  if (command === 'list') console.log(JSON.stringify(Object.values(state.tasks), null, 2));
  else if (command === 'ready') console.log(JSON.stringify(Object.values(state.tasks).filter((task) => task.state === 'READY'), null, 2));
  else if (!taskId) throw new Error('TASK_ID_REQUIRED');
  else if (command === 'acquire') { const lease = acquire(state, tasks, taskId, holder, new Date()); await writeState(state); console.log(JSON.stringify(lease, null, 2)); }
  else if (command === 'renew') { const version = Number(option('--lease-version')); const target = assertLease(state, taskId, version, holder, new Date()); target.expiresAt = new Date(Date.now() + 900_000).toISOString(); await writeState(state); console.log(JSON.stringify(target, null, 2)); }
  else if (command === 'complete') { const version = Number(option('--lease-version')); const target = assertLease(state, taskId, version, holder, new Date()); if (option('--verified') !== 'true') throw new Error('INDEPENDENT_VERIFICATION_REQUIRED'); target.state = 'VERIFIED'; target.commit = option('--commit') ?? ''; await writeState(state); console.log(JSON.stringify(target, null, 2)); }
  else if (command === 'release') { const version = Number(option('--lease-version')); const target = assertLease(state, taskId, version, holder, new Date()); target.state = 'READY'; delete target.holder; delete target.expiresAt; await writeState(state); console.log(JSON.stringify(target, null, 2)); }
  else throw new Error(`UNKNOWN_COMMAND:${command}`);
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
