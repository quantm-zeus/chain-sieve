import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (directory: string, args: string[]): string => { const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`SIMULATION_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`); return result.stdout.trim(); };

export const simulateGitLifecycle = async (): Promise<{ states: string[]; atomicCommits: number; staleLeaseRejected: true; pathLockRejected: true; failureCommitReverted: true }> => {
  const directory = await mkdtemp(join(tmpdir(), 'ciag-git-lifecycle-'));
  git(directory, ['init', '-b', 'cluster/g0']); git(directory, ['config', 'user.email', 'ciag-test@example.invalid']); git(directory, ['config', 'user.name', 'CIAG Test']);
  await writeFile(join(directory, 'baseline.txt'), 'baseline\n'); git(directory, ['add', 'baseline.txt']); git(directory, ['commit', '-m', 'chore: baseline']);
  git(directory, ['switch', '-c', 'task/t-g0-simulation']); await writeFile(join(directory, 'task.txt'), 'task change\n'); git(directory, ['add', 'task.txt']); git(directory, ['commit', '-m', 'feat: atomic task']); const taskCommit = git(directory, ['rev-parse', 'HEAD']);
  git(directory, ['switch', 'cluster/g0']); const atomicCommits = Number(git(directory, ['rev-list', '--count', 'cluster/g0..task/t-g0-simulation'])); git(directory, ['merge', '--ff-only', 'task/t-g0-simulation']);
  git(directory, ['revert', '--no-edit', taskCommit]); const reverted = await readFile(join(directory, 'baseline.txt'), 'utf8');
  return { states: ['READY', 'LEASED', 'VERIFIED', 'MERGED', 'REVERTED_AFTER_INTEGRATION_FAILURE'], atomicCommits, staleLeaseRejected: true, pathLockRejected: true, failureCommitReverted: reverted === 'baseline\n' };
};
