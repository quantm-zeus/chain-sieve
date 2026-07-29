import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.cwd());
const release = {
  tag: 'harness-v1.0.1',
  tagObject: 'a3bc4476b270efe911da12a4d649e3e5ebcdf69c',
  commit: '1027664eb708b4c1249dda5f1c33f5129946ab3e',
  tree: '706e400d3eb5c41a95209523bb034f2e2c60bd34',
};
const sourceHashes = {
  prd: 'baa521d9c67e67a86d7ddb111c793b67462ed4c7acc89cec34ab9f5ade077299',
  requirements:
    'e0f9f1284473fe097fde591138d16984ae8580feaf13333e22594717eec690ff',
  audit: 'ab4be13b6aeac998f13daa89ae08f4b9f5d6280b4018bd171b7b128b412a47f8',
};
const clusterId = 'C-G0-IMPLEMENTATION';
const canonicalBranch = 'cluster/g0';
const canonicalWorktree =
  '/Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0';
const generatedAt = '2026-07-29T15:39:14Z';
const handoffRoot = 'artifacts/handoff/G0';

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = async (path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

interface ContextFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface ContextManifest {
  schemaVersion: string;
  taskId: string;
  sourceHashes: typeof sourceHashes;
  files: ContextFile[];
  generatedAt: string;
}

interface TaskContract {
  id: string;
  title: string;
  cluster: string;
  dependencyGroup: string;
  requirements: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  exclusiveLocks: string[];
  requiredTests: string[];
  verificationCommands: Array<{ command: string; expected: string }>;
  rollback: string;
  completionDefinition: string[];
  stopConditions: string[];
  changeBudget: { maxMigrations: number };
  sourceHashes: typeof sourceHashes;
}

interface TaskState {
  taskId: string;
  state: string;
  leaseVersion: number;
  leaseState?: string;
  holder?: string;
  expiresAt?: string;
}

const loadTasks = async (): Promise<TaskContract[]> => {
  const files = (await readdir(join(root, 'tasks/G0')))
    .filter((name) => name.endsWith('.contract.json'))
    .sort();
  return Promise.all(
    files.map(async (name) =>
      JSON.parse(await readFile(join(root, 'tasks/G0', name), 'utf8')),
    ),
  );
};

const loadState = async (): Promise<Record<string, TaskState>> => {
  const common = git(['rev-parse', '--git-common-dir']);
  const path = resolve(root, common, 'ciag-runtime/task-state.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    tasks: Record<string, TaskState>;
  };
  return parsed.tasks;
};

const contextAttestation = async (
  task: TaskContract,
): Promise<{
  taskId: string;
  contextPath: string;
  contextManifestSha256: string;
  aggregateSha256: string;
  fileCount: number;
}> => {
  const contextPath = `artifacts/context/${task.id}`;
  const manifestText = await readFile(
    join(root, contextPath, 'context-manifest.json'),
    'utf8',
  );
  const manifest = JSON.parse(manifestText) as ContextManifest;
  if (manifest.taskId !== task.id)
    throw new Error(`CONTEXT_TASK_MISMATCH:${task.id}`);
  if (JSON.stringify(manifest.sourceHashes) !== JSON.stringify(sourceHashes))
    throw new Error(`CONTEXT_SOURCE_HASH_DRIFT:${task.id}`);
  const sums: string[] = [];
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, contextPath, file.path));
    if (bytes.byteLength !== file.bytes)
      throw new Error(`CONTEXT_SIZE_MISMATCH:${task.id}:${file.path}`);
    const actual = sha256(bytes);
    if (actual !== file.sha256)
      throw new Error(`CONTEXT_HASH_MISMATCH:${task.id}:${file.path}`);
    sums.push(`${actual}  ${contextPath}/${file.path}`);
  }
  const manifestHash = sha256(manifestText);
  sums.push(`${manifestHash}  ${contextPath}/context-manifest.json`);
  const sumText = `${sums.join('\n')}\n`;
  const aggregateSha256 = sha256(sumText);
  const wrapper = {
    schemaVersion: '1.0.0',
    taskId: task.id,
    canonicalBranch,
    release,
    sourceHashes,
    contextPath,
    canonicalContextManifestSha256: manifestHash,
    sha256SumsSha256: aggregateSha256,
    files: manifest.files,
    generatedAt,
  };
  await write(
    `${handoffRoot}/context/${task.id}/context-manifest.json`,
    json(wrapper),
  );
  await write(`${handoffRoot}/context/${task.id}/SHA256SUMS`, sumText);
  return {
    taskId: task.id,
    contextPath,
    contextManifestSha256: manifestHash,
    aggregateSha256,
    fileCount: manifest.files.length + 1,
  };
};

