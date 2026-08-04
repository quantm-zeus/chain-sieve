import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProject } from '../agent/lib/discovery.js';
import { decideNextAction } from '../agent/lib/engine.js';
import {
  executeOrchestration,
  leaseForTask,
  renderDryRun,
} from '../agent/lib/executor.js';
import {
  agentRuntimeRoot,
  listLaunchReceiptCandidates,
} from '../agent/lib/runtime.js';
import type {
  AgentProvider,
  AgentProviderId,
  ClusterRecord,
  CommandResult,
  CommandRunner,
  ProjectInventory,
  TaskRecord,
} from '../agent/lib/types.js';
import { createProvider } from '../agent/providers/index.js';
import { computeAutopilotWorkspaceHashes } from '../agent/lib/workspace-hash.js';
import { acquireAutopilotLock } from './lock.js';
import { loadAutonomyPolicy, type AutonomyPolicy } from './policy.js';

export const DEFAULT_AUTONOMOUS_PROVIDER = 'antigravity' as const;
export const MAX_PRODUCT_CORRECTION_ROUNDS = 3;
export const ANTIGRAVITY_MODEL_STATUS =
  'GEMINI_3_6_FLASH_HIGH_ENFORCED_BY_CLI' as const;
// FW-AUTOPILOT-001: one command owns discovery, execution, verification, merge, and continuation.
// FW-AUTOPILOT-002: lease renewal and exact-state recovery remain invisible to the owner.
// FW-AUTOPILOT-003: corrections retain strict bindings and product work stops after bounded rounds.
// FW-AUTOPILOT-004: Antigravity is headless by default; Codex is an explicit fallback only.
// FW-AUTOPILOT-005: the committed full-autonomy policy preauthorizes machine-gated work.
export const correctionRoundAllowed = (completedRounds: number): boolean =>
  completedRounds + 1 <= MAX_PRODUCT_CORRECTION_ROUNDS;

