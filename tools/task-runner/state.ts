import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TaskLeaseSchema } from '@ciag/shared-schemas';

export type TaskLifecycleState =
  | 'DRAFT'
  | 'VALIDATED'
  | 'READY'
  | 'LEASED'
  | 'IMPLEMENTING'
  | 'SELF_REVIEWING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'MERGE_QUEUED'
  | 'MERGED'
  | 'BLOCKED'
  | 'INTEGRATION_FAILED'
  | 'REVERTED_AFTER_INTEGRATION_FAILURE';

export interface EvidenceReference {
  path: string;
  sha256: string;
  status: 'CURRENT' | 'STALE';
  commit?: string;
  tree?: string;
}

export interface LeaseCredential {
  taskId: string;
  holder: string;
  leaseId: string;
  fencingVersion: number;
}

export interface TransitionRecord {
  from: TaskLifecycleState | 'LEGACY_PLANNED';
  to: TaskLifecycleState;
  at: string;
  command: string;
  leaseVersion?: number;
  evidenceSha256?: string;
}

export interface TaskState {
  taskId: string;
  state: TaskLifecycleState;
  leaseVersion: number;
  holder?: string;
  leaseId?: string;
  acquiredAt?: string;
  renewedAt?: string;
  expiresAt?: string;
  leaseState?: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'COMPLETED';
  commit?: string;
  tree?: string;
  baseCommit?: string;
  branch?: string;
  worktree?: string;
  validationEvidence?: EvidenceReference;
  implementationEvidence?: EvidenceReference;
  selfReviewEvidence?: EvidenceReference;
  taskResultEvidence?: EvidenceReference;
  verificationEvidence?: EvidenceReference;
  lifecycleBinding?: EvidenceReference;
  verificationBaseline?: EvidenceReference;
  completedLifecycleBinding?: EvidenceReference;
  completedVerificationBaseline?: EvidenceReference;
  launchReceiptEvidence?: EvidenceReference;
  retiredLeases?: Array<{
    leaseId: string;
    fencingVersion: number;
    state: 'EXPIRED' | 'RENEWED';
    retiredAt: string;
  }>;
  renewal?: { requestSha256: string; receipt: EvidenceReference; resultingLeaseId: string; resultingFencingVersion: number };
  recovery?: { requestSha256: string; receipt: EvidenceReference; previousLeaseId: string; previousFencingVersion: number; resultingLeaseId: string; resultingFencingVersion: number };
  blockedReason?: 'SPECIFICATION_GAP';
  history?: TransitionRecord[];
}

export interface LifecycleDocument {
  schemaVersion: '2.0.0';
  tasks: Record<string, TaskState>;
  compatibilityMigrations?: Array<{
    taskId: string;
    from: 'PLANNED';
    to: 'DRAFT';
    policy: 'legacy-planned-requires-validation';
  }>;
}

export interface LeaseContract {
  id: string;
  dependencies: string[];
  exclusiveLocks: string[];
}

interface LegacyLifecycleDocument {
  schemaVersion: '1.0.0';
  tasks: Record<string, Omit<TaskState, 'state'> & { state: TaskLifecycleState | 'PLANNED' }>;
}

export interface TransitionContext {
  at?: Date;
  command: string;
  credential?: LeaseCredential;
  evidence?: EvidenceReference;
  worktreeValid?: boolean;
  currentCommit?: string;
  currentTree?: string;
  mergeQueueProcessed?: boolean;
}

const commonGitDirectory = (cwd = process.cwd()): string => {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('GIT_COMMON_DIR_UNAVAILABLE');
  const value = result.stdout.trim();
  return resolve(cwd, isAbsolute(value) ? value : join(cwd, value));
};

