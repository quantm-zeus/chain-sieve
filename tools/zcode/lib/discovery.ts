import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import {
  ClusterContractSchema,
  TaskContractSchema,
  type ClusterContract,
  type TaskContract,
} from '@ciag/shared-schemas';
import type { LifecycleDocument, TaskState } from '../../task-runner/state.js';
import { ZCodeError } from './errors.js';
import {
  defaultWorktreeRoot,
  taskBranch,
  taskWorkspacePath,
} from './paths.js';
import type {
  BranchInterface,
  ClusterLifecycleState,
  ClusterRecord,
  CommandRunner,
  ProjectInventory,
  ReleaseBinding,
  TaskRecord,
} from './types.js';

interface RawClusterContract extends Record<string, unknown> {
  id?: unknown;
  group?: unknown;
  branchInterface?: {
    branch?: unknown;
    integrationTarget?: unknown;
    integrationBase?: unknown;
    worktree?: unknown;
  };
  integrationTarget?: unknown;
}

interface Graph {
  nodes: Array<{ id: string; group?: string; cluster?: string }>;
  edges: Array<{ from: string; to: string }>;
}

interface WorktreeBlock {
  worktree: string;
  head?: string;
  branch?: string;
}

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

const verifySourceIntegrity = async (
  root: string,
): Promise<TaskContract['sourceHashes']> => {
  const specRoot = join(root, 'docs', 'spec');
  const sums = (await readFile(join(specRoot, 'SHA256SUMS'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([^/]+)$/.exec(line);
      if (!match) throw new ZCodeError('SPEC_CHECKSUM_MANIFEST_INVALID', line);
      return { sha256: match[1]!, file: match[2]! };
    });
  if (sums.length === 0) throw new ZCodeError('SPEC_CHECKSUM_MANIFEST_EMPTY');
  for (const item of sums) {
    const bytes = await readFile(join(specRoot, item.file));
    if (sha256(bytes) !== item.sha256)
      throw new ZCodeError('SPEC_SOURCE_DRIFT', item.file);
  }
  const prd = sums.find((item) => item.file.endsWith('.md'))?.sha256;
  const requirements = sums.find((item) =>
    item.file.endsWith('.requirements.json'),
  )?.sha256;
  const audit = sums.find((item) => item.file.endsWith('.audit.json'))?.sha256;
  if (!prd || !requirements || !audit)
    throw new ZCodeError('SPEC_CHECKSUM_BINDINGS_INCOMPLETE');
  return { prd, requirements, audit };
};

const git = (
  runner: CommandRunner,
  root: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): string => {
  const result = runner.run('git', args, { cwd: root });
  if (result.status !== 0 && !options.allowFailure)
    throw new ZCodeError('GIT_FAILED', args.join(' '), [result.stderr.trim()]);
  return result.stdout.trim();
};

const recursivelyFindContracts = async (
  directory: string,
  suffix: string,
): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      found.push(...(await recursivelyFindContracts(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path);
  }
  return found.sort();
};

const assertUnique = (values: string[], code: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ZCodeError(code, value);
    seen.add(value);
  }
};

export const topologicalOrder = (
  nodeIds: string[],
  edges: Array<{ from: string; to: string }>,
  code: string,
): string[] => {
  const nodes = new Set(nodeIds);
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to))
      throw new ZCodeError(`${code}_UNKNOWN_NODE`, `${edge.from}->${edge.to}`);
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  const queue = nodeIds.filter((id) => incoming.get(id) === 0).sort();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id)!.sort()) {
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  if (ordered.length !== nodeIds.length) throw new ZCodeError(`${code}_CYCLIC`);
  return ordered;
};

