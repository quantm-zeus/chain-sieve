import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskReviewSchema, type TaskContract } from '@ciag/shared-schemas';
import {
  listLaunchReceiptCandidates,
  validateLaunchReceipt,
  type LaunchReceiptCandidate,
} from '../agent/lib/runtime.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import { readTrustedFile } from '../agent/lib/trusted-path.js';
import { sha256 } from '../prd-compiler/compiler.js';
import {
  deriveChangedFiles,
  hashPathAtCommit,
} from '../task-verifier/attestation.js';
import {
  resolveTrustedVerificationRuntime,
  runTrustedTsx,
  runTrustedVitest,
} from '../task-verifier/trusted-execution.js';
import { taskBranch } from '../worktree-manager/identity.js';
import {
  readBoundTaskContract,
  readLifecycleBinding,
  validateVerificationBaseline,
} from './authority.js';
import { registerCurrentEvidence } from './evidence-ledger.js';
import { mandatoryPasses } from './self-review.js';
import {
  acquireLifecycleMutationLock,
  assertLease,
  readState,
  runtimeRoot,
  writeState,
  type EvidenceReference,
  type TaskState,
} from './state.js';

export const LegacyTaskReviewSchema = TaskReviewSchema.omit({
  lifecycleBindingSha256: true,
  verificationBaselineSha256: true,
  launchReceiptId: true,
  launchReceiptSha256: true,
});

type LegacyTaskReview = ReturnType<typeof LegacyTaskReviewSchema.parse>;

export interface TrustedSelfReviewOutputs {
  spec: string;
  prohibited: string;
  architecture: string;
  acceptance: string;
}

export interface SelfReviewRefreshDependencies {
  runChecks?: (
    trustedRoot: string,
    targetWorktree: string,
    task: TaskContract,
  ) => Promise<TrustedSelfReviewOutputs>;
  listReceipts?: typeof listLaunchReceiptCandidates;
  validateReceipt?: typeof validateLaunchReceipt;
}

export interface SelfReviewRefreshResult {
  taskId: string;
  contractPath: string;
  contractSha256: string;
  contractMode: 'LEGACY' | 'GENERATED';
  oldReview: EvidenceReference;
  newReview: EvidenceReference;
  launchReceiptId: string;
  launchReceiptSha256: string;
  commit: string;
  tree: string;
  state: 'SELF_REVIEWING';
  leaseId: string;
  fencingVersion: number;
}

const git = (args: string[], cwd: string): string => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `SELF_REVIEW_REFRESH_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`,
    );
  return result.stdout.trim();
};

const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : pattern === path;

const worktreeForBranch = (root: string, branch: string): string => {
  const block = git(['worktree', 'list', '--porcelain'], root)
    .split('\n\n')
    .find((item) => item.split('\n').includes(`branch refs/heads/${branch}`));
  const path = block
    ?.split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length);
  if (!path) throw new Error(`BOUND_WORKTREE_NOT_FOUND:${branch}`);
  return path;
};

const requirePassingOutput = (
  value: { exitCode: number; output: string },
  label: string,
): string => {
  if (value.exitCode !== 0)
    throw new Error(
      `SELF_REVIEW_REFRESH_CHECK_FAILED:${label}:${value.output.slice(-2000)}`,
    );
  return value.output;
};

const trustedWorkspaceAliases = async (
  trustedRoot: string,
  task: TaskContract,
): Promise<Record<string, string>> => {
  const packagePaths = [
    ...new Set([
      ...task.ownerPackages,
      ...[...task.allowedPaths, ...task.readSet, ...task.writeSet]
        .filter((path) => path.startsWith('packages/'))
        .map((path) => path.split('/').slice(0, 2).join('/')),
    ]),
  ];
  const aliases = await Promise.all(
    packagePaths.map(async (packagePath) => {
      let manifest: { name?: string; exports?: string };
      try {
        manifest = JSON.parse(
          await readFile(join(trustedRoot, packagePath, 'package.json'), 'utf8'),
        ) as { name?: string; exports?: string };
      } catch {
        return undefined;
      }
      if (
        !manifest.name ||
        !manifest.exports ||
        !manifest.exports.startsWith('./') ||
        manifest.exports.includes('..')
      )
        throw new Error(`TRUSTED_WORKSPACE_ALIAS_INVALID:${packagePath}`);
      return [manifest.name, join(packagePath, manifest.exports)] as const;
    }),
  );
  return Object.fromEntries(
    aliases.filter(
      (item): item is readonly [string, string] => Boolean(item),
    ),
  );
};

