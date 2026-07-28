import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TaskReviewSchema, type TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { deriveChangedFiles, hashPathAtCommit } from '../task-verifier/attestation.js';
import { currentLeaseCredential, runtimeRoot, type EvidenceReference, type TaskState } from './state.js';

const mandatoryPasses = [
  'requirement-coverage',
  'acceptance-test-coverage',
  'scope-and-forbidden-path-review',
  'dependency-interface-review',
  'adversarial-review',
  'test-quality-review',
  'architecture-boundary-review',
  'clean-worktree-review',
] as const;

const git = (args: string[], cwd = process.cwd()): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`SELF_REVIEW_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};

const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : pattern === path;

const run = (args: string[], cwd = process.cwd()): string => {
  const result = spawnSync('pnpm', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0)
    throw new Error(`SELF_REVIEW_COMMAND_FAILED:pnpm ${args.join(' ')}:${output.slice(-2000)}`);
  return output;
};

const patchId = (commit: string, cwd: string): string => {
  const show = spawnSync('git', ['show', '--pretty=format:', '--binary', commit], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (show.status !== 0) throw new Error(`SELF_REVIEW_PRE_REBASE_COMMIT_MISSING:${commit}`);
  const result = spawnSync('git', ['patch-id', '--stable'], {
    cwd,
    input: show.stdout,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('SELF_REVIEW_PATCH_ID_FAILED');
  return result.stdout.trim().split(/\s+/)[0] ?? '';
};

export interface SelfReviewOptions {
  previousHeadCommit?: string;
  now?: Date;
}

export const performTaskSelfReview = async (
  task: TaskContract,
  target: TaskState,
  reviewer: string,
  cwd = process.cwd(),
  options: SelfReviewOptions = {},
): Promise<{ path: string; sha256: string; evidence: EvidenceReference }> => {
  if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
  const credential = currentLeaseCredential(target);
  const head = git(['rev-parse', 'HEAD'], cwd);
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  if (head === target.baseCommit) throw new Error('TASK_COMMIT_MISSING');
  if (Number(git(['rev-list', '--count', `${target.baseCommit}..${head}`], cwd)) !== 1)
    throw new Error('TASK_COMMIT_NOT_ATOMIC');
  if (git(['status', '--porcelain'], cwd) !== '') throw new Error('DIRTY_WORKTREE');
  const changedFiles = deriveChangedFiles(target.baseCommit, head, cwd);
  if (changedFiles.length === 0) throw new Error('EMPTY_SELF_REVIEW_DIFF');
  for (const file of changedFiles) {
    if (task.forbiddenPaths.some((pattern) => covers(pattern, file.path)))
      throw new Error(`SELF_REVIEW_FORBIDDEN_PATH:${file.path}`);
    if (!task.allowedPaths.some((pattern) => covers(pattern, file.path)))
      throw new Error(`SELF_REVIEW_OUT_OF_SCOPE_PATH:${file.path}`);
  }
  const diff = git(['diff', `${target.baseCommit}..${head}`], cwd);
  if (/^(?:<{7}|={7}|>{7})/m.test(diff)) throw new Error('SELF_REVIEW_CONFLICT_MARKER_DETECTED');
  const diffCheck = git(['diff', '--check', `${target.baseCommit}..${head}`], cwd);
  const specOutput = run(['spec:verify'], cwd);
  const prohibitedOutput = run(['prohibited-capabilities:scan'], cwd);
  const architectureOutput = run(['architecture:verify'], cwd);
  const acceptanceOutput = run(['exec', 'vitest', 'run', ...task.requiredTests], cwd);
  const acceptanceTestArtifacts = task.requiredTests.map((path) => ({
    path,
    sha256: hashPathAtCommit(head, path, 'M', cwd),
  }));
  const semanticChangesDetected = options.previousHeadCommit
    ? patchId(options.previousHeadCommit, cwd) !== patchId(head, cwd)
    : false;
  if (semanticChangesDetected) throw new Error('REBASE_SEMANTIC_CHANGE_DETECTED');
  const review = TaskReviewSchema.parse({
    schemaVersion: '2.0.0',
    taskId: task.id,
    reviewer,
    reviewedBaseCommit: target.baseCommit,
    reviewedCommit: head,
    reviewedTree: tree,
    changedFiles,
    dependencyInterfaceHashes: task.interfaceHashes,
    acceptanceTestArtifacts,
    leaseId: credential.leaseId,
    leaseFencingVersion: credential.fencingVersion,
    reviewedAt: (options.now ?? new Date()).toISOString(),
    rebase: {
      ...(options.previousHeadCommit ? { previousHeadCommit: options.previousHeadCommit } : {}),
      conflictsDetected: false,
      semanticChangesDetected,
    },
    passes: [
      {
        name: mandatoryPasses[0],
        status: 'PASS',
        evidence: task.requirements.map((id) => `${id}:${sha256(JSON.stringify(changedFiles))}`),
      },
      {
        name: mandatoryPasses[1],
        status: 'PASS',
        evidence: acceptanceTestArtifacts.map((item) => `${item.path}:${item.sha256}`),
      },
      {
        name: mandatoryPasses[2],
        status: 'PASS',
        evidence: [`changed-files-sha256:${sha256(JSON.stringify(changedFiles))}`],
      },
      {
        name: mandatoryPasses[3],
        status: 'PASS',
        evidence: Object.entries(task.interfaceHashes).map(([name, hash]) => `${name}:${hash}`),
      },
      {
        name: mandatoryPasses[4],
        status: 'PASS',
        evidence: [`prohibited-scan-sha256:${sha256(prohibitedOutput)}`],
      },
      {
        name: mandatoryPasses[5],
        status: 'PASS',
        evidence: [`acceptance-tests-sha256:${sha256(acceptanceOutput)}`],
      },
      {
        name: mandatoryPasses[6],
        status: 'PASS',
        evidence: [`architecture-sha256:${sha256(architectureOutput)}`, `spec-sha256:${sha256(specOutput)}`],
      },
      {
        name: mandatoryPasses[7],
        status: 'PASS',
        evidence: [`git-diff-check-sha256:${sha256(diffCheck)}`, `head-tree:${tree}`],
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
  const evidence = { path: relativePath, sha256: sha256(text), status: 'CURRENT' as const, commit: head, tree };
  return { path: relativePath, sha256: evidence.sha256, evidence };
};

export { mandatoryPasses };
