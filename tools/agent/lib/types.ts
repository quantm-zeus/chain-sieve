import type { ClusterContract, TaskContract } from '@ciag/shared-schemas';
import type { TaskState } from '../../task-runner/state.js';

export type ClusterLifecycleState =
  | 'UNPREPARED'
  | 'READY'
  | 'ACTIVE'
  | 'VERIFYING'
  | 'REVIEW_REQUIRED'
  | 'CI_PENDING'
  | 'CI_FAILED'
  | 'COMPLETE';

export interface ReleaseBinding {
  tag: string;
  tagObject: string;
  commit: string;
  tree: string;
}

export interface BranchInterface {
  branch: string;
  integrationTarget: string;
  worktree: string;
}

export interface ClusterRecord {
  contract: ClusterContract;
  contractPath: string;
  goalPath: string;
  branch: BranchInterface;
  state: ClusterLifecycleState;
  branchHead?: string;
  localBranchHead?: string;
  remoteBranchHead?: string;
  branchRemoteState?: 'ALIGNED' | 'LOCAL_AHEAD' | 'REMOTE_AHEAD' | 'DIVERGED';
  worktreeHead?: string;
  worktreeBranch?: string;
  worktreeDirty?: boolean;
  worktreeChanges?: string[];
  worktreeRegistered?: boolean;
  worktreeForeign?: boolean;
  conflictingWorktree?: string;
}

export interface TaskRecord {
  contract: TaskContract;
  contractPath: string;
  contextPath: string;
  contextManifestPath: string;
  contextManifestSha256: string;
  conformanceManifestPath?: string;
  conformanceManifestSha256?: string;
  compatibilityMigration?: 'LEGACY_ACTIVE_CONTRACT';
  cluster: ClusterRecord;
  state: TaskState;
  dependencyWave: number;
  priority: number;
  workspace: string;
  workspaceExists: boolean;
  workspaceRegistered?: boolean;
  workspaceForeign?: boolean;
  conflictingWorkspace?: string;
  workspaceBranch?: string;
  workspaceHead?: string;
  workspaceTree?: string;
  workspaceDirty?: boolean;
  workspaceChanges?: string[];
  commitCountFromBase?: number;
}

export interface InventoryCoverage {
  requirements: { accounted: number; total: number; missing: string[] };
  acceptanceCriteria: { accounted: number; total: number; missing: string[] };
}

export interface ProjectInventory {
  root: string;
  rootBranch: string;
  rootHead: string;
  rootTree: string;
  rootDirty: boolean;
  rootChanges: string[];
  worktreeRoot: string;
  release: ReleaseBinding;
  clusters: ClusterRecord[];
  tasks: TaskRecord[];
  coverage: InventoryCoverage;
  activeTask?: TaskRecord;
  clusterOrder: string[];
}

export type OrchestrationAction =
  | 'RESUME_TASK'
  | 'CONTINUE_TASK'
  | 'CORRECT_TASK'
  | 'VERIFY_TASK'
  | 'START_TASK'
  | 'INITIALIZE_CLUSTER'
  | 'VERIFY_CLUSTER'
  | 'REVIEW_CLUSTER'
  | 'CREATE_CLUSTER_PR'
  | 'WAIT_FOR_CI'
  | 'REPAIR_CI'
  | 'MERGE_CLUSTER'
  | 'COMPLETE_PROJECT'
  | 'STOP';

export interface Decision {
  action: OrchestrationAction;
  reason: string;
  cluster?: ClusterRecord;
  task?: TaskRecord;
  nextCluster?: ClusterRecord;
  nextTask?: TaskRecord;
  taskWorkspace?: string;
  failures?: string[];
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string },
  ): CommandResult;
}

export interface PullRequestState {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  checks: Array<{
    name: string;
    state: 'PENDING' | 'PASS' | 'FAIL';
    required: boolean;
  }>;
  mergeCommit?: string;
}

export interface PayloadBinding {
  task: TaskRecord;
  release: ReleaseBinding;
  taskWorkspace: string;
  leaseId: string;
  holder: string;
  fencingVersion: number;
  expiresAt: string;
  baseCommit: string;
  baseTree: string;
  goalPath: string;
  goalSha256: string;
  contextManifestPath: string;
  contextManifestSha256: string;
  conformanceManifestPath?: string;
  conformanceManifestSha256?: string;
  taskContractPath: string;
  taskContractSha256: string;
  lifecycleBindingPath: string;
  lifecycleBindingSha256: string;
  verificationBaselinePath: string;
  verificationBaselineSha256: string;
  controlPlaneCommit: string;
  controlPlaneTree: string;
  launchReceiptId?: string;
  launchReceiptSha256?: string;
  failures: string[];
}

export type AgentProviderId = 'antigravity' | 'codex' | 'zcode';

export interface ProviderDetection {
  available: boolean;
  mechanism: 'command' | 'application' | 'missing';
  command?: string;
  application?: string;
  bundleIdentifier?: string;
  detail: string;
}

export type TaskLaunchBinding = PayloadBinding;

/** Desktop/model concerns only. Lifecycle authority remains in tools/agent/lib. */
export interface AgentProvider {
  readonly id: AgentProviderId;
  detect(): ProviderDetection;
  generatePayload(binding: TaskLaunchBinding): string;
  copyPayload(payload: string): void;
  openWorkspace(workspace: string): void;
  renderOwnerInstruction(taskId: string, clusterId: string): string;
}

export interface StatusView {
  nextAction: OrchestrationAction;
  completedTasks: number;
  totalTasks: number;
  completedClusters: number;
  totalClusters: number;
  currentCluster?: ClusterRecord;
  currentTask?: TaskRecord;
  nextTask?: TaskRecord;
  nextCluster?: ClusterRecord;
}
