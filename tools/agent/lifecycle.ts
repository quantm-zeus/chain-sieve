import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { TaskContractSchema } from '@ciag/shared-schemas';
import { persistLifecycleAuthority, validateRecoveryWorkspace } from '../task-runner/authority.js';
import {
  acquireLifecycleMutationLock, readState, recoverExpiredLease, renewValidLease, runtimeRoot, writeState,
  type EvidenceReference, type TaskLifecycleState,
} from '../task-runner/state.js';
import { loadTasks } from '../task-verifier/verify.js';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const required = (name: string): string => option(name) ?? (() => { throw new Error(`OPTION_REQUIRED:${name}`); })();
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
  try { content = await readFile(path, 'utf8'); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
    const target = state.tasks[taskId];
    if (!target) throw new Error('TASK_NOT_FOUND');
    const request = { schemaVersion: '1.0.0', action: 'RENEW_VALID_LEASE', taskId, expectedLeaseId, expectedFencingVersion, holder };
    const requestSha256 = sha256(JSON.stringify(request));
    const requestedAt = new Date();
    const receiptRecord = await receiptEvidence(root, taskId, 'renewals', requestSha256, { ...request, requestSha256, operationAt: requestedAt.toISOString(), previousLeaseId: expectedLeaseId, previousFencingVersion: expectedFencingVersion, newLeaseId: `${taskId}:${expectedFencingVersion + 1}:${requestedAt.getTime()}`, newFencingVersion: expectedFencingVersion + 1 });
    const operationAt = new Date(String(receiptRecord.document.operationAt));
    const lease = renewValidLease(state, { taskId, expectedLeaseId, expectedFencingVersion, holder, requestSha256, receipt: receiptRecord.evidence }, operationAt);
    await writeState(state, root);
    console.log(JSON.stringify({ action: 'RENEW_VALID_LEASE', idempotentRequest: requestSha256, lease, receipt: receiptRecord.evidence }, null, 2));
  } else if (command === 'recover') {
    const taskId = commandArguments[0] ?? '';
    const expectedExpiredLeaseId = required('--expected-expired-lease-id');
    const expectedFencingVersion = Number(required('--expected-fencing-version'));
    const expectedHolder = required('--holder');
    const expectedTaskState = required('--expected-task-state') as TaskLifecycleState;
    const expectedTaskBranch = required('--expected-task-branch');
    const expectedTaskWorktree = required('--expected-task-worktree');
    const expectedBaseCommit = required('--expected-base-commit');
    const expectedTracked = required('--expected-tracked-work-sha256');
    const expectedUntracked = required('--expected-untracked-work-sha256');
    const expectedContract = required('--expected-legacy-contract-sha256');
    const expectedContext = required('--expected-legacy-context-sha256');
    const target = state.tasks[taskId];
    if (!target) throw new Error('TASK_NOT_FOUND');
    const generated = tasks.find((item) => item.id === taskId);
    if (!generated) throw new Error('TASK_NOT_FOUND');
    const legacyContractPath = contractPath(generated.dependencyGroup, taskId);
    const { contractText: legacyContractText } = await validateRecoveryWorkspace({
      taskWorktree: expectedTaskWorktree,
      expectedBranch: expectedTaskBranch,
      expectedBaseCommit,
      expectedTrackedWorkSha256: expectedTracked,
      expectedUntrackedWorkSha256: expectedUntracked,
      contractPath: legacyContractPath,
      expectedContractSha256: expectedContract,
      contextManifestPath: contextPath(taskId),
      expectedContextManifestSha256: expectedContext,
    });
    const legacyTask = TaskContractSchema.parse(JSON.parse(legacyContractText));
    const request = { schemaVersion: '1.0.0', action: 'RECOVER_EXPIRED_LEASE', taskId, expectedExpiredLeaseId, expectedFencingVersion, expectedHolder, expectedTaskState, expectedTaskBranch, expectedTaskWorktree, expectedBaseCommit, expectedTracked, expectedUntracked, expectedContract, expectedContext };
    const requestSha256 = sha256(JSON.stringify(request));
    const authority = target.lifecycleBinding && target.verificationBaseline ? { binding: target.lifecycleBinding, baseline: target.verificationBaseline } : await persistLifecycleAuthority({
      trustedRoot: root,
      taskRoot: expectedTaskWorktree,
      task: legacyTask,
      state: target,
      contractPath: legacyContractPath,
      contextManifestPath: contextPath(taskId),
      contractMode: 'LEGACY',
      ...(generated.conformanceManifestPath
        ? { compatibilityConformanceManifestPath: generated.conformanceManifestPath }
        : {}),
      ...(generated.conformanceManifestSha256
        ? { compatibilityConformanceManifestSha256: generated.conformanceManifestSha256 }
        : {}),
    });
    const requestedAt = new Date();
    const receiptRecord = await receiptEvidence(root, taskId, 'recoveries', requestSha256, { ...request, requestSha256, operationAt: requestedAt.toISOString(), oldCredentialState: 'PERMANENTLY_EXPIRED', newLeaseId: `${taskId}:${expectedFencingVersion + 1}:recovery:${requestSha256.slice(0, 16)}`, newFencingVersion: expectedFencingVersion + 1, lifecycleBindingSha256: authority.binding.sha256, verificationBaselineSha256: authority.baseline.sha256 });
    const operationAt = new Date(String(receiptRecord.document.operationAt));
    target.lifecycleBinding = authority.binding;
    target.verificationBaseline = authority.baseline;
    const taskContracts = tasks.map((item) => item.id === taskId ? legacyTask : item);
    const lease = recoverExpiredLease(state, taskContracts, { taskId, expectedExpiredLeaseId, expectedFencingVersion, expectedHolder, expectedTaskState, expectedTaskBranch, expectedTaskWorktree, expectedBaseCommit, requestSha256, receipt: receiptRecord.evidence }, operationAt);
    await writeState(state, root);
    console.log(JSON.stringify({ action: 'RECOVER_EXPIRED_LEASE', idempotentRequest: requestSha256, lease, receipt: receiptRecord.evidence, authority }, null, 2));
  } else throw new Error(`UNKNOWN_LIFECYCLE_COMMAND:${command ?? ''}`);
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await releaseMutationLock?.();
}
