import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProject } from '../agent/lib/discovery.js';
import { decideNextAction } from '../agent/lib/engine.js';
import { executeOrchestration, leaseForTask, renderDryRun } from '../agent/lib/executor.js';
import { agentRuntimeRoot, listLaunchReceiptCandidates } from '../agent/lib/runtime.js';
import { CodexProvider } from '../agent/providers/codex.js';
import type { CommandResult, CommandRunner, TaskRecord } from '../agent/lib/types.js';
import { computeAutopilotWorkspaceHashes } from '../agent/lib/workspace-hash.js';
import { acquireAutopilotLock } from './lock.js';

export const DEFAULT_AUTONOMOUS_PROVIDER = 'codex' as const;
export const MAX_PRODUCT_CORRECTION_ROUNDS = 3;
export const ANTIGRAVITY_MODEL_STATUS = 'ANTIGRAVITY_MODEL_NOT_PROGRAMMATICALLY_ENFORCEABLE' as const;
// FW-AUTOPILOT-001: one command owns discovery, execution, verification, merge, and continuation.
// FW-AUTOPILOT-002: lease renewal and exact-state recovery remain invisible to the owner.
// FW-AUTOPILOT-003: corrections retain strict bindings and product work stops after three rounds.
// FW-AUTOPILOT-004: Codex is headless by default; unsupported Antigravity model control is explicit.
export const correctionRoundAllowed = (completedRounds: number): boolean =>
  completedRounds + 1 <= MAX_PRODUCT_CORRECTION_ROUNDS;

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sleep = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0) throw new Error(`${code}:${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};
const pnpm = (runner: CommandRunner, root: string, args: string[]): string =>
  requireSuccess(runner.run('pnpm', ['--silent', ...args], { cwd: root }), `AUTOPILOT_COMMAND_FAILED:${args.join(':')}`);

const ensureLease = async (root: string, runner: CommandRunner, task: TaskRecord): Promise<void> => {
  const state = task.state;
  if (!state.expiresAt || !state.leaseId || !state.holder || !state.baseCommit || !state.branch) return;
  const remaining = Date.parse(state.expiresAt) - Date.now();
  if (remaining > 10 * 60_000) return;
  if (remaining > 0) {
    const alreadyRenewed = state.renewal?.resultingLeaseId === state.leaseId &&
      state.renewal.resultingFencingVersion === state.leaseVersion;
    if (!alreadyRenewed) {
      pnpm(runner, root, ['agent:renew', '--', task.contract.id, '--expected-lease-id', state.leaseId, '--expected-fencing-version', String(state.leaseVersion), '--holder', state.holder, '--ttl-minutes', '120']);
      return;
    }
    await sleep(remaining + 1_000);
  }
  const workspace = task.workspace;
  const hashes = await computeAutopilotWorkspaceHashes(workspace);
  const head = requireSuccess(runner.run('git', ['rev-parse', 'HEAD'], { cwd: workspace }), 'AUTOPILOT_HEAD_FAILED');
  const tree = requireSuccess(runner.run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: workspace }), 'AUTOPILOT_TREE_FAILED');
  const contractPath = `tasks/${task.contract.dependencyGroup}/${task.contract.id}.contract.json`;
  const contextPath = `artifacts/context/${task.contract.id}/context-manifest.json`;
  const contractHash = hash(await readFile(join(workspace, contractPath)));
  const contextHash = hash(await readFile(join(workspace, contextPath)));
  pnpm(runner, root, ['agent:recover', '--', task.contract.id, '--expected-expired-lease-id', state.leaseId, '--expected-fencing-version', String(state.leaseVersion), '--holder', state.holder, '--expected-task-state', state.state, '--expected-task-branch', state.branch, '--expected-task-worktree', workspace, '--expected-lifecycle-base-commit', state.baseCommit, '--expected-task-head-commit', head, '--expected-task-head-tree', tree, '--expected-tracked-work-sha256', hashes.tracked, '--expected-untracked-work-sha256', hashes.untracked, '--expected-legacy-contract-sha256', contractHash, '--expected-legacy-context-sha256', contextHash, '--ttl-minutes', '120']);
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
  const correction = value.correction as { previousCommit?: unknown; failureCodes?: unknown } | undefined;
  return ['antigravity', 'codex', 'zcode'].includes(String(value.provider)) &&
    typeof correction?.previousCommit === 'string' &&
    Array.isArray(correction.failureCodes) &&
    (!binding.taskId || value.taskId === binding.taskId) &&
    (!binding.holder || value.holder === binding.holder) &&
    (!binding.leaseId || value.leaseId === binding.leaseId) &&
    (!binding.fencingVersion || value.fencingVersion === binding.fencingVersion) &&
    (!binding.worktree || value.taskWorktree === binding.worktree) &&
    (!binding.previousCommit || correction.previousCommit === binding.previousCommit) &&
    (!binding.failureCode || correction.failureCodes.includes(binding.failureCode));
};

const correctionReceipts = async (root: string, runner: CommandRunner, task: TaskRecord) =>
  (await listLaunchReceiptCandidates(root, runner, task.contract.id)).filter(({ value }) =>
    correctionReceiptMatches(value, {
      taskId: task.contract.id,
      holder: task.state.holder!,
      leaseId: task.state.leaseId!,
      fencingVersion: task.state.leaseVersion,
      worktree: task.workspace,
    }),
  );

const bindCompletedCorrection = async (root: string, runner: CommandRunner, task: TaskRecord): Promise<boolean> => {
  const previous = task.state.commit;
  if (task.state.state !== 'SELF_REVIEWING' || !previous || !task.workspaceHead || previous === task.workspaceHead) return false;
  const receipts = await correctionReceipts(root, runner, task);
  const candidate = receipts.find(({ value }) => correctionReceiptMatches(value, { previousCommit: previous }));
  const failureCode = (candidate?.value.correction as { failureCodes?: string[] } | undefined)?.failureCodes?.[0];
  if (!failureCode) throw new Error('AUTOPILOT_CORRECTION_RECEIPT_MISSING');
  pnpm(runner, root, ['task:self-review-correct', task.contract.id, '--holder', task.state.holder!, '--lease-version', String(task.state.leaseVersion), '--target-worktree', task.workspace, '--expected-previous-commit', previous, '--failure-code', failureCode]);
  return true;
};

export interface AutopilotOptions {
  dryRun?: boolean;
  issueReceiptOnly?: boolean;
  maxCycles?: number;
  pollMilliseconds?: number;
}

export const runAutopilot = async (
  root: string,
  runner: CommandRunner,
  options: AutopilotOptions = {},
): Promise<string> => {
  const provider = new CodexProvider(runner);
  let inventory = await discoverProject(root, runner);
  let decision = decideNextAction(inventory);
  if (options.dryRun) return renderDryRun(inventory, decision, provider.id);
  const release = await acquireAutopilotLock(root, runner);
  try {
    if (options.issueReceiptOnly) {
      const task = inventory.activeTask;
      if (!task) throw new Error('AUTOPILOT_ACTIVE_TASK_REQUIRED');
      const generated = await leaseForTask(inventory, task, runner, provider);
      return generated.binding.launchReceiptId!;
    }
    const detection = provider.detect();
    if (!detection.available) throw new Error(`CODEX_CLI_MISSING:${detection.detail}`);
    for (let cycle = 0; cycle < (options.maxCycles ?? Number.POSITIVE_INFINITY); cycle += 1) {
      inventory = await discoverProject(root, runner);
      if (inventory.activeTask) {
        await ensureLease(root, runner, inventory.activeTask);
        inventory = await discoverProject(root, runner);
        if (inventory.activeTask && await bindCompletedCorrection(root, runner, inventory.activeTask)) continue;
      }
      decision = decideNextAction(inventory);
      if (decision.action === 'CORRECT_TASK' && decision.task) {
        const rounds = (await correctionReceipts(root, runner, decision.task)).length;
        if (decision.task.contract.dependencyGroup !== 'FW' && !correctionRoundAllowed(rounds))
          throw new Error(`AUTOPILOT_CORRECTION_LIMIT:${decision.task.contract.id}:${rounds}`);
      }
      const reviewing = decision.action === 'REVIEW_CLUSTER' ? decision.cluster : undefined;
      await executeOrchestration(root, runner, { dryRun: false, provider });
      if (reviewing) {
        const reviewPath = join(agentRuntimeRoot(root, runner), 'cluster-reviews', `${reviewing.contract.id}.review-instructions.md`);
        const result = provider.executePayload!(reviewing.branch.worktree, `Read and obey ${reviewPath}. Perform the independent review autonomously, create the exact review artifact, commit only that artifact, and stop.`);
        requireSuccess(result, 'AUTOPILOT_CLUSTER_REVIEW_FAILED');
      }
      if (decision.action === 'COMPLETE_PROJECT') return 'AUTOPILOT_COMPLETE';
      if (decision.action === 'CREATE_CLUSTER_PR') await sleep(options.pollMilliseconds ?? 15_000);
    }
    return 'AUTOPILOT_CYCLE_LIMIT';
  } finally {
    await release();
  }
};
