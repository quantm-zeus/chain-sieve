import { spawnSync } from 'node:child_process';
import { TaskContractSchema, type TaskContract } from '@ciag/shared-schemas';
import { registerCurrentEvidence } from '../task-runner/evidence-ledger.js';
import { performTaskSelfReview } from '../task-runner/self-review.js';
import {
  acquireLifecycleMutationLock,
  assertLease,
  currentLeaseCredential,
  readState,
  transition,
  writeState,
  type EvidenceReference,
} from '../task-runner/state.js';
import { taskBranch } from '../worktree-manager/identity.js';

const BINDING_ENV = 'CHAINSIEVE_HOST_TASK_BINDING_JSON';

type HostTaskBinding = {
  trustedRoot: string;
  taskWorkspace: string;
  task: TaskContract;
};

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const required = (name: string): string =>
  option(name) ??
  (() => {
    throw new Error(`OPTION_REQUIRED:${name}`);
  })();

const loadBinding = (): HostTaskBinding => {
  const raw = process.env[BINDING_ENV];
  if (!raw) throw new Error('HOST_TASK_BINDING_REQUIRED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HOST_TASK_BINDING_INVALID');
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('HOST_TASK_BINDING_INVALID');
  const value = parsed as {
    trustedRoot?: unknown;
    taskWorkspace?: unknown;
    task?: unknown;
  };
  if (
    typeof value.trustedRoot !== 'string' ||
    value.trustedRoot.length === 0 ||
    typeof value.taskWorkspace !== 'string' ||
    value.taskWorkspace.length === 0
  )
    throw new Error('HOST_TASK_BINDING_INVALID');
  return {
    trustedRoot: value.trustedRoot,
    taskWorkspace: value.taskWorkspace,
    task: TaskContractSchema.parse(value.task),
  };
};

const git = (
  workspace: string,
  args: string[],
  allowFailure = false,
): string => {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `HOST_TASK_GIT_FAILED:${args.join(':')}:${(result.stderr ?? '').trim()}`,
    );
  return (result.stdout ?? '').trim();
};

const command = process.argv[2] ?? '';
const taskId = process.argv[3] ?? '';
const holder = required('--holder');
const leaseVersion = Number(required('--lease-version'));
let releaseMutationLock: (() => Promise<void>) | undefined;