export const runtimeRoot = (cwd = process.cwd()): string => join(commonGitDirectory(cwd), 'ciag-runtime');
export const acquireLifecycleMutationLock = async (
  cwd = process.cwd(),
): Promise<() => Promise<void>> => {
  const path = join(runtimeRoot(cwd), 'lifecycle-mutation.lock');
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${Date.now()}`;
  try {
    await symlink(token, path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readlink(path).catch(() => '');
      const ownerPid = Number(existing.split(':')[0]);
      let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
      if (ownerAlive) {
        try {
          process.kill(ownerPid, 0);
        } catch (processError: unknown) {
          ownerAlive = (processError as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (!ownerAlive) {
        await unlink(path).catch(() => undefined);
        return acquireLifecycleMutationLock(cwd);
      }
      throw new Error('LIFECYCLE_MUTATION_IN_PROGRESS');
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if ((await readlink(path).catch(() => '')) !== token) return;
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  };
};
export const statePath = (cwd = process.cwd()): string => join(runtimeRoot(cwd), 'task-state.json');

const initialTask = (taskId: string): TaskState => ({
  taskId,
  state: 'DRAFT',
  leaseVersion: 0,
  history: [],
});

const migrateState = (raw: LegacyLifecycleDocument | LifecycleDocument): LifecycleDocument => {
  if (raw.schemaVersion === '2.0.0') return raw;
  const migrations: NonNullable<LifecycleDocument['compatibilityMigrations']> = [];
  const tasks = Object.fromEntries(
    Object.entries(raw.tasks).map(([taskId, task]) => {
      if (task.state !== 'PLANNED')
        return [
          taskId,
          { ...task, state: task.state as TaskLifecycleState, history: task.history ?? [] } satisfies TaskState,
        ];
      migrations.push({ taskId, from: 'PLANNED', to: 'DRAFT', policy: 'legacy-planned-requires-validation' });
      return [
        taskId,
        {
          ...task,
          state: 'DRAFT' as const,
          history: [
            ...(task.history ?? []),
            {
              from: 'LEGACY_PLANNED' as const,
              to: 'DRAFT' as const,
              at: new Date(0).toISOString(),
              command: 'state:migrate-v1-planned',
            },
          ],
        },
      ];
    }),
  );
  return { schemaVersion: '2.0.0', tasks, compatibilityMigrations: migrations };
};

export const readState = async (tasks: LeaseContract[], cwd = process.cwd()): Promise<LifecycleDocument> => {
  try {
    const raw = JSON.parse(await readFile(statePath(cwd), 'utf8')) as LegacyLifecycleDocument | LifecycleDocument;
    if (!['1.0.0', '2.0.0'].includes(raw.schemaVersion) || typeof raw.tasks !== 'object')
      throw new Error('TASK_STATE_INVALID');
    const value = migrateState(raw);
    for (const task of tasks) value.tasks[task.id] ??= initialTask(task.id);
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      schemaVersion: '2.0.0',
      tasks: Object.fromEntries(tasks.map((task) => [task.id, initialTask(task.id)])),
    };
  }
};

export const writeState = async (state: LifecycleDocument, cwd = process.cwd()): Promise<void> => {
  const target = statePath(cwd);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
};

const protectedStates = new Set<TaskLifecycleState>([
  'LEASED',
  'IMPLEMENTING',
  'SELF_REVIEWING',
  'VERIFYING',
  'VERIFIED',
  'MERGE_QUEUED',
]);

const assertCredentialForTarget = (target: TaskState, credential: LeaseCredential, now: Date): TaskState => {
  if (!protectedStates.has(target.state)) throw new Error('NO_ACTIVE_LEASE');
  if (target.leaseState && target.leaseState !== 'ACTIVE') throw new Error('NO_ACTIVE_LEASE');
  if (credential.taskId !== target.taskId) throw new Error('WRONG_LEASE_TASK');
  if (target.leaseVersion !== credential.fencingVersion) throw new Error('STALE_LEASE_VERSION');
  if (target.holder !== credential.holder) throw new Error('WRONG_LEASE_OWNER');
  if (target.leaseId !== credential.leaseId) throw new Error('LOST_LEASE');
  if (!target.expiresAt || Date.parse(target.expiresAt) <= now.getTime()) throw new Error('LEASE_EXPIRED');
  return target;
};

export const currentLeaseCredential = (target: TaskState): LeaseCredential => {
  if (!target.holder || !target.leaseId || target.leaseVersion < 1) throw new Error('LEASE_CREDENTIAL_MISSING');
  return {
    taskId: target.taskId,
    holder: target.holder,
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
  };
};

export const assertLeaseCredential = (
  state: LifecycleDocument,
  credential: LeaseCredential,
  now: Date,
): TaskState => {
  const target = state.tasks[credential.taskId];
  if (!target) throw new Error('WRONG_LEASE_TASK');
  return assertCredentialForTarget(target, credential, now);
};

export const assertLease = (
  state: LifecycleDocument,
  taskId: string,
  version: number,
  holder: string,
  now: Date,
  leaseId?: string,
): TaskState => {
  const target = state.tasks[taskId];
  if (!target) throw new Error('WRONG_LEASE_TASK');
  return assertCredentialForTarget(
    target,
    { taskId, holder, leaseId: leaseId ?? target.leaseId ?? '', fencingVersion: version },
    now,
  );
};

const record = (
  target: TaskState,
  from: TaskLifecycleState,
  to: TaskLifecycleState,
  context: TransitionContext,
): void => {
  target.history ??= [];
  target.history.push({
    from,
    to,
    at: (context.at ?? new Date()).toISOString(),
    command: context.command,
    ...(context.credential ? { leaseVersion: context.credential.fencingVersion } : {}),
    ...(context.evidence ? { evidenceSha256: context.evidence.sha256 } : {}),
  });
  target.state = to;
};

const requireCurrentEvidence = (evidence: EvidenceReference | undefined, code: string): EvidenceReference => {
  if (!evidence) throw new Error(`${code}_MISSING`);
  if (evidence.status !== 'CURRENT') throw new Error(`${code}_STALE`);
  return evidence;
};

export const transition = (
  target: TaskState,
  from: TaskLifecycleState[],
  to: TaskLifecycleState,
  context: TransitionContext,
): void => {
  if (!from.includes(target.state)) throw new Error(`INVALID_TASK_TRANSITION:${target.state}:${to}`);
  const actualFrom = target.state;
  const expected: Partial<Record<TaskLifecycleState, TaskLifecycleState>> = {
    DRAFT: 'VALIDATED',
    VALIDATED: 'READY',
    READY: 'LEASED',
    LEASED: 'IMPLEMENTING',
    IMPLEMENTING: 'SELF_REVIEWING',
    SELF_REVIEWING: 'VERIFYING',
    VERIFYING: 'VERIFIED',
    VERIFIED: 'MERGE_QUEUED',
    MERGE_QUEUED: 'MERGED',
  };
  if (expected[actualFrom] !== to) throw new Error(`SKIPPED_TASK_TRANSITION:${actualFrom}:${to}`);
  if (actualFrom === 'DRAFT') {
    if (!context.evidence || context.evidence.status !== 'CURRENT') throw new Error('VALIDATION_EVIDENCE_REQUIRED');
    target.validationEvidence = context.evidence;
  } else if (actualFrom === 'VALIDATED') {
    requireCurrentEvidence(target.validationEvidence, 'VALIDATION_EVIDENCE');
  } else if (actualFrom === 'READY') {
    if (!target.leaseId || !target.holder || !target.expiresAt) throw new Error('ACTIVE_FENCED_LEASE_REQUIRED');
    if (!context.credential) throw new Error('LEASE_CREDENTIAL_REQUIRED');
    assertCredentialForTarget({ ...target, state: 'LEASED' }, context.credential, context.at ?? new Date());
  } else {
    if (!context.credential) throw new Error('LEASE_CREDENTIAL_REQUIRED');
    assertCredentialForTarget(target, context.credential, context.at ?? new Date());
    if (actualFrom === 'LEASED' && !context.worktreeValid) throw new Error('CORRECT_WORKTREE_REQUIRED');
    if (actualFrom === 'IMPLEMENTING') {
      if (!context.evidence || context.evidence.status !== 'CURRENT') throw new Error('IMPLEMENTATION_EVIDENCE_REQUIRED');
      target.implementationEvidence = context.evidence;
    }
    if (actualFrom === 'SELF_REVIEWING') {
      if (!context.evidence || context.evidence.status !== 'CURRENT') throw new Error('SELF_REVIEW_EVIDENCE_REQUIRED');
      if (context.evidence.commit !== context.currentCommit || context.evidence.tree !== context.currentTree)
        throw new Error('SELF_REVIEW_BINDING_MISMATCH');
      target.selfReviewEvidence = context.evidence;
    }
    if (actualFrom === 'VERIFYING') {
      requireCurrentEvidence(target.selfReviewEvidence, 'SELF_REVIEW_EVIDENCE');
      if (!context.evidence || context.evidence.status !== 'CURRENT') throw new Error('VERIFICATION_EVIDENCE_REQUIRED');
      target.verificationEvidence = context.evidence;
    }
    if (actualFrom === 'VERIFIED') {
      requireCurrentEvidence(target.verificationEvidence, 'VERIFICATION_EVIDENCE');
      requireCurrentEvidence(target.taskResultEvidence, 'TASK_RESULT_EVIDENCE');
      if (
        !target.commit ||
        !target.tree ||
        target.commit !== context.currentCommit ||
        target.tree !== context.currentTree
      )
        throw new Error('MERGE_QUEUE_BINDING_MISMATCH');
    }
    if (actualFrom === 'MERGE_QUEUED' && !context.mergeQueueProcessed)
      throw new Error('REAL_MERGE_QUEUE_REQUIRED');
  }
  record(target, actualFrom, to, context);
};

export const markValidated = (target: TaskState, evidence: EvidenceReference, at = new Date()): void =>
  transition(target, ['DRAFT'], 'VALIDATED', { command: 'task:validate', evidence, at });

export const markReady = (
  state: LifecycleDocument,
  tasks: LeaseContract[],
  taskId: string,
  at = new Date(),
): void => {
  const target = state.tasks[taskId];
  const contract = tasks.find((task) => task.id === taskId);
  if (!target || !contract) throw new Error('TASK_NOT_FOUND');
  if (!contract.dependencies.every((dependency) => state.tasks[dependency]?.state === 'MERGED'))
    throw new Error('TASK_DEPENDENCIES_NOT_READY');
  transition(target, ['VALIDATED'], 'READY', { command: 'task:mark-ready', at });
};

export const acquire = (
  state: LifecycleDocument,
  tasks: LeaseContract[],
  taskId: string,
  holder: string,
  now: Date,
  ttlMs = 900_000,
  baseCommit?: string,
  branch?: string,
): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = state.tasks[taskId];
  if (!target) throw new Error('TASK_NOT_FOUND');
  if (target.state !== 'READY') throw new Error(`TASK_NOT_READY:${target.state}`);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('TASK_CONTRACT_NOT_FOUND');
  const conflict = Object.values(state.tasks).find(
    (item) =>
      protectedStates.has(item.state) &&
      item.expiresAt &&
      Date.parse(item.expiresAt) > now.getTime() &&
      tasks
        .find((candidate) => candidate.id === item.taskId)
        ?.exclusiveLocks.some((lock) => task.exclusiveLocks.includes(lock)),
  );
  if (conflict) throw new Error(`PATH_LOCK_CONFLICT:${conflict.taskId}`);
  target.leaseVersion += 1;
  target.holder = holder;
  target.acquiredAt = now.toISOString();
  delete target.renewedAt;
  target.leaseId = `${taskId}:${target.leaseVersion}:${now.getTime()}`;
  target.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  target.leaseState = 'ACTIVE';
  if (baseCommit) target.baseCommit = baseCommit;
  if (branch) target.branch = branch;
  const credential = currentLeaseCredential(target);
  transition(target, ['READY'], 'LEASED', { command: 'task:acquire', credential, at: now });
  return TaskLeaseSchema.parse({
    schemaVersion: '2.0.0',
    taskId,
    holder,
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
    version: target.leaseVersion,
    acquiredAt: target.acquiredAt,
    expiresAt: target.expiresAt,
    state: 'ACTIVE',
  });
};

export const renewLease = (
  state: LifecycleDocument,
  credential: LeaseCredential,
  now: Date,
  ttlMs = 900_000,
): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = assertLeaseCredential(state, credential, now);
  target.leaseVersion += 1;
  target.renewedAt = now.toISOString();
  target.leaseId = `${target.taskId}:${target.leaseVersion}:${now.getTime()}`;
  target.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  target.leaseState = 'ACTIVE';
  return TaskLeaseSchema.parse({
    schemaVersion: '2.0.0',
    taskId: target.taskId,
    holder: target.holder,
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
    version: target.leaseVersion,
    acquiredAt: target.acquiredAt,
    expiresAt: target.expiresAt,
    state: 'ACTIVE',
  });
};

export interface ExplicitRenewalExpectation {
  taskId: string;
  expectedLeaseId: string;
  expectedFencingVersion: number;
  holder: string;
  requestSha256: string;
  receipt: EvidenceReference;
}

export const renewValidLease = (
  state: LifecycleDocument,
  expectation: ExplicitRenewalExpectation,
  now: Date,
  ttlMs = 900_000,
): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = state.tasks[expectation.taskId];
  if (!target) throw new Error('TASK_NOT_FOUND');
  if (target.renewal?.requestSha256 === expectation.requestSha256) {
    if (
      target.leaseId !== target.renewal.resultingLeaseId ||
      target.leaseVersion !== target.renewal.resultingFencingVersion
    )
      throw new Error('RENEWAL_RETRY_NO_LONGER_CURRENT');
    return TaskLeaseSchema.parse({
      schemaVersion: '2.0.0', taskId: target.taskId, holder: target.holder,
      leaseId: target.leaseId, fencingVersion: target.leaseVersion, version: target.leaseVersion,
      acquiredAt: target.acquiredAt, expiresAt: target.expiresAt, state: target.leaseState,
    });
  }
  if (target.leaseId !== expectation.expectedLeaseId) throw new Error('RENEWAL_EXPECTED_LEASE_MISMATCH');
  if (target.leaseVersion !== expectation.expectedFencingVersion) throw new Error('RENEWAL_EXPECTED_FENCING_MISMATCH');
  if (target.holder !== expectation.holder) throw new Error('RENEWAL_EXPECTED_HOLDER_MISMATCH');
  const previousLeaseId = target.leaseId;
  const previousVersion = target.leaseVersion;
  const credential = currentLeaseCredential(target);
  const lease = renewLease(state, credential, now, ttlMs);
  target.retiredLeases ??= [];
  target.retiredLeases.push({ leaseId: previousLeaseId, fencingVersion: previousVersion, state: 'RENEWED', retiredAt: now.toISOString() });
  target.renewal = {
    requestSha256: expectation.requestSha256,
    receipt: expectation.receipt,
    resultingLeaseId: lease.leaseId,
    resultingFencingVersion: lease.fencingVersion,
  };
  return lease;
};

export interface ExpiredRecoveryExpectation {
  taskId: string;
  expectedExpiredLeaseId: string;
  expectedFencingVersion: number;
  expectedHolder: string;
  expectedTaskState: TaskLifecycleState;
  expectedTaskBranch: string;
  expectedTaskWorktree: string;
  expectedBaseCommit: string;
  requestSha256: string;
  receipt: EvidenceReference;
}

export const recoverExpiredLease = (
  state: LifecycleDocument,
  tasks: LeaseContract[],
  expectation: ExpiredRecoveryExpectation,
  now: Date,
  ttlMs = 900_000,
): ReturnType<typeof TaskLeaseSchema.parse> => {
  const target = state.tasks[expectation.taskId];
  if (!target) throw new Error('TASK_NOT_FOUND');
  if (target.recovery?.requestSha256 === expectation.requestSha256) {
    if (
      target.leaseId !== target.recovery.resultingLeaseId ||
      target.leaseVersion !== target.recovery.resultingFencingVersion
    )
      throw new Error('RECOVERY_RETRY_NO_LONGER_CURRENT');
    return TaskLeaseSchema.parse({
      schemaVersion: '2.0.0', taskId: target.taskId, holder: target.holder,
      leaseId: target.leaseId, fencingVersion: target.leaseVersion, version: target.leaseVersion,
      acquiredAt: target.acquiredAt, expiresAt: target.expiresAt, state: target.leaseState,
    });
  }
  if (target.leaseId !== expectation.expectedExpiredLeaseId) throw new Error('RECOVERY_EXPECTED_LEASE_MISMATCH');
  if (target.leaseVersion !== expectation.expectedFencingVersion) throw new Error('RECOVERY_EXPECTED_FENCING_MISMATCH');
  if (target.holder !== expectation.expectedHolder) throw new Error('RECOVERY_EXPECTED_HOLDER_MISMATCH');
  if (target.state !== expectation.expectedTaskState) throw new Error('RECOVERY_EXPECTED_STATE_MISMATCH');
  if (target.branch !== expectation.expectedTaskBranch) throw new Error('RECOVERY_EXPECTED_BRANCH_MISMATCH');
  if (target.worktree !== expectation.expectedTaskWorktree) throw new Error('RECOVERY_EXPECTED_WORKTREE_MISMATCH');
  if (target.baseCommit !== expectation.expectedBaseCommit) throw new Error('RECOVERY_EXPECTED_BASE_MISMATCH');
  if (!target.expiresAt || Date.parse(target.expiresAt) > now.getTime()) throw new Error('RECOVERY_LEASE_NOT_EXPIRED');
  if (!protectedStates.has(target.state)) throw new Error('RECOVERY_STATE_NOT_ACTIVE');
  const contract = tasks.find((item) => item.id === target.taskId);
  if (!contract) throw new Error('TASK_CONTRACT_NOT_FOUND');
  const conflict = Object.values(state.tasks).find((item) => {
    if (item.taskId === target.taskId || !protectedStates.has(item.state)) return false;
    const other = tasks.find((candidate) => candidate.id === item.taskId);
    return Boolean(other?.exclusiveLocks.some((lock) => contract.exclusiveLocks.includes(lock)));
  });
  if (conflict) throw new Error(`RECOVERY_PATH_LOCK_CONFLICT:${conflict.taskId}`);
  const secondActive = Object.values(state.tasks).find(
    (item) => item.taskId !== target.taskId && protectedStates.has(item.state),
  );
  if (secondActive) throw new Error(`RECOVERY_MULTIPLE_ACTIVE_TASKS:${secondActive.taskId}`);
  target.retiredLeases ??= [];
  target.retiredLeases.push({ leaseId: target.leaseId, fencingVersion: target.leaseVersion, state: 'EXPIRED', retiredAt: now.toISOString() });
  const previousLeaseId = target.leaseId;
  const previousFencingVersion = target.leaseVersion;
  target.leaseVersion += 1;
  target.leaseId = `${target.taskId}:${target.leaseVersion}:recovery:${expectation.requestSha256.slice(0, 16)}`;
  target.renewedAt = now.toISOString();
  target.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  target.leaseState = 'ACTIVE';
  target.recovery = {
    requestSha256: expectation.requestSha256,
    receipt: expectation.receipt,
    previousLeaseId,
    previousFencingVersion,
    resultingLeaseId: target.leaseId,
    resultingFencingVersion: target.leaseVersion,
  };
  return TaskLeaseSchema.parse({
    schemaVersion: '2.0.0', taskId: target.taskId, holder: target.holder,
    leaseId: target.leaseId, fencingVersion: target.leaseVersion, version: target.leaseVersion,
    acquiredAt: target.acquiredAt, expiresAt: target.expiresAt, state: 'ACTIVE',
  });
};

export const refreshReady = (state: LifecycleDocument, tasks: LeaseContract[]): void => {
  for (const task of tasks) {
    const target = state.tasks[task.id];
    if (
      target?.state === 'VALIDATED' &&
      target.validationEvidence?.status === 'CURRENT' &&
      task.dependencies.every((dependency) => state.tasks[dependency]?.state === 'MERGED')
    )
      markReady(state, tasks, task.id);
  }
};

export const invalidateCurrentEvidence = (target: TaskState): EvidenceReference[] => {
  const stale: EvidenceReference[] = [];
  for (const key of ['selfReviewEvidence', 'taskResultEvidence', 'verificationEvidence'] as const) {
    const evidence = target[key];
    if (evidence?.status === 'CURRENT') {
      evidence.status = 'STALE';
      stale.push({ ...evidence });
    }
  }
  return stale;
};

export const resetAfterRebase = (
  target: TaskState,
  credential: LeaseCredential,
  newBaseCommit: string,
  newHeadCommit: string,
  newHeadTree: string,
  at = new Date(),
): void => {
  if (target.state !== 'MERGE_QUEUED') throw new Error(`REBASE_STATE_INVALID:${target.state}`);
  assertCredentialForTarget(target, credential, at);
  target.history ??= [];
  target.history.push({
    from: 'MERGE_QUEUED',
    to: 'SELF_REVIEWING',
    at: at.toISOString(),
    command: 'merge-queue:post-rebase-self-review',
    leaseVersion: credential.fencingVersion,
  });
  target.state = 'SELF_REVIEWING';
  target.baseCommit = newBaseCommit;
  target.commit = newHeadCommit;
  target.tree = newHeadTree;
  delete target.selfReviewEvidence;
  delete target.taskResultEvidence;
  delete target.verificationEvidence;
};

export const releaseLease = (target: TaskState, credential: LeaseCredential, at = new Date()): void => {
  assertCredentialForTarget(target, credential, at);
  const from = target.state;
  target.state = 'VALIDATED';
  target.leaseState = 'RELEASED';
  target.history ??= [];
  target.history.push({
    from,
    to: 'VALIDATED',
    at: at.toISOString(),
    command: 'task:release',
    leaseVersion: credential.fencingVersion,
  });
  delete target.holder;
  delete target.leaseId;
  delete target.acquiredAt;
  delete target.renewedAt;
  delete target.expiresAt;
  delete target.commit;
  delete target.tree;
  delete target.branch;
  delete target.worktree;
  delete target.implementationEvidence;
  delete target.selfReviewEvidence;
  delete target.taskResultEvidence;
  delete target.verificationEvidence;
};

export const markIntegrationFailure = (
  target: TaskState,
  credential: LeaseCredential,
  reverted: boolean,
  at = new Date(),
): void => {
  assertCredentialForTarget(target, credential, at);
  const from = target.state;
  const intermediate: TaskLifecycleState = 'INTEGRATION_FAILED';
  target.history ??= [];
  target.history.push({
    from,
    to: intermediate,
    at: at.toISOString(),
    command: 'cluster:verify-integration',
    leaseVersion: credential.fencingVersion,
  });
  target.state = intermediate;
  if (reverted) {
    target.history.push({
      from: intermediate,
      to: 'REVERTED_AFTER_INTEGRATION_FAILURE',
      at: at.toISOString(),
      command: 'merge-queue:auto-revert',
      leaseVersion: credential.fencingVersion,
    });
    target.state = 'REVERTED_AFTER_INTEGRATION_FAILURE';
    target.leaseState = 'COMPLETED';
  }
};
