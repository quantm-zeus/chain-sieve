import { describe, expect, it } from 'vitest';
import {
  buildAutopilotProgressSnapshot,
  phaseForAction,
  telemetryError,
} from '../../tools/observability/progress.js';
import type {
  Decision,
  ProjectInventory,
} from '../../tools/agent/lib/types.js';

const inventory = (): ProjectInventory =>
  ({
    root: '/repo',
    rootBranch: 'main',
    rootHead: 'a'.repeat(40),
    rootTree: 'b'.repeat(40),
    rootDirty: false,
    rootChanges: [],
    worktreeRoot: '/repo-worktrees',
    release: {
      tag: 'harness-v1.0.1',
      tagObject: 'c'.repeat(40),
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
    },
    coverage: {
      requirements: { accounted: 10, total: 12, missing: ['REQ-11', 'REQ-12'] },
      acceptanceCriteria: { accounted: 20, total: 20, missing: [] },
    },
    clusterOrder: ['C-G0', 'C-G1'],
    clusters: [
      {
        contract: { id: 'C-G0' },
        contractPath: 'clusters/C-G0.json',
        goalPath: 'clusters/C-G0.md',
        branch: {
          branch: 'cluster/g0',
          integrationTarget: 'main',
          worktree: '/repo-worktrees/g0',
        },
        state: 'ACTIVE',
        worktreeHead: 'f'.repeat(40),
      },
      {
        contract: { id: 'C-G1' },
        contractPath: 'clusters/C-G1.json',
        goalPath: 'clusters/C-G1.md',
        branch: {
          branch: 'cluster/g1',
          integrationTarget: 'main',
          worktree: '/repo-worktrees/g1',
        },
        state: 'COMPLETE',
      },
    ],
    tasks: [
      {
        contract: { id: 'T-G0-01', cluster: 'C-G0' },
        contractPath: 'tasks/g0/T-G0-01.json',
        contextPath: 'context',
        contextManifestPath: 'manifest',
        contextManifestSha256: '1'.repeat(64),
        cluster: {
          contract: { id: 'C-G0' },
          contractPath: 'clusters/C-G0.json',
          goalPath: 'clusters/C-G0.md',
          branch: {
            branch: 'cluster/g0',
            integrationTarget: 'main',
            worktree: '/repo-worktrees/g0',
          },
          state: 'ACTIVE',
          worktreeHead: 'f'.repeat(40),
        },
        state: {
          taskId: 'T-G0-01',
          state: 'IMPLEMENTING',
          leaseVersion: 2,
          branch: 'task/t-g0-01',
        },
        dependencyWave: 0,
        priority: 1,
        workspace: '/repo-worktrees/g0/.worktrees/T-G0-01',
        workspaceExists: true,
        workspaceHead: '9'.repeat(40),
        workspaceDirty: false,
        commitCountFromBase: 1,
      },
      {
        contract: { id: 'T-G1-01', cluster: 'C-G1' },
        contractPath: 'tasks/g1/T-G1-01.json',
        contextPath: 'context',
        contextManifestPath: 'manifest',
        contextManifestSha256: '2'.repeat(64),
        cluster: {
          contract: { id: 'C-G1' },
          contractPath: 'clusters/C-G1.json',
          goalPath: 'clusters/C-G1.md',
          branch: {
            branch: 'cluster/g1',
            integrationTarget: 'main',
            worktree: '/repo-worktrees/g1',
          },
          state: 'COMPLETE',
        },
        state: {
          taskId: 'T-G1-01',
          state: 'MERGED',
          leaseVersion: 1,
        },
        dependencyWave: 1,
        priority: 1,
        workspace: '/repo-worktrees/g1/.worktrees/T-G1-01',
        workspaceExists: false,
      },
    ],
  }) as unknown as ProjectInventory;

describe('product progress observability', () => {
  it('maps lifecycle actions to understandable phases', () => {
    expect(phaseForAction('CONTINUE_TASK')).toBe('TASK_IMPLEMENT');
    expect(phaseForAction('VERIFY_TASK')).toBe('TASK_VERIFY');
    expect(phaseForAction('WAIT_FOR_CI')).toBe('CLUSTER_CI');
    expect(phaseForAction('COMPLETE_PROJECT')).toBe('PROJECT_FINAL_CI');
  });

  it('reports durable task, cluster, coverage, and current-target progress', () => {
    const project = inventory();
    const decision = {
      action: 'CONTINUE_TASK',
      reason: 'active implementation has a committed checkpoint',
      task: project.tasks[0],
      cluster: project.clusters[0],
    } as Decision;
    const snapshot = buildAutopilotProgressSnapshot(project, decision, 'muse', 7);

    expect(snapshot).toMatchObject({
      cycle: 7,
      provider: 'muse',
      phase: 'TASK_IMPLEMENT',
      action: 'CONTINUE_TASK',
      tasks: { completed: 1, total: 2, percent: 50 },
      clusters: { completed: 1, total: 2, percent: 50 },
      coverage: {
        requirements: { accounted: 10, total: 12 },
        acceptanceCriteria: { accounted: 20, total: 20 },
      },
      currentTask: {
        id: 'T-G0-01',
        state: 'IMPLEMENTING',
        branch: 'task/t-g0-01',
        dirty: false,
        commitsFromBase: 1,
      },
      currentCluster: {
        id: 'C-G0',
        state: 'ACTIVE',
        branch: 'cluster/g0',
      },
    });
    expect(snapshot.tasks.states).toEqual({ IMPLEMENTING: 1, MERGED: 1 });
    expect(snapshot.clusters.states).toEqual({ ACTIVE: 1, COMPLETE: 1 });
  });

  it('renders bounded single-line errors for journal telemetry', () => {
    expect(telemetryError(new Error('line one\nline two'))).toBe(
      'Error:line one line two',
    );
  });
});
