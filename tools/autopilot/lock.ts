import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandRunner } from '../agent/lib/types.js';
import { agentRuntimeRoot } from '../agent/lib/runtime.js';

const LOCK_TTL_MS = 6 * 60 * 60_000;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

const readOwner = async (path: string): Promise<LockOwner | undefined> => {
  try {
    const value = JSON.parse(
      await readFile(join(path, 'owner.json'), 'utf8'),
    ) as Partial<LockOwner>;
    if (
      !Number.isInteger(value.pid) ||
      typeof value.host !== 'string' ||
      typeof value.token !== 'string' ||
      typeof value.acquiredAt !== 'string'
    )
      return undefined;
    return value as LockOwner;
  } catch {
    return undefined;
  }
};

export const acquireAutopilotLock = async (
  root: string,
  runner: CommandRunner,
): Promise<() => Promise<void>> => {
  const path = join(agentRuntimeRoot(root, runner), 'autopilot.lock');
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readOwner(path);
    const fresh =
      owner && Date.now() - Date.parse(owner.acquiredAt) <= LOCK_TTL_MS;
    if (
      owner &&
      fresh &&
      owner.host === hostname() &&
      processAlive(owner.pid)
    )
      throw new Error(`AUTOPILOT_ALREADY_RUNNING:${owner.pid}`);
    await rm(path, { recursive: true, force: true });
    await mkdir(path);
  }
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const temporary = join(path, `owner.${owner.token}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await rename(temporary, join(path, 'owner.json'));
  return async () => {
    const current = await readOwner(path);
    if (current?.token === owner.token)
      await rm(path, { recursive: true, force: true });
  };
};
