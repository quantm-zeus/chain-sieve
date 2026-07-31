import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256 } from '../prd-compiler/compiler.js';
import { assertEvidenceCurrent } from '../task-runner/evidence-ledger.js';
import { readState } from '../task-runner/state.js';
import { readLifecycleBinding, readVerificationBaseline } from '../task-runner/authority.js';
import { loadTasks } from '../task-verifier/verify.js';
import { persistGoalAndPayload } from '../agent/lib/runtime.js';
import { SystemCommandRunner } from '../agent/lib/system.js';
import type { TaskRecord } from '../agent/lib/types.js';
import { processMergeQueue, readQueue } from './processor.js';
import {
  deriveLifecycleVerdict,
  type ObservedCommand,
  type ObservedLifecycleManifest,
  type ObservedScenario,
} from './lifecycle-manifest.js';

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `LIFECYCLE_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`,
    );
  return result.stdout.trim();
};

const emptyScenario = (
  scenarioId: ObservedScenario['scenarioId'],
): ObservedScenario => ({
  scenarioId,
  commandsExecuted: [],
  stateTransitionsObserved: [],
  commitShas: [],
  gitTreeShas: [],
  leaseVersions: [],
  evidenceHashes: [],
  queueOperations: [],
  rebaseResult: 'NOT_APPLICABLE',
  verificationResult: 'NOT_APPLICABLE',
  mergeResult: 'NOT_APPLICABLE',
  revertResult: 'NOT_APPLICABLE',
  cleanupResult: 'NOT_APPLICABLE',
});

const parseError = (output: string): string => {
  const matches = [...output.matchAll(/"error"\s*:\s*"([^"]+)"/g)];
  return matches.at(-1)?.[1] ?? output.trim().slice(-400);
};

const persistHarnessReceipt = async (
  repository: string,
  task: Awaited<ReturnType<typeof loadTasks>>[number],
): Promise<string> => {
  const tasks = await loadTasks();
  const state = await readState(tasks, repository);
  const target = state.tasks[task.id]!;
  const lifecycle = await readLifecycleBinding(repository, target);
  const baseline = await readVerificationBaseline(repository, target);
  if (
    !lifecycle ||
    !baseline ||
    !target.lifecycleBinding ||
    !target.verificationBaseline ||
    !target.leaseId ||
    !target.holder ||
    !target.expiresAt ||
    !target.baseCommit
  )
    throw new Error('HARNESS_RECEIPT_BINDING_MISSING');
  const authorizedWorktree = target.worktree!;
  const authorizedClusterWorktree = git(repository, ['rev-parse', '--show-toplevel']);
  const clusterBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  const record = {
    contract: task,
    contractPath: lifecycle.contractPath,
    contextPath: lifecycle.contextManifestPath.replace(/\/context-manifest\.json$/, ''),
    contextManifestPath: lifecycle.contextManifestPath,
    contextManifestSha256: lifecycle.contextManifestSha256,
    cluster: {
      contract: { id: task.cluster },
      branch: { branch: clusterBranch, integrationTarget: 'main', worktree: authorizedClusterWorktree },
    },
    state: target,
    workspace: authorizedWorktree,
    workspaceBranch: target.branch,
  } as unknown as TaskRecord;
  const stored = await persistGoalAndPayload(repository, new SystemCommandRunner(), {
    task: record,
    release: {
      ...baseline.releaseBaseline,
      tagObject: git(repository, ['rev-parse', `refs/tags/${baseline.releaseBaseline.tag}`]),
    },
    taskWorkspace: authorizedWorktree,
    leaseId: target.leaseId,
    holder: target.holder,
    fencingVersion: target.leaseVersion,
    expiresAt: target.expiresAt,
    baseCommit: target.baseCommit,
    baseTree: git(authorizedWorktree, ['rev-parse', `${target.baseCommit}^{tree}`]),
    contextManifestPath: lifecycle.contextManifestPath,
    contextManifestSha256: lifecycle.contextManifestSha256,
    ...(lifecycle.conformanceManifestPath ? { conformanceManifestPath: lifecycle.conformanceManifestPath } : {}),
    ...(lifecycle.conformanceManifestSha256 ? { conformanceManifestSha256: lifecycle.conformanceManifestSha256 } : {}),
    taskContractPath: lifecycle.contractPath,
    taskContractSha256: lifecycle.contractSha256,
    lifecycleBindingPath: target.lifecycleBinding.path,
    lifecycleBindingSha256: target.lifecycleBinding.sha256,
    verificationBaselinePath: target.verificationBaseline.path,
    verificationBaselineSha256: target.verificationBaseline.sha256,
    controlPlaneCommit: baseline.controlPlaneCommit,
    controlPlaneTree: baseline.controlPlaneTree,
    failures: [],
  }, 'antigravity');
  if (!stored.binding.launchReceiptId) throw new Error('HARNESS_RECEIPT_ID_MISSING');
  return stored.binding.launchReceiptId;
};

