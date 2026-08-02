import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandRunner } from '../agent/lib/types.js';
import { agentRuntimeRoot } from '../agent/lib/runtime.js';

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
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
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid?: number };
    if (owner.pid && processAlive(owner.pid)) throw new Error(`AUTOPILOT_ALREADY_RUNNING:${owner.pid}`);
    await rm(path, { recursive: true });
    await mkdir(path);
  }
  await writeFile(join(path, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  return async () => rm(path, { recursive: true });
};
