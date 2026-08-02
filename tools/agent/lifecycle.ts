import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { TaskContractSchema } from '@ciag/shared-schemas';
import { persistLifecycleAuthority, readLifecycleBinding, validateRecoveryWorkspace } from '../task-runner/authority.js';
import {
  AGENT_LEASE_TTL_MINUTES, acquireLifecycleMutationLock, assertAgentLeaseTtlMinutes, readState,
  recoverExpiredLease, renewValidLease, runtimeRoot, writeState,
  type EvidenceReference, type TaskLifecycleState,
} from '../task-runner/state.js';
import { loadTasks } from '../task-verifier/verify.js';
import { isTrustedPathFilesystemError, readTrustedFile } from './lib/trusted-path.js';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const required = (name: string): string => option(name) ?? (() => { throw new Error(`OPTION_REQUIRED:${name}`); })();
const ttlMinutesOption = (): number => {
  const raw = option('--ttl-minutes');
  if (raw === undefined) {
    if (process.argv.includes('--ttl-minutes')) throw new Error('LEASE_TTL_MINUTES_INTEGER_REQUIRED');
    return AGENT_LEASE_TTL_MINUTES.default;
  }
  if (!/^[0-9]+$/.test(raw)) throw new Error('LEASE_TTL_MINUTES_INTEGER_REQUIRED');
  return assertAgentLeaseTtlMinutes(Number(raw));
};
const recoveryCommitExpectations = (): {
  expectedLifecycleBaseCommit: string;
  expectedTaskHeadCommit: string;
  expectedTaskHeadTree: string;
  compatibilityMode: 'EXPLICIT' | 'LEGACY_EQUAL_BASE_AND_HEAD';
} => {
  const legacy = option('--expected-base-commit');
  const lifecycle = option('--expected-lifecycle-base-commit');
  const head = option('--expected-task-head-commit');
  const tree = option('--expected-task-head-tree');
  if (legacy) {
    if (lifecycle || head) throw new Error('RECOVERY_COMMIT_OPTIONS_CONFLICT');
    if (!tree) throw new Error('OPTION_REQUIRED:--expected-task-head-tree');
    return {
      expectedLifecycleBaseCommit: legacy,
      expectedTaskHeadCommit: legacy,
      expectedTaskHeadTree: tree,
      compatibilityMode: 'LEGACY_EQUAL_BASE_AND_HEAD',
    };
  }
  if (!lifecycle) throw new Error('OPTION_REQUIRED:--expected-lifecycle-base-commit');
  if (!head) throw new Error('OPTION_REQUIRED:--expected-task-head-commit');
  if (!tree) throw new Error('OPTION_REQUIRED:--expected-task-head-tree');
  return {
    expectedLifecycleBaseCommit: lifecycle,
    expectedTaskHeadCommit: head,
    expectedTaskHeadTree: tree,
    compatibilityMode: 'EXPLICIT',
  };
};
const rawArguments = process.argv.slice(2);
const argumentsAfterSeparator = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const writeImmutable = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== content) throw new Error(`IMMUTABLE_LIFECYCLE_RECEIPT_COLLISION:${path}`);
  }
};
const receiptEvidence = async (root: string, taskId: string, kind: 'renewals' | 'recoveries', requestSha256: string, value: Record<string, unknown>): Promise<{ evidence: EvidenceReference; document: Record<string, unknown> }> => {
  const path = join(runtimeRoot(root), kind, taskId, `${requestSha256}.json`);
  let content = `${JSON.stringify(value, null, 2)}\n`;
  try { content = (await readTrustedFile(runtimeRoot(root), path, 'RECOVERY_RECEIPT')).toString('utf8'); }
  catch (error: unknown) { if (!isTrustedPathFilesystemError(error, 'ENOENT')) throw error; }
  await writeImmutable(path, content);
  return { evidence: { path: relative(runtimeRoot(root), path), sha256: sha256(content), status: 'CURRENT' }, document: JSON.parse(content) as Record<string, unknown> };
};
const contextPath = (taskId: string): string => `artifacts/context/${taskId}/context-manifest.json`;
const contractPath = (group: string, taskId: string): string => `tasks/${group}/${taskId}.contract.json`;

const command = argumentsAfterSeparator[0];
const commandArguments = argumentsAfterSeparator[1] === '--'
  ? argumentsAfterSeparator.slice(2)
  : argumentsAfterSeparator.slice(1);