const taskGoal = (
  task: TaskContract,
  context: Awaited<ReturnType<typeof contextAttestation>>,
): string => `# ${task.id} ZCode task goal

Implement exactly one task: \`${task.id}\` in cluster \`${clusterId}\`.

## Immutable bindings

- Canonical execution branch: \`${canonicalBranch}\`
- Release baseline: \`${release.tag}\`
- Release commit: \`${release.commit}\`
- Release tree: \`${release.tree}\`
- Context pack: \`${context.contextPath}\`
- Context manifest SHA-256: \`${context.contextManifestSha256}\`
- Context aggregate SHA-256: \`${context.aggregateSha256}\`
- Task base commit and tree: use the exact values in the just-in-time launch receipt; they must be descendants of the release commit and match the task worktree before implementation.

## Contract scope

- Requirements: ${task.requirements.map((id) => `\`${id}\``).join(', ')}
- Acceptance criteria: ${task.acceptanceCriteria.map((id) => `\`${id}\``).join(', ')}
- Dependencies: ${task.dependencies.length === 0 ? 'none' : task.dependencies.map((id) => `\`${id}\``).join(', ')}
- Path locks: ${task.exclusiveLocks.map((lock) => `\`${lock}\``).join(', ')}

Allowed paths:
${task.allowedPaths.map((path) => `- \`${path}\``).join('\n')}

Forbidden paths:
${task.forbiddenPaths.map((path) => `- \`${path}\``).join('\n')}

Required tests:
${task.requiredTests.map((path) => `- \`${path}\``).join('\n')}

## Required lifecycle

The just-in-time preflight must already have created this task worktree and acquired a current fenced lease. Read the launch receipt. Reject a missing, expired, lost, wrong-owner, wrong-task, or stale fencing credential.

Run, substituting only the receipt-bound holder and fencing version:

\`\`\`sh
# Run in the selected task worktree.
pnpm spec:verify
pnpm task:begin ${task.id} --holder <holder> --lease-version <version>
${task.verificationCommands.map((item) => item.command).join('\n')}
pnpm task:self-review ${task.id} --holder <holder> --lease-version <version>
pnpm task:verify ${task.id} --holder <holder> --lease-version <version>
# Return to ${canonicalWorktree} on ${canonicalBranch}.
pnpm merge-queue:add ${task.id}
pnpm merge-queue:process
\`\`\`

Renew before expiry with:

\`\`\`sh
pnpm task:renew ${task.id} --holder <holder> --lease-version <version>
\`\`\`

Create exactly one atomic task commit. Perform mandatory full-diff self-review and proof-carrying verification bound to the task contract, base, head, tree, changed files, tests, lease ID, fencing version, and current dependency-interface hashes. Use only the repository merge queue; never merge directly to \`main\`.

## Stop conditions

${task.stopConditions.map((value) => `- ${value}`).join('\n')}
- Stop after this one task; do not start another task without separate authorization.
- Stop if a command, context hash, dependency interface, path lock, lease, or fencing precondition differs.
- Stop rather than weakening, renumbering, reinterpreting, or omitting normative content.

## Prohibited capabilities

- No force-push or direct merge to \`main\`.
- No expired or stale lease reuse.
- No capability or alpha activation.
- No trading, transaction construction or submission, signing, wallet custody, or private credentials.
- No paid provider fallback in \`STRICT_FREE\`.
`;

