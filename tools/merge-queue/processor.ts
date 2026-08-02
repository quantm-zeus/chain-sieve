import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';
import { verifyPostMergeIntegration, type IntegrationRunner } from '../cluster-verifier/integration.js';
import { invalidateRebaseEvidence, registerCurrentEvidence } from '../task-runner/evidence-ledger.js';
import { performTaskSelfReview } from '../task-runner/self-review.js';
import {
  assertLeaseCredential,
  currentLeaseCredential,
  markIntegrationFailure,
  readState,
  refreshReady,
  resetAfterRebase,
  runtimeRoot,
  transition,
  writeState,
  type LeaseContract,
  type LifecycleDocument,
} from '../task-runner/state.js';
import { readTaskResult } from '../task-verifier/verify.js';
import { validateTaskAttestation } from '../task-verifier/attestation.js';
import { taskBranch } from '../worktree-manager/identity.js';
import {
  persistLifecycleAuthority,
  readLifecycleBinding,
  readVerificationBaseline,
} from '../task-runner/authority.js';
import { persistGoalAndPayload } from '../agent/lib/runtime.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { TaskRecord } from '../agent/lib/types.js';

export interface QueueItem {
  taskId: string;
  holder: string;
  leaseId: string;
  fencingVersion: number;
  enqueuedCommit: string;
  enqueuedTree: string;
  status: 'QUEUED' | 'PROCESSING' | 'MERGED' | 'REVERTED';
}

export interface MergeQueue {
  schemaVersion: '2.0.0';
  items: QueueItem[];
}

export interface ProcessResult {
  taskId: string;
  status: 'MERGED' | 'REVERTED_AFTER_INTEGRATION_FAILURE';
  commit: string;
  tree: string;
  clusterHeadBefore: string;
  rebaseApplied: boolean;
  staleEvidence: string[];
  postRebaseSelfReview?: string;
  postRebaseVerification?: string;
  mergeCommit: string;
  revertCommit?: string;
  integration: ReturnType<IntegrationRunner>;
  queueOperations: string[];
}

const queuePath = (cwd: string): string => join(runtimeRoot(cwd), 'merge-queue.json');

export const readQueue = async (cwd = process.cwd()): Promise<MergeQueue> => {
  try {
    const raw = JSON.parse(await readFile(queuePath(cwd), 'utf8')) as
      | MergeQueue
      | { schemaVersion: '1.0.0'; taskIds: string[] };
    if (raw.schemaVersion === '2.0.0' && Array.isArray(raw.items)) return raw;
    if (raw.schemaVersion === '1.0.0' && Array.isArray(raw.taskIds) && raw.taskIds.length === 0)
      return { schemaVersion: '2.0.0', items: [] };
    throw new Error('LEGACY_NONEMPTY_MERGE_QUEUE_REQUIRES_MIGRATION');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: '2.0.0', items: [] };
  }
};

export const writeQueue = async (queue: MergeQueue, cwd = process.cwd()): Promise<void> => {
  const path = queuePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
};

