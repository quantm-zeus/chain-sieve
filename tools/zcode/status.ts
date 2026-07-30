import { discoverProject } from './lib/discovery.js';
import { statusView } from './lib/engine.js';
import { errorCode } from './lib/errors.js';
import { findRepositoryRoot } from './lib/paths.js';
import { SystemCommandRunner } from './lib/system.js';

try {
  const root = findRepositoryRoot();
  const inventory = await discoverProject(root, new SystemCommandRunner());
  const status = statusView(inventory);
  const currentTask = status.currentTask;
  const lease = !currentTask?.state.expiresAt
    ? 'none'
    : Date.parse(currentTask.state.expiresAt) <= Date.now()
      ? 'expired'
      : currentTask.state.leaseState === 'ACTIVE'
        ? 'active'
        : 'none';
  console.log(
    `Project progress: ${status.completedTasks}/${status.totalTasks} tasks`,
  );
  console.log(
    `Clusters complete: ${status.completedClusters}/${status.totalClusters}`,
  );
  console.log(
    `Current cluster: ${status.currentCluster?.contract.id ?? 'none'}`,
  );
  console.log(`Current task: ${currentTask?.contract.id ?? 'none'}`);
  console.log(`Task state: ${currentTask?.state.state ?? 'none'}`);
  console.log(`Lease: ${lease}`);
  console.log(`Fencing version: ${currentTask?.state.leaseVersion ?? 'none'}`);
  console.log(
    `Cluster branch: ${status.currentCluster?.branch.branch ?? 'none'}`,
  );
  console.log(
    `Cluster worktree: ${status.currentCluster?.branch.worktree ?? 'none'}`,
  );
  console.log(`Next task: ${status.nextTask?.contract.id ?? 'none'}`);
  console.log(`Next cluster: ${status.nextCluster?.contract.id ?? 'none'}`);
  console.log(`Root checkout: ${inventory.rootBranch}`);
  console.log(`Root working tree: ${inventory.rootDirty ? 'dirty' : 'clean'}`);
  console.log(
    `Cluster working tree: ${
      status.currentCluster?.worktreeDirty === undefined
        ? 'none'
        : status.currentCluster.worktreeDirty
          ? 'dirty'
          : 'clean'
    }`,
  );
  console.log(`Next action: ${status.nextAction}`);
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