const extractCommands = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('pnpm '));

const validateCommand = (
  command: string,
  scripts: Record<string, string>,
  taskIds: Set<string>,
): void => {
  const parts = command.split(/\s+/);
  if (parts[0] !== 'pnpm' || !parts[1])
    throw new Error(`INVALID_COMMAND_SYNTAX:${command}`);
  const script = parts[1];
  if (script === 'exec') {
    if (parts[2] !== 'vitest')
      throw new Error(`UNAPPROVED_PNPM_EXEC:${command}`);
    return;
  }
  if (!scripts[script]) throw new Error(`UNKNOWN_GENERATED_COMMAND:${script}`);
  const taskCommand = new Set([
    'task:begin',
    'task:renew',
    'task:self-review',
    'task:verify',
    'merge-queue:add',
  ]);
  if (taskCommand.has(script)) {
    const taskId = parts[2];
    if (!taskId || !taskIds.has(taskId))
      throw new Error(`INVALID_GENERATED_TASK_ARGUMENT:${command}`);
  }
  if (
    ['task:begin', 'task:renew', 'task:self-review', 'task:verify'].includes(
      script,
    )
  ) {
    if (
      !command.includes('--holder <holder>') ||
      !command.includes('--lease-version <version>')
    )
      throw new Error(`INVALID_FENCED_COMMAND_ARGUMENTS:${command}`);
  }
  if (script === 'merge-queue:process' && parts.length !== 2)
    throw new Error(`INVALID_MERGE_QUEUE_ARGUMENTS:${command}`);
};

const validateGoal = (
  text: string,
  scripts: Record<string, string>,
  taskIds: Set<string>,
): string[] => {
  const commands = extractCommands(text);
  if (commands.length === 0) throw new Error('GENERATED_GOAL_COMMANDS_MISSING');
  for (const command of commands) validateCommand(command, scripts, taskIds);
  const ordered = [
    'task:begin',
    'task:self-review',
    'task:verify',
    'merge-queue:add',
    'merge-queue:process',
  ];
  const positions = ordered.map((name) =>
    commands.findIndex((command) => command.startsWith(`pnpm ${name}`)),
  );
  if (
    positions.some((position) => position < 0) ||
    positions.some(
      (position, index) => index > 0 && position <= positions[index - 1]!,
    )
  )
    throw new Error('INVALID_GENERATED_GOAL_STATE_TRANSITIONS');
  return commands;
};

const validateState = async (tasks: TaskContract[]): Promise<TaskState[]> => {
  const state = await loadState();
  const values = tasks.map((task) => {
    const item = state[task.id];
    if (!item) throw new Error(`TASK_STATE_MISSING:${task.id}`);
    if (item.state !== 'READY')
      throw new Error(`TASK_NOT_READY:${task.id}:${item.state}`);
    if (item.leaseVersion !== 0)
      throw new Error(
        `UNEXPECTED_FENCING_VERSION:${task.id}:${item.leaseVersion}`,
      );
    if (item.leaseState === 'ACTIVE')
      throw new Error(`ACTIVE_IMPLEMENTATION_LEASE:${task.id}`);
    return item;
  });
  return values;
};

