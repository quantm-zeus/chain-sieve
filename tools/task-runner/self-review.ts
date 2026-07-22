import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TaskReviewSchema, type TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { runtimeRoot, type TaskState } from './state.js';

const git = (args: string[], cwd = process.cwd()): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`SELF_REVIEW_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};
const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**') ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : pattern === path;
const run = (args: string[], cwd = process.cwd()): string => {
  const result = spawnSync('pnpm', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`SELF_REVIEW_COMMAND_FAILED:pnpm ${args.join(' ')}:${output.slice(-2000)}`);
  return output;
};

export const performTaskSelfReview = async (
  task: TaskContract,
  target: TaskState,
  reviewer: string,
  cwd = process.cwd(),
): Promise<{ path: string; sha256: string }> => {
  if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
  const head = git(['rev-parse', 'HEAD'], cwd);
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  if (head === target.baseCommit) throw new Error('TASK_COMMIT_MISSING');
  if (Number(git(['rev-list', '--count', `${target.baseCommit}..${head}`], cwd)) !== 1)
    throw new Error('TASK_COMMIT_NOT_ATOMIC');
  if (git(['status', '--porcelain', '--untracked-files=no'], cwd) !== '') throw new Error('DIRTY_TRACKED_SOURCE');
  const changed = git(['diff', '--name-only', `${target.baseCommit}..${head}`], cwd)
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0) throw new Error('EMPTY_SELF_REVIEW_DIFF');
  for (const path of changed) {
    if (task.forbiddenPaths.some((pattern) => covers(pattern, path)))
      throw new Error(`SELF_REVIEW_FORBIDDEN_PATH:${path}`);
    if (!task.allowedPaths.some((pattern) => covers(pattern, path)))
      throw new Error(`SELF_REVIEW_OUT_OF_SCOPE_PATH:${path}`);
  }
  const diffCheck = git(['diff', '--check', `${target.baseCommit}..${head}`], cwd);
  const specOutput = run(['spec:verify'], cwd);
  const prohibitedOutput = run(['prohibited-capabilities:scan'], cwd);
  const architectureOutput = run(['architecture:verify'], cwd);
  const review = TaskReviewSchema.parse({
    schemaVersion: '2.0.0',
    taskId: task.id,
    reviewer,
    reviewedCommit: head,
    reviewedTree: tree,
    passes: [
      {
        name: 'scope-and-atomicity',
        status: 'PASS',
        evidence: [`changed-files-sha256:${sha256(JSON.stringify(changed))}`, `commit-count:1`],
      },
      { name: 'immutable-source-integrity', status: 'PASS', evidence: [`command-output-sha256:${sha256(specOutput)}`] },
      {
        name: 'prohibited-capability-and-activation',
        status: 'PASS',
        evidence: [`command-output-sha256:${sha256(prohibitedOutput)}`],
      },
      {
        name: 'architecture-and-interface',
        status: 'PASS',
        evidence: [`command-output-sha256:${sha256(architectureOutput)}`],
      },
      {
        name: 'diff-whitespace-and-conflict-markers',
        status: 'PASS',
        evidence: [`git-diff-check-sha256:${sha256(diffCheck)}`],
      },
    ],
    verdict: 'PASS',
    findings: [],
  });
  const text = `${JSON.stringify(review, null, 2)}\n`;
  const relativePath = `reviews/${task.id}/${head}.review.json`;
  const absolute = join(runtimeRoot(cwd), relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(text) };
};
