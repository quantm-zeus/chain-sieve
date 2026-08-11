import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { taskBranch } from './paths.js';
import type { CommandResult, CommandRunner, TaskLaunchBinding } from './types.js';

interface TaskLifecycleSnapshot {
  state?: string;
  leaseVersion?: number;
  holder?: string;
  leaseId?: string;
  expiresAt?: string;
  commit?: string;
  tree?: string;
  selfReviewEvidence?: {
    status?: string;
    commit?: string;
    tree?: string;
  };
}

const git = (
  runner: CommandRunner,
  cwd: string,
  args: string[],
): CommandResult =>
  runner.run('git', args, { cwd, timeoutMilliseconds: 10_000 });

const gitText = (
  runner: CommandRunner,
  cwd: string,
  args: string[],
): string | undefined => {
  const result = git(runner, cwd, args);
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const gitCommonDirectory = (
  runner: CommandRunner,
  workspace: string,
): string | undefined => {
  const value = gitText(runner, workspace, ['rev-parse', '--git-common-dir']);
  if (!value) return undefined;
  return resolve(workspace, isAbsolute(value) ? value : join(workspace, value));
};

const lifecycleAuthorityWorkspace = (binding: TaskLaunchBinding): string =>
  binding.task.cluster.branch.worktree;

const readTaskLifecycleSnapshot = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): TaskLifecycleSnapshot | undefined => {
  // Lifecycle state belongs to the trusted cluster/root control plane. Reading it
  // through a stale or foreign task worktree can create a split-brain view where
  // the launch receipt is fenced at N while that worktree observes an older N-k.
  const common = gitCommonDirectory(runner, lifecycleAuthorityWorkspace(binding));
  if (!common) return undefined;
  const path = join(common, 'ciag-runtime', 'task-state.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      tasks?: Record<string, TaskLifecycleSnapshot>;
    };
    return parsed.tasks?.[binding.task.contract.id];
  } catch {
    return undefined;
  }
};

export const readTaskLifecycleState = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => readTaskLifecycleSnapshot(runner, binding)?.state;

export const cleanAtomicTaskCommit = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): string | undefined => {
  const status = gitText(runner, binding.taskWorkspace, [
    'status',
    '--porcelain=v1',
  ]);
  if (status === undefined || status !== '') return undefined;
  const head = gitText(runner, binding.taskWorkspace, ['rev-parse', 'HEAD']);
  if (!head || head === binding.baseCommit) return undefined;
  const count = gitText(runner, binding.taskWorkspace, [
    'rev-list',
    '--count',
    `${binding.baseCommit}..${head}`,
  ]);
  if (Number(count) !== 1) return undefined;
  return head;
};

const ensureCanonicalTaskBranch = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  head: string,
): CommandResult | undefined => {
  const expected = taskBranch(binding.task.contract.id);
  const current = gitText(runner, binding.taskWorkspace, [
    'branch',
    '--show-current',
  ]);
  if (current === expected) return undefined;
  const expectedRef = gitText(runner, binding.taskWorkspace, [
    'rev-parse',
    '--verify',
    `refs/heads/${expected}`,
  ]);
  if (expectedRef && expectedRef !== binding.baseCommit && expectedRef !== head) {
    return {
      status: 1,
      stdout: '',
      stderr: `TASK_CHECKPOINT_BRANCH_DIVERGED:${binding.task.contract.id}:${expectedRef}:${head}`,
    };
  }
  const attach = git(runner, binding.taskWorkspace, [
    'switch',
    '-C',
    expected,
    head,
  ]);
  if (attach.status !== 0) {
    return {
      ...attach,
      stderr: `TASK_CHECKPOINT_BRANCH_REATTACH_FAILED:${binding.task.contract.id}:${attach.stderr || attach.stdout}`,
    };
  }
  console.log(
    `CHAINSIEVE_TASK_BRANCH_REATTACHED:${binding.task.contract.id}:${current || 'detached'}:${expected}:${head}`,
  );
  return undefined;
};

