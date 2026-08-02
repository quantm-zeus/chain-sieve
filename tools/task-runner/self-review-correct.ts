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
import { assertTrustedTargetPaths } from '../task-verifier/verify.js';
import { taskBranch } from '../worktree-manager/identity.js';
import {
  readBoundTaskContract,
  readLifecycleBinding,
  readVerificationBaseline,
  validateVerificationBaseline,
  type VerificationBaselineDocument,
} from './authority.js';
import {
  assertEvidenceCurrent,
  replaceCorrectedEvidence,
} from './evidence-ledger.js';
import { mandatoryPasses } from './self-review.js';
import {
  runTrustedSelfReviewChecks,
  type SelfReviewRefreshDependencies,
  type TrustedSelfReviewOutputs,
} from './self-review-refresh.js';
import {
  acquireLifecycleMutationLock,
  assertLease,
  readState,
  runtimeRoot,
  writeState,
  type EvidenceReference,
  type TaskState,
} from './state.js';

export interface SelfReviewCorrectionDependencies {
  runChecks?: (
    trustedRoot: string,
    targetWorktree: string,
    task: TaskContract,
  ) => Promise<TrustedSelfReviewOutputs>;
  listReceipts?: SelfReviewRefreshDependencies['listReceipts'];
  validateReceipt?: SelfReviewRefreshDependencies['validateReceipt'];
}