const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0)
    throw new Error(`${code}:${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};
const pnpm = (runner: CommandRunner, root: string, args: string[]): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], { cwd: root }),
    `AUTOPILOT_COMMAND_FAILED:${args.join(':')}`,
  );
const git = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('git', args, { cwd }),
    `AUTOPILOT_GIT_FAILED:${args.join(':')}`,
  );

const ensureLease = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
): Promise<void> => {
  const state = task.state;
  if (
    !state.expiresAt ||
    !state.leaseId ||
    !state.holder ||
    !state.baseCommit ||
    !state.branch
  )
    return;
  const remaining = Date.parse(state.expiresAt) - Date.now();
  if (remaining > 10 * 60_000) return;
  if (remaining > 0) {
    const alreadyRenewed =
      state.renewal?.resultingLeaseId === state.leaseId &&
      state.renewal.resultingFencingVersion === state.leaseVersion;
    if (!alreadyRenewed) {
      pnpm(runner, root, [
        'agent:renew',
        '--',
        task.contract.id,
        '--expected-lease-id',
        state.leaseId,
        '--expected-fencing-version',
        String(state.leaseVersion),
        '--holder',
        state.holder,
        '--ttl-minutes',
        '120',
      ]);
      return;
    }
    await sleep(remaining + 1_000);
  }
  const workspace = task.workspace;
  const hashes = await computeAutopilotWorkspaceHashes(workspace);
  const head = git(runner, workspace, ['rev-parse', 'HEAD']);
  const tree = git(runner, workspace, ['rev-parse', 'HEAD^{tree}']);
  const contractPath = `tasks/${task.contract.dependencyGroup}/${task.contract.id}.contract.json`;
  const contextPath = `artifacts/context/${task.contract.id}/context-manifest.json`;
  const contractHash = hash(await readFile(join(workspace, contractPath)));
  const contextHash = hash(await readFile(join(workspace, contextPath)));
  pnpm(runner, root, [
    'agent:recover',
    '--',
    task.contract.id,
    '--expected-expired-lease-id',
    state.leaseId,
    '--expected-fencing-version',
    String(state.leaseVersion),
    '--holder',
    state.holder,
    '--expected-task-state',
    state.state,
    '--expected-task-branch',
    state.branch,
    '--expected-task-worktree',
    workspace,
    '--expected-lifecycle-base-commit',
    state.baseCommit,
    '--expected-task-head-commit',
    head,
    '--expected-task-head-tree',
    tree,
    '--expected-tracked-work-sha256',
    hashes.tracked,
    '--expected-untracked-work-sha256',
    hashes.untracked,
    '--expected-legacy-contract-sha256',
    contractHash,
    '--expected-legacy-context-sha256',
    contextHash,
    '--ttl-minutes',
    '120',
  ]);
};

export const correctionReceiptMatches = (
  value: Record<string, unknown>,
  binding: {
    taskId?: string;
    holder?: string;
    leaseId?: string;
    fencingVersion?: number;
    worktree?: string;
    previousCommit?: string;
    failureCode?: string;
  } = {},
): boolean => {
  const correction = value.correction as
    | { previousCommit?: unknown; failureCodes?: unknown }
    | undefined;
  return (
    ['antigravity', 'codex', 'zcode'].includes(String(value.provider)) &&
    typeof correction?.previousCommit === 'string' &&
    Array.isArray(correction.failureCodes) &&
    (!binding.taskId || value.taskId === binding.taskId) &&
    (!binding.holder || value.holder === binding.holder) &&
    (!binding.leaseId || value.leaseId === binding.leaseId) &&
    (!binding.fencingVersion ||
      value.fencingVersion === binding.fencingVersion) &&
    (!binding.worktree || value.taskWorktree === binding.worktree) &&
    (!binding.previousCommit ||
      correction.previousCommit === binding.previousCommit) &&
    (!binding.failureCode ||
      correction.failureCodes.includes(binding.failureCode))
  );
};

const correctionReceipts = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
) =>
  (await listLaunchReceiptCandidates(root, runner, task.contract.id)).filter(
    ({ value }) =>
      correctionReceiptMatches(value, {
        taskId: task.contract.id,
        holder: task.state.holder!,
        leaseId: task.state.leaseId!,
        fencingVersion: task.state.leaseVersion,
        worktree: task.workspace,
      }),
  );

const bindCompletedCorrection = async (
  root: string,
  runner: CommandRunner,
  task: TaskRecord,
): Promise<boolean> => {
  const previous = task.state.commit;
  if (
    task.state.state !== 'SELF_REVIEWING' ||
    !previous ||
    !task.workspaceHead ||
    previous === task.workspaceHead
  )
    return false;
  const receipts = await correctionReceipts(root, runner, task);
  const candidate = receipts.find(({ value }) =>
    correctionReceiptMatches(value, { previousCommit: previous }),
  );
  const failureCode = (
    candidate?.value.correction as { failureCodes?: string[] } | undefined
  )?.failureCodes?.[0];
  if (!failureCode)
    throw new Error('AUTOPILOT_CORRECTION_RECEIPT_MISSING');
  pnpm(runner, root, [
    'task:self-review-correct',
    task.contract.id,
    '--holder',
    task.state.holder!,
    '--lease-version',
    String(task.state.leaseVersion),
    '--target-worktree',
    task.workspace,
    '--expected-previous-commit',
    previous,
    '--failure-code',
    failureCode,
  ]);
  return true;
};

interface PullRequestCheck {
  name?: string;
  context?: string;
  conclusion?: string;
  state?: string;
  status?: string;
}
interface PullRequestProbe {
  number: number;
  url: string;
  statusCheckRollup?: PullRequestCheck[];
}

const failedClusterPullRequest = (
  runner: CommandRunner,
  root: string,
  cluster: ClusterRecord,
): { number: number; url: string; failures: string[] } | undefined => {
  const result = runner.run(
    'gh',
    [
      'pr',
      'list',
      '--head',
      cluster.branch.branch,
      '--base',
      cluster.branch.integrationTarget,
      '--state',
      'open',
      '--limit',
      '1',
      '--json',
      'number,url,statusCheckRollup',
    ],
    { cwd: root },
  );
  if (result.status !== 0) return undefined;
  const pr = (JSON.parse(result.stdout) as PullRequestProbe[])[0];
  if (!pr) return undefined;
  const failures = (pr.statusCheckRollup ?? [])
    .filter((check) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(
        String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase(),
      ),
    )
    .map((check) => check.name ?? check.context ?? 'unnamed-check');
  return failures.length > 0 ? { number: pr.number, url: pr.url, failures } : undefined;
};

const repairClusterCi = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  cluster: ClusterRecord,
  failure: { number: number; url: string; failures: string[] },
  round: number,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  const resultPath = join(
    runtime,
    'cluster-results',
    `${cluster.contract.id}.result.json`,
  );
  const result = existsSync(resultPath)
    ? (JSON.parse(await readFile(resultPath, 'utf8')) as {
        headCommitSha?: string;
        headTreeSha?: string;
      })
    : undefined;
  const repairSessionId = randomUUID();
  const receiptPath = join(
    runtime,
    'ci-repair-sessions',
    `${cluster.contract.id}.${repairSessionId}.json`,
  );
  await mkdir(join(runtime, 'ci-repair-sessions'), { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        sessionId: repairSessionId,
        clusterId: cluster.contract.id,
        pullRequest: failure.url,
        failedChecks: failure.failures,
        round,
        frozenProductCommit: result?.headCommitSha,
        frozenProductTree: result?.headTreeSha,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const prompt = `You are an isolated ChainSieve cluster CI repair session ${repairSessionId}. Work only in ${cluster.branch.worktree} on ${cluster.branch.branch}. Inspect pull request ${failure.url} and download the complete logs for failed checks: ${failure.failures.join(', ')}. The previous independent review and cluster result are stale after any source correction. Before editing, read ${receiptPath}. Reset the branch to the frozen product commit ${result?.headCommitSha ?? 'recorded in the cluster result'} so the old review-only commit is removed, using force-with-lease only when pushing the repaired branch. Remove the stale cluster review artifact and the stale runtime cluster result. Repair only the concrete CI failures, run focused checks, and create one atomic repair commit. Do not forge task, cluster, review, or CI evidence. Push the branch and stop; the root autopilot will independently regenerate the cluster result, start a fresh review session, and re-evaluate CI.`;
  requireSuccess(
    provider.executePayload!(cluster.branch.worktree, prompt),
    'AUTOPILOT_CLUSTER_CI_REPAIR_FAILED',
  );
  if (existsSync(resultPath)) await rm(resultPath, { force: true });
};

const reviewCluster = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  cluster: ClusterRecord,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  const reviewPath = join(
    runtime,
    'cluster-reviews',
    `${cluster.contract.id}.review-instructions.md`,
  );
  const sessionId = randomUUID();
  const identity = `antigravity-independent-${sessionId}`;
  const receiptDirectory = join(runtime, 'review-sessions');
  const receiptPath = join(
    receiptDirectory,
    `${cluster.contract.id}.${sessionId}.json`,
  );
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        sessionId,
        reviewerIdentity: identity,
        clusterId: cluster.contract.id,
        productCommit: cluster.worktreeHead ?? cluster.branchHead,
        productTree: cluster.worktreeHead
          ? git(runner, cluster.branch.worktree, ['rev-parse', 'HEAD^{tree}'])
          : undefined,
        implementationHolders: cluster.contract.tasks,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const prompt = `Read and obey ${reviewPath}. This is independent review session ${sessionId}; use reviewerIdentity exactly ${identity}. Read only the frozen diff, contracts, result evidence, and tests needed for review. Do not reuse implementation-session reasoning. Create the exact review artifact, commit only that artifact, and stop. The machine verifier will reject stale bindings or unresolved P0/P1 findings. Review session receipt: ${receiptPath}.`;
  requireSuccess(
    provider.executePayload!(cluster.branch.worktree, prompt),
    'AUTOPILOT_CLUSTER_REVIEW_FAILED',
  );
};

const resolveSpecificationGap = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  inventory: ProjectInventory,
  policy: AutonomyPolicy,
): Promise<boolean> => {
  if (!policy.allowAutonomousSpecificationResolution) return false;
  const task = inventory.tasks.find(
    (candidate) =>
      candidate.state.state === 'BLOCKED' &&
      candidate.contract.specificationStatus === 'SPECIFICATION_GAP',
  );
  if (!task) return false;
  const slug = task.contract.id.toLowerCase();
  const branch = `autonomy/spec-${slug}`;
  const worktree = join(inventory.worktreeRoot, `spec-${slug}`);
  if (!existsSync(worktree)) {
    await mkdir(inventory.worktreeRoot, { recursive: true });
    const branchExists =
      runner.run('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
        cwd: root,
      }).status === 0;
    git(
      runner,
      root,
      branchExists
        ? ['worktree', 'add', worktree, branch]
        : ['worktree', 'add', '-b', branch, worktree, 'main'],
    );
  }
  pnpm(runner, worktree, ['install', '--frozen-lockfile']);
  const sessionId = randomUUID();
  const prompt = `You are ChainSieve autonomous specification resolver ${sessionId}. Resolve only specification gap ${task.contract.id} for cluster ${task.contract.cluster} in ${worktree}. The repository owner has committed FULL_AUTONOMY policy at config/autonomy-policy.json and will not provide human review. Read the gap task context, PRD, requirements, audit, ADRs, dependency interfaces, and safe-default policy. Choose the narrowest reversible specification that satisfies existing product intent. Never enable live trading, external writes, secret materialization, or irreversible migrations. Do not implement product functionality in this session. Update only authoritative specification/ADR/source files and deterministic generated contracts/context/conformance artifacts required to change this task from SPECIFICATION_GAP to READY. Run pnpm prd:compile, spec:verify, prd:drift-check, requirements:coverage, architecture:verify, and focused compiler tests. Create one atomic specification commit, push ${branch}, create or update a pull request to main, wait for all required GitHub checks, repair specification-only failures, and merge only after every required check passes. Then stop.`;
  requireSuccess(
    provider.executePayload!(worktree, prompt),
    'AUTOPILOT_SPECIFICATION_RESOLUTION_FAILED',
  );
  git(runner, root, ['fetch', 'origin', '--prune']);
  git(runner, root, ['pull', '--ff-only', 'origin', 'main']);
  git(runner, task.cluster.branch.worktree, [
    'merge',
    '--no-edit',
    'refs/remotes/origin/main',
  ]);
  git(runner, task.cluster.branch.worktree, [
    'push',
    'origin',
    task.cluster.branch.branch,
  ]);
  pnpm(runner, task.cluster.branch.worktree, [
    'task:validate',
    task.contract.id,
  ]);
  pnpm(runner, task.cluster.branch.worktree, [
    'task:mark-ready',
    task.contract.id,
  ]);
  git(runner, root, ['worktree', 'remove', '--force', worktree]);
  return true;
};

export interface AutopilotOptions {
  dryRun?: boolean;
  issueReceiptOnly?: boolean;
  maxCycles?: number;
  pollMilliseconds?: number;
  providerId?: AgentProviderId;
}

export const runAutopilot = async (
  root: string,
  runner: CommandRunner,
  options: AutopilotOptions = {},
): Promise<string> => {
  const policy = await loadAutonomyPolicy(root);
  const provider = createProvider(
    options.providerId ?? DEFAULT_AUTONOMOUS_PROVIDER,
    runner,
  );
  let inventory = await discoverProject(root, runner);
  let decision = decideNextAction(inventory);
  if (options.dryRun) return renderDryRun(inventory, decision, provider.id);
  const release = await acquireAutopilotLock(root, runner);
  const ciRepairRounds = new Map<string, number>();
  try {
    if (options.issueReceiptOnly) {
      const task = inventory.activeTask;
      if (!task) throw new Error('AUTOPILOT_ACTIVE_TASK_REQUIRED');
      const generated = await leaseForTask(inventory, task, runner, provider);
      return generated.binding.launchReceiptId!;
    }
    const detection = provider.detect();
    if (!detection.available || !provider.executePayload)
      throw new Error(
        `AUTONOMOUS_PROVIDER_UNAVAILABLE:${provider.id}:${detection.detail}`,
      );
    for (
      let cycle = 0;
      cycle < (options.maxCycles ?? Number.POSITIVE_INFINITY);
      cycle += 1
    ) {
      inventory = await discoverProject(root, runner);
      if (inventory.activeTask) {
        await ensureLease(root, runner, inventory.activeTask);
        inventory = await discoverProject(root, runner);
        if (
          inventory.activeTask &&
          (await bindCompletedCorrection(root, runner, inventory.activeTask))
        )
          continue;
      }
      decision = decideNextAction(inventory);
      if (
        decision.action === 'STOP' &&
        decision.reason.startsWith('UNRESOLVED_BLOCKED_TASKS:') &&
        (await resolveSpecificationGap(
          root,
          runner,
          provider,
          inventory,
          policy,
        ))
      )
        continue;
      if (decision.action === 'CORRECT_TASK' && decision.task) {
        const rounds = (
          await correctionReceipts(root, runner, decision.task)
        ).length;
        if (
          decision.task.contract.dependencyGroup !== 'FW' &&
          rounds >= policy.limits.taskCorrectionRounds
        )
          throw new Error(
            `AUTOPILOT_CORRECTION_LIMIT:${decision.task.contract.id}:${rounds}`,
          );
      }
      const reviewing =
        decision.action === 'REVIEW_CLUSTER' ? decision.cluster : undefined;
      const integrating =
        decision.action === 'CREATE_CLUSTER_PR' ? decision.cluster : undefined;
      await executeOrchestration(root, runner, {
        dryRun: false,
        provider,
      });
      if (reviewing) await reviewCluster(root, runner, provider, reviewing);
      if (integrating && policy.allowAutonomousCiRepair) {
        const failure = failedClusterPullRequest(runner, root, integrating);
        if (failure) {
          const round = (ciRepairRounds.get(integrating.contract.id) ?? 0) + 1;
          if (round > policy.limits.clusterCiCorrectionRounds)
            throw new Error(
              `AUTOPILOT_CLUSTER_CI_REPAIR_LIMIT:${integrating.contract.id}:${round - 1}`,
            );
          ciRepairRounds.set(integrating.contract.id, round);
          await repairClusterCi(
            root,
            runner,
            provider,
            integrating,
            failure,
            round,
          );
          continue;
        }
      }
      if (decision.action === 'COMPLETE_PROJECT') return 'AUTOPILOT_COMPLETE';
      if (decision.action === 'CREATE_CLUSTER_PR')
        await sleep(options.pollMilliseconds ?? 15_000);
    }
    return 'AUTOPILOT_CYCLE_LIMIT';
  } finally {
    await release();
  }
};
