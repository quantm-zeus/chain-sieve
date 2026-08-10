import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProject } from '../agent/lib/discovery.js';
import { executeOrchestration } from '../agent/lib/executor.js';
import { agentRuntimeRoot } from '../agent/lib/runtime.js';
import type { CommandRunner } from '../agent/lib/types.js';
import { createProvider } from '../agent/providers/index.js';
import { loadAutonomyPolicy, type AutonomyPolicy } from '../autopilot/policy.js';
import { runSupervisedProductFactory } from './recovery-supervisor.js';

const ESCALATION_STATE_FILE = 'autonomous-escalation.json';

export type AutonomousEscalationStage =
  | 'TASK_FALLBACK'
  | 'DEGRADED_RECOVERY'
  | 'EXHAUSTED';

export interface AutonomousEscalationRecord {
  fingerprint: string;
  failureCode: string;
  attempts: number;
  lastStage: Exclude<AutonomousEscalationStage, 'EXHAUSTED'>;
  rootHead: string;
  taskId?: string;
  taskHead?: string;
  updatedAt: string;
}

interface AutonomousEscalationState {
  schemaVersion: '1.0.0';
  records: Record<string, AutonomousEscalationRecord>;
}

const ESCALATABLE_FAILURE_MARKERS = [
  'MUSE_TASK_CALL_BUDGET_EXHAUSTED',
  'MUSE_DUPLICATE_TASK_EVIDENCE_BLOCKED',
  'MUSE_SEMANTIC_CALL_BUDGET_EXHAUSTED',
  'MUSE_DUPLICATE_SEMANTIC_EVIDENCE_BLOCKED',
  'MUSE_PROVIDER_RETRY_STORM',
  'MUSE_HARD_TIMEOUT',
  'AUTOPILOT_CORRECTION_LIMIT',
  'AUTOPILOT_CLUSTER_CI_REPAIR_LIMIT',
  'PRODUCT_FACTORY_CONVERGENCE_LIMIT',
  'PRODUCT_FACTORY_SUPERVISOR_RECOVERY_LIMIT',
  'PRODUCT_FACTORY_SUPERVISOR_GLOBAL_RECOVERY_LIMIT',
  'PRODUCT_FACTORY_RECOVERY_CI_LIMIT',
] as const;

export const isAutonomousEscalationFailure = (failure: string): boolean =>
  ESCALATABLE_FAILURE_MARKERS.some((marker) => failure.includes(marker));

export const selectAutonomousEscalationStage = (
  attempt: number,
  hasActiveTask: boolean,
  policy: Pick<AutonomyPolicy, 'limits'>,
): AutonomousEscalationStage => {
  const taskRounds = hasActiveTask ? policy.limits.taskEscalationRounds : 0;
  if (hasActiveTask && attempt <= taskRounds) return 'TASK_FALLBACK';
  if (attempt <= taskRounds + policy.limits.degradedRecoveryRounds)
    return 'DEGRADED_RECOVERY';
  return 'EXHAUSTED';
};

export const autonomousEscalationFingerprint = (input: {
  failure: string;
  rootHead: string;
  taskId?: string;
  taskHead?: string;
}): string => {
  const failureCode = input.failure.split(':')[0] ?? input.failure;
  const raw = [
    failureCode,
    input.rootHead,
    input.taskId ?? 'project',
    input.taskHead ?? 'no-task-head',
  ].join(':');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
};

const statePath = (root: string, runner: CommandRunner): string =>
  join(agentRuntimeRoot(root, runner), ESCALATION_STATE_FILE);

const readState = async (
  root: string,
  runner: CommandRunner,
): Promise<AutonomousEscalationState> => {
  try {
    const parsed = JSON.parse(
      await readFile(statePath(root, runner), 'utf8'),
    ) as AutonomousEscalationState;
    if (parsed.schemaVersion !== '1.0.0' || !parsed.records)
      throw new Error('invalid');
    return parsed;
  } catch {
    return { schemaVersion: '1.0.0', records: {} };
  }
};

const writeState = async (
  root: string,
  runner: CommandRunner,
  state: AutonomousEscalationState,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  await mkdir(runtime, { recursive: true });
  const finalPath = statePath(root, runner);
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, finalPath);
  } finally {
    await rm(temporary, { force: true });
  }
};

const requireAntigravity = (runner: CommandRunner) => {
  const provider = createProvider('antigravity', runner);
  const detection = provider.detect();
  if (!detection.available || !provider.executePayload)
    throw new Error(
      `AUTONOMOUS_ESCALATION_PROVIDER_UNAVAILABLE:${detection.detail}`,
    );
  return provider;
};

export const runAutonomousEscalation = async (
  root: string,
  runner: CommandRunner,
  failure: string,
  options: { maxCorrectionRounds?: number } = {},
): Promise<AutonomousEscalationStage> => {
  if (!isAutonomousEscalationFailure(failure))
    throw new Error(`AUTONOMOUS_ESCALATION_NOT_ELIGIBLE:${failure}`);

  const policy = await loadAutonomyPolicy(root);
  const inventory = await discoverProject(root, runner);
  const activeTask = inventory.activeTask;
  const fingerprint = autonomousEscalationFingerprint({
    failure,
    rootHead: inventory.rootHead,
    ...(activeTask ? { taskId: activeTask.contract.id } : {}),
    ...(activeTask?.workspaceHead
      ? { taskHead: activeTask.workspaceHead }
      : {}),
  });
  const state = await readState(root, runner);
  const existing = state.records[fingerprint];
  const attempt = (existing?.attempts ?? 0) + 1;
  const stage = selectAutonomousEscalationStage(
    attempt,
    Boolean(activeTask),
    policy,
  );
  if (stage === 'EXHAUSTED')
    throw new Error(
      `AUTONOMOUS_ESCALATION_EXHAUSTED:${fingerprint}:${attempt - 1}:${failure.split(':')[0] ?? failure}`,
    );

  state.records[fingerprint] = {
    fingerprint,
    failureCode: failure.split(':')[0] ?? failure,
    attempts: attempt,
    lastStage: stage,
    rootHead: inventory.rootHead,
    ...(activeTask ? { taskId: activeTask.contract.id } : {}),
    ...(activeTask?.workspaceHead
      ? { taskHead: activeTask.workspaceHead }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeState(root, runner, state);

  const antigravity = requireAntigravity(runner);
  console.log(
    `CHAINSIEVE_AUTONOMOUS_ESCALATION:${stage}:${attempt}:${fingerprint}:${failure.split(':')[0] ?? failure}`,
  );

  if (stage === 'TASK_FALLBACK') {
    await executeOrchestration(root, runner, {
      dryRun: false,
      provider: antigravity,
    });
    return stage;
  }

  await runSupervisedProductFactory(root, runner, {
    providerId: 'antigravity',
    maxCorrectionRounds: Math.min(options.maxCorrectionRounds ?? 1, 1),
  });
  return stage;
};
