import type {
  ProjectInventory,
  Decision,
  StatusView,
  TaskRecord,
  ClusterRecord,
} from './types.js';
import { isManagedTaskWorkspace, taskBranch } from './paths.js';

const protectedStates = new Set([
  'LEASED',
  'IMPLEMENTING',
  'SELF_REVIEWING',
  'VERIFYING',
  'VERIFIED',
  'MERGE_QUEUED',
]);

const taskOrder = (left: TaskRecord, right: TaskRecord): number =>
  left.dependencyWave - right.dependencyWave ||
  left.priority - right.priority ||
  left.contract.id.localeCompare(right.contract.id);

const dependenciesMerged = (
  inventory: ProjectInventory,
  task: TaskRecord,
): boolean =>
  task.contract.dependencies.every(
    (dependency) =>
      inventory.tasks.find((candidate) => candidate.contract.id === dependency)
        ?.state.state === 'MERGED',
  );

const clusterDependenciesComplete = (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
): boolean =>
  cluster.contract.dependencies.every(
    (dependency) =>
      inventory.clusters.find(
        (candidate) => candidate.contract.id === dependency,
      )?.state === 'COMPLETE',
  );

export const runnableTasks = (
  inventory: ProjectInventory,
  cluster: ClusterRecord,
): TaskRecord[] =>
  inventory.tasks
    .filter(
      (task) =>
        task.contract.cluster === cluster.contract.id &&
        task.state.state === 'READY' &&
        task.contract.specificationStatus !== 'SPECIFICATION_GAP' &&
        dependenciesMerged(inventory, task),
    )
    .sort(taskOrder);

export const dependencyReadyClusters = (
  inventory: ProjectInventory,
): ClusterRecord[] =>
  inventory.clusters.filter(
    (cluster) =>
      cluster.state !== 'COMPLETE' &&
      clusterDependenciesComplete(inventory, cluster),
  );