export const runLifecycleHarness = async (): Promise<{
  manifest: ObservedLifecycleManifest;
  verdict: ReturnType<typeof deriveLifecycleVerdict>;
}> => {
  const source = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (git(source, ['status', '--porcelain']) !== '')
    throw new Error('LIFECYCLE_SOURCE_WORKTREE_NOT_CLEAN');
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'chain-sieve-production-lifecycle-'),
  );
  const repository = join(temporaryRoot, 'repository');
  const scenarios = Object.fromEntries(
    (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const).map((id) => [
      id,
      emptyScenario(id),
    ]),
  ) as Record<ObservedScenario['scenarioId'], ObservedScenario>;
  const allCommands: ObservedCommand[] = [];
  const run = (
    command: string,
    args: string[],
    cwd: string,
    expectedRejection?: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): string => {
    const result = spawnSync('pnpm', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CIAG_LIFECYCLE_HARNESS: '1', CIAG_TRUSTED_CONTROL_PLANE: repository, ...extraEnv },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const observed: ObservedCommand = {
      command,
      exitCode: result.status ?? 1,
      outputSha256: sha256(output),
      ...(expectedRejection ? { expectedRejection } : {}),
    };
    allCommands.push(observed);
    if (expectedRejection) {
      if (
        result.status === 0 ||
        !parseError(output).includes(expectedRejection)
      )
        throw new Error(
          `EXPECTED_REJECTION_NOT_OBSERVED:${expectedRejection}:${parseError(output)}`,
        );
    } else if (result.status !== 0) {
      throw new Error(
        `LIFECYCLE_COMMAND_FAILED:${command}:${parseError(output)}`,
      );
    }
    return output;
  };
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--shared', '--no-hardlinks', source, repository],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (clone.status !== 0)
      throw new Error(`LIFECYCLE_CLONE_FAILED:${clone.stderr}`);
    git(repository, [
      'config',
      'user.email',
      'lifecycle-harness@example.invalid',
    ]);
    git(repository, ['config', 'user.name', 'ChainSieve Lifecycle Harness']);
    git(repository, ['switch', '-c', 'cluster/g0']);
    await symlink(
      join(source, 'node_modules'),
      join(repository, 'node_modules'),
      'dir',
    );
    await writeFile(join(repository, '.git/info/exclude'), '\nnode_modules\n', {
      flag: 'a',
    });
    const tasks = await loadTasks();
    const byId = (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`LIFECYCLE_TASK_MISSING:${id}`);
      return task;
    };
    for (const task of [byId('T-G0-DISC'), byId('T-G0-TRACE')]) {
      for (const path of task.requiredTests) {
        const absolute = join(repository, path);
        const exported =
          task.id === 'T-G0-DISC'
            ? 'lifecycleHarnessFixture'
            : 'lifecycleFailureFixture';
        const module =
          task.id === 'T-G0-DISC'
            ? '../../packages/cheap-monitor/src/lifecycle-harness-fixture.js'
            : '../../packages/release-conformance/src/lifecycle-failure-fixture.js';
        const negative = /negative/i.test(path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(
          absolute,
          [
            "import { describe, expect, it } from 'vitest';",
            `import { ${exported} } from '${module}';`,
            `describe('${task.id} lifecycle acceptance fixture', () => {`,
            negative
              ? `  it('rejects a seeded invalid value', () => { const seededFault = -1; expect(() => ${exported}(seededFault)).toThrow('INVALID_LIFECYCLE_FIXTURE'); });`
              : `  it('invokes changed production behavior', () => { const property = (value: number) => ${exported}(value) === value; expect(property(7)).toBe(true); });`,
            '});',
            '',
          ].join('\n'),
        );
      }
    }
    git(repository, [
      'add',
      'tests/acceptance',
      'tests/negative',
      'tests/task-facets',
    ]);
    git(repository, [
      'commit',
      '-m',
      'test: add isolated lifecycle acceptance fixtures',
    ]);

    for (const taskId of ['T-G0-COL-01', 'T-G0-COL-02']) {
      run('task:validate', ['task:validate', taskId], repository);
      run('task:mark-ready', ['task:mark-ready', taskId], repository);
      run('worktree:create', ['worktree:create', taskId], repository);
    }
    const colOne = join(repository, '.worktrees', 'T-G0-COL-01');
    const colTwo = join(repository, '.worktrees', 'T-G0-COL-02');
    run(
      'task:acquire',
      ['task:acquire', 'T-G0-COL-01', '--holder', 'lock-one'],
      colOne,
    );
    run(
      'task:acquire',
      ['task:acquire', 'T-G0-COL-02', '--holder', 'lock-two'],
      colTwo,
      'PATH_LOCK_CONFLICT',
    );
    run(
      'task:release',
      [
        'task:release',
        'T-G0-COL-01',
        '--holder',
        'lock-one',
        '--lease-version',
        '1',
      ],
      colOne,
    );
    run('worktree:cleanup', ['worktree:cleanup', 'T-G0-COL-01'], repository);
    run('worktree:cleanup', ['worktree:cleanup', 'T-G0-COL-02'], repository);
    scenarios.C.verificationResult =
      'SECOND_CONFLICTING_PROTECTED_OPERATION_REJECTED';

    const normalTask = byId('T-G0-DISC');
    run('task:validate', ['task:validate', normalTask.id], repository);
    run('task:mark-ready', ['task:mark-ready', normalTask.id], repository);
    run('worktree:create', ['worktree:create', normalTask.id], repository);
    const normalWorktree = join(repository, '.worktrees', normalTask.id);
    run(
      'task:acquire',
      ['task:acquire', normalTask.id, '--holder', 'lifecycle-worker'],
      normalWorktree,
    );
    run(
      'agent:renew',
      [
        'agent:renew',
        '--',
        normalTask.id,
        '--expected-lease-id',
        (await readState(tasks, normalWorktree)).tasks[normalTask.id]!.leaseId!,
        '--expected-fencing-version',
        '1',
        '--holder',
        'lifecycle-worker',
      ],
      normalWorktree,
    );
    run(
      'task:begin',
      [
        'task:begin',
        normalTask.id,
        '--holder',
        'lifecycle-worker',
        '--lease-version',
        '1',
      ],
      normalWorktree,
      'STALE_LEASE_VERSION',
    );
    run(
      'task:begin',
      [
        'task:begin',
        normalTask.id,
        '--holder',
        'lifecycle-worker',
        '--lease-version',
        '2',
      ],
      normalWorktree,
    );
    const normalPath = join(
      normalWorktree,
      'packages/cheap-monitor/src/lifecycle-harness-fixture.ts',
    );
    await mkdir(dirname(normalPath), { recursive: true });
    await writeFile(
      normalPath,
      "export const lifecycleHarnessFixture = (value: number): number => { if (value < 0) throw new Error('INVALID_LIFECYCLE_FIXTURE'); return value; };\n",
    );
    git(normalWorktree, [
      'add',
      'packages/cheap-monitor/src/lifecycle-harness-fixture.ts',
    ]);
    git(normalWorktree, [
      'commit',
      '-m',
      'test: atomic lifecycle implementation',
    ]);
    const normalReceiptId = await persistHarnessReceipt(repository, normalTask);
    run(
      'task:self-review',
      [
        'task:self-review',
        normalTask.id,
        '--holder',
        'lifecycle-worker',
        '--lease-version',
        '2',
        '--launch-receipt-id',
        normalReceiptId,
      ],
      normalWorktree,
    );
    run(
      'task:verify',
      [
        'task:verify',
        normalTask.id,
        '--holder',
        'lifecycle-worker',
        '--lease-version',
        '2',
        '--target-worktree',
        normalWorktree,
      ],
      repository,
    );
    const preRebaseState = await readState(tasks, repository);
    const preRebaseTarget = structuredClone(
      preRebaseState.tasks[normalTask.id]!,
    );
    run('merge-queue:add', ['merge-queue:add', normalTask.id], repository);
    const advancePath = join(
      repository,
      'docs/implementation/lifecycle-cluster-advance.md',
    );
    await mkdir(dirname(advancePath), { recursive: true });
    await writeFile(
      advancePath,
      'deterministic cluster-head advance for lifecycle verification\n',
    );
    git(repository, [
      'add',
      'docs/implementation/lifecycle-cluster-advance.md',
    ]);
    git(repository, ['commit', '-m', 'test: advance lifecycle cluster head']);
    const queueResult = await processMergeQueue(tasks, {
      cwd: repository,
      integrationRunner: (cwd) => {
        const output = run(
          'cluster:verify-integration',
          ['test:integration'],
          cwd,
        );
        return {
          command: 'pnpm test:integration',
          exitCode: 0,
          outputSha256: sha256(output),
          status: 'PASS',
        };
      },
    });
    allCommands.push({
      command: 'merge-queue:process',
      exitCode: 0,
      outputSha256: sha256(JSON.stringify(queueResult)),
    });
    allCommands.push({
      command: 'cluster:verify-integration',
      exitCode: queueResult.integration.exitCode,
      outputSha256: queueResult.integration.outputSha256,
    });
    if (queueResult.status !== 'MERGED' || !queueResult.rebaseApplied)
      throw new Error('REAL_CLUSTER_ADVANCE_REBASE_NOT_MERGED');
    const mergedState = await readState(tasks, repository);
    const mergedTarget = mergedState.tasks[normalTask.id]!;
    scenarios.A.stateTransitionsObserved = [
      'DRAFT',
      ...(mergedTarget.history ?? []).map((entry) => entry.to),
    ].filter((value, index, values) => values.indexOf(value) === index);
    scenarios.A.commitShas.push(mergedTarget.commit!);
    scenarios.A.gitTreeShas.push(mergedTarget.tree!);
    scenarios.A.evidenceHashes.push(
      mergedTarget.validationEvidence!.sha256,
      mergedTarget.selfReviewEvidence!.sha256,
      mergedTarget.taskResultEvidence!.sha256,
      mergedTarget.verificationEvidence!.sha256,
    );
    scenarios.A.mergeResult = 'MERGED_THROUGH_REAL_QUEUE';
    scenarios.B.leaseVersions = [1, 2];
    scenarios.B.verificationResult = 'OLD_FENCE_REJECTED_NEW_FENCE_ACCEPTED';
    scenarios.D.rebaseResult = 'REBASING_WITH_FRESH_EVIDENCE';
    scenarios.D.queueOperations = queueResult.queueOperations;
    scenarios.D.commitShas.push(
      queueResult.clusterHeadBefore,
      queueResult.commit,
    );
    scenarios.D.gitTreeShas.push(queueResult.tree);
    scenarios.D.evidenceHashes.push(
      queueResult.postRebaseSelfReview!,
      queueResult.postRebaseVerification!,
      mergedTarget.taskResultEvidence!.sha256,
    );
    scenarios.D.verificationResult = 'REAL_POST_REBASE_TASK_VERIFY_PASS';
    scenarios.D.mergeResult = queueResult.status;
    for (const [kind, evidence] of [
      ['SELF_REVIEW', preRebaseTarget.selfReviewEvidence],
      ['TASK_RESULT', preRebaseTarget.taskResultEvidence],
      ['VERIFICATION', preRebaseTarget.verificationEvidence],
    ] as const) {
      if (!evidence) throw new Error(`PRE_REBASE_${kind}_MISSING`);
      try {
        await assertEvidenceCurrent(normalTask.id, kind, evidence, repository);
        throw new Error(`STALE_${kind}_EVIDENCE_ACCEPTED`);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes(`STALE_${kind}_EVIDENCE`)
        )
          throw error;
      }
    }
    scenarios.E.verificationResult = 'ALL_PRE_REBASE_EVIDENCE_REJECTED';

    const failureTask = byId('T-G0-TRACE');
    run('task:validate', ['task:validate', failureTask.id], repository);
    run('task:mark-ready', ['task:mark-ready', failureTask.id], repository);
    run('worktree:create', ['worktree:create', failureTask.id], repository);
    const failureWorktree = join(repository, '.worktrees', failureTask.id);
    run(
      'task:acquire',
      ['task:acquire', failureTask.id, '--holder', 'failure-worker'],
      failureWorktree,
    );
    run(
      'task:begin',
      [
        'task:begin',
        failureTask.id,
        '--holder',
        'failure-worker',
        '--lease-version',
        '1',
      ],
      failureWorktree,
    );
    const failurePath = join(
      failureWorktree,
      'packages/release-conformance/src/lifecycle-failure-fixture.ts',
    );
    await mkdir(dirname(failurePath), { recursive: true });
    await writeFile(
      failurePath,
      "export const lifecycleFailureFixture = (value: number): number => { if (value < 0) throw new Error('INVALID_LIFECYCLE_FIXTURE'); return value; };\n",
    );
    git(failureWorktree, [
      'add',
      'packages/release-conformance/src/lifecycle-failure-fixture.ts',
    ]);
    git(failureWorktree, [
      'commit',
      '-m',
      'test: lifecycle integration failure fixture',
    ]);
    const failureReceiptId = await persistHarnessReceipt(repository, failureTask);
    run(
      'task:self-review',
      [
        'task:self-review',
        failureTask.id,
        '--holder',
        'failure-worker',
        '--lease-version',
        '1',
        '--launch-receipt-id',
        failureReceiptId,
      ],
      failureWorktree,
    );
    run(
      'task:verify',
      [
        'task:verify',
        failureTask.id,
        '--holder',
        'failure-worker',
        '--lease-version',
        '1',
        '--target-worktree',
        failureWorktree,
      ],
      repository,
    );
    await writeFile(
      failurePath,
      'export const lifecycleFailureFixture = (value: number): number => value;\n',
    );
    run(
      'merge-queue:add',
      ['merge-queue:add', failureTask.id],
      repository,
      'DIRTY_TRACKED_SOURCE',
    );
    git(failureWorktree, [
      'restore',
      'packages/release-conformance/src/lifecycle-failure-fixture.ts',
    ]);
    scenarios.F.verificationResult = 'DIRTY_TRACKED_SOURCE_REJECTED';
    run('merge-queue:add', ['merge-queue:add', failureTask.id], repository);
    const failureResult = await processMergeQueue(tasks, {
      cwd: repository,
      integrationRunner: (cwd) => {
        const output = run(
          'cluster:verify-integration',
          [
            'exec',
            'tsx',
            '-e',
            "console.error('deterministic lifecycle integration failure');process.exit(86)",
          ],
          cwd,
          'deterministic lifecycle integration failure',
        );
        return {
          command: 'cluster:verify-integration',
          exitCode: 86,
          outputSha256: sha256(output),
          status: 'FAIL',
        };
      },
    });
    allCommands.push({
      command: 'merge-queue:process',
      exitCode: 0,
      outputSha256: sha256(JSON.stringify(failureResult)),
    });
    if (!failureResult.revertCommit)
      throw new Error('AUTOMATIC_REVERT_MISSING');
    scenarios.G.commitShas.push(
      failureResult.commit,
      failureResult.mergeCommit,
      failureResult.revertCommit,
    );
    scenarios.G.gitTreeShas.push(failureResult.tree);
    scenarios.G.queueOperations = failureResult.queueOperations;
    scenarios.G.mergeResult =
      'MERGED_THROUGH_REAL_QUEUE_THEN_FAILED_INTEGRATION';
    scenarios.G.revertResult = 'AUTOMATIC_REVERT_CREATED_AND_TREE_RESTORED';

    run('worktree:cleanup', ['worktree:cleanup', normalTask.id], repository);
    run('worktree:cleanup', ['worktree:cleanup', failureTask.id], repository);
    const finalState = await readState(tasks, repository);
    const finalQueue = await readQueue(repository);
    const worktrees = git(repository, ['worktree', 'list', '--porcelain']);
    if (worktrees.includes(`${repository}/.worktrees/`))
      throw new Error('TEMPORARY_WORKTREE_NOT_REMOVED');
    if (
      finalQueue.items.some((item) =>
        ['QUEUED', 'PROCESSING'].includes(item.status),
      )
    )
      throw new Error('QUEUE_NOT_FINALIZED');
    if (
      [normalTask.id, failureTask.id].some(
        (id) =>
          !['COMPLETED', 'RELEASED', 'EXPIRED'].includes(
            finalState.tasks[id]?.leaseState ?? '',
          ),
      )
    )
      throw new Error('LEASE_NOT_FINALIZED');
    if (git(repository, ['status', '--porcelain']) !== '')
      throw new Error('LIFECYCLE_REPOSITORY_NOT_CLEAN');
    scenarios.H.cleanupResult = 'WORKTREES_LEASES_LOCKS_QUEUE_BRANCHES_CLEAN';

    for (const command of allCommands) {
      const scenario =
        command.command === 'agent:renew' ||
        command.expectedRejection === 'STALE_LEASE_VERSION'
          ? scenarios.B
          : command.expectedRejection === 'PATH_LOCK_CONFLICT'
            ? scenarios.C
            : command.expectedRejection === 'DIRTY_TRACKED_SOURCE'
              ? scenarios.F
              : command.command === 'worktree:cleanup'
                ? scenarios.H
                : scenarios.A;
      scenario.commandsExecuted.push(command);
    }
    scenarios.D.commandsExecuted.push(
      ...allCommands.filter(
        (command) => command.command === 'merge-queue:process',
      ),
    );
    scenarios.G.commandsExecuted.push(
      ...allCommands.filter(
        (command) =>
          command.command === 'merge-queue:process' ||
          command.command === 'cluster:verify-integration',
      ),
    );
    scenarios.E.commandsExecuted.push({
      command: 'stale-evidence:assert',
      exitCode: 0,
      outputSha256: sha256('all pre-rebase evidence rejected'),
    });
    const manifest: ObservedLifecycleManifest = {
      schemaVersion: '1.0.0',
      harness: 'production-lifecycle',
      repository: 'isolated-temporary-git-repository',
      scenarios: Object.values(scenarios),
      generatedAt: new Date().toISOString(),
    };
    return { manifest, verdict: deriveLifecycleVerdict(manifest) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};