const runTrustedSelfReviewChecks = async (
  trustedRoot: string,
  targetWorktree: string,
  task: TaskContract,
): Promise<TrustedSelfReviewOutputs> => {
  const runtime = resolveTrustedVerificationRuntime(trustedRoot);
  const aliases = await trustedWorkspaceAliases(trustedRoot, task);
  const acceptance = runTrustedVitest(
    runtime,
    targetWorktree,
    task.requiredTests,
    {
      approvedInputs: [
        ...[...task.allowedPaths, ...task.readSet, ...task.writeSet].filter(
          (path) => !path.startsWith('tests/'),
        ),
        ...task.requiredTests,
        'tests/fixtures/**',
        'tasks/generated/interface-hashes.json',
      ],
      workspaceAliases: aliases,
    },
  );
  const architecture = runTrustedTsx(
    runtime,
    'tools/architecture-verifier/cli.ts',
    ['architecture', '--target-root', targetWorktree],
  );
  const prohibited = runTrustedTsx(
    runtime,
    'tools/architecture-verifier/cli.ts',
    ['prohibited', '--target-root', targetWorktree],
  );
  const spec = runTrustedTsx(runtime, 'tools/task-verifier/cli.ts', [
    'spec:verify',
  ]);
  return {
    acceptance: requirePassingOutput(acceptance, 'acceptance'),
    architecture: requirePassingOutput(architecture, 'architecture'),
    prohibited: requirePassingOutput(prohibited, 'prohibited'),
    spec: requirePassingOutput(spec, 'spec'),
  };
};

const parseExistingReview = (text: string): LegacyTaskReview =>
  LegacyTaskReviewSchema.parse(JSON.parse(text));

const validateExistingReview = (
  review: LegacyTaskReview,
  task: TaskContract,
  target: TaskState,
  commit: string,
  tree: string,
  targetWorktree: string,
): {
  changedFiles: ReturnType<typeof deriveChangedFiles>;
  acceptanceTestArtifacts: Array<{ path: string; sha256: string }>;
} => {
  if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
  if (
    review.taskId !== task.id ||
    review.reviewedBaseCommit !== target.baseCommit ||
    review.reviewedCommit !== commit ||
    review.reviewedTree !== tree
  )
    throw new Error('LEGACY_SELF_REVIEW_BINDING_MISMATCH');
  const changedFiles = deriveChangedFiles(
    target.baseCommit,
    commit,
    targetWorktree,
  );
  if (!isDeepStrictEqual(review.changedFiles, changedFiles))
    throw new Error('LEGACY_SELF_REVIEW_CHANGED_FILES_MISMATCH');
  const acceptanceTestArtifacts = task.requiredTests.map((path) => ({
    path,
    sha256: hashPathAtCommit(commit, path, 'M', targetWorktree),
  }));
  if (
    !isDeepStrictEqual(
      review.acceptanceTestArtifacts,
      acceptanceTestArtifacts,
    )
  )
    throw new Error('LEGACY_SELF_REVIEW_ACCEPTANCE_HASH_MISMATCH');
  if (
    !isDeepStrictEqual(
      review.dependencyInterfaceHashes,
      task.interfaceHashes,
    )
  )
    throw new Error('LEGACY_SELF_REVIEW_INTERFACE_HASH_MISMATCH');
  for (const name of mandatoryPasses)
    if (!review.passes.some((pass) => pass.name === name))
      throw new Error(`LEGACY_SELF_REVIEW_PASS_MISSING:${name}`);
  if (
    review.verdict !== 'PASS' ||
    review.findings.some(
      (finding) =>
        !finding.resolved &&
        (finding.severity === 'P0' || finding.severity === 'P1'),
    )
  )
    throw new Error('LEGACY_SELF_REVIEW_NOT_PASSING');
  return { changedFiles, acceptanceTestArtifacts };
};