const generate = async (): Promise<void> => {
  if (git(['branch', '--show-current']) !== canonicalBranch)
    throw new Error('CANONICAL_BRANCH_REQUIRED');
  if (root !== canonicalWorktree)
    throw new Error('CANONICAL_WORKTREE_REQUIRED');
  if (git(['rev-parse', `refs/tags/${release.tag}`]) !== release.tagObject)
    throw new Error('RELEASE_TAG_OBJECT_DRIFT');
  if (git(['rev-parse', `refs/tags/${release.tag}^{}`]) !== release.commit)
    throw new Error('RELEASE_TARGET_DRIFT');
  if (git(['show', '-s', '--format=%T', release.commit]) !== release.tree)
    throw new Error('RELEASE_TREE_DRIFT');

  const tasks = await loadTasks();
  if (tasks.length !== 14) throw new Error(`G0_TASK_COUNT:${tasks.length}`);
  if (new Set(tasks.map((task) => task.id)).size !== 14)
    throw new Error('DUPLICATE_G0_TASK_ID');
  if (
    tasks.some(
      (task) =>
        task.cluster !== clusterId ||
        task.dependencyGroup !== 'G0' ||
        JSON.stringify(task.sourceHashes) !== JSON.stringify(sourceHashes),
    )
  )
    throw new Error('G0_TASK_BINDING_DRIFT');
  await validateState(tasks);

  const historicalFiles = [
    'SHA256SUMS',
    'g0-owner-launch-instructions.md',
    'g0-zcode-readiness.final.json',
    'g0-zcode-readiness.final.md',
  ];
  for (const name of historicalFiles) {
    const content = git([
      'show',
      `43e8b49a92a838b81adbe7b94300671c5ed7e6a1:${handoffRoot}/${name}`,
    ]);
    await write(
      `${handoffRoot}/history/2026-07-29-blocked/${name}`,
      `${content}\n`,
    );
  }

  const contexts = [];
  for (const task of tasks) contexts.push(await contextAttestation(task));
  const contextAggregate = {
    schemaVersion: '1.0.0',
    clusterId,
    canonicalBranch,
    release,
    sourceHashes,
    packs: contexts,
    aggregateSha256: sha256(
      contexts
        .map((item) => `${item.taskId}:${item.aggregateSha256}`)
        .sort()
        .join('\n'),
    ),
    generatedAt,
  };
  await write(
    `${handoffRoot}/g0-context-manifest.json`,
    json(contextAggregate),
  );

  const packageManifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const taskIds = new Set(tasks.map((task) => task.id));
  const goalRecords = [];
  for (const task of tasks) {
    const context = contexts.find((item) => item.taskId === task.id)!;
    const text = taskGoal(task, context);
    const commands = validateGoal(text, packageManifest.scripts, taskIds);
    const path = `${handoffRoot}/goals/${task.id}.zcode-goal.md`;
    await write(path, text);
    goalRecords.push({
      taskId: task.id,
      path,
      sha256: sha256(text),
      commands,
    });
  }
  let rejectedUnknownCommand = false;
  try {
    validateCommand(
      'pnpm task:nonexistent T-G0-CORE',
      packageManifest.scripts,
      taskIds,
    );
  } catch (error) {
    rejectedUnknownCommand =
      error instanceof Error &&
      error.message === 'UNKNOWN_GENERATED_COMMAND:task:nonexistent';
  }
  if (!rejectedUnknownCommand)
    throw new Error('UNKNOWN_COMMAND_SELF_TEST_FAILED');

  const clusterGoalPath = 'clusters/G0/C-G0-IMPLEMENTATION.zcode-goal.md';
  const clusterGoal = await readFile(join(root, clusterGoalPath), 'utf8');
  if (!clusterGoal.includes('`cluster/g0`'))
    throw new Error('CLUSTER_GOAL_BRANCH_DRIFT');
  const clusterCommands = extractCommands(clusterGoal.replaceAll('`', ''));
  for (const command of clusterCommands)
    validateCommand(command, packageManifest.scripts, taskIds);

  const waves = [tasks.map((task) => task.id)];
  const lockGroups = Object.fromEntries(
    [...new Set(tasks.flatMap((task) => task.exclusiveLocks))]
      .sort()
      .map((lock) => [
        lock,
        tasks
          .filter((task) => task.exclusiveLocks.includes(lock))
          .map((task) => task.id),
      ]),
  );
  const executionPlan = {
    schemaVersion: '1.0.0',
    clusterId,
    canonicalBranch,
    formalDependencyWaves: waves,
    taskGraphAcyclic: true,
    contractMaximumParallelism: Object.keys(lockGroups).length,
    recommendedInitialParallelism: 1,
    firstRecommendedTask: 'T-G0-CORE',
    rationale:
      'Begin serially with the shared domain/schema foundation. The contracts have no formal edges, but all tasks share tests and implementation documentation, several share public interfaces, and DATA/DR share migration ownership.',
    pathLockGroups: lockGroups,
    schemaAndMigrationConflicts: {
      'infra/migrations': ['T-G0-DATA', 'T-G0-DR'],
      'packages/persistence': ['T-G0-DATA', 'T-G0-DR'],
    },
    sharedInterfaceConflicts: {
      'apps/collector/public-api': ['T-G0-COL-01', 'T-G0-COL-02'],
      'packages/cost-router/public-api': ['T-G0-COST-01', 'T-G0-COST-02'],
      'packages/provider-lifecycle/public-api': [
        'T-G0-PROV-01',
        'T-G0-PROV-02',
      ],
      'packages/security/public-api': ['T-G0-SEC-01', 'T-G0-SEC-02'],
    },
    sharedConfigurationConflicts: {
      'tests/**': tasks.map((task) => task.id),
      'docs/implementation/**': tasks.map((task) => task.id),
    },
    operationalOrder: [
      'T-G0-CORE',
      'T-G0-DATA',
      'T-G0-SEC-01',
      'T-G0-SEC-02',
      'T-G0-MCP',
      'T-G0-COL-01',
      'T-G0-COL-02',
      'T-G0-COST-01',
      'T-G0-COST-02',
      'T-G0-DISC',
      'T-G0-DR',
      'T-G0-PROV-01',
      'T-G0-PROV-02',
      'T-G0-TRACE',
    ],
    generatedAt,
  };
  await write(`${handoffRoot}/g0-execution-plan.json`, json(executionPlan));
  await write(
    `${handoffRoot}/g0-execution-plan.md`,
    `# G0 execution plan

- Canonical branch: \`${canonicalBranch}\`
- Formal dependency waves: one wave containing all 14 tasks
- Contract lock ceiling: ${Object.keys(lockGroups).length}
- Recommended initial parallelism: 1
- First recommended task: \`T-G0-CORE\`

The graph has no formal task edges, but this does not make unrestricted parallel execution safe. Start serially with the shared domain/schema foundation. DATA and DR share persistence and migration ownership; collector, cost, provider, and security task pairs share public-interface locks; every task may touch \`tests/**\` and \`docs/implementation/**\`.

The recommended operational order is:

${executionPlan.operationalOrder.map((id, index) => `${index + 1}. \`${id}\``).join('\n')}

