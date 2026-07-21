import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TaskLeaseSchema, type TaskContract } from '@ciag/shared-schemas';

export type TaskLifecycleState = 'PLANNED' | 'READY' | 'LEASED' | 'VERIFIED' | 'MERGED' | 'BLOCKED';
export interface TaskState { taskId: string; state: TaskLifecycleState; leaseVersion: number; holder?: string; expiresAt?: string; commit?: string }
export interface LifecycleDocument { schemaVersion: '1.0.0'; tasks: Record<string, TaskState> }
const statePath = join(process.cwd(), 'artifacts/runtime/task-state.json');

export const readState = async (tasks: TaskContract[]): Promise<LifecycleDocument> => {
  try { return JSON.parse(await readFile(statePath, 'utf8')) as LifecycleDocument; } catch { const readyIds = new Set(tasks.filter((task) => task.dependencies.length === 0).map((task) => task.id)); return { schemaVersion: '1.0.0', tasks: Object.fromEntries(tasks.map((task) => [task.id, { taskId: task.id, state: readyIds.has(task.id) ? 'READY' : 'PLANNED', leaseVersion: 0 }])) }; }
};
export const writeState = async (state: LifecycleDocument): Promise<void> => { await mkdir(dirname(statePath), { recursive: true }); await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`); };
export const acquire = (state: LifecycleDocument, tasks: TaskContract[], taskId: string, holder: string, now: Date, ttlMs = 900_000): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = state.tasks[taskId]; if (!target) throw new Error('TASK_NOT_FOUND'); if (target.state !== 'READY') throw new Error(`TASK_NOT_READY:${target.state}`);
  const task = tasks.find((item) => item.id === taskId); if (!task) throw new Error('TASK_CONTRACT_NOT_FOUND');
  const conflict = Object.values(state.tasks).find((item) => item.state === 'LEASED' && item.expiresAt && Date.parse(item.expiresAt) > now.getTime() && tasks.find((candidate) => candidate.id === item.taskId)?.exclusiveLocks.some((lock) => task.exclusiveLocks.includes(lock)));
  if (conflict) throw new Error(`PATH_LOCK_CONFLICT:${conflict.taskId}`);
  target.state = 'LEASED'; target.leaseVersion += 1; target.holder = holder; target.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return TaskLeaseSchema.parse({ schemaVersion: '1.0.0', taskId, holder, version: target.leaseVersion, acquiredAt: now.toISOString(), expiresAt: target.expiresAt, state: 'ACTIVE' });
};
export const assertLease = (state: LifecycleDocument, taskId: string, version: number, holder: string, now: Date): TaskState => { const target = state.tasks[taskId]; if (!target || target.state !== 'LEASED') throw new Error('NO_ACTIVE_LEASE'); if (target.leaseVersion !== version) throw new Error('STALE_LEASE_VERSION'); if (target.holder !== holder) throw new Error('STALE_LEASE_HOLDER'); if (!target.expiresAt || Date.parse(target.expiresAt) <= now.getTime()) throw new Error('LEASE_EXPIRED'); return target; };
export const refreshReady = (state: LifecycleDocument, tasks: TaskContract[]): void => { for (const task of tasks) { const target = state.tasks[task.id]; if (target?.state === 'PLANNED' && task.dependencies.every((dependency) => state.tasks[dependency]?.state === 'MERGED')) target.state = 'READY'; } };
