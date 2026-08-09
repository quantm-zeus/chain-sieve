import { describe, expect, it } from 'vitest';
import { clusterNeedsInitialization, decideNextAction } from '../../tools/agent/lib/engine.js';
import type {
  ClusterRecord,
  ProjectInventory,
  TaskRecord,
} from '../../tools/agent/lib/types.js';

const cluster = (worktreeRegistered: boolean): ClusterRecord =>
  ({
    contract: {
      id: 'C-FW-AUTOPILOT',
      dependencies: [],
    },
    contractPath: 'clusters/FW/C-FW-AUTOPILOT.contract.json',
    goalPath: 'clusters/FW/C-FW-AUTOPILOT.agent-goal.md',
    branch: {
      branch: 'cluster/fw',
      integrationTarget: 'main',
      worktree: '/tmp/worktrees/fw',
    },
    state: 'READY',
    branchHead: 'legacy-head',
    worktreeRegistered,
  }) as unknown as ClusterRecord;

const task = (owner: ClusterRecord): TaskRecord =>
  ({
    contract: {
      id: 'T-FW-AUTOPILOT',
      cluster: owner.contract.id,
      dependencies: [],
      specificationStatus: 'READY',
    },
    contractPath: 'tasks/FW/T-FW-AUTOPILOT.contract.json',
    contextPath: 'artifacts/context/T-FW-AUTOPILOT',
    contextManifestPath:
      'artifacts/context/T-FW-AUTOPILOT/context-manifest.json',
    contextManifestSha256: 'a'.repeat(64),
    cluster: owner,
    state: {
      taskId: 'T-FW-AUTOPILOT',
      state: 'DRAFT',
      leaseVersion: 0,
      history: [],
    },
    dependencyWave: 0,
    priority: 0,
    workspace: '/tmp/worktrees/fw/tasks/T-FW-AUTOPILOT',
    workspaceExists: false,
  }) as unknown as TaskRecord;

const inventory = (owner: ClusterRecord): ProjectInventory =>
  ({
    root: '/repo',
    rootBranch: 'main',
    rootHead: 'main-head',
    rootTree: 'main-tree',
    rootDirty: false,
    rootChanges: [],
    worktreeRoot: '/tmp/worktrees',
    release: {
      tag: 'harness-v1',
      tagObject: 'tag',
      commit: 'release',
      tree: 'release-tree',
    },
    clusters: [owner],
    tasks: [task(owner)],
    coverage: {
      requirements: { accounted: 1, total: 1, missing: [] },
      acceptanceCriteria: { accounted: 1, total: 1, missing: [] },
    },
    clusterOrder: [owner.contract.id],
  }) as ProjectInventory;

describe('cluster bootstrap state', () => {
  it('treats an existing legacy branch with no registered worktree as bootstrap state', () => {
    const owner = cluster(false);
    expect(clusterNeedsInitialization(owner)).toBe(true);
    expect(decideNextAction(inventory(owner))).toMatchObject({
      action: 'INITIALIZE_CLUSTER',
      reason: 'DEPENDENCY_READY_CLUSTER_WORKTREE_MISSING',
      cluster: owner,
    });
  });

  it('does not reinitialize a registered READY cluster merely because tasks are not runnable', () => {
    const owner = cluster(true);
    expect(clusterNeedsInitialization(owner)).toBe(false);
    expect(decideNextAction(inventory(owner))).toMatchObject({
      action: 'STOP',
      reason: 'NO_RUNNABLE_TASK_IN_CLUSTER:C-FW-AUTOPILOT',
    });
  });
});