const runLifecycle = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  args: string[],
): CommandResult =>
  runner.run('pnpm', ['--silent', ...args], {
    cwd: binding.taskWorkspace,
    timeoutMilliseconds: 30 * 60_000,
  });

const lifecycleOutput = (result: CommandResult): string =>
  (result.stderr || result.stdout).trim();

const currentSelfReview = (snapshot: TaskLifecycleSnapshot): boolean =>
  snapshot.state === 'SELF_REVIEWING' &&
  snapshot.selfReviewEvidence?.status === 'CURRENT' &&
  Boolean(snapshot.commit) &&
  Boolean(snapshot.tree) &&
  snapshot.selfReviewEvidence.commit === snapshot.commit &&
  snapshot.selfReviewEvidence.tree === snapshot.tree;

const leaseSnapshotRegression = (
  binding: TaskLaunchBinding,
  snapshot: TaskLifecycleSnapshot | undefined,
): CommandResult | undefined => {
  if (
    !snapshot ||
    typeof snapshot.leaseVersion !== 'number' ||
    snapshot.leaseVersion >= binding.fencingVersion
  )
    return undefined;
  console.error(
    `CHAINSIEVE_TASK_CHECKPOINT_LEASE_REGRESSION:${binding.task.contract.id}:${binding.fencingVersion}->${snapshot.leaseVersion}`,
  );
  return {
    status: 1,
    stdout: '',
    stderr: `TASK_CHECKPOINT_LEASE_SNAPSHOT_REGRESSION:${binding.task.contract.id}:${binding.fencingVersion}:${snapshot.leaseVersion}:${binding.leaseId}:${snapshot.leaseId ?? 'missing'}`,
  };
};

const leaseCredentialAdvanced = (
  binding: TaskLaunchBinding,
  snapshot: TaskLifecycleSnapshot | undefined,
): boolean =>
  Boolean(
    snapshot &&
      typeof snapshot.leaseVersion === 'number' &&
      snapshot.leaseVersion > binding.fencingVersion,
  );

const leaseRebindResult = (
  binding: TaskLaunchBinding,
  snapshot: TaskLifecycleSnapshot | undefined,
): CommandResult | undefined => {
  const regression = leaseSnapshotRegression(binding, snapshot);
  if (regression) return regression;
  if (!leaseCredentialAdvanced(binding, snapshot)) return undefined;
  const version = snapshot?.leaseVersion ?? 'missing';
  const leaseId = snapshot?.leaseId ?? 'missing';
  console.log(
    `CHAINSIEVE_TASK_CHECKPOINT_LEASE_REBIND:${binding.task.contract.id}:${binding.fencingVersion}->${version}`,
  );
  return {
    status: 0,
    stdout: `TASK_CHECKPOINT_REBIND_REQUIRED:${binding.task.contract.id}:${binding.fencingVersion}:${version}:${binding.leaseId}:${leaseId}`,
    stderr: '',
  };
};

const rebindAfterLeaseFailure = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
  result: CommandResult,
): CommandResult | undefined => {
  const output = lifecycleOutput(result);
  if (
    !output.includes('STALE_LEASE_VERSION') &&
    !output.includes('LOST_LEASE') &&
    !output.includes('WRONG_LEASE_OWNER')
  )
    return undefined;
  const snapshot = readTaskLifecycleSnapshot(runner, binding);
  const regression = leaseSnapshotRegression(binding, snapshot);
  if (regression) return regression;
  return leaseRebindResult(binding, snapshot);
};