export const selectSelfReviewRefreshReceipt = (
  candidates: LaunchReceiptCandidate[],
  binding: {
    taskId: string;
    leaseId: string;
    fencingVersion: number;
    holder: string;
    taskWorktree: string;
  },
): LaunchReceiptCandidate => {
  const matches = candidates.filter(({ value }) =>
    value.schemaVersion === '2.0.0' &&
    value.taskId === binding.taskId &&
    value.leaseId === binding.leaseId &&
    value.fencingVersion === binding.fencingVersion &&
    value.holder === binding.holder &&
    value.taskWorktree === binding.taskWorktree &&
    value.provider === 'antigravity',
  );
  if (matches.length !== 1) {
    const ids = candidates
      .map((candidate) => candidate.receiptId ?? '<missing>')
      .sort();
    throw new Error(
      `SELF_REVIEW_REFRESH_RECEIPT_MATCH_COUNT:${matches.length}:CANDIDATES:${ids.join(',') || '<none>'}`,
    );
  }
  return matches[0]!;
};

export const refreshTaskSelfReview = async (
  taskId: string,
  holder: string,
  leaseVersion: number,
  targetPath: string,
  options: {
    trustedRoot?: string;
    now?: Date;
    dependencies?: SelfReviewRefreshDependencies;
  } = {},
): Promise<SelfReviewRefreshResult> => {
  const trustedRoot = await realpath(options.trustedRoot ?? process.cwd());
  const releaseLock = await acquireLifecycleMutationLock(trustedRoot);
  try {
  if (git(['branch', '--show-current'], trustedRoot) !== 'main')
    throw new Error('TRUSTED_MAIN_CHECKOUT_REQUIRED');
  if (git(['status', '--porcelain'], trustedRoot) !== '')
    throw new Error('TRUSTED_CONTROL_PLANE_DIRTY');
  const state = await readState([], trustedRoot);
  const target = assertLease(
    state,
    taskId,
    leaseVersion,
    holder,
    options.now ?? new Date(),
  );
  if (target.state !== 'SELF_REVIEWING')
    throw new Error(`SELF_REVIEW_REFRESH_STATE_INVALID:${target.state}`);
  if (!target.worktree) throw new Error('TASK_WORKTREE_MISSING');
  const authorizedWorktree = await realpath(target.worktree);
  const targetWorktree = await realpath(targetPath);
  if (targetWorktree !== authorizedWorktree)
    throw new Error('TASK_WORKTREE_TARGET_MISMATCH');
  if (!target.branch) throw new Error('TASK_BRANCH_MISSING');
  const branch = git(['branch', '--show-current'], targetWorktree);
  if (branch !== target.branch || branch !== taskBranch(taskId))
    throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
  if (git(['status', '--porcelain'], targetWorktree) !== '')
    throw new Error('DIRTY_WORKTREE');
  if (!target.commit || !target.tree)
    throw new Error('TASK_IMPLEMENTATION_BINDING_MISSING');
  const commit = git(['rev-parse', 'HEAD'], targetWorktree);
  const tree = git(['rev-parse', 'HEAD^{tree}'], targetWorktree);
  if (commit !== target.commit) throw new Error('TASK_COMMIT_MISMATCH');
  if (tree !== target.tree) throw new Error('TASK_TREE_MISMATCH');
  if (
    target.implementationEvidence?.commit !== commit ||
    target.implementationEvidence.tree !== tree
  )
    throw new Error('TASK_IMPLEMENTATION_EVIDENCE_MISMATCH');
  if (!target.selfReviewEvidence)
    throw new Error('SELF_REVIEW_EVIDENCE_MISSING');
  if (
    target.selfReviewEvidence.status !== 'CURRENT' ||
    target.selfReviewEvidence.commit !== commit ||
    target.selfReviewEvidence.tree !== tree
  )
    throw new Error('SELF_REVIEW_EVIDENCE_BINDING_MISMATCH');
  const oldReview = { ...target.selfReviewEvidence };
  const reviewText = (
    await readTrustedFile(
      runtimeRoot(trustedRoot),
      oldReview.path,
      'LEGACY_TASK_SELF_REVIEW',
    )
  ).toString('utf8');
  if (sha256(reviewText) !== oldReview.sha256)
    throw new Error('SELF_REVIEW_HASH_MISMATCH');
  const existingReview = parseExistingReview(reviewText);
  const lifecycle = await readLifecycleBinding(trustedRoot, target);
  const task = await readBoundTaskContract(trustedRoot, target);
  if (!lifecycle || !task || !target.lifecycleBinding)
    throw new Error('TRUSTED_LIFECYCLE_AUTHORITY_MISSING');
  if (task.id !== taskId || task.cluster !== lifecycle.clusterId)
    throw new Error('TRUSTED_TASK_CONTRACT_ID_MISMATCH');
  const baseline = await validateVerificationBaseline(trustedRoot, target, {
    allowTrustedControlPlaneAdvance: true,
  });
  if (!target.verificationBaseline || !target.expiresAt || !target.leaseId)
    throw new Error('TRUSTED_VERIFICATION_AUTHORITY_MISSING');
  const { changedFiles, acceptanceTestArtifacts } = validateExistingReview(
    existingReview,
    task,
    target,
    commit,
    tree,
    targetWorktree,
  );
  if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
  if (commit === target.baseCommit) throw new Error('TASK_COMMIT_MISSING');
  if (
    Number(
      git(
        ['rev-list', '--count', `${target.baseCommit}..${commit}`],
        targetWorktree,
      ),
    ) !== 1
  )
    throw new Error('TASK_COMMIT_NOT_ATOMIC');
  for (const file of changedFiles) {
    if (task.forbiddenPaths.some((pattern) => covers(pattern, file.path)))
      throw new Error(`SELF_REVIEW_FORBIDDEN_PATH:${file.path}`);
    if (!task.allowedPaths.some((pattern) => covers(pattern, file.path)))
      throw new Error(`SELF_REVIEW_OUT_OF_SCOPE_PATH:${file.path}`);
  }
  const diff = git(['diff', `${target.baseCommit}..${commit}`], targetWorktree);
  if (/^(?:<{7}|={7}|>{7})/m.test(diff))
    throw new Error('SELF_REVIEW_CONFLICT_MARKER_DETECTED');
  const diffCheck = git(
    ['diff', '--check', `${target.baseCommit}..${commit}`],
    targetWorktree,
  );
  const runner = new SystemCommandRunner();
  const candidates = await (
    options.dependencies?.listReceipts ?? listLaunchReceiptCandidates
  )(trustedRoot, runner, taskId);
  const selected = selectSelfReviewRefreshReceipt(candidates, {
    taskId,
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
    holder,
    taskWorktree: targetWorktree,
  });
  if (!selected.receiptId)
    throw new Error('SELF_REVIEW_REFRESH_RECEIPT_ID_MISSING');
  const clusterBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  await (options.dependencies?.validateReceipt ?? validateLaunchReceipt)(
    trustedRoot,
    runner,
    {
      taskId,
      clusterId: task.cluster,
      leaseId: target.leaseId,
      fencingVersion: target.leaseVersion,
      contextManifestSha256: lifecycle.contextManifestSha256,
      ...(lifecycle.conformanceManifestSha256
        ? {
            conformanceManifestSha256:
              lifecycle.conformanceManifestSha256,
          }
        : {}),
      receiptId: selected.receiptId,
      receiptSha256: selected.sha256,
      provider: 'antigravity',
      holder,
      expiresAt: target.expiresAt,
      taskBranch: target.branch,
      taskWorktree: targetWorktree,
      clusterBranch,
      clusterWorktree: worktreeForBranch(trustedRoot, clusterBranch),
      baseCommit: target.baseCommit,
      baseTree: git(
        ['rev-parse', `${target.baseCommit}^{tree}`],
        targetWorktree,
      ),
      release: {
        ...baseline.releaseBaseline,
        tagObject: git(
          ['rev-parse', `refs/tags/${baseline.releaseBaseline.tag}`],
          trustedRoot,
        ),
      },
      integrationTarget: 'main',
      contextManifestPath: lifecycle.contextManifestPath,
      ...(lifecycle.conformanceManifestPath
        ? { conformanceManifestPath: lifecycle.conformanceManifestPath }
        : {}),
      contractPath: lifecycle.contractPath,
      contractSha256: lifecycle.contractSha256,
      lifecycleBindingPath: target.lifecycleBinding.path,
      lifecycleBindingSha256: target.lifecycleBinding.sha256,
      verificationBaselinePath: target.verificationBaseline.path,
      verificationBaselineSha256: target.verificationBaseline.sha256,
      pathLocks: task.exclusiveLocks,
      controlPlaneCommit: baseline.controlPlaneCommit,
      controlPlaneTree: baseline.controlPlaneTree,
      requireProviderNeutral: true,
    },
  );
  const outputs = await (
    options.dependencies?.runChecks ?? runTrustedSelfReviewChecks
  )(trustedRoot, targetWorktree, task);
  const changedFilesHash = sha256(JSON.stringify(changedFiles));
  const review = TaskReviewSchema.parse({
    schemaVersion: '2.0.0',
    taskId,
    reviewer: existingReview.reviewer,
    reviewedBaseCommit: target.baseCommit,
    reviewedCommit: commit,
    reviewedTree: tree,
    changedFiles,
    dependencyInterfaceHashes: task.interfaceHashes,
    acceptanceTestArtifacts,
    leaseId: target.leaseId,
    leaseFencingVersion: target.leaseVersion,
    lifecycleBindingSha256: target.lifecycleBinding.sha256,
    verificationBaselineSha256: target.verificationBaseline.sha256,
    launchReceiptId: selected.receiptId,
    launchReceiptSha256: selected.sha256,
    reviewedAt: (options.now ?? new Date()).toISOString(),
    rebase: existingReview.rebase,
    passes: [
      {
        name: mandatoryPasses[0],
        status: 'PASS',
        evidence: task.requirements.map(
          (id) => `${id}:${changedFilesHash}`,
        ),
      },
      {
        name: mandatoryPasses[1],
        status: 'PASS',
        evidence: acceptanceTestArtifacts.map(
          (item) => `${item.path}:${item.sha256}`,
        ),
      },
      {
        name: mandatoryPasses[2],
        status: 'PASS',
        evidence: [`changed-files-sha256:${changedFilesHash}`],
      },
      {
        name: mandatoryPasses[3],
        status: 'PASS',
        evidence: Object.entries(task.interfaceHashes).map(
          ([name, hash]) => `${name}:${hash}`,
        ),
      },
      {
        name: mandatoryPasses[4],
        status: 'PASS',
        evidence: [`prohibited-scan-sha256:${sha256(outputs.prohibited)}`],
      },
      {
        name: mandatoryPasses[5],
        status: 'PASS',
        evidence: [`acceptance-tests-sha256:${sha256(outputs.acceptance)}`],
      },
      {
        name: mandatoryPasses[6],
        status: 'PASS',
        evidence: [
          `architecture-sha256:${sha256(outputs.architecture)}`,
          `spec-sha256:${sha256(outputs.spec)}`,
        ],
      },
      {
        name: mandatoryPasses[7],
        status: 'PASS',
        evidence: [
          `git-diff-check-sha256:${sha256(diffCheck)}`,
          `head-tree:${tree}`,
        ],
      },
    ],
    verdict: 'PASS',
    findings: [],
  });
  if (git(['status', '--porcelain'], targetWorktree) !== '')
    throw new Error('TASK_WORKTREE_CHANGED_DURING_REFRESH');
  if (git(['rev-parse', 'HEAD'], targetWorktree) !== commit)
    throw new Error('TASK_COMMIT_CHANGED_DURING_REFRESH');
  if (git(['rev-parse', 'HEAD^{tree}'], targetWorktree) !== tree)
    throw new Error('TASK_TREE_CHANGED_DURING_REFRESH');
  const text = `${JSON.stringify(review, null, 2)}\n`;
  const reviewSha256 = sha256(text);
  const relativePath = `reviews/${taskId}/${commit}.refresh-${reviewSha256}.review.json`;
  const absolutePath = join(runtimeRoot(trustedRoot), relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, text, { mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(absolutePath, 'utf8')) !== text)
      throw new Error('IMMUTABLE_SELF_REVIEW_REFRESH_COLLISION');
  }
  const evidence: EvidenceReference = {
    path: relativePath,
    sha256: reviewSha256,
    status: 'CURRENT',
    commit,
    tree,
  };
  await registerCurrentEvidence(taskId, 'SELF_REVIEW', evidence, trustedRoot);
  target.selfReviewEvidence = evidence;
  await writeState(state, trustedRoot);
  return {
    taskId,
    contractPath: lifecycle.contractPath,
    contractSha256: lifecycle.contractSha256,
    contractMode: lifecycle.contractMode,
    oldReview,
    newReview: evidence,
    launchReceiptId: selected.receiptId,
    launchReceiptSha256: selected.sha256,
    commit,
    tree,
    state: 'SELF_REVIEWING',
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
  };
  } finally {
    await releaseLock();
  }
};
