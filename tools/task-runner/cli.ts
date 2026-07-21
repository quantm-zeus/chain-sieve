import { spawnSync } from 'node:child_process';
import { loadTasks } from '../task-verifier/verify.js';
import { acquire, assertLease, readState, refreshReady, transition, writeState } from './state.js';
import { loadRepairLeaseContracts } from './repair-contract.js';

const option = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const git = (args: string[]): string => { const result = spawnSync('git', args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}`); return result.stdout.trim(); };
const command = process.argv[2] ?? 'list'; const taskId = process.argv[3]; const holder = option('--holder') ?? process.env.USER ?? 'local-agent';
try {
  const productTasks = await loadTasks(); const repairTasks = await loadRepairLeaseContracts(); const tasks = [...productTasks, ...repairTasks]; const state = await readState(tasks); refreshReady(state, tasks);
  if (command === 'list') console.log(JSON.stringify(Object.values(state.tasks), null, 2));
  else if (command === 'ready') console.log(JSON.stringify(Object.values(state.tasks).filter((task) => task.state === 'READY'), null, 2));
  else if (!taskId) throw new Error('TASK_ID_REQUIRED');
  else if (command === 'acquire') { const repair = repairTasks.find((task) => task.id === taskId); const expected = repair?.approvedBranch ?? `task/${taskId.toLowerCase()}`; const branch = git(['branch', '--show-current']); if (branch !== expected) throw new Error(`TASK_BRANCH_REQUIRED:${expected}`); const lease = acquire(state, tasks, taskId, holder, new Date(), 900_000, git(['rev-parse', 'HEAD']), branch); await writeState(state); console.log(JSON.stringify(lease, null, 2)); }
  else { const version = Number(option('--lease-version')); const target = assertLease(state, taskId, version, holder, new Date());
    if (command === 'renew') target.expiresAt = new Date(Date.now() + 900_000).toISOString();
    else if (command === 'begin') transition(target, ['LEASED'], 'IMPLEMENTING');
    else if (command === 'self-review') transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING');
    else if (command === 'complete') { if (target.state !== 'VERIFIED' || !target.commit) throw new Error('INDEPENDENT_VERIFICATION_REQUIRED'); }
    else if (command === 'release') { transition(target, ['LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED'], 'READY'); delete target.holder; delete target.expiresAt; delete target.commit; }
    else throw new Error(`UNKNOWN_COMMAND:${command}`);
    await writeState(state); console.log(JSON.stringify(target, null, 2));
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
