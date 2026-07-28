import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TaskContractSchema, TaskResultSchema, TaskReviewSchema, type TaskContract } from '@ciag/shared-schemas';
import { loadAndValidateSpecification, sha256 } from '../../tools/prd-compiler/compiler.js';
import {
  deriveAcceptanceMapping,
  deriveChangedFiles,
  deriveRequirementMapping,
  hashPathAtCommit,
  persistCommandEvidence,
  TASK_VERIFIER_VERSION,
  VERIFICATION_POLICY_VERSION,
} from '../../tools/task-verifier/attestation.js';
import { runtimeRoot, type TaskState } from '../../tools/task-runner/state.js';

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`FIXTURE_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};
const put = async (root: string, path: string, content: string): Promise<void> => {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
};

export interface AttestationFixture {
  root: string;
  task: TaskContract;
  base: string;
  head: string;
  result: ReturnType<typeof TaskResultSchema.parse>;
  state: TaskState;
  codePath: string;
  cleanup: () => Promise<void>;
  removeFirstArtifact: () => Promise<void>;
  commitSourceMutation: () => Promise<string>;
  restoreHead: () => void;
}

export const createAttestationFixture = async (): Promise<AttestationFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'chain-sieve-attestation-'));
  git(root, ['init', '-b', 'task/t-g0-core']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Attestation Test']);
  const contractText = `${git(process.cwd(), ['show', 'HEAD:tasks/G0/T-G0-CORE.contract.json'])}\n`;
  const task = TaskContractSchema.parse(JSON.parse(contractText));
  await put(root, `tasks/${task.dependencyGroup}/${task.id}.contract.json`, contractText);
  await put(
    root,
    'tasks/generated/interface-hashes.json',
    `${JSON.stringify({ [task.id]: task.interfaceHashes }, null, 2)}\n`,
  );
  for (const path of task.requiredTests) await put(root, path, `// immutable acceptance fixture for ${path}\n`);
  await put(root, 'baseline.txt', 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: baseline']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const codePath = 'packages/domain/src/attested.ts';
  await put(root, codePath, 'export const attested = true;\n');
  git(root, ['add', codePath]);
  git(root, ['commit', '-m', 'test: attested implementation']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const changedFiles = deriveChangedFiles(base, head, root);
  const command = `pnpm exec vitest run ${task.requiredTests.join(' ')}`;
  const commandEvidence = await persistCommandEvidence(
    task.id,
    head,
    [{ command, exitCode: 0, output: 'all mapped tests passed\n', outputSha256: sha256('all mapped tests passed\n') }],
    root,
  );
  const leaseId = `${task.id}:1:fixture`;
  const mandatoryPassNames = [
    'requirement-coverage',
    'acceptance-test-coverage',
    'scope-and-forbidden-path-review',
    'dependency-interface-review',
    'adversarial-review',
    'test-quality-review',
    'architecture-boundary-review',
    'clean-worktree-review',
  ];
  const review = TaskReviewSchema.parse({
    schemaVersion: '2.0.0',
    taskId: task.id,
    reviewer: 'fixture-reviewer',
    reviewedBaseCommit: base,
    reviewedCommit: head,
    reviewedTree: tree,
    changedFiles,
    dependencyInterfaceHashes: task.interfaceHashes,
    acceptanceTestArtifacts: task.requiredTests.map((path) => ({
      path,
      sha256: hashPathAtCommit(head, path, 'M', root),
    })),
    leaseId,
    leaseFencingVersion: 1,
    reviewedAt: '2026-07-21T00:00:00.000Z',
    rebase: { conflictsDetected: false, semanticChangesDetected: false },
    passes: mandatoryPassNames.map((name) => ({ name, status: 'PASS', evidence: [`fixture:${name}`] })),
    verdict: 'PASS',
    findings: [],
  });
  const reviewText = `${JSON.stringify(review, null, 2)}\n`;
  const reviewPath = `reviews/${task.id}/${head}.review.json`;
  await put(runtimeRoot(root), reviewPath, reviewText);
  const specification = await loadAndValidateSpecification();
  const result = TaskResultSchema.parse({
    schemaVersion: '2.0.0',
    taskId: task.id,
    status: 'PASS',
    bindings: {
      taskContractSha256: sha256(contractText),
      prdSha256: specification.hashes.prd,
      requirementManifestSha256: specification.hashes.requirements,
      auditSha256: specification.hashes.audit,
      baseCommitSha: base,
      headCommitSha: head,
      headTreeSha: tree,
      changedFiles,
      requirementToCode: deriveRequirementMapping(task, changedFiles, head, root),
      acceptanceToTests: await deriveAcceptanceMapping(task, head, root),
      requiredTestArtifacts: commandEvidence,
      dependencyInterfaceHashes: task.interfaceHashes,
      verifierVersion: TASK_VERIFIER_VERSION,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      leaseId,
      leaseFencingVersion: 1,
      verificationTimestamp: '2026-07-21T00:00:00.000Z',
      selfReviewPath: reviewPath,
      selfReviewSha256: sha256(reviewText),
    },
    commandEvidence,
  });
  const state: TaskState = {
    taskId: task.id,
    state: 'SELF_REVIEWING',
    leaseVersion: 1,
    leaseId,
    holder: 'fixture',
    expiresAt: '2099-01-01T00:00:00.000Z',
    baseCommit: base,
    branch: 'task/t-g0-core',
  };
  return {
    root,
    task,
    base,
    head,
    result,
    state,
    codePath,
    cleanup: async () => rm(root, { recursive: true, force: true }),
    removeFirstArtifact: async () => unlink(join(runtimeRoot(root), commandEvidence[0]!.artifactPath)),
    commitSourceMutation: async () => {
      await put(root, codePath, 'export const attested = false;\n');
      git(root, ['add', codePath]);
      git(root, ['commit', '-m', 'test: post-result mutation']);
      return git(root, ['rev-parse', 'HEAD']);
    },
    restoreHead: () => {
      git(root, ['reset', '--hard', head]);
    },
  };
};