export const beginTaskBeforeProvider = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  const snapshot = readTaskLifecycleSnapshot(runner, binding);
  const regression = leaseSnapshotRegression(binding, snapshot);
  if (regression) return regression;
  if (snapshot?.state !== 'LEASED') return undefined;
  const preflightRebind = leaseRebindResult(binding, snapshot);
  if (preflightRebind) return preflightRebind;
  const result = runLifecycle(runner, binding, [
    'task:begin',
    binding.task.contract.id,
    '--holder',
    binding.holder,
    '--lease-version',
    String(binding.fencingVersion),
  ]);
  if (result.status !== 0) {
    const rebind = rebindAfterLeaseFailure(runner, binding, result);
    if (rebind) return rebind;
    return {
      ...result,
      stderr: `TASK_BEGIN_BEFORE_PROVIDER_FAILED:${binding.task.contract.id}:${lifecycleOutput(result)}`,
    };
  }
  console.log(`CHAINSIEVE_HOST_TASK_BEGUN:${binding.task.contract.id}`);
  return undefined;
};

export const reconcileCommittedTaskCheckpoint = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  const snapshot = readTaskLifecycleSnapshot(runner, binding);
  const regression = leaseSnapshotRegression(binding, snapshot);
  if (regression) return regression;
  const preflightRebind = leaseRebindResult(binding, snapshot);
  if (preflightRebind) return preflightRebind;
  const state = snapshot?.state;
  const incompleteSelfReview =
    state === 'SELF_REVIEWING' && snapshot && !currentSelfReview(snapshot);
  const active =
    state === 'LEASED' || state === 'IMPLEMENTING' || incompleteSelfReview;
  const durable = Boolean(
    snapshot &&
      (currentSelfReview(snapshot) ||
        ['VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED'].includes(
          state ?? '',
        )),
  );
  if (!active && !durable) return undefined;

  const head = cleanAtomicTaskCommit(runner, binding);
  if (head && durable) {
    const branchFailure = ensureCanonicalTaskBranch(runner, binding, head);
    if (branchFailure) return branchFailure;
  }

  if (durable) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_ALREADY_DURABLE:${binding.task.contract.id}:${state}`,
    );
    return { status: 0, stdout: '', stderr: '' };
  }
  if (incompleteSelfReview && snapshot?.selfReviewEvidence) {
    return {
      status: 1,
      stdout: '',
      stderr: `TASK_CHECKPOINT_SELF_REVIEW_EVIDENCE_STALE:${binding.task.contract.id}`,
    };
  }
  if (!head || !binding.launchReceiptId) return undefined;

  if (state === 'LEASED' || state === 'IMPLEMENTING') {
    const adopted = runLifecycle(runner, binding, [
      'task:checkpoint-adopt',
      binding.task.contract.id,
      '--holder',
      binding.holder,
      '--lease-version',
      String(binding.fencingVersion),
    ]);
    if (adopted.status !== 0) {
      const rebind = rebindAfterLeaseFailure(runner, binding, adopted);
      if (rebind) return rebind;
      return {
        ...adopted,
        stderr: `TASK_CHECKPOINT_ADOPT_FAILED:${binding.task.contract.id}:${lifecycleOutput(adopted)}`,
      };
    }
    const rebind = leaseRebindResult(
      binding,
      readTaskLifecycleSnapshot(runner, binding),
    );
    if (rebind) return rebind;
  }

  console.log(
    `CHAINSIEVE_TASK_CHECKPOINT_RECONCILE:${binding.task.contract.id}:${head}`,
  );
  const reviewed = runLifecycle(runner, binding, [
    'task:self-review',
    binding.task.contract.id,
    '--holder',
    binding.holder,
    '--lease-version',
    String(binding.fencingVersion),
    '--launch-receipt-id',
    binding.launchReceiptId,
  ]);
  if (reviewed.status === 0) {
    console.log(
      `CHAINSIEVE_TASK_CHECKPOINT_RECONCILED:${binding.task.contract.id}:${head}`,
    );
    return reviewed;
  }
  const rebind = rebindAfterLeaseFailure(runner, binding, reviewed);
  if (rebind) return rebind;
  return {
    ...reviewed,
    stderr: `TASK_CHECKPOINT_RECONCILE_FAILED:${binding.task.contract.id}:${lifecycleOutput(reviewed)}`,
  };
};