export interface SelfReviewCorrectionResult {
  taskId: string;
  contractPath: string;
  contractSha256: string;
  contractMode: 'LEGACY' | 'GENERATED';
  previousImplementation: EvidenceReference;
  previousReview: EvidenceReference;
  implementationEvidence: EvidenceReference;
  selfReviewEvidence: EvidenceReference;
  launchReceiptId: string;
  launchReceiptSha256: string;
  failureCode: string;
  changedFiles: number;
  changedLines: number;
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
      `SELF_REVIEW_CORRECTION_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`,
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

const changedLineCount = (base: string, head: string, cwd: string): number =>
  git(['diff', '--numstat', `${base}..${head}`], cwd)
    .split('\n')
    .filter(Boolean)
    .reduce(
      (sum, line) =>
        sum +
        line
          .split('\t')
          .slice(0, 2)
          .reduce((count, value) => count + (Number(value) || 0), 0),
      0,
    );

const correctionGoalContains = (goal: string, failureCode: string): boolean =>
  goal
    .split('\n')
    .filter((line) => line.startsWith('- Correction required: '))
    .some((line) =>
      line
        .slice('- Correction required: '.length)
        .split(/[^A-Z0-9_]+/)
        .includes(failureCode),
    );

export const selectSelfReviewCorrectionReceipt = async (
  candidates: LaunchReceiptCandidate[],
  binding: {
    taskId: string;
    leaseId: string;
    fencingVersion: number;
    holder: string;
    taskWorktree: string;
  },
  failureCode: string,
): Promise<LaunchReceiptCandidate> => {
  const bound = candidates.filter(
    ({ value }) =>
      value.schemaVersion === '2.0.0' &&
      value.taskId === binding.taskId &&
      value.leaseId === binding.leaseId &&
      value.fencingVersion === binding.fencingVersion &&
      value.holder === binding.holder &&
      value.taskWorktree === binding.taskWorktree &&
      value.provider === 'antigravity',
  );
  const matches: LaunchReceiptCandidate[] = [];
  for (const candidate of bound) {
    const goalPath = candidate.value.goalPath;
    const goalSha256 = candidate.value.goalSha256;
    if (typeof goalPath !== 'string' || typeof goalSha256 !== 'string')
      throw new Error('SELF_REVIEW_CORRECTION_RECEIPT_GOAL_BINDING_MISSING');
    const goal = (
      await readTrustedFile(
        join(candidate.runtime, 'goals', binding.taskId),
        goalPath,
        'SELF_REVIEW_CORRECTION_GOAL',
      )
    ).toString('utf8');
    if (sha256(goal) !== goalSha256)
      throw new Error('SELF_REVIEW_CORRECTION_GOAL_HASH_MISMATCH');
    if (correctionGoalContains(goal, failureCode)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    const ids = candidates
      .map((candidate) => candidate.receiptId ?? '<missing>')
      .sort();
    throw new Error(
      `SELF_REVIEW_CORRECTION_RECEIPT_MATCH_COUNT:${matches.length}:FAILURE:${failureCode}:CANDIDATES:${ids.join(',') || '<none>'}`,
    );
  }
  return matches[0]!;
};

const validatePreviousEvidence = async (
  trustedRoot: string,
  targetWorktree: string,
  task: TaskContract,
  target: TaskState,
  expectedPreviousCommit: string,
): Promise<{
  implementation: EvidenceReference;
  reviewEvidence: EvidenceReference;
  review: ReturnType<typeof TaskReviewSchema.parse>;
}> => {
  if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
  if (target.commit !== expectedPreviousCommit)
    throw new Error('PREVIOUS_TASK_COMMIT_BINDING_MISMATCH');
  const previousTree = git(
    ['rev-parse', `${expectedPreviousCommit}^{tree}`],
    targetWorktree,
  );
  if (
    target.tree !== previousTree
  )
    throw new Error('PREVIOUS_TASK_COMMIT_BINDING_MISMATCH');
  const implementation = target.implementationEvidence;
  if (
    !implementation ||
    implementation.status !== 'CURRENT' ||
    implementation.path !== `git:${expectedPreviousCommit}` ||
    implementation.sha256 !== sha256(`${expectedPreviousCommit}:${previousTree}`) ||
    implementation.commit !== expectedPreviousCommit ||
    implementation.tree !== previousTree
  )
    throw new Error('PREVIOUS_IMPLEMENTATION_EVIDENCE_MISMATCH');
  const reviewEvidence = target.selfReviewEvidence;
  if (
    !reviewEvidence ||
    reviewEvidence.status !== 'CURRENT' ||
    reviewEvidence.commit !== expectedPreviousCommit ||
    reviewEvidence.tree !== previousTree
  )
    throw new Error('PREVIOUS_SELF_REVIEW_EVIDENCE_MISMATCH');
  const reviewText = (
    await readTrustedFile(
      runtimeRoot(trustedRoot),
      reviewEvidence.path,
      'PREVIOUS_TASK_SELF_REVIEW',
    )
  ).toString('utf8');
  if (sha256(reviewText) !== reviewEvidence.sha256)
    throw new Error('PREVIOUS_SELF_REVIEW_HASH_MISMATCH');
  const review = TaskReviewSchema.parse(JSON.parse(reviewText));
  if (
    review.taskId !== task.id ||
    review.reviewedBaseCommit !== target.baseCommit ||
    review.reviewedCommit !== expectedPreviousCommit ||
    review.reviewedTree !== previousTree
  )
    throw new Error('PREVIOUS_SELF_REVIEW_BINDING_MISMATCH');
  const changedFiles = deriveChangedFiles(
    target.baseCommit,
    expectedPreviousCommit,
    targetWorktree,
  );
  if (!isDeepStrictEqual(review.changedFiles, changedFiles))
    throw new Error('PREVIOUS_SELF_REVIEW_CHANGED_FILES_MISMATCH');
  const acceptanceTestArtifacts = task.requiredTests.map((path) => ({
    path,
    sha256: hashPathAtCommit(expectedPreviousCommit, path, 'M', targetWorktree),
  }));
  if (!isDeepStrictEqual(review.acceptanceTestArtifacts, acceptanceTestArtifacts))
    throw new Error('PREVIOUS_SELF_REVIEW_ACCEPTANCE_HASH_MISMATCH');
  if (!isDeepStrictEqual(review.dependencyInterfaceHashes, task.interfaceHashes))
    throw new Error('PREVIOUS_SELF_REVIEW_INTERFACE_HASH_MISMATCH');
  for (const name of mandatoryPasses)
    if (!review.passes.some((pass) => pass.name === name))
      throw new Error(`PREVIOUS_SELF_REVIEW_PASS_MISSING:${name}`);
  if (
    review.verdict !== 'PASS' ||
    review.findings.some(
      (finding) =>
        !finding.resolved &&
        (finding.severity === 'P0' || finding.severity === 'P1'),
    )
  )
    throw new Error('PREVIOUS_SELF_REVIEW_NOT_PASSING');
  if (review.lifecycleBindingSha256 !== target.lifecycleBinding?.sha256)
    throw new Error('PREVIOUS_SELF_REVIEW_LIFECYCLE_MISMATCH');
  await assertEvidenceCurrent(
    task.id,
    'SELF_REVIEW',
    reviewEvidence,
    trustedRoot,
  );
  return { implementation: { ...implementation }, reviewEvidence: { ...reviewEvidence }, review };
};

const baselineForPreviousReview = async (
  trustedRoot: string,
  target: TaskState,
  review: ReturnType<typeof TaskReviewSchema.parse>,
): Promise<{
  evidence: EvidenceReference;
  baseline: VerificationBaselineDocument;
  expiresAt: string;
}> => {
  if (!target.verificationBaseline || !target.expiresAt)
    throw new Error('TRUSTED_VERIFICATION_AUTHORITY_MISSING');
  const currentLease =
    review.leaseId === target.leaseId &&
    review.leaseFencingVersion === target.leaseVersion;
  const recoveredLease =
    target.recovery?.previousLeaseId === review.leaseId &&
    target.recovery.previousFencingVersion === review.leaseFencingVersion &&
    target.recovery.resultingLeaseId === target.leaseId &&
    target.recovery.resultingFencingVersion === target.leaseVersion;
  if (!currentLease && !recoveredLease)
    throw new Error('PREVIOUS_SELF_REVIEW_LEASE_BINDING_MISMATCH');
  const evidence =
    review.verificationBaselineSha256 === target.verificationBaseline.sha256
      ? target.verificationBaseline
      : recoveredLease &&
          target.recovery?.previousVerificationBaseline?.sha256 ===
            review.verificationBaselineSha256 &&
          target.recovery.resultingVerificationBaseline?.sha256 ===
            target.verificationBaseline.sha256
        ? target.recovery.previousVerificationBaseline
        : undefined;
  if (!evidence)
    throw new Error('PREVIOUS_SELF_REVIEW_BASELINE_UNAUTHORIZED');
  const baseline = await readVerificationBaseline(trustedRoot, {
    ...target,
    verificationBaseline: evidence,
  });
  if (!baseline) throw new Error('PREVIOUS_SELF_REVIEW_BASELINE_MISSING');
  const expiresAt = currentLease
    ? target.expiresAt
    : target.recovery?.previousExpiresAt;
  if (!expiresAt)
    throw new Error('PREVIOUS_SELF_REVIEW_EXPIRY_BINDING_MISSING');
  return { evidence, baseline, expiresAt };
};

const validateBoundReceipt = async (
  trustedRoot: string,
  targetWorktree: string,
  clusterWorktree: string,
  task: TaskContract,
  target: TaskState,
  lifecycle: NonNullable<Awaited<ReturnType<typeof readLifecycleBinding>>>,
  binding: {
    receiptId: string;
    receiptSha256: string;
    leaseId: string;
    fencingVersion: number;
    expiresAt: string;
    provider: 'antigravity' | 'zcode';
    baselineEvidence: EvidenceReference;
    baseline: VerificationBaselineDocument;
    allowHistoricalExpiry?: boolean;
  },
  validateReceipt: typeof validateLaunchReceipt,
): Promise<void> => {
  if (!target.baseCommit || !target.branch || !target.holder || !target.lifecycleBinding)
    throw new Error('TRUSTED_LIFECYCLE_AUTHORITY_MISSING');
  await validateReceipt(trustedRoot, new SystemCommandRunner(), {
    taskId: task.id,
    clusterId: task.cluster,
    leaseId: binding.leaseId,
    fencingVersion: binding.fencingVersion,
    contextManifestSha256: lifecycle.contextManifestSha256,
    ...(lifecycle.conformanceManifestSha256
      ? { conformanceManifestSha256: lifecycle.conformanceManifestSha256 }
      : {}),
    receiptId: binding.receiptId,
    receiptSha256: binding.receiptSha256,
    provider: binding.provider,
    holder: target.holder,
    expiresAt: binding.expiresAt,
    taskBranch: target.branch,
    taskWorktree: targetWorktree,
    clusterBranch: `cluster/${task.dependencyGroup.toLowerCase()}`,
    clusterWorktree,
    baseCommit: target.baseCommit,
    baseTree: git(['rev-parse', `${target.baseCommit}^{tree}`], targetWorktree),
    release: {
      ...binding.baseline.releaseBaseline,
      tagObject: git(
        ['rev-parse', `refs/tags/${binding.baseline.releaseBaseline.tag}`],
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
    verificationBaselinePath: binding.baselineEvidence.path,
    verificationBaselineSha256: binding.baselineEvidence.sha256,
    pathLocks: task.exclusiveLocks,
    controlPlaneCommit: binding.baseline.controlPlaneCommit,
    controlPlaneTree: binding.baseline.controlPlaneTree,
    requireProviderNeutral: true,
    ...(binding.allowHistoricalExpiry ? { allowHistoricalExpiry: true } : {}),
  });
};

export const correctTaskSelfReview = async (
  taskId: string,
  holder: string,
  leaseVersion: number,
  targetPath: string,
  expectedPreviousCommit: string,
  failureCode: string,
  options: {
    trustedRoot?: string;
    now?: Date;
    dependencies?: SelfReviewCorrectionDependencies;
  } = {},
): Promise<SelfReviewCorrectionResult> => {
  if (!/^[a-f0-9]{40}$/.test(expectedPreviousCommit))
    throw new Error('EXPECTED_PREVIOUS_COMMIT_INVALID');
  if (!/^[A-Z][A-Z0-9_]*$/.test(failureCode))
    throw new Error('CORRECTION_FAILURE_CODE_INVALID');
  const trustedRoot = await realpath(options.trustedRoot ?? process.cwd());
  const releaseLock = await acquireLifecycleMutationLock(trustedRoot);
  try {
    if (git(['branch', '--show-current'], trustedRoot) !== 'main')
      throw new Error('TRUSTED_MAIN_CHECKOUT_REQUIRED');
    if (git(['status', '--porcelain'], trustedRoot) !== '')
      throw new Error('TRUSTED_CONTROL_PLANE_DIRTY');
    const trustedHead = git(['rev-parse', 'HEAD'], trustedRoot);
    const trustedTree = git(['rev-parse', 'HEAD^{tree}'], trustedRoot);
    const state = await readState([], trustedRoot);
    const target = assertLease(
      state,
      taskId,
      leaseVersion,
      holder,
      options.now ?? new Date(),
    );
    if (target.state !== 'SELF_REVIEWING')
      throw new Error(`SELF_REVIEW_CORRECTION_STATE_INVALID:${target.state}`);
    if (!target.worktree || !target.branch)
      throw new Error('TASK_WORKTREE_BINDING_MISSING');
    const targetWorktree = await realpath(targetPath);
    const authorizedWorktree = await realpath(target.worktree);
    const expectedBranch = taskBranch(taskId);
    const canonicalWorktree = await realpath(
      worktreeForBranch(trustedRoot, expectedBranch),
    );
    if (
      targetWorktree !== authorizedWorktree ||
      targetWorktree !== canonicalWorktree
    )
      throw new Error('TASK_WORKTREE_TARGET_MISMATCH');
    const branch = git(['branch', '--show-current'], targetWorktree);
    if (branch !== expectedBranch || target.branch !== expectedBranch)
      throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
    if (git(['status', '--porcelain'], targetWorktree) !== '')
      throw new Error('DIRTY_WORKTREE');

    const lifecycle = await readLifecycleBinding(trustedRoot, target);
    const task = await readBoundTaskContract(trustedRoot, target);
    if (!lifecycle || !task || !target.lifecycleBinding)
      throw new Error('TRUSTED_LIFECYCLE_AUTHORITY_MISSING');
    if (task.id !== taskId || task.cluster !== lifecycle.clusterId)
      throw new Error('TRUSTED_TASK_CONTRACT_ID_MISMATCH');
    if (target.baseCommit !== lifecycle.baseCommit)
      throw new Error('TASK_BASE_COMMIT_MISSING_OR_DRIFTED');
    const baseline = await validateVerificationBaseline(trustedRoot, target, {
      allowTrustedControlPlaneAdvance: true,
    });
    if (!target.verificationBaseline || !target.leaseId || !target.expiresAt)
      throw new Error('TRUSTED_VERIFICATION_AUTHORITY_MISSING');
    const previous = await validatePreviousEvidence(
      trustedRoot,
      targetWorktree,
      task,
      target,
      expectedPreviousCommit,
    );
    const clusterWorktree = await realpath(
      worktreeForBranch(
        trustedRoot,
        `cluster/${task.dependencyGroup.toLowerCase()}`,
      ),
    );
    const previousAuthority = await baselineForPreviousReview(
      trustedRoot,
      target,
      previous.review,
    );
    const previousProvider = previous.review.launchReceiptId.startsWith(
      'antigravity-',
    )
      ? 'antigravity'
      : previous.review.launchReceiptId.startsWith('zcode-')
        ? 'zcode'
        : undefined;
    if (!previousProvider)
      throw new Error('PREVIOUS_LAUNCH_RECEIPT_PROVIDER_UNBOUND');
    const validateReceipt =
      options.dependencies?.validateReceipt ?? validateLaunchReceipt;
    await validateBoundReceipt(
      trustedRoot,
      targetWorktree,
      clusterWorktree,
      task,
      target,
      lifecycle,
      {
        receiptId: previous.review.launchReceiptId,
        receiptSha256: previous.review.launchReceiptSha256,
        leaseId: previous.review.leaseId,
        fencingVersion: previous.review.leaseFencingVersion,
        expiresAt: previousAuthority.expiresAt,
        provider: previousProvider,
        baselineEvidence: previousAuthority.evidence,
        baseline: previousAuthority.baseline,
        allowHistoricalExpiry: true,
      },
      validateReceipt,
    );

    const head = git(['rev-parse', 'HEAD'], targetWorktree);
    const tree = git(['rev-parse', 'HEAD^{tree}'], targetWorktree);
    if (head === expectedPreviousCommit)
      throw new Error('SELF_REVIEW_CORRECTION_HEAD_UNCHANGED');
    if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
    if (
      Number(
        git(
          ['rev-list', '--count', `${target.baseCommit}..${head}`],
          targetWorktree,
        ),
      ) !== 1
    )
      throw new Error('TASK_COMMIT_NOT_ATOMIC');
    const changedFiles = deriveChangedFiles(
      target.baseCommit,
      head,
      targetWorktree,
    );
    if (changedFiles.length === 0) throw new Error('TASK_DIFF_EMPTY');
    assertTrustedTargetPaths(changedFiles.map((file) => file.path));
    if (changedFiles.length > task.complexityBudget.maxFiles)
      throw new Error('TASK_FILE_BUDGET_EXCEEDED');
    for (const file of changedFiles) {
      if (task.forbiddenPaths.some((pattern) => covers(pattern, file.path)))
        throw new Error(`SELF_REVIEW_FORBIDDEN_PATH:${file.path}`);
      if (!task.allowedPaths.some((pattern) => covers(pattern, file.path)))
        throw new Error(`SELF_REVIEW_OUT_OF_SCOPE_PATH:${file.path}`);
    }
    const changedLines = changedLineCount(
      target.baseCommit,
      head,
      targetWorktree,
    );
    if (changedLines > task.complexityBudget.maxChangedLines)
      throw new Error('TASK_LINE_BUDGET_EXCEEDED');
    const diff = git(
      ['diff', `${target.baseCommit}..${head}`],
      targetWorktree,
    );
    if (/^(?:<{7}|={7}|>{7})/m.test(diff))
      throw new Error('SELF_REVIEW_CONFLICT_MARKER_DETECTED');
    const diffCheck = git(
      ['diff', '--check', `${target.baseCommit}..${head}`],
      targetWorktree,
    );

    const runner = new SystemCommandRunner();
    const candidates = await (
      options.dependencies?.listReceipts ?? listLaunchReceiptCandidates
    )(trustedRoot, runner, taskId);
    const correctionReceipt = await selectSelfReviewCorrectionReceipt(
      candidates,
      {
        taskId,
        leaseId: target.leaseId,
        fencingVersion: target.leaseVersion,
        holder,
        taskWorktree: targetWorktree,
      },
      failureCode,
    );
    if (!correctionReceipt.receiptId)
      throw new Error('SELF_REVIEW_CORRECTION_RECEIPT_ID_MISSING');
    await validateBoundReceipt(
      trustedRoot,
      targetWorktree,
      clusterWorktree,
      task,
      target,
      lifecycle,
      {
        receiptId: correctionReceipt.receiptId,
        receiptSha256: correctionReceipt.sha256,
        leaseId: target.leaseId,
        fencingVersion: target.leaseVersion,
        expiresAt: target.expiresAt,
        provider: 'antigravity',
        baselineEvidence: target.verificationBaseline,
        baseline,
      },
      validateReceipt,
    );
    const outputs = await (
      options.dependencies?.runChecks ?? runTrustedSelfReviewChecks
    )(trustedRoot, targetWorktree, task);
    if (git(['status', '--porcelain'], targetWorktree) !== '')
      throw new Error('TASK_WORKTREE_CHANGED_DURING_CORRECTION');
    if (git(['rev-parse', 'HEAD'], targetWorktree) !== head)
      throw new Error('TASK_COMMIT_CHANGED_DURING_CORRECTION');
    if (git(['rev-parse', 'HEAD^{tree}'], targetWorktree) !== tree)
      throw new Error('TASK_TREE_CHANGED_DURING_CORRECTION');
    if (
      git(['branch', '--show-current'], trustedRoot) !== 'main' ||
      git(['status', '--porcelain'], trustedRoot) !== '' ||
      git(['rev-parse', 'HEAD'], trustedRoot) !== trustedHead ||
      git(['rev-parse', 'HEAD^{tree}'], trustedRoot) !== trustedTree
    )
      throw new Error('TRUSTED_CONTROL_PLANE_CHANGED_DURING_CORRECTION');

    const acceptanceTestArtifacts = task.requiredTests.map((path) => ({
      path,
      sha256: hashPathAtCommit(head, path, 'M', targetWorktree),
    }));
    const changedFilesHash = sha256(JSON.stringify(changedFiles));
    const review = TaskReviewSchema.parse({
      schemaVersion: '2.0.0',
      taskId,
      reviewer: holder,
      reviewedBaseCommit: target.baseCommit,
      reviewedCommit: head,
      reviewedTree: tree,
      changedFiles,
      dependencyInterfaceHashes: task.interfaceHashes,
      acceptanceTestArtifacts,
      leaseId: target.leaseId,
      leaseFencingVersion: target.leaseVersion,
      lifecycleBindingSha256: target.lifecycleBinding.sha256,
      verificationBaselineSha256: target.verificationBaseline.sha256,
      launchReceiptId: correctionReceipt.receiptId,
      launchReceiptSha256: correctionReceipt.sha256,
      reviewedAt: (options.now ?? new Date()).toISOString(),
      rebase: {
        previousHeadCommit: expectedPreviousCommit,
        conflictsDetected: false,
        semanticChangesDetected: true,
      },
      passes: [
        {
          name: mandatoryPasses[0],
          status: 'PASS',
          evidence: task.requirements.map((id) => `${id}:${changedFilesHash}`),
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
          evidence: [
            `changed-files-sha256:${changedFilesHash}`,
            `changed-lines:${changedLines}`,
          ],
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
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    const reviewSha256 = sha256(reviewText);
    const correctionBinding = sha256(
      `${failureCode}:${correctionReceipt.receiptId}:${correctionReceipt.sha256}`,
    );
    const reviewPath = `reviews/${taskId}/${head}.correction-${correctionBinding}.review.json`;
    const absoluteReviewPath = join(runtimeRoot(trustedRoot), reviewPath);
    await mkdir(dirname(absoluteReviewPath), { recursive: true });
    try {
      await writeFile(absoluteReviewPath, reviewText, {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await readFile(absoluteReviewPath, 'utf8')) !== reviewText)
        throw new Error('IMMUTABLE_SELF_REVIEW_CORRECTION_COLLISION');
    }
    const implementationEvidence: EvidenceReference = {
      path: `git:${head}`,
      sha256: sha256(`${head}:${tree}`),
      status: 'CURRENT',
      commit: head,
      tree,
    };
    const selfReviewEvidence: EvidenceReference = {
      path: reviewPath,
      sha256: reviewSha256,
      status: 'CURRENT',
      commit: head,
      tree,
    };
    const previousImplementation = {
      ...previous.implementation,
      status: 'STALE' as const,
    };
    const previousReview = {
      ...previous.reviewEvidence,
      status: 'STALE' as const,
    };
    await replaceCorrectedEvidence(
      taskId,
      {
        implementation: previous.implementation,
        selfReview: previous.reviewEvidence,
      },
      { implementation: implementationEvidence, selfReview: selfReviewEvidence },
      trustedRoot,
      options.now ?? new Date(),
    );
    target.commit = head;
    target.tree = tree;
    target.implementationEvidence = implementationEvidence;
    target.selfReviewEvidence = selfReviewEvidence;
    await writeState(state, trustedRoot);
    return {
      taskId,
      contractPath: lifecycle.contractPath,
      contractSha256: lifecycle.contractSha256,
      contractMode: lifecycle.contractMode,
      previousImplementation,
      previousReview,
      implementationEvidence,
      selfReviewEvidence,
      launchReceiptId: correctionReceipt.receiptId,
      launchReceiptSha256: correctionReceipt.sha256,
      failureCode,
      changedFiles: changedFiles.length,
      changedLines,
      commit: head,
      tree,
      state: 'SELF_REVIEWING',
      leaseId: target.leaseId,
      fencingVersion: target.leaseVersion,
    };
  } finally {
    await releaseLock();
  }
};
