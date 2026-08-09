import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentRuntimeRoot } from '../agent/lib/runtime.js';
import type {
  AgentProviderId,
  CommandRunner,
  Decision,
  ProjectInventory,
} from '../agent/lib/types.js';

export type TelemetrySeverity = 'info' | 'warn' | 'error';

const compactText = (value: string, limit = 1_000): string =>
  [...value]
    .filter((character) => character !== '\r' && character.charCodeAt(0) !== 0)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

export const telemetryError = (error: unknown, limit = 2_000): string => {
  if (error instanceof Error) return compactText(`${error.name}:${error.message}`, limit);
  return compactText(String(error), limit);
};

export const emitTelemetry = (
  event: string,
  fields: Record<string, unknown> = {},
  severity: TelemetrySeverity = 'info',
): void => {
  const payload = {
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    event,
    severity,
    pid: process.pid,
    ...fields,
  };
  const line = `CHAINSIEVE_EVENT:${JSON.stringify(payload)}`;
  if (severity === 'error') console.error(line);
  else console.log(line);
};

export type AutopilotPhase =
  | 'TASK_PREPARE'
  | 'TASK_IMPLEMENT'
  | 'TASK_VERIFY'
  | 'CLUSTER_VERIFY'
  | 'CLUSTER_REVIEW'
  | 'CLUSTER_CI'
  | 'CLUSTER_MERGE'
  | 'PROJECT_FINAL_CI'
  | 'PROJECT_COMPLETE'
  | 'BLOCKED';

export const phaseForAction = (action: Decision['action']): AutopilotPhase => {
  switch (action) {
    case 'INITIALIZE_CLUSTER':
    case 'START_TASK':
      return 'TASK_PREPARE';
    case 'RESUME_TASK':
    case 'CONTINUE_TASK':
    case 'CORRECT_TASK':
      return 'TASK_IMPLEMENT';
    case 'VERIFY_TASK':
      return 'TASK_VERIFY';
    case 'VERIFY_CLUSTER':
      return 'CLUSTER_VERIFY';
    case 'REVIEW_CLUSTER':
      return 'CLUSTER_REVIEW';
    case 'CREATE_CLUSTER_PR':
    case 'WAIT_FOR_CI':
    case 'REPAIR_CI':
      return 'CLUSTER_CI';
    case 'MERGE_CLUSTER':
      return 'CLUSTER_MERGE';
    case 'COMPLETE_PROJECT':
      return 'PROJECT_FINAL_CI';
    case 'STOP':
      return 'BLOCKED';
  }
};

interface LifecycleCounts {
  [state: string]: number;
}

export interface AutopilotProgressSnapshot {
  schemaVersion: '1.0.0';
  timestamp: string;
  cycle: number;
  provider: AgentProviderId;
  action: Decision['action'];
  phase: AutopilotPhase;
  reason: string;
  rootHead: string;
  tasks: {
    completed: number;
    total: number;
    percent: number;
    states: LifecycleCounts;
  };
  clusters: {
    completed: number;
    total: number;
    percent: number;
    states: LifecycleCounts;
  };
  coverage: {
    requirements: { accounted: number; total: number };
    acceptanceCriteria: { accounted: number; total: number };
  };
  currentTask?: {
    id: string;
    state: string;
    branch?: string;
    head?: string;
    dirty?: boolean;
    commitsFromBase?: number;
  };
  currentCluster?: {
    id: string;
    state: string;
    branch: string;
    head?: string;
  };
}

const counts = (values: string[]): LifecycleCounts =>
  values.reduce<LifecycleCounts>((result, state) => {
    result[state] = (result[state] ?? 0) + 1;
    return result;
  }, {});

const percent = (completed: number, total: number): number =>
  total === 0 ? 100 : Math.round((completed / total) * 10_000) / 100;

export const buildAutopilotProgressSnapshot = (
  inventory: ProjectInventory,
  decision: Decision,
  provider: AgentProviderId,
  cycle: number,
): AutopilotProgressSnapshot => {
  const task = decision.task ?? decision.nextTask ?? inventory.activeTask;
  const cluster = decision.cluster ?? decision.nextCluster ?? task?.cluster;
  const completedTasks = inventory.tasks.filter(
    (candidate) => candidate.state.state === 'MERGED',
  ).length;
  const completedClusters = inventory.clusters.filter(
    (candidate) => candidate.state === 'COMPLETE',
  ).length;

  return {
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    cycle,
    provider,
    action: decision.action,
    phase: phaseForAction(decision.action),
    reason: compactText(decision.reason, 500),
    rootHead: inventory.rootHead,
    tasks: {
      completed: completedTasks,
      total: inventory.tasks.length,
      percent: percent(completedTasks, inventory.tasks.length),
      states: counts(inventory.tasks.map((candidate) => candidate.state.state)),
    },
    clusters: {
      completed: completedClusters,
      total: inventory.clusters.length,
      percent: percent(completedClusters, inventory.clusters.length),
      states: counts(inventory.clusters.map((candidate) => candidate.state)),
    },
    coverage: {
      requirements: {
        accounted: inventory.coverage.requirements.accounted,
        total: inventory.coverage.requirements.total,
      },
      acceptanceCriteria: {
        accounted: inventory.coverage.acceptanceCriteria.accounted,
        total: inventory.coverage.acceptanceCriteria.total,
      },
    },
    ...(task
      ? {
          currentTask: {
            id: task.contract.id,
            state: task.state.state,
            ...(task.state.branch ? { branch: task.state.branch } : {}),
            ...(task.workspaceHead ? { head: task.workspaceHead } : {}),
            ...(task.workspaceDirty !== undefined ? { dirty: task.workspaceDirty } : {}),
            ...(task.commitCountFromBase !== undefined
              ? { commitsFromBase: task.commitCountFromBase }
              : {}),
          },
        }
      : {}),
    ...(cluster
      ? {
          currentCluster: {
            id: cluster.contract.id,
            state: cluster.state,
            branch: cluster.branch.branch,
            ...(cluster.worktreeHead || cluster.branchHead
              ? { head: cluster.worktreeHead ?? cluster.branchHead }
              : {}),
          },
        }
      : {}),
  };
};

const progressPath = (root: string, runner: CommandRunner): string =>
  join(agentRuntimeRoot(root, runner), 'autopilot-progress.json');

export const persistAutopilotProgress = async (
  root: string,
  runner: CommandRunner,
  snapshot: AutopilotProgressSnapshot,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  await mkdir(runtime, { recursive: true });
  const target = progressPath(root, runner);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const emitAutopilotProgress = (snapshot: AutopilotProgressSnapshot): void => {
  console.log(`CHAINSIEVE_PROGRESS:${JSON.stringify(snapshot)}`);
  const task = snapshot.currentTask
    ? `${snapshot.currentTask.id}/${snapshot.currentTask.state}`
    : '-';
  const cluster = snapshot.currentCluster
    ? `${snapshot.currentCluster.id}/${snapshot.currentCluster.state}`
    : '-';
  console.log(
    `CHAINSIEVE_PROGRESS_SUMMARY:cycle=${snapshot.cycle} phase=${snapshot.phase} action=${snapshot.action} tasks=${snapshot.tasks.completed}/${snapshot.tasks.total}(${snapshot.tasks.percent}%) clusters=${snapshot.clusters.completed}/${snapshot.clusters.total}(${snapshot.clusters.percent}%) task=${task} cluster=${cluster} head=${snapshot.rootHead.slice(0, 12)}`,
  );
};