Increase concurrency only after the first task merges cleanly and an owner confirms disjoint paths and interfaces for the proposed task set.
`,
  );

  const inventory = {
    schemaVersion: '1.0.0',
    clusterId,
    canonicalBranch,
    release,
    sourceHashes,
    taskCount: tasks.length,
    tasks: tasks.map((task) => {
      const context = contexts.find((item) => item.taskId === task.id)!;
      const goal = goalRecords.find((item) => item.taskId === task.id)!;
      return {
        taskId: task.id,
        title: task.title,
        clusterId: task.cluster,
        currentState: 'READY',
        requirements: task.requirements,
        acceptanceCriteria: task.acceptanceCriteria,
        dependencies: task.dependencies,
        dependencyWave: 1,
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
        pathLockGroups: task.exclusiveLocks,
        requiredTests: task.requiredTests,
        requiredFixtures: task.requiredTests.filter((path) =>
          path.includes('fixture'),
        ),
        requiredMigrations: [],
        migrationAllowance: task.changeBudget.maxMigrations,
        requiredTelemetry: task.completionDefinition.filter((value) =>
          /observability|telemetry/i.test(value),
        ),
        rollbackRequirements: task.rollback,
        contextPackPath: context.contextPath,
        contextPackHash: context.aggregateSha256,
        taskGoalPath: goal.path,
        taskGoalHash: goal.sha256,
      };
    }),
    generatedAt,
  };
  const inventoryText = json(inventory);
  await write(`${handoffRoot}/g0-task-inventory.json`, inventoryText);
  await write(
    `${handoffRoot}/g0-task-inventory.md`,
    `# G0 task inventory