const dependencyWaves = (
  tasks: TaskContract[],
  graph: Graph,
): Map<string, number> => {
  const order = topologicalOrder(
    tasks.map((task) => task.id),
    graph.edges,
    'TASK_GRAPH',
  );
  const incoming = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const edge of graph.edges) incoming.get(edge.to)!.push(edge.from);
  const waves = new Map<string, number>();
  for (const id of order) {
    const parents = incoming.get(id)!;
    waves.set(
      id,
      parents.length === 0
        ? 0
        : Math.max(...parents.map((parent) => waves.get(parent)!)) + 1,
    );
  }
  return waves;
};

const parseWorktrees = (value: string): WorktreeBlock[] =>
  value
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const fields = Object.fromEntries(
        block
          .split('\n')
          .filter((line) => line.includes(' '))
          .map((line) => {
            const index = line.indexOf(' ');
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      );
      return {
        worktree: fields.worktree!,
        ...(fields.HEAD ? { head: fields.HEAD } : {}),
        ...(fields.branch
          ? { branch: fields.branch.replace(/^refs\/heads\//, '') }
          : {}),
      };
    });

const latestRelease = (runner: CommandRunner, root: string): ReleaseBinding => {
  const tags = git(runner, root, [
    'tag',
    '--list',
    'harness-v*',
    '--sort=-v:refname',
  ])
    .split('\n')
    .filter(Boolean);
  for (const tag of tags) {
    const commit = git(runner, root, ['rev-parse', `${tag}^{commit}`], {
      allowFailure: true,
    });
    if (!commit) continue;
    const reachable =
      runner.run(
        'git',
        ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main'],
        {
          cwd: root,
        },
      ).status === 0;
    if (!reachable) continue;
    return {
      tag,
      tagObject: git(runner, root, ['rev-parse', `refs/tags/${tag}`]),
      commit,
      tree: git(runner, root, ['rev-parse', `${commit}^{tree}`]),
    };
  }
  throw new ZCodeError('RELEASE_BASELINE_NOT_FOUND');
};

const branchFromGeneratedGoal = async (
  root: string,
  contract: ClusterContract,
): Promise<string | undefined> => {
  const path = join(
    root,
    'clusters',
    contract.group,
    `${contract.id}.zcode-goal.md`,
  );
  if (!existsSync(path)) return undefined;
  const match = (await readFile(path, 'utf8')).match(
    /`(cluster\/[a-z0-9._/-]+)`/i,
  );
  return match?.[1];
};

const branchInterface = async (
  root: string,
  worktreeRoot: string,
  rootBranch: string,
  raw: RawClusterContract,
  contract: ClusterContract,
): Promise<BranchInterface> => {
  const generated = await branchFromGeneratedGoal(root, contract);
  const configuredBranch =
    typeof raw.branchInterface?.branch === 'string'
      ? raw.branchInterface.branch
      : undefined;
  const branch = configuredBranch ?? generated;
  if (!branch || branch === 'main')
    throw new ZCodeError('CLUSTER_BRANCH_INTERFACE_MISSING', contract.id);
  const configuredTarget =
    typeof raw.branchInterface?.integrationTarget === 'string'
      ? raw.branchInterface.integrationTarget
      : typeof raw.branchInterface?.integrationBase === 'string'
        ? raw.branchInterface.integrationBase
        : typeof raw.integrationTarget === 'string'
          ? raw.integrationTarget
          : undefined;
  const integrationTarget =
    configuredTarget ?? (rootBranch === 'main' ? rootBranch : 'main');
  const configuredWorktree =
    typeof raw.branchInterface?.worktree === 'string'
      ? raw.branchInterface.worktree
      : undefined;
  const leaf = basename(branch);
  if (!leaf || leaf === '.' || leaf === '..')
    throw new ZCodeError('UNSAFE_CLUSTER_BRANCH', branch);
  const worktree = configuredWorktree
    ? resolve(root, configuredWorktree)
    : join(worktreeRoot, leaf);
  const safeWorktreeRoot = resolve(worktreeRoot);
  if (!resolve(worktree).startsWith(`${safeWorktreeRoot}/`))
    throw new ZCodeError('UNSAFE_CLUSTER_WORKTREE', worktree);
  return {
    branch,
    integrationTarget,
    worktree,
  };
};

const readLifecycle = async (
  runner: CommandRunner,
  root: string,
  tasks: TaskContract[],
): Promise<LifecycleDocument> => {
  const commonRaw = git(runner, root, ['rev-parse', '--git-common-dir']);
  const common = resolve(root, commonRaw);
  const path = join(common, 'ciag-runtime', 'task-state.json');
  let parsed: LifecycleDocument | undefined;
  try {
    parsed = await readJson<LifecycleDocument>(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (parsed && parsed.schemaVersion !== '2.0.0')
    throw new ZCodeError('TASK_STATE_SCHEMA_UNSUPPORTED', parsed.schemaVersion);
  const taskStates = parsed?.tasks ?? {};
  const allowedStates = new Set([
    'DRAFT',
    'VALIDATED',
    'READY',
    'LEASED',
    'IMPLEMENTING',
    'SELF_REVIEWING',
    'VERIFYING',
    'VERIFIED',
    'MERGE_QUEUED',
    'MERGED',
    'BLOCKED',
    'INTEGRATION_FAILED',
    'REVERTED_AFTER_INTEGRATION_FAILURE',
  ]);
  for (const task of tasks) {
    taskStates[task.id] ??= {
      taskId: task.id,
      state: 'DRAFT',
      leaseVersion: 0,
      history: [],
    };
    const state = taskStates[task.id]!;
    if (
      state.taskId !== task.id ||
      !allowedStates.has(state.state) ||
      !Number.isInteger(state.leaseVersion) ||
      state.leaseVersion < 0
    )
      throw new ZCodeError('TASK_STATE_INVALID', task.id);
  }
  return { schemaVersion: '2.0.0', tasks: taskStates };
};

const readPriority = async (
  runner: CommandRunner,
  root: string,
  cluster: ClusterContract,
  branch: string,
): Promise<Map<string, number>> => {
  const groupSlug = cluster.group.toLowerCase();
  const candidates = [
    `artifacts/handoff/${cluster.group}/${groupSlug}-execution-plan.json`,
    `artifacts/handoff/${cluster.group}/execution-plan.json`,
  ];
  for (const path of candidates) {
    const value = git(
      runner,
      root,
      ['show', `refs/remotes/origin/${branch}:${path}`],
      {
        allowFailure: true,
      },
    );
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as {
        operationalOrder?: string[];
        priorityOrder?: string[];
      };
      const order = parsed.priorityOrder ?? parsed.operationalOrder;
      if (order && new Set(order).size === order.length)
        return new Map(order.map((id, index) => [id, index]));
    } catch {
      throw new ZCodeError('CLUSTER_EXECUTION_PLAN_INVALID', path);
    }
  }
  return new Map(cluster.tasks.map((id, index) => [id, index]));
};

const clusterState = (
  cluster: ClusterContract,
  states: Record<string, TaskState>,
  branchHead: string | undefined,
  hasResult: boolean,
  hasReview: boolean,
  mergedIntoTarget: boolean,
): ClusterLifecycleState => {
  const values = cluster.tasks.map((id) => states[id]?.state ?? 'DRAFT');
  if (mergedIntoTarget && values.every((state) => state === 'MERGED'))
    return 'COMPLETE';
  if (!branchHead) return 'UNPREPARED';
  if (values.every((state) => state === 'MERGED')) {
    if (!hasReview) return 'REVIEW_REQUIRED';
    if (!hasResult) return 'VERIFYING';
    return 'READY';
  }
  if (
    values.some((state) =>
      [
        'LEASED',
        'IMPLEMENTING',
        'SELF_REVIEWING',
        'VERIFYING',
        'VERIFIED',
        'MERGE_QUEUED',
      ].includes(state),
    )
  )
    return 'ACTIVE';
  return 'READY';
};

const verifyContextManifest = async (
  root: string,
  task: TaskContract,
): Promise<{ path: string; sha256: string }> => {
  const contextPath = join(root, 'artifacts', 'context', task.id);
  const manifestPath = join(contextPath, 'context-manifest.json');
  const text = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(text) as {
    taskId: string;
    sourceHashes: TaskContract['sourceHashes'];
    files: Array<{ path: string; sha256: string; bytes: number }>;
  };
  if (manifest.taskId !== task.id)
    throw new ZCodeError('CONTEXT_TASK_MISMATCH', task.id);
  if (
    JSON.stringify(manifest.sourceHashes) !== JSON.stringify(task.sourceHashes)
  )
    throw new ZCodeError('CONTEXT_SOURCE_HASH_DRIFT', task.id);
  for (const file of manifest.files) {
    const target = resolve(contextPath, file.path);
    if (!target.startsWith(`${contextPath}/`))
      throw new ZCodeError('UNSAFE_CONTEXT_PATH', file.path);
    const bytes = await readFile(target);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256)
      throw new ZCodeError('CONTEXT_FILE_DRIFT', `${task.id}:${file.path}`);
  }
  return { path: relative(root, manifestPath), sha256: sha256(text) };
};

const assertGraphInventory = (
  taskGraph: Graph,
  clusterGraph: Graph,
  tasks: TaskContract[],
  clusters: ClusterContract[],
): { taskOrder: string[]; clusterOrder: string[] } => {
  assertUnique(
    tasks.map((task) => task.id),
    'DUPLICATE_TASK_ID',
  );
  assertUnique(
    clusters.map((cluster) => cluster.id),
    'DUPLICATE_CLUSTER_ID',
  );
  assertUnique(
    taskGraph.nodes.map((node) => node.id),
    'DUPLICATE_TASK_GRAPH_NODE',
  );
  assertUnique(
    clusterGraph.nodes.map((node) => node.id),
    'DUPLICATE_CLUSTER_GRAPH_NODE',
  );
  const contractTaskIds = tasks.map((task) => task.id).sort();
  const graphTaskIds = taskGraph.nodes.map((node) => node.id).sort();
  if (JSON.stringify(contractTaskIds) !== JSON.stringify(graphTaskIds))
    throw new ZCodeError('TASK_GRAPH_OMISSION');
  const contractClusterIds = clusters.map((cluster) => cluster.id).sort();
  const graphClusterIds = clusterGraph.nodes.map((node) => node.id).sort();
  if (JSON.stringify(contractClusterIds) !== JSON.stringify(graphClusterIds))
    throw new ZCodeError('CLUSTER_GRAPH_OMISSION');
  const assignments = new Map<string, number>();
  for (const cluster of clusters)
    for (const taskId of cluster.tasks)
      assignments.set(taskId, (assignments.get(taskId) ?? 0) + 1);
  for (const task of tasks) {
    if (assignments.get(task.id) !== 1)
      throw new ZCodeError('TASK_CLUSTER_ASSIGNMENT_INVALID', task.id);
    const graphNode = taskGraph.nodes.find((node) => node.id === task.id);
    if (graphNode?.cluster !== task.cluster)
      throw new ZCodeError('TASK_CLUSTER_GRAPH_MISMATCH', task.id);
    const graphDependencies = taskGraph.edges
      .filter((edge) => edge.to === task.id)
      .map((edge) => edge.from)
      .sort();
    if (
      JSON.stringify(graphDependencies) !==
      JSON.stringify([...task.dependencies].sort())
    )
      throw new ZCodeError('TASK_DEPENDENCY_GRAPH_MISMATCH', task.id);
  }
  for (const cluster of clusters) {
    const graphDependencies = clusterGraph.edges
      .filter((edge) => edge.to === cluster.id)
      .map((edge) => edge.from)
      .sort();
    if (
      JSON.stringify(graphDependencies) !==
      JSON.stringify([...cluster.dependencies].sort())
    )
      throw new ZCodeError('CLUSTER_DEPENDENCY_GRAPH_MISMATCH', cluster.id);
    const ownedTasks = tasks.filter((task) => task.cluster === cluster.id);
    const requirements = [
      ...new Set(ownedTasks.flatMap((task) => task.requirements)),
    ].sort();
    const acceptance = [
      ...new Set(ownedTasks.flatMap((task) => task.acceptanceCriteria)),
    ].sort();
    if (
      JSON.stringify(requirements) !==
      JSON.stringify([...cluster.requirements].sort())
    )
      throw new ZCodeError(
        'CLUSTER_REQUIREMENT_OWNERSHIP_MISMATCH',
        cluster.id,
      );
    if (
      JSON.stringify(acceptance) !==
      JSON.stringify([...cluster.acceptanceCriteria].sort())
    )
      throw new ZCodeError('CLUSTER_ACCEPTANCE_OWNERSHIP_MISMATCH', cluster.id);
  }
  return {
    taskOrder: topologicalOrder(contractTaskIds, taskGraph.edges, 'TASK_GRAPH'),
    clusterOrder: topologicalOrder(
      contractClusterIds,
      clusterGraph.edges,
      'CLUSTER_GRAPH',
    ),
  };
};

const coverage = async (
  root: string,
  tasks: TaskContract[],
): Promise<ProjectInventory['coverage']> => {
  const spec = await readJson<{
    requirements: Array<{ id: string }>;
    acceptanceCriteria: Array<{ id: string }>;
  }>(
    join(
      root,
      'docs/spec/crypto_intelligence_agent_gateway_PRD_FINAL_v6.0.requirements.json',
    ),
  );
  const requirementOwners = new Map<string, number>();
  const acceptanceOwners = new Map<string, number>();
  for (const task of tasks) {
    for (const id of task.requirements)
      requirementOwners.set(id, (requirementOwners.get(id) ?? 0) + 1);
    for (const id of task.acceptanceCriteria)
      acceptanceOwners.set(id, (acceptanceOwners.get(id) ?? 0) + 1);
  }
  const badRequirements = spec.requirements
    .filter((item) => requirementOwners.get(item.id) !== 1)
    .map((item) => item.id);
  const badAcceptance = spec.acceptanceCriteria
    .filter((item) => acceptanceOwners.get(item.id) !== 1)
    .map((item) => item.id);
  const unknownRequirements = [...requirementOwners.keys()].filter(
    (id) => !spec.requirements.some((item) => item.id === id),
  );
  const unknownAcceptance = [...acceptanceOwners.keys()].filter(
    (id) => !spec.acceptanceCriteria.some((item) => item.id === id),
  );
  const missingRequirements = [
    ...badRequirements,
    ...unknownRequirements,
  ].sort();
  const missingAcceptance = [...badAcceptance, ...unknownAcceptance].sort();
  if (missingRequirements.length > 0)
    throw new ZCodeError('REQUIREMENT_OMISSION', missingRequirements.join(','));
  if (missingAcceptance.length > 0)
    throw new ZCodeError(
      'ACCEPTANCE_CRITERION_OMISSION',
      missingAcceptance.join(','),
    );
  return {
    requirements: {
      accounted: requirementOwners.size,
      total: spec.requirements.length,
      missing: [],
    },
    acceptanceCriteria: {
      accounted: acceptanceOwners.size,
      total: spec.acceptanceCriteria.length,
      missing: [],
    },
  };
};

export const discoverProject = async (
  root: string,
  runner: CommandRunner,
): Promise<ProjectInventory> => {
  const rootBranch = git(runner, root, ['branch', '--show-current']);
  const rootHead = git(runner, root, ['rev-parse', 'HEAD']);
  const rootTree = git(runner, root, ['rev-parse', 'HEAD^{tree}']);
  const rootStatus = git(runner, root, ['status', '--porcelain=v1']);
  const rootChanges = rootStatus.split('\n').filter(Boolean);
  const worktreeRoot = defaultWorktreeRoot(root);
  const sourceHashes = await verifySourceIntegrity(root);
  const taskPaths = await recursivelyFindContracts(
    join(root, 'tasks'),
    '.contract.json',
  );
  const clusterPaths = await recursivelyFindContracts(
    join(root, 'clusters'),
    '.contract.json',
  );
  const tasks: TaskContract[] = [];
  for (const path of taskPaths)
    tasks.push(TaskContractSchema.parse(await readJson<unknown>(path)));
  const clusterInputs: Array<{
    contract: ClusterContract;
    raw: RawClusterContract;
    path: string;
  }> = [];
  for (const path of clusterPaths) {
    const raw = await readJson<RawClusterContract>(path);
    clusterInputs.push({
      contract: ClusterContractSchema.parse(raw),
      raw,
      path,
    });
  }
  tasks.sort((left, right) => left.id.localeCompare(right.id));
  clusterInputs.sort((left, right) =>
    left.contract.id.localeCompare(right.contract.id),
  );
  for (const task of tasks)
    if (JSON.stringify(task.sourceHashes) !== JSON.stringify(sourceHashes))
      throw new ZCodeError('TASK_SOURCE_HASH_DRIFT', task.id);
  for (const cluster of clusterInputs)
    if (
      JSON.stringify(cluster.contract.sourceHashes) !==
      JSON.stringify(sourceHashes)
    )
      throw new ZCodeError('CLUSTER_SOURCE_HASH_DRIFT', cluster.contract.id);
  const taskGraph = await readJson<Graph>(
    join(root, 'tasks/generated/graph.json'),
  );
  const clusterGraph = await readJson<Graph>(
    join(root, 'tasks/generated/cluster-graph.json'),
  );
  const { clusterOrder } = assertGraphInventory(
    taskGraph,
    clusterGraph,
    tasks,
    clusterInputs.map((item) => item.contract),
  );
  const waves = dependencyWaves(tasks, taskGraph);
  const lifecycle = await readLifecycle(runner, root, tasks);
  const worktrees = parseWorktrees(
    git(runner, root, ['worktree', 'list', '--porcelain']),
  );
  const release = latestRelease(runner, root);
  const clusterRecords: ClusterRecord[] = [];
  const priorities = new Map<string, Map<string, number>>();
  for (const input of clusterInputs) {
    const branch = await branchInterface(
      root,
      worktreeRoot,
      rootBranch,
      input.raw,
      input.contract,
    );
    priorities.set(
      input.contract.id,
      await readPriority(runner, root, input.contract, branch.branch),
    );
    const localRef = `refs/heads/${branch.branch}`;
    const remoteRef = `refs/remotes/origin/${branch.branch}`;
    const localBranchHead =
      git(runner, root, ['rev-parse', '--verify', localRef], {
        allowFailure: true,
      }) || undefined;
    const remoteBranchHead =
      git(runner, root, ['rev-parse', '--verify', remoteRef], {
        allowFailure: true,
      }) || undefined;
    const branchHead = localBranchHead ?? remoteBranchHead;
    let branchRemoteState: ClusterRecord['branchRemoteState'];
    if (localBranchHead && remoteBranchHead) {
      if (localBranchHead === remoteBranchHead) branchRemoteState = 'ALIGNED';
      else if (
        runner.run(
          'git',
          ['merge-base', '--is-ancestor', remoteBranchHead, localBranchHead],
          { cwd: root },
        ).status === 0
      )
        branchRemoteState = 'LOCAL_AHEAD';
      else if (
        runner.run(
          'git',
          ['merge-base', '--is-ancestor', localBranchHead, remoteBranchHead],
          { cwd: root },
        ).status === 0
      )
        branchRemoteState = 'REMOTE_AHEAD';
      else branchRemoteState = 'DIVERGED';
    }
    const registered = worktrees.find(
      (item) => resolve(item.worktree) === resolve(branch.worktree),
    );
    const branchRegistration = worktrees.find(
      (item) => item.branch === branch.branch,
    );
    const conflictingWorktree =
      branchRegistration &&
      resolve(branchRegistration.worktree) !== resolve(branch.worktree)
        ? branchRegistration.worktree
        : undefined;
    let worktreeHead = registered?.head;
    let worktreeBranch = registered?.branch;
    let worktreeDirty: boolean | undefined;
    let worktreeChanges: string[] | undefined;
    let worktreeForeign = false;
    if (existsSync(branch.worktree)) {
      const directHead = git(runner, branch.worktree, ['rev-parse', 'HEAD'], {
        allowFailure: true,
      });
      const directBranch = git(
        runner,
        branch.worktree,
        ['branch', '--show-current'],
        {
          allowFailure: true,
        },
      );
      if (directHead) worktreeHead = directHead;
      if (directBranch) worktreeBranch = directBranch;
      const status = git(
        runner,
        branch.worktree,
        ['status', '--porcelain=v1'],
        {
          allowFailure: true,
        },
      );
      worktreeChanges = status.split('\n').filter(Boolean);
      worktreeDirty = worktreeChanges.length > 0;
      worktreeForeign = !registered && Boolean(directHead);
    }
    const commonRaw = git(runner, root, ['rev-parse', '--git-common-dir']);
    const common = resolve(root, commonRaw);
    const resultPath = join(
      common,
      'ciag-runtime',
      'cluster-results',
      `${input.contract.id}.result.json`,
    );
    const reviewPath = join(
      root,
      'artifacts/reviews/clusters',
      `${input.contract.id}.review.json`,
    );
    const targetRef =
      git(
        runner,
        root,
        [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${branch.integrationTarget}`,
        ],
        {
          allowFailure: true,
        },
      ) ||
      git(
        runner,
        root,
        ['rev-parse', '--verify', `refs/heads/${branch.integrationTarget}`],
        {
          allowFailure: true,
        },
      );
    const mergedIntoTarget =
      Boolean(branchHead && targetRef) &&
      runner.run(
        'git',
        ['merge-base', '--is-ancestor', branchHead!, targetRef],
        { cwd: root },
      ).status === 0;
    clusterRecords.push({
      contract: input.contract,
      contractPath: relative(root, input.path),
      goalPath: `clusters/${input.contract.group}/${input.contract.id}.zcode-goal.md`,
      branch,
      state: clusterState(
        input.contract,
        lifecycle.tasks,
        branchHead,
        existsSync(resultPath),
        existsSync(reviewPath),
        mergedIntoTarget,
      ),
      ...(branchHead ? { branchHead } : {}),
      ...(localBranchHead ? { localBranchHead } : {}),
      ...(remoteBranchHead ? { remoteBranchHead } : {}),
      ...(branchRemoteState ? { branchRemoteState } : {}),
      ...(worktreeHead ? { worktreeHead } : {}),
      ...(worktreeBranch ? { worktreeBranch } : {}),
      ...(worktreeDirty === undefined ? {} : { worktreeDirty }),
      ...(worktreeChanges ? { worktreeChanges } : {}),
      worktreeRegistered: Boolean(registered),
      worktreeForeign,
      ...(conflictingWorktree ? { conflictingWorktree } : {}),
    });
  }
  assertUnique(
    clusterRecords.map((cluster) => cluster.branch.branch),
    'DUPLICATE_CLUSTER_BRANCH',
  );
  assertUnique(
    clusterRecords.map((cluster) => resolve(cluster.branch.worktree)),
    'DUPLICATE_CLUSTER_WORKTREE',
  );
  const taskRecords: TaskRecord[] = [];
  for (const task of tasks) {
    const cluster = clusterRecords.find(
      (item) => item.contract.id === task.cluster,
    );
    if (!cluster) throw new ZCodeError('TASK_CLUSTER_MISSING', task.id);
    const context = await verifyContextManifest(root, task);
    const lifecycleState = lifecycle.tasks[task.id]!;
    const workspace =
      lifecycleState.worktree ??
      taskWorkspacePath(cluster.branch.worktree, task.id);
    const workspaceExists = existsSync(workspace);
    const workspaceRegistration = worktrees.find(
      (item) => resolve(item.worktree) === resolve(workspace),
    );
    const taskBranchRegistration = worktrees.find(
      (item) => item.branch === taskBranch(task.id),
    );
    const conflictingWorkspace =
      taskBranchRegistration &&
      resolve(taskBranchRegistration.worktree) !== resolve(workspace)
        ? taskBranchRegistration.worktree
        : undefined;
    const workspaceHead = workspaceExists
      ? git(runner, workspace, ['rev-parse', 'HEAD'], { allowFailure: true }) ||
        undefined
      : undefined;
    const workspaceTree = workspaceHead
      ? git(runner, workspace, ['rev-parse', 'HEAD^{tree}'], {
          allowFailure: true,
        }) || undefined
      : undefined;
    const workspaceBranch = workspaceHead
      ? git(runner, workspace, ['branch', '--show-current'], {
          allowFailure: true,
        }) || undefined
      : undefined;
    const workspaceStatus = workspaceHead
      ? git(runner, workspace, ['status', '--porcelain=v1'], {
          allowFailure: true,
        })
      : '';
    const workspaceChanges = workspaceStatus.split('\n').filter(Boolean);
    const baseCommit = lifecycleState.baseCommit;
    const commitCountFromBase =
      workspaceHead && baseCommit
        ? Number(
            git(
              runner,
              workspace,
              ['rev-list', '--count', `${baseCommit}..${workspaceHead}`],
              {
                allowFailure: true,
              },
            ) || Number.NaN,
          )
        : undefined;
    taskRecords.push({
      contract: task,
      contractPath: relative(
        root,
        taskPaths.find(
          (path) => basename(path) === `${task.id}.contract.json`,
        )!,
      ),
      contextPath: `artifacts/context/${task.id}`,
      contextManifestPath: context.path,
      contextManifestSha256: context.sha256,
      cluster,
      state: lifecycleState,
      dependencyWave: waves.get(task.id)!,
      priority:
        priorities.get(task.cluster)?.get(task.id) ?? Number.MAX_SAFE_INTEGER,
      workspace,
      workspaceExists,
      workspaceRegistered: Boolean(workspaceRegistration),
      workspaceForeign: Boolean(workspaceHead && !workspaceRegistration),
      ...(conflictingWorkspace ? { conflictingWorkspace } : {}),
      ...(workspaceBranch ? { workspaceBranch } : {}),
      ...(workspaceHead ? { workspaceHead } : {}),
      ...(workspaceTree ? { workspaceTree } : {}),
      ...(workspaceHead
        ? { workspaceDirty: workspaceChanges.length > 0, workspaceChanges }
        : {}),
      ...(commitCountFromBase === undefined || Number.isNaN(commitCountFromBase)
        ? {}
        : { commitCountFromBase }),
    });
  }
  const active = taskRecords.filter((task) =>
    [
      'LEASED',
      'IMPLEMENTING',
      'SELF_REVIEWING',
      'VERIFYING',
      'VERIFIED',
      'MERGE_QUEUED',
    ].includes(task.state.state),
  );
  if (active.length > 1)
    throw new ZCodeError(
      'MULTIPLE_ACTIVE_PRODUCT_TASKS',
      active.map((task) => task.contract.id).join(','),
    );
  return {
    root,
    rootBranch,
    rootHead,
    rootTree,
    rootDirty: rootChanges.length > 0,
    rootChanges,
    worktreeRoot,
    release,
    clusters: clusterRecords.sort(
      (left, right) =>
        clusterOrder.indexOf(left.contract.id) -
        clusterOrder.indexOf(right.contract.id),
    ),
    tasks: taskRecords,
    coverage: await coverage(root, tasks),
    ...(active[0] ? { activeTask: active[0] } : {}),
    clusterOrder,
  };
};
