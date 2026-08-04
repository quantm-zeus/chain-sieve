import { spawnSync } from 'node:child_process';

const git = (args: string[]): { status: number | null; stdout: string } => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim() };
};

const exists = (ref: string): boolean =>
  git(['show-ref', '--verify', '--quiet', ref]).status === 0;

if (!exists('refs/heads/main') && exists('refs/remotes/origin/main')) {
  const commit = git(['rev-parse', 'refs/remotes/origin/main']);
  if (commit.status !== 0 || !commit.stdout)
    throw new Error('CI_MAIN_REF_RESOLUTION_FAILED');
  const update = git(['update-ref', 'refs/heads/main', commit.stdout]);
  if (update.status !== 0) throw new Error('CI_MAIN_REF_CREATION_FAILED');
}