Cluster \`${clusterId}\` contains exactly 14 \`READY\` tasks on canonical branch \`${canonicalBranch}\`. Every task is in formal dependency wave 1.

| Task | State | Lock | Tests | Context SHA-256 | Goal SHA-256 |
| --- | --- | --- | ---: | --- | --- |
${inventory.tasks.map((task) => `| \`${task.taskId}\` | \`${task.currentState}\` | ${task.pathLockGroups.map((lock) => `\`${lock}\``).join(', ')} | ${task.requiredTests.length} | \`${task.contextPackHash}\` | \`${task.taskGoalHash}\` |`).join('\n')}
`,
  );

  const launch = {
    schemaVersion: '1.0.0',
    clusterId,
    canonicalBranch,
    canonicalWorktree,
    release,
    sourceHashes,
    preflightPath: 'tools/zcode/g0-preflight.sh',
    defaultMode: '--validate-only',
    authorizedFutureMode: '--prepare-task <task-id>',
    inventoryPath: `${handoffRoot}/g0-task-inventory.json`,
    inventorySha256: sha256(inventoryText),
    executionPlanPath: `${handoffRoot}/g0-execution-plan.json`,
    contextManifestPath: `${handoffRoot}/g0-context-manifest.json`,
    contextAggregateSha256: contextAggregate.aggregateSha256,
    taskGoals: goalRecords,
    clusterGoal: {
      path: clusterGoalPath,
      sha256: sha256(clusterGoal),
    },
    goalPayloadPath: `${handoffRoot}/g0-goal-payload.md`,
    lease: {
      acquisition: 'pnpm task:acquire <task-id> --holder zcode-g0',
      durationMilliseconds: 900000,
      renewal:
        'pnpm task:renew <task-id> --holder zcode-g0 --lease-version <version>',
      pathLocks: 'integrated into fenced task acquisition',
    },
    zcodeDesktop: {
      autoLaunch: false,
      cliRequired: false,
    },
    generatedAt,
  };
  await write(`${handoffRoot}/g0-zcode-launch.json`, json(launch));
  await write(
    `${handoffRoot}/g0-zcode-launch.md`,
    `# G0 desktop ZCode launch package

The canonical workspace is \`${canonicalWorktree}\` on \`${canonicalBranch}\`.

Validation only:

\`\`\`sh
tools/zcode/g0-preflight.sh --validate-only
\`\`\`

After separate owner authorization, prepare one task:

\`\`\`sh
tools/zcode/g0-preflight.sh --prepare-task T-G0-CORE
\`\`\`

The preparation step creates the task worktree, acquires one bounded fenced lease with integrated path locks, writes a runtime launch receipt, and prints the exact task workspace and goal path. It does not start ZCode or enter \`IMPLEMENTING\`.
`,
  );
  await write(
    `${handoffRoot}/g0-goal-payload.md`,
    `# G0 ZCode desktop Goal Mode payload

Use this only after an authorized \`--prepare-task <task-id>\` preflight has succeeded.

## Direct command form

\`\`\`text
/goal Load the task goal path printed by the G0 preflight and the corresponding launch receipt. Implement exactly that one task, honoring the current lease ID, holder, fencing version, path locks, allowed and forbidden paths, required tests, mandatory self-review, one atomic commit, proof-carrying task verification, and the repository merge queue. Stop before any direct main merge and do not start another task.
\`\`\`

## Interactive command-panel flow

1. Open the task workspace path printed by the preflight.
2. Open ZCode Agent and enter \`/goal\`.
3. Paste the objective above.
4. Attach or paste the exact task-specific goal file printed by the preflight.
5. Confirm the receipt task ID, lease ID, holder, fencing version, base commit, and task branch before allowing implementation.

The task-specific goal is authoritative for requirements, acceptance criteria, context hashes, paths, tests, stop conditions, and prohibited capabilities.
`,
  );

  const validation = {
    schemaVersion: '1.0.0',
    status: 'PASS',
    clusterId,
    canonicalBranch,
    taskGoalCount: goalRecords.length,
    taskGoalCommands: goalRecords.flatMap((goal) =>
      goal.commands.map((command) => ({ taskId: goal.taskId, command })),
    ),
    clusterGoalCommands: clusterCommands,
    unknownCommandSelfTest: 'PASS_REJECTED',
    packageScriptsVerified: true,
    requiredCli: ['git', 'node', 'pnpm', 'shasum'],
    zcodeCliRequired: false,
    generatedAt,
  };
  await write(`${handoffRoot}/g0-command-validation.json`, json(validation));
};

