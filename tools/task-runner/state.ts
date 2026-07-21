import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TaskLeaseSchema, type TaskContract } from '@ciag/shared-schemas';

export type TaskLifecycleState = 'PLANNED' | 'READY' | 'LEASED' | 'IMPLEMENTING' | 'SELF_REVIEWING' | 'VERIFYING' | 'VERIFIED' | 'MERGE_QUEUED' | 'MERGED' | 'BLOCKED';
export interface TaskState { taskId: string; state: TaskLifecycleState; leaseVersion: number; holder?: string; expiresAt?: string; commit?: string; baseCommit?: string; branch?: string }
export interface LifecycleDocument { schemaVersion: '1.0.0'; tasks: Record<string, TaskState> }

const commonGitDirectory = (cwd = process.cwd()): string => { const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error('GIT_COMMON_DIR_UNAVAILABLE'); const value = result.stdout.trim(); return resolve(cwd, isAbsolute(value) ? value : join(cwd, value)); };
export const runtimeRoot = (cwd = process.cwd()): string => join(commonGitDirectory(cwd), 'ciag-runtime');
export const statePath = (cwd = process.cwd()): string => join(runtimeRoot(cwd), 'task-state.json');

export const readState = async (tasks: TaskContract[], cwd = process.cwd()): Promise<LifecycleDocument> => {
  try { const value = JSON.parse(await readFile(statePath(cwd), 'utf8')) as LifecycleDocument; if (value.schemaVersion !== '1.0.0' || typeof value.tasks !== 'object') throw new Error('TASK_STATE_INVALID'); return value; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const readyIds = new Set(tasks.filter((task) => task.dependencies.length === 0).map((task) => task.id)); return { schemaVersion: '1.0.0', tasks: Object.fromEntries(tasks.map((task) => [task.id, { taskId: task.id, state: readyIds.has(task.id) ? 'READY' : 'PLANNED', leaseVersion: 0 }])) }; }
};
export const writeState = async (state: LifecycleDocument, cwd = process.cwd()): Promise<void> => { const target = statePath(cwd); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); };

const activeStates = new Set<TaskLifecycleState>(['LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED']);
export const acquire = (state: LifecycleDocument, tasks: TaskContract[], taskId: string, holder: string, now: Date, ttlMs = 900_000, baseCommit?: string, branch?: string): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = state.tasks[taskId]; if (!target) throw new Error('TASK_NOT_FOUND'); if (target.state !== 'READY') throw new Error(`TASK_NOT_READY:${target.state}`);
  const task = tasks.find((item) => item.id === taskId); if (!task) throw new Error('TASK_CONTRACT_NOT_FOUND');
  const conflict = Object.values(state.tasks).find((item) => activeStates.has(item.state) && item.expiresAt && Date.parse(item.expiresAt) > now.getTime() && tasks.find((candidate) => candidate.id === item.taskId)?.exclusiveLocks.some((lock) => task.exclusiveLocks.includes(lock)));
  if (conflict) throw new Error(`PATH_LOCK_CONFLICT:${conflict.taskId}`);
  target.state = 'LEASED'; target.leaseVersion += 1; target.holder = holder; target.expiresAt = new Date(now.getTime() + ttlMs).toISOString(); if (baseCommit) target.baseCommit = baseCommit; if (branch) target.branch = branch;
  return TaskLeaseSchema.parse({ schemaVersion: '1.0.0', taskId, holder, version: target.leaseVersion, acquiredAt: now.toISOString(), expiresAt: target.expiresAt, state: 'ACTIVE' });
};
export const assertLease = (state: LifecycleDocument, taskId: string, version: number, holder: string, now: Date): TaskState => { const target = state.tasks[taskId]; if (!target || !activeStates.has(target.state)) throw new Error('NO_ACTIVE_LEASE'); if (target.leaseVersion !== version) throw new Error('STALE_LEASE_VERSION'); if (target.holder !== holder) throw new Error('STALE_LEASE_HOLDER'); if (!target.expiresAt || Date.parse(target.expiresAt) <= now.getTime()) throw new Error('LEASE_EXPIRED'); return target; };
export const transition = (target: TaskState, from: TaskLifecycleState[], to: TaskLifecycleState): void => { if (!from.includes(target.state)) throw new Error(`INVALID_TASK_TRANSITION:${target.state}:${to}`); target.state = to; };
export const refreshReady = (state: LifecycleDocument, tasks: TaskContract[]): void => { for (const task of tasks) { const target = state.tasks[task.id]; if (target?.state === 'PLANNED' && task.dependencies.every((dependency) => state.tasks[dependency]?.state === 'MERGED')) target.state = 'READY'; } };
