import { discoverProject } from './lib/discovery.js';
import { decideNextAction, statusView } from './lib/engine.js';
import { errorCode } from './lib/errors.js';
import { findRepositoryRoot } from './lib/paths.js';
import { SystemCommandRunner } from './lib/system.js';
import {
  buildAutopilotProgressSnapshot,
  telemetryError,
} from '../observability/progress.js';

const has = (flag: string): boolean => process.argv.includes(flag);
const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const intervalMilliseconds = (): number => {
  const raw = value('--interval-ms') ?? '5000';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 60_000)
    throw new Error(`STATUS_INTERVAL_INVALID:${raw}`);
  return parsed;
};

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const short = (sha?: string): string => (sha ? sha.slice(0, 12) : 'none');

const stateCounts = (states: Record<string, number>): string =>
  Object.entries(states)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}=${count}`)
    .join(' ');

const renderHuman = async (): Promise<void> => {
  const root = findRepositoryRoot();
  const runner = new SystemCommandRunner();
  const inventory = await discoverProject(root, runner);
  const decision = decideNextAction(inventory);
  const status = statusView(inventory);
  const snapshot = buildAutopilotProgressSnapshot(
    inventory,
    decision,
    'muse',
    0,
  );
  const currentTask = status.currentTask ?? decision.task ?? decision.nextTask;
  const currentCluster = status.currentCluster ?? decision.cluster ?? decision.nextCluster;
  const expiresAt = currentTask?.state.expiresAt;
  const lease = !expiresAt
    ? 'none'
    : Date.parse(expiresAt) <= Date.now()
      ? 'expired'
      : currentTask.state.leaseState === 'ACTIVE'
        ? 'active'
        : currentTask.state.leaseState ?? 'none';
  const lastTransition = currentTask?.state.history?.at(-1);
  const processes = runner.run(
    'pgrep',
    ['-af', 'muse|agy|product-factory/cli|product:autopilot'],
    { timeoutMilliseconds: 5_000 },
  );

  console.log(`\n=== ChainSieve live status @ ${new Date().toISOString()} ===`);
  console.log(
    `Overall: tasks ${snapshot.tasks.completed}/${snapshot.tasks.total} (${snapshot.tasks.percent}%) | clusters ${snapshot.clusters.completed}/${snapshot.clusters.total} (${snapshot.clusters.percent}%)`,
  );
  console.log(`Phase: ${snapshot.phase} | Next action: ${decision.action}`);
  console.log(`Reason: ${decision.reason}`);
  console.log(
    `Coverage: requirements ${snapshot.coverage.requirements.accounted}/${snapshot.coverage.requirements.total} | acceptance ${snapshot.coverage.acceptanceCriteria.accounted}/${snapshot.coverage.acceptanceCriteria.total}`,
  );
  console.log(`Task states: ${stateCounts(snapshot.tasks.states) || 'none'}`);
  console.log(`Cluster states: ${stateCounts(snapshot.clusters.states) || 'none'}`);
  console.log('--- Current task ---');
  console.log(`ID/state: ${currentTask?.contract.id ?? 'none'} / ${currentTask?.state.state ?? 'none'}`);
  console.log(`Branch/head: ${currentTask?.state.branch ?? 'none'} / ${short(currentTask?.workspaceHead)}`);
  console.log(
    `Worktree: ${currentTask?.workspace ?? 'none'} | ${currentTask?.workspaceDirty === undefined ? 'unknown' : currentTask.workspaceDirty ? 'DIRTY' : 'clean'} | commits-from-base=${currentTask?.commitCountFromBase ?? 'unknown'}`,
  );
  if (currentTask?.workspaceChanges?.length)
    console.log(`Changed: ${currentTask.workspaceChanges.slice(0, 20).join(', ')}`);
  console.log(
    `Lease: ${lease} | holder=${currentTask?.state.holder ?? 'none'} | fencing=${currentTask?.state.leaseVersion ?? 'none'} | expires=${expiresAt ?? 'none'}`,
  );
  console.log(
    `Last transition: ${lastTransition ? `${lastTransition.from}->${lastTransition.to} @ ${lastTransition.at} via ${lastTransition.command}` : 'none'}`,
  );
  console.log('--- Current cluster ---');
  console.log(`ID/state: ${currentCluster?.contract.id ?? 'none'} / ${currentCluster?.state ?? 'none'}`);
  console.log(
    `Branch/head: ${currentCluster?.branch.branch ?? 'none'} / ${short(currentCluster?.worktreeHead ?? currentCluster?.branchHead)}`,
  );
  console.log(
    `Worktree: ${currentCluster?.branch.worktree ?? 'none'} | ${currentCluster?.worktreeDirty === undefined ? 'unknown' : currentCluster.worktreeDirty ? 'DIRTY' : 'clean'}`,
  );
  console.log('--- Control plane ---');
  console.log(`Root: ${inventory.rootBranch}@${short(inventory.rootHead)} | ${inventory.rootDirty ? 'DIRTY' : 'clean'}`);
  console.log(`Next task: ${status.nextTask?.contract.id ?? 'none'} | Next cluster: ${status.nextCluster?.contract.id ?? 'none'}`);
  console.log(`Active processes: ${processes.status === 0 && processes.stdout.trim() ? processes.stdout.trim().replace(/\n/g, ' | ') : 'none'}`);
};

const renderJson = async (): Promise<void> => {
  const root = findRepositoryRoot();
  const runner = new SystemCommandRunner();
  const inventory = await discoverProject(root, runner);
  const decision = decideNextAction(inventory);
  const snapshot = buildAutopilotProgressSnapshot(inventory, decision, 'muse', 0);
  console.log(JSON.stringify(snapshot, null, 2));
};

try {
  const watch = has('--watch');
  const json = has('--json');
  const interval = intervalMilliseconds();
  do {
    try {
      if (json) await renderJson();
      else await renderHuman();
    } catch (error) {
      console.error(`STATUS_REFRESH_FAILED:${telemetryError(error)}`);
      if (!watch) throw error;
    }
    if (watch) await sleep(interval);
  } while (watch);
} catch (error) {
  console.error(errorCode(error));
  process.exitCode = 1;
}