let releaseMutationLock: (() => Promise<void>) | undefined;
try {
  const root = process.cwd();
  if (command === 'renew' || command === 'recover')
    releaseMutationLock = await acquireLifecycleMutationLock(root);
  const tasks = await loadTasks();
  const state = await readState(tasks, root);
  if (command === 'migration-check') {
    const productTaskIds = new Set(tasks.map((task) => task.id));
    const active = Object.values(state.tasks).filter((item) => productTaskIds.has(item.taskId) && ['LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED'].includes(item.state));
    console.log(JSON.stringify({ schemaVersion: '1.0.0', status: 'PASS', active: active.map((item) => ({ taskId: item.taskId, lifecycleBinding: item.lifecycleBinding ? 'BOUND' : 'MIGRATION_REQUIRED', verificationBaseline: item.verificationBaseline ? 'BOUND' : 'MIGRATION_REQUIRED' })) }, null, 2));
  } else if (command === 'migrate') {
    const productTaskIds = new Set(tasks.map((task) => task.id));
    const active = Object.values(state.tasks).filter((item) => productTaskIds.has(item.taskId) && ['LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED'].includes(item.state));
    console.log(JSON.stringify({ schemaVersion: '1.0.0', dryRun: process.argv.includes('--dry-run'), mutations: active.filter((item) => !item.lifecycleBinding || !item.verificationBaseline).map((item) => ({ taskId: item.taskId, change: 'ADD_IMMUTABLE_LIFECYCLE_BINDING_AND_TRUSTED_BASELINE', credentialsChanged: false, productWorkChanged: false })) }, null, 2));
    if (!process.argv.includes('--dry-run')) throw new Error('MIGRATION_REQUIRES_AUTHORITATIVE_RECOVERY_OR_ACQUISITION');
  } else if (command === 'renew') {
    const taskId = commandArguments[0] ?? '';
    const holder = required('--holder');
    const expectedLeaseId = required('--expected-lease-id');
    const expectedFencingVersion = Number(required('--expected-fencing-version'));
    const ttlMinutes = ttlMinutesOption();
    const target = state.tasks[taskId];
    if (!target) throw new Error('TASK_NOT_FOUND');
    const request = { schemaVersion: '1.1.0', action: 'RENEW_VALID_LEASE', taskId, expectedLeaseId, expectedFencingVersion, holder, ttlMinutes };
    const requestSha256 = sha256(JSON.stringify(request));
    const requestedAt = new Date();
    const receiptRecord = await receiptEvidence(root, taskId, 'renewals', requestSha256, { ...request, requestSha256, operationAt: requestedAt.toISOString(), ttlMilliseconds: ttlMinutes * 60_000, expiresAt: new Date(requestedAt.getTime() + ttlMinutes * 60_000).toISOString(), previousLeaseId: expectedLeaseId, previousFencingVersion: expectedFencingVersion, newLeaseId: `${taskId}:${expectedFencingVersion + 1}:${requestedAt.getTime()}`, newFencingVersion: expectedFencingVersion + 1 });
    const operationAt = new Date(String(receiptRecord.document.operationAt));
    const lease = renewValidLease(state, { taskId, expectedLeaseId, expectedFencingVersion, holder, ttlMinutes, requestSha256, receipt: receiptRecord.evidence }, operationAt);
    await writeState(state, root);
    console.log(JSON.stringify({ action: 'RENEW_VALID_LEASE', idempotentRequest: requestSha256, ttlMinutes, expiresAt: lease.expiresAt, lease, receipt: receiptRecord.evidence }, null, 2));
  } else if (command === 'recover') {
    const taskId = commandArguments[0] ?? '';
    const expectedExpiredLeaseId = required('--expected-expired-lease-id');
    const expectedFencingVersion = Number(required('--expected-fencing-version'));
    const expectedHolder = required('--holder');
    const expectedTaskState = required('--expected-task-state') as TaskLifecycleState;
    const expectedTaskBranch = required('--expected-task-branch');
    const expectedTaskWorktree = required('--expected-task-worktree');
    const { expectedLifecycleBaseCommit, expectedTaskHeadCommit, expectedTaskHeadTree, compatibilityMode } = recoveryCommitExpectations();
    const ttlMinutes = ttlMinutesOption();
    const expectedTracked = required('--expected-tracked-work-sha256');
    const expectedUntracked = required('--expected-untracked-work-sha256');
    const expectedContract = required('--expected-legacy-contract-sha256');
    const expectedContext = required('--expected-legacy-context-sha256');
    const target = state.tasks[taskId];
    if (!target) throw new Error('TASK_NOT_FOUND');
    const generated = tasks.find((item) => item.id === taskId);
    if (!generated) throw new Error('TASK_NOT_FOUND');
    const legacyContractPath = contractPath(generated.dependencyGroup, taskId);
    const workspaceExpectation = {
      taskWorktree: expectedTaskWorktree,
      expectedBranch: expectedTaskBranch,
      expectedTaskHeadCommit,
      expectedTaskHeadTree,
      expectedTrackedWorkSha256: expectedTracked,
      expectedUntrackedWorkSha256: expectedUntracked,
      contractPath: legacyContractPath,
      expectedContractSha256: expectedContract,
      contextManifestPath: contextPath(taskId),
      expectedContextManifestSha256: expectedContext,
    };
    const { contractText: legacyContractText } = await validateRecoveryWorkspace(workspaceExpectation);
    const legacyTask = TaskContractSchema.parse(JSON.parse(legacyContractText));
    const request = { schemaVersion: '1.1.0', action: 'RECOVER_EXPIRED_LEASE', taskId, expectedExpiredLeaseId, expectedFencingVersion, expectedHolder, expectedTaskState, expectedTaskBranch, expectedTaskWorktree, expectedLifecycleBaseCommit, expectedTaskHeadCommit, expectedTaskHeadTree, expectedTracked, expectedUntracked, expectedContract, expectedContext, ttlMinutes, compatibilityMode };
    const requestSha256 = sha256(JSON.stringify(request));
    if (
      target.recovery &&
      target.recovery.requestSha256 !== requestSha256 &&
      target.recovery.previousLeaseId === expectedExpiredLeaseId &&
      target.recovery.previousFencingVersion === expectedFencingVersion
    )
      throw new Error('RECOVERY_REQUEST_CONFLICT');
    const previousVerificationBaseline = target.verificationBaseline
      ? structuredClone(target.verificationBaseline)
      : undefined;
    const existingLifecycle = await readLifecycleBinding(root, target);
    const contractMode = existingLifecycle?.contractMode ?? 'LEGACY';
    const authority = await persistLifecycleAuthority({
      trustedRoot: root,
      taskRoot: expectedTaskWorktree,
      task: legacyTask,
      state: target,
      contractPath: legacyContractPath,
      contextManifestPath: contextPath(taskId),
      contractMode,
      ...(contractMode === 'LEGACY' && generated.conformanceManifestPath
        ? { compatibilityConformanceManifestPath: generated.conformanceManifestPath }
        : {}),
      ...(contractMode === 'LEGACY' && generated.conformanceManifestSha256
        ? { compatibilityConformanceManifestSha256: generated.conformanceManifestSha256 }
        : {}),
    });
    if (target.lifecycleBinding && target.lifecycleBinding.sha256 !== authority.binding.sha256)
      throw new Error('RECOVERY_LIFECYCLE_AUTHORITY_MISMATCH');
    await validateRecoveryWorkspace(workspaceExpectation);
    const requestedAt = new Date();
    const receiptRecord = await receiptEvidence(root, taskId, 'recoveries', requestSha256, { ...request, requestSha256, operationAt: requestedAt.toISOString(), ttlMilliseconds: ttlMinutes * 60_000, expiresAt: new Date(requestedAt.getTime() + ttlMinutes * 60_000).toISOString(), oldCredentialState: 'PERMANENTLY_EXPIRED', newLeaseId: `${taskId}:${expectedFencingVersion + 1}:recovery:${requestSha256.slice(0, 16)}`, newFencingVersion: expectedFencingVersion + 1, lifecycleBindingSha256: authority.binding.sha256, previousVerificationBaselineSha256: previousVerificationBaseline?.sha256, verificationBaselineSha256: authority.baseline.sha256 });
    const operationAt = new Date(String(receiptRecord.document.operationAt));
    const taskContracts = tasks.map((item) => item.id === taskId ? legacyTask : item);
    const lease = recoverExpiredLease(state, taskContracts, { taskId, expectedExpiredLeaseId, expectedFencingVersion, expectedHolder, expectedTaskState, expectedTaskBranch, expectedTaskWorktree, expectedLifecycleBaseCommit, expectedTaskHeadCommit, expectedTaskHeadTree, ttlMinutes, requestSha256, receipt: receiptRecord.evidence, ...(previousVerificationBaseline ? { previousVerificationBaseline } : {}), resultingVerificationBaseline: authority.baseline }, operationAt);
    target.lifecycleBinding = authority.binding;
    await writeState(state, root);
    console.log(JSON.stringify({ action: 'RECOVER_EXPIRED_LEASE', idempotentRequest: requestSha256, compatibilityMode, ttlMinutes, expiresAt: lease.expiresAt, lease, receipt: receiptRecord.evidence, authority }, null, 2));
  } else throw new Error(`UNKNOWN_LIFECYCLE_COMMAND:${command ?? ''}`);
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await releaseMutationLock?.();
}