const activeDecision = (
  inventory: ProjectInventory,
  task: TaskRecord,
  now: Date,
): Decision => {
  const state = task.state;
  const workspace = task.workspace;
  if (!protectedStates.has(state.state))
    return {
      action: 'STOP',
      reason: `ACTIVE_TASK_STATE_INVALID:${state.state}`,
      task,
      cluster: task.cluster,
    };
  if (!state.expiresAt || Date.parse(state.expiresAt) <= now.getTime())
    return {
      action: 'STOP',
      reason: 'LEASE_EXPIRED:AUTHORITATIVE_RECOVERY_REQUIRED',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (
    !state.leaseId ||
    !state.holder ||
    state.leaseVersion < 1 ||
    state.leaseState !== 'ACTIVE'
  )
    return {
      action: 'STOP',
      reason: 'LEASE_OR_FENCING_BINDING_INVALID',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (!task.workspaceExists)
    return {
      action: 'STOP',
      reason: `TASK_WORKTREE_MISSING:${workspace ?? 'unknown'}`,
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (!isManagedTaskWorkspace(task.cluster.branch.worktree, workspace))
    return {
      action: 'STOP',
      reason: `TASK_WORKTREE_OUTSIDE_CLUSTER_PLANE:${workspace}`,
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  const expectedBranch = taskBranch(task.contract.id);
  if (
    task.workspaceBranch !== expectedBranch ||
    state.branch !== expectedBranch
  )
    return {
      action: 'STOP',
      reason: `TASK_BRANCH_MISMATCH:${task.workspaceBranch ?? 'detached'}:${expectedBranch}`,
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (state.worktree && state.worktree !== workspace)
    return {
      action: 'STOP',
      reason: `TASK_WORKTREE_MISMATCH:${state.worktree}:${workspace ?? 'unknown'}`,
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (task.commitCountFromBase !== undefined && task.commitCountFromBase > 1)
    return {
      action: 'CORRECT_TASK',
      reason: 'TASK_COMMIT_NOT_ATOMIC',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
      failures: ['More than one task commit exists above the task base.'],
    };
  if (state.state === 'LEASED')
    return {
      action: 'RESUME_TASK',
      reason: 'LEASED_TASK_AWAITS_BEGIN',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (
    state.state === 'IMPLEMENTING' &&
    (task.workspaceDirty || (task.commitCountFromBase ?? 0) > 0)
  )
    return {
      action: 'CONTINUE_TASK',
      reason: 'UNFINISHED_IMPLEMENTATION_PRESENT',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (state.state === 'IMPLEMENTING')
    return {
      action: 'RESUME_TASK',
      reason: 'IMPLEMENTATION_ACTIVE',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
    };
  if (task.workspaceDirty)
    return {
      action: 'CORRECT_TASK',
      reason: 'DIRTY_WORKTREE_AFTER_IMPLEMENTATION',
      task,
      cluster: task.cluster,
      taskWorkspace: workspace,
      failures: task.workspaceChanges ?? [],
    };
  if (['VERIFIED', 'MERGE_QUEUED'].includes(state.state)) {
    if (!state.commit || state.commit !== task.workspaceHead)
      return {
        action: 'CORRECT_TASK',
        reason: 'TASK_RESULT_GENERATED_FOR_ANOTHER_COMMIT',
        task,
        cluster: task.cluster,
        taskWorkspace: workspace,
        failures: [
          'Verified evidence is not bound to the current task commit.',
        ],
      };
    if (!state.tree || state.tree !== task.workspaceTree)
      return {
        action: 'CORRECT_TASK',
        reason: 'TASK_RESULT_GENERATED_FOR_ANOTHER_TREE',
        task,
        cluster: task.cluster,
        taskWorkspace: workspace,
        failures: ['Verified evidence is not bound to the current Git tree.'],
      };
    if (
      !state.taskResultEvidence ||
      state.taskResultEvidence.status !== 'CURRENT' ||
      state.taskResultEvidence.commit !== state.commit ||
      state.taskResultEvidence.tree !== state.tree ||
      !state.verificationEvidence ||
      state.verificationEvidence.status !== 'CURRENT'
    )
      return {
        action: 'CORRECT_TASK',
        reason: 'TASK_EVIDENCE_MISSING_OR_STALE',
        task,
        cluster: task.cluster,
        taskWorkspace: workspace,
        failures: [
          'Proof-carrying task evidence is missing, stale, or bound to another commit/tree.',
        ],
      };
  }
  return {
    action: 'VERIFY_TASK',
    reason: `TASK_LIFECYCLE_${state.state}`,
    task,
    cluster: task.cluster,
    taskWorkspace: workspace,
  };
};

export const decideNextAction = (
  inventory: ProjectInventory,
  now = new Date(),
): Decision => {
  if (inventory.activeTask)
    return activeDecision(inventory, inventory.activeTask, now);
  if (inventory.tasks.every((task) => task.state.state === 'MERGED')) {
    const incomplete = inventory.clusters.find(
      (cluster) => cluster.state !== 'COMPLETE',
    );
    if (!incomplete)
      return {
        action: 'COMPLETE_PROJECT',
        reason: 'ALL_GENERATED_TASKS_AND_CLUSTERS_COMPLETE',
      };
  }
  const readyClusters = dependencyReadyClusters(inventory);
  const current = readyClusters[0];
  if (!current)
    return {
      action: 'STOP',
      reason: 'NO_DEPENDENCY_READY_CLUSTER',
    };
  const clusterTasks = inventory.tasks.filter(
    (task) => task.contract.cluster === current.contract.id,
  );
  if (clusterTasks.every((task) => task.state.state === 'MERGED')) {
    if (current.state === 'VERIFYING')
      return {
        action: 'VERIFY_CLUSTER',
        reason: 'CLUSTER_TASKS_MERGED',
        cluster: current,
      };
    if (current.state === 'REVIEW_REQUIRED')
      return {
        action: 'REVIEW_CLUSTER',
        reason: 'INDEPENDENT_CLUSTER_REVIEW_REQUIRED',
        cluster: current,
      };
    return {
      action: 'CREATE_CLUSTER_PR',
      reason: 'CLUSTER_REVIEW_PASSED',
      cluster: current,
    };
  }
  if (current.state === 'UNPREPARED') {
    const draft = clusterTasks
      .filter((task) =>
        ['DRAFT', 'VALIDATED', 'READY'].includes(task.state.state),
      )
      .sort(taskOrder)[0];
    return {
      action: 'INITIALIZE_CLUSTER',
      reason: 'DEPENDENCY_READY_CLUSTER_NOT_PREPARED',
      cluster: current,
      nextCluster: current,
      ...(draft ? { task: draft, nextTask: draft } : {}),
    };
  }
  const runnable = runnableTasks(inventory, current);
  if (runnable[0])
    return {
      action: 'START_TASK',
      reason: 'RUNNABLE_TASK_SELECTED',
      cluster: current,
      task: runnable[0],
      nextTask: runnable[0],
      taskWorkspace: runnable[0].workspace,
    };
  const blocked = clusterTasks.filter((task) => task.state.state === 'BLOCKED');
  if (blocked.length > 0)
    return {
      action: 'STOP',
      reason: `UNRESOLVED_BLOCKED_TASKS:${blocked.map((task) => task.contract.id).join(',')}`,
      cluster: current,
    };
  return {
    action: 'STOP',
    reason: `NO_RUNNABLE_TASK_IN_CLUSTER:${current.contract.id}`,
    cluster: current,
  };
};

export const statusView = (inventory: ProjectInventory): StatusView => {
  const decision = decideNextAction(inventory);
  return {
    nextAction: decision.action,
    completedTasks: inventory.tasks.filter(
      (task) => task.state.state === 'MERGED',
    ).length,
    totalTasks: inventory.tasks.length,
    completedClusters: inventory.clusters.filter(
      (cluster) => cluster.state === 'COMPLETE',
    ).length,
    totalClusters: inventory.clusters.length,
    ...(inventory.activeTask?.cluster
      ? { currentCluster: inventory.activeTask.cluster }
      : decision.cluster
        ? { currentCluster: decision.cluster }
        : {}),
    ...(inventory.activeTask ? { currentTask: inventory.activeTask } : {}),
    ...(decision.nextTask ? { nextTask: decision.nextTask } : {}),
    ...(decision.nextCluster ? { nextCluster: decision.nextCluster } : {}),
  };
};