const git = (args: string[], cwd: string, allowFailure = false): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure)
    throw new Error(`MERGE_QUEUE_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};

const taskWorktree = (taskId: string, cwd: string): string => {
  const blocks = git(['worktree', 'list', '--porcelain'], cwd).split('\n\n');
  const block = blocks.find((value) => value.includes(`branch refs/heads/${taskBranch(taskId)}`));
  const path = block?.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
  if (!path) throw new Error('TASK_WORKTREE_NOT_FOUND');
  return path;
};

const persistPostRebaseReceipt = async (
  task: TaskContract,
  target: LifecycleDocument['tasks'][string],
  worktree: string,
  trustedRoot: string,
): Promise<string> => {
  if (
    !target.leaseId ||
    !target.holder ||
    !target.expiresAt ||
    !target.baseCommit ||
    !target.lifecycleBinding ||
    !target.verificationBaseline
  )
    throw new Error('POST_REBASE_RECEIPT_BINDING_MISSING');
  const lifecycle = await readLifecycleBinding(trustedRoot, target);
  const baseline = await readVerificationBaseline(trustedRoot, target);
  if (!lifecycle || !baseline) throw new Error('POST_REBASE_AUTHORITY_MISSING');
  const clusterBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  const clusterWorktree = git(['rev-parse', '--show-toplevel'], trustedRoot);
  const record = {
    contract: task,
    contractPath: lifecycle.contractPath,
    contextPath: lifecycle.contextManifestPath.replace(/\/context-manifest\.json$/, ''),
    contextManifestPath: lifecycle.contextManifestPath,
    contextManifestSha256: lifecycle.contextManifestSha256,
    ...(lifecycle.conformanceManifestPath
      ? { conformanceManifestPath: lifecycle.conformanceManifestPath }
      : {}),
    ...(lifecycle.conformanceManifestSha256
      ? { conformanceManifestSha256: lifecycle.conformanceManifestSha256 }
      : {}),
    cluster: {
      contract: { id: task.cluster },
      branch: { branch: clusterBranch, integrationTarget: 'main', worktree: clusterWorktree },
    },
    state: target,
    workspace: worktree,
    workspaceBranch: target.branch,
  } as unknown as TaskRecord;
  const runner = new SystemCommandRunner();
  const stored = await persistGoalAndPayload(
    trustedRoot,
    runner,
    {
      task: record,
      release: {
        ...baseline.releaseBaseline,
        tagObject: git(['rev-parse', `refs/tags/${baseline.releaseBaseline.tag}`], trustedRoot),
      },
      taskWorkspace: worktree,
      leaseId: target.leaseId,
      holder: target.holder,
      fencingVersion: target.leaseVersion,
      expiresAt: target.expiresAt,
      baseCommit: target.baseCommit,
      baseTree: git(['rev-parse', `${target.baseCommit}^{tree}`], worktree),
      contextManifestPath: lifecycle.contextManifestPath,
      contextManifestSha256: lifecycle.contextManifestSha256,
      ...(lifecycle.conformanceManifestPath
        ? { conformanceManifestPath: lifecycle.conformanceManifestPath }
        : {}),
      ...(lifecycle.conformanceManifestSha256
        ? { conformanceManifestSha256: lifecycle.conformanceManifestSha256 }
        : {}),
      taskContractPath: lifecycle.contractPath,
      taskContractSha256: lifecycle.contractSha256,
      lifecycleBindingPath: target.lifecycleBinding.path,
      lifecycleBindingSha256: target.lifecycleBinding.sha256,
      verificationBaselinePath: target.verificationBaseline.path,
      verificationBaselineSha256: target.verificationBaseline.sha256,
      controlPlaneCommit: baseline.controlPlaneCommit,
      controlPlaneTree: baseline.controlPlaneTree,
      failures: ['Post-rebase evidence was invalidated; perform a fresh semantic self-review.'],
    },
    'antigravity',
  );
  if (!stored.binding.launchReceiptId) throw new Error('POST_REBASE_RECEIPT_ID_MISSING');
  return stored.binding.launchReceiptId;
};

const assertPathLocks = (
  task: TaskContract,
  tasks: TaskContract[],
  state: LifecycleDocument,
  now: Date,
): void => {
  const active = new Set(['LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED']);
  for (const other of Object.values(state.tasks)) {
    if (other.taskId === task.id || !active.has(other.state) || !other.expiresAt) continue;
    if (Date.parse(other.expiresAt) <= now.getTime()) continue;
    const otherContract = tasks.find((candidate) => candidate.id === other.taskId);
    if (otherContract?.exclusiveLocks.some((lock) => task.exclusiveLocks.includes(lock)))
      throw new Error(`PATH_LOCK_CONFLICT:${other.taskId}`);
  }
};

export const enqueueTask = async (
  task: TaskContract,
  tasks: TaskContract[],
  state: LifecycleDocument,
  queue: MergeQueue,
  cwd = process.cwd(),
  now = new Date(),
): Promise<QueueItem> => {
  const target = state.tasks[task.id];
  if (!target || target.state !== 'VERIFIED' || !target.commit || !target.tree)
    throw new Error('TASK_NOT_VERIFIED');
  const credential = currentLeaseCredential(target);
  assertLeaseCredential(state, credential, now);
  assertPathLocks(task, tasks, state, now);
  const worktree = taskWorktree(task.id, cwd);
  if (git(['rev-parse', 'HEAD'], worktree) !== target.commit) throw new Error('TASK_WORKTREE_HEAD_MISMATCH');
  if (git(['status', '--porcelain'], worktree) !== '') throw new Error('DIRTY_TRACKED_SOURCE');
  const result = await readTaskResult(task.id, cwd);
  await validateTaskAttestation(task, result, { cwd, state: target });
  if (
    result.bindings.headCommitSha !== target.commit ||
    result.bindings.headTreeSha !== target.tree ||
    result.status !== 'PASS'
  )
    throw new Error('TASK_RESULT_MISMATCH');
  transition(target, ['VERIFIED'], 'MERGE_QUEUED', {
    command: 'merge-queue:add',
    credential,
    currentCommit: target.commit,
    currentTree: target.tree,
  });
  const item: QueueItem = {
    taskId: task.id,
    holder: credential.holder,
    leaseId: credential.leaseId,
    fencingVersion: credential.fencingVersion,
    enqueuedCommit: target.commit,
    enqueuedTree: target.tree,
    status: 'QUEUED',
  };
  if (queue.items.some((candidate) => candidate.taskId === task.id && candidate.status === 'QUEUED'))
    throw new Error('TASK_ALREADY_QUEUED');
  queue.items.push(item);
  await writeState(state, cwd);
  await writeQueue(queue, cwd);
  return item;
};

export interface ProcessorOptions {
  cwd?: string;
  now?: Date;
  integrationRunner?: IntegrationRunner;
}

export const processMergeQueue = async (
  tasks: TaskContract[],
  options: ProcessorOptions = {},
): Promise<ProcessResult> => {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const queue = await readQueue(cwd);
  const item = queue.items.find((candidate) => candidate.status === 'QUEUED' || candidate.status === 'PROCESSING');
  if (!item) throw new Error('MERGE_QUEUE_EMPTY');
  const task = tasks.find((candidate) => candidate.id === item.taskId);
  if (!task) throw new Error('TASK_NOT_FOUND');
  const clusterBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  const currentBranch = git(['branch', '--show-current'], cwd);
  if (currentBranch === 'main') throw new Error('DIRECT_MAIN_MERGE_PROHIBITED');
  if (currentBranch !== clusterBranch) throw new Error(`CLUSTER_BRANCH_REQUIRED:${clusterBranch}`);
  if (git(['status', '--porcelain'], cwd) !== '') throw new Error('CLUSTER_WORKTREE_NOT_CLEAN');
  let state = await readState(tasks, cwd);
  let target = state.tasks[item.taskId];
  if (!target || target.state !== 'MERGE_QUEUED') throw new Error('TASK_NOT_MERGE_QUEUED');
  const credential = { taskId: item.taskId, holder: item.holder, leaseId: item.leaseId, fencingVersion: item.fencingVersion };
  assertLeaseCredential(state, credential, now);
  assertPathLocks(task, tasks, state, now);
  item.status = 'PROCESSING';
  await writeQueue(queue, cwd);
  const worktree = taskWorktree(task.id, cwd);
  const clusterHeadBefore = git(['rev-parse', clusterBranch], cwd);
  const preResult = await readTaskResult(task.id, cwd);
  await validateTaskAttestation(task, preResult, { cwd, state: target });
  const previousHead = git(['rev-parse', 'HEAD'], worktree);
  const rebaseApplied = preResult.bindings.baseCommitSha !== clusterHeadBefore;
  const staleEvidence: string[] = [];
  let postRebaseSelfReview: string | undefined;
  let postRebaseVerification: string | undefined;
  const queueOperations = ['read-queue-item', 'validated-lease-and-fence', 'validated-path-locks', 'fetched-cluster-head'];
  if (rebaseApplied) {
    const previousLifecycle = await readLifecycleBinding(cwd, target);
    if (!previousLifecycle) throw new Error('PRE_REBASE_LIFECYCLE_BINDING_MISSING');
    git(['rebase', clusterBranch], worktree);
    queueOperations.push('rebased-task-branch');
    const commit = git(['rev-parse', 'HEAD'], worktree);
    const tree = git(['rev-parse', 'HEAD^{tree}'], worktree);
    const invalidation = await invalidateRebaseEvidence(target, cwd, now);
    staleEvidence.push(...invalidation.records.map((record) => `${record.kind}:${record.sha256}`));
    if (invalidation.records.length !== 3) throw new Error('PRE_REBASE_EVIDENCE_INVALIDATION_INCOMPLETE');
    queueOperations.push('invalidated-pre-rebase-evidence');
    resetAfterRebase(target, credential, clusterHeadBefore, commit, tree, now);
    const authority = await persistLifecycleAuthority({
      trustedRoot: cwd,
      taskRoot: worktree,
      task,
      state: target,
      contractPath: previousLifecycle.contractPath,
      contextManifestPath: previousLifecycle.contextManifestPath,
      contractMode: previousLifecycle.contractMode,
      ...(previousLifecycle.contractMode === 'LEGACY' && previousLifecycle.conformanceManifestPath
        ? { compatibilityConformanceManifestPath: previousLifecycle.conformanceManifestPath }
        : {}),
      ...(previousLifecycle.contractMode === 'LEGACY' && previousLifecycle.conformanceManifestSha256
        ? { compatibilityConformanceManifestSha256: previousLifecycle.conformanceManifestSha256 }
        : {}),
    });
    target.lifecycleBinding = authority.binding;
    target.verificationBaseline = authority.baseline;
    await writeState(state, cwd);
    const launchReceiptId = await persistPostRebaseReceipt(task, target, worktree, cwd);
    const review = await performTaskSelfReview(task, target, item.holder, worktree, {
      previousHeadCommit: previousHead,
      now,
      launchReceiptId,
    });
    target.selfReviewEvidence = review.evidence;
    await registerCurrentEvidence(task.id, 'SELF_REVIEW', review.evidence, cwd);
    await writeState(state, cwd);
    postRebaseSelfReview = review.sha256;
    queueOperations.push('generated-post-rebase-self-review');
    const verification = spawnSync(
      'pnpm',
      [
        'task:verify',
        task.id,
        '--holder',
        item.holder,
        '--lease-version',
        String(item.fencingVersion),
        '--target-worktree',
        worktree,
      ],
      { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env },
    );
    if (verification.status !== 0)
      throw new Error(`POST_REBASE_TASK_VERIFICATION_FAILED:${verification.stderr || verification.stdout}`);
    state = await readState(tasks, cwd);
    target = state.tasks[item.taskId];
    if (!target || target.state !== 'VERIFIED' || !target.commit || !target.tree)
      throw new Error('POST_REBASE_TASK_NOT_VERIFIED');
    const freshResult = await readTaskResult(task.id, cwd);
    await validateTaskAttestation(task, freshResult, { cwd, state: target });
    postRebaseVerification = target.verificationEvidence?.sha256;
    transition(target, ['VERIFIED'], 'MERGE_QUEUED', {
      command: 'merge-queue:post-rebase-enqueue',
      credential,
      currentCommit: target.commit,
      currentTree: target.tree,
    });
    await writeState(state, cwd);
    queueOperations.push('ran-real-task-verifier', 'requeued-fresh-verified-result');
  }
  state = await readState(tasks, cwd);
  target = state.tasks[item.taskId];
  if (!target || target.state !== 'MERGE_QUEUED' || !target.commit || !target.tree)
    throw new Error('TASK_NOT_FRESHLY_MERGE_QUEUED');
  assertLeaseCredential(state, credential, now);
  const result = await readTaskResult(task.id, cwd);
  await validateTaskAttestation(task, result, { cwd, state: target });
  const commit = git(['rev-parse', 'HEAD'], worktree);
  const tree = git(['rev-parse', 'HEAD^{tree}'], worktree);
  if (commit !== target.commit || tree !== target.tree) throw new Error('POST_REBASE_RESULT_MISMATCH');
  if (git(['rev-parse', taskBranch(task.id)], cwd) !== commit)
    throw new Error('TASK_COMMIT_NOT_REACHABLE_FROM_REBASED_BRANCH');
  if (Number(git(['rev-list', '--count', `${clusterBranch}..${commit}`], cwd)) !== 1)
    throw new Error('TASK_COMMIT_NOT_ATOMIC');
  const preMergeTree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  git(['merge', '--ff-only', commit], cwd);
  const mergeCommit = git(['rev-parse', 'HEAD'], cwd);
  queueOperations.push('merged-task-commit');
  const integration = (options.integrationRunner ?? verifyPostMergeIntegration)(cwd);
  queueOperations.push('ran-post-merge-cluster-verifier');
  if (integration.status === 'FAIL') {
    git(['revert', '--no-edit', commit], cwd);
    const revertCommit = git(['rev-parse', 'HEAD'], cwd);
    const restoredTree = git(['rev-parse', 'HEAD^{tree}'], cwd);
    if (restoredTree !== preMergeTree) throw new Error('AUTOMATIC_REVERT_DID_NOT_RESTORE_TREE');
    const audit = {
      schemaVersion: '1.0.0',
      taskId: task.id,
      taskCommit: commit,
      mergeCommit,
      revertCommit,
      preMergeTree,
      restoredTree,
      integration,
      recordedAt: now.toISOString(),
    };
    const auditText = `${JSON.stringify(audit, null, 2)}\n`;
    const auditPath = join(runtimeRoot(cwd), 'integration-failures', task.id, `${revertCommit}.json`);
    await mkdir(dirname(auditPath), { recursive: true });
    await writeFile(auditPath, auditText, { mode: 0o600 });
    markIntegrationFailure(target, credential, true, now);
    item.status = 'REVERTED';
    await writeState(state, cwd);
    await writeQueue(queue, cwd);
    queueOperations.push('created-automatic-revert', 'persisted-integration-failure-audit');
    return {
      taskId: task.id,
      status: 'REVERTED_AFTER_INTEGRATION_FAILURE',
      commit,
      tree,
      clusterHeadBefore,
      rebaseApplied,
      staleEvidence,
      ...(postRebaseSelfReview ? { postRebaseSelfReview } : {}),
      ...(postRebaseVerification ? { postRebaseVerification } : {}),
      mergeCommit,
      revertCommit,
      integration,
      queueOperations,
    };
  }
  transition(target, ['MERGE_QUEUED'], 'MERGED', {
    command: 'merge-queue:process',
    credential,
    mergeQueueProcessed: true,
  });
  target.commit = commit;
  target.tree = tree;
  target.leaseState = 'COMPLETED';
  item.status = 'MERGED';
  refreshReady(state, tasks as LeaseContract[]);
  await writeState(state, cwd);
  await writeQueue(queue, cwd);
  queueOperations.push('persisted-merged-state');
  return {
    taskId: task.id,
    status: 'MERGED',
    commit,
    tree,
    clusterHeadBefore,
    rebaseApplied,
    staleEvidence,
    ...(postRebaseSelfReview ? { postRebaseSelfReview } : {}),
    ...(postRebaseVerification ? { postRebaseVerification } : {}),
    mergeCommit,
    integration,
    queueOperations,
  };
};