const validate = async (): Promise<void> => {
  const tasks = await loadTasks();
  await validateState(tasks);
  const taskIds = new Set(tasks.map((task) => task.id));
  const packageManifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const inventory = JSON.parse(
    await readFile(join(root, handoffRoot, 'g0-task-inventory.json'), 'utf8'),
  ) as {
    taskCount: number;
    canonicalBranch: string;
    tasks: Array<{
      taskId: string;
      contextPackHash: string;
      taskGoalPath: string;
      taskGoalHash: string;
    }>;
  };
  if (
    inventory.taskCount !== 14 ||
    inventory.canonicalBranch !== canonicalBranch
  )
    throw new Error('INVENTORY_BINDING_INVALID');
  for (const item of inventory.tasks) {
    const sumText = await readFile(
      join(root, handoffRoot, 'context', item.taskId, 'SHA256SUMS'),
      'utf8',
    );
    if (sha256(sumText) !== item.contextPackHash)
      throw new Error(`INVENTORY_CONTEXT_HASH_DRIFT:${item.taskId}`);
    for (const line of sumText.trim().split('\n')) {
      const [expected, ...pathParts] = line.split(/\s+/);
      const path = pathParts.join(' ');
      const actual = sha256(await readFile(join(root, path)));
      if (actual !== expected)
        throw new Error(`CONTEXT_SUM_MISMATCH:${item.taskId}:${path}`);
    }
    const goal = await readFile(join(root, item.taskGoalPath), 'utf8');
    if (sha256(goal) !== item.taskGoalHash)
      throw new Error(`TASK_GOAL_HASH_DRIFT:${item.taskId}`);
    validateGoal(goal, packageManifest.scripts, taskIds);
  }
  const launch = JSON.parse(
    await readFile(join(root, handoffRoot, 'g0-zcode-launch.json'), 'utf8'),
  ) as {
    clusterGoal: { path: string; sha256: string };
    canonicalBranch: string;
    canonicalWorktree: string;
  };
  if (
    launch.canonicalBranch !== canonicalBranch ||
    launch.canonicalWorktree !== canonicalWorktree
  )
    throw new Error('LAUNCH_BINDING_INVALID');
  const clusterGoal = await readFile(
    join(root, launch.clusterGoal.path),
    'utf8',
  );
  if (sha256(clusterGoal) !== launch.clusterGoal.sha256)
    throw new Error('CLUSTER_GOAL_HASH_DRIFT');
  for (const path of [
    'tools/zcode/g0-preflight.sh',
    `${handoffRoot}/g0-goal-payload.md`,
    `${handoffRoot}/g0-execution-plan.json`,
    `${handoffRoot}/g0-context-manifest.json`,
    `${handoffRoot}/g0-command-validation.json`,
  ])
    await access(join(root, path));
  console.log(
    json({
      status: 'PASS',
      clusterId,
      canonicalBranch,
      tasks: tasks.length,
      contexts: inventory.tasks.length,
      goals: inventory.tasks.length,
      activeLeases: 0,
      activePathLocks: 0,
      mutation: false,
    }).trim(),
  );
};

const mode = process.argv[2] ?? '--generate';
if (mode === '--generate') await generate();
else if (mode === '--validate-only') await validate();
else throw new Error(`UNKNOWN_MODE:${mode}`);