try {
  const binding = loadBinding();
  if (binding.task.id !== taskId)
    throw new Error(`HOST_TASK_BINDING_TASK_MISMATCH:${binding.task.id}:${taskId}`);
  if (!Number.isInteger(leaseVersion) || leaseVersion < 1)
    throw new Error(`HOST_TASK_LEASE_VERSION_INVALID:${leaseVersion}`);

  releaseMutationLock = await acquireLifecycleMutationLock(binding.trustedRoot);
  const state = await readState([binding.task], binding.trustedRoot);
  const target = assertLease(state, taskId, leaseVersion, holder, new Date());
  const credential = currentLeaseCredential(target);
  const expectedBranch = taskBranch(taskId);

  if (command === 'task:begin') {
    const branch = git(binding.taskWorkspace, ['branch', '--show-current']);
    if (branch !== expectedBranch || target.branch !== expectedBranch)
      throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
    if (git(binding.taskWorkspace, ['status', '--porcelain']) !== '')
      throw new Error('DIRTY_WORKTREE');
    if (git(binding.taskWorkspace, ['rev-parse', 'HEAD']) !== target.baseCommit)
      throw new Error('TASK_BASE_COMMIT_MISMATCH');
    target.worktree = git(binding.taskWorkspace, ['rev-parse', '--show-toplevel']);
    transition(target, ['LEASED'], 'IMPLEMENTING', {
      command: 'task:begin',
      credential,
      worktreeValid: true,
    });
    await writeState(state, binding.trustedRoot);
    console.log(JSON.stringify(target, null, 2));
  } else if (command === 'task:checkpoint-adopt') {
    if (target.branch !== expectedBranch)
      throw new Error(
        `TASK_BRANCH_BINDING_MISMATCH:${target.branch ?? 'missing'}:${expectedBranch}`,
      );
    if (git(binding.taskWorkspace, ['status', '--porcelain']) !== '')
      throw new Error('DIRTY_WORKTREE');
    if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
    const head = git(binding.taskWorkspace, ['rev-parse', 'HEAD']);
    if (head === target.baseCommit) throw new Error('TASK_COMMIT_MISSING');
    if (
      Number(
        git(binding.taskWorkspace, [
          'rev-list',
          '--count',
          `${target.baseCommit}..${head}`,
        ]),
      ) !== 1
    )
      throw new Error('TASK_COMMIT_NOT_ATOMIC');
    const currentBranch = git(binding.taskWorkspace, [
      'branch',
      '--show-current',
    ]);
    if (currentBranch !== expectedBranch) {
      const expectedRef = git(
        binding.taskWorkspace,
        ['rev-parse', '--verify', `refs/heads/${expectedBranch}`],
        true,
      );
      if (
        expectedRef &&
        expectedRef !== target.baseCommit &&
        expectedRef !== head
      )
        throw new Error(
          `TASK_CHECKPOINT_BRANCH_DIVERGED:${taskId}:${expectedRef}:${head}`,
        );
      git(binding.taskWorkspace, ['switch', '-C', expectedBranch, head]);
    }
    if (target.state === 'LEASED') {
      target.worktree = git(binding.taskWorkspace, [
        'rev-parse',
        '--show-toplevel',
      ]);
      transition(target, ['LEASED'], 'IMPLEMENTING', {
        command: 'task:checkpoint-adopt',
        credential,
        worktreeValid: true,
      });
      await writeState(state, binding.trustedRoot);
    } else if (target.state !== 'IMPLEMENTING') {
      throw new Error(`TASK_CHECKPOINT_ADOPT_STATE_INVALID:${target.state}`);
    }
    console.log(
      JSON.stringify(
        { status: 'TASK_CHECKPOINT_ADOPTED', taskId, head, state: target },
        null,
        2,
      ),
    );
  } else if (command === 'task:self-review') {
    const recoveringIncompleteReview =
      target.state === 'SELF_REVIEWING' && !target.selfReviewEvidence;
    if (target.state !== 'IMPLEMENTING' && !recoveringIncompleteReview)
      throw new Error(`TASK_SELF_REVIEW_STATE_INVALID:${target.state}`);
    const commit = git(binding.taskWorkspace, ['rev-parse', 'HEAD']);
    const tree = git(binding.taskWorkspace, ['rev-parse', 'HEAD^{tree}']);
    const implementationEvidence: EvidenceReference = {
      path: `git:${commit}`,
      sha256: await import('../prd-compiler/compiler.js').then(({ sha256 }) =>
        sha256(`${commit}:${tree}`),
      ),
      status: 'CURRENT',
      commit,
      tree,
    };
    const launchReceiptId = required('--launch-receipt-id');
    const review = await performTaskSelfReview(
      binding.task,
      target,
      holder,
      binding.taskWorkspace,
      { launchReceiptId, trustedRoot: binding.trustedRoot },
    );
    if (target.state === 'IMPLEMENTING')
      transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING', {
        command: 'task:self-review',
        credential,
        evidence: implementationEvidence,
      });
    target.selfReviewEvidence = review.evidence;
    await registerCurrentEvidence(
      taskId,
      'SELF_REVIEW',
      review.evidence,
      binding.trustedRoot,
    );
    await writeState(state, binding.trustedRoot);
    console.log(JSON.stringify({ ...target, selfReview: review }, null, 2));
  } else {
    throw new Error(`HOST_TASK_LIFECYCLE_COMMAND_UNSUPPORTED:${command}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await releaseMutationLock?.();
}
