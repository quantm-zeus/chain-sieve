import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`AUTOPILOT_WORKSPACE_GIT_FAILED:${args.join(':')}`);
  return result.stdout.trim();
};

export const computeAutopilotWorkspaceHashes = async (cwd: string): Promise<{ tracked: string; untracked: string }> => {
  const tracked = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: null });
  if (tracked.status !== 0) throw new Error('AUTOPILOT_TRACKED_WORK_HASH_FAILED');
  const files = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const manifest = (await Promise.all(files.map(async (path) => `${sha256(await readFile(join(cwd, path)))}  ${path}\n`))).sort().join('');
  return { tracked: sha256(tracked.stdout), untracked: sha256(manifest) };
};
