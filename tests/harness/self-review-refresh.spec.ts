import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  TaskContractSchema,
  TaskReviewSchema,
  type TaskContract,
} from '@ciag/shared-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchReceiptCandidate } from '../../tools/agent/lib/runtime.js';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import {
  correctTaskSelfReview,
  selectSelfReviewCorrectionReceipt,
} from '../../tools/task-runner/self-review-correct.js';
import {
  LegacyTaskReviewSchema,
  refreshTaskSelfReview,
  selectSelfReviewRefreshReceipt,
} from '../../tools/task-runner/self-review-refresh.js';
import { mandatoryPasses } from '../../tools/task-runner/self-review.js';
import { runtimeRoot } from '../../tools/task-runner/state.js';
import {
  deriveChangedFiles,
  hashPathAtCommit,
} from '../../tools/task-verifier/attestation.js';
import { readBoundTaskReview } from '../../tools/task-verifier/verify.js';
import {
  TASK_VERIFIER_VERSION,
  VERIFICATION_POLICY_VERSION,
} from '../../tools/task-verifier/policy.js';

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const put = async (root: string, path: string, text: string): Promise<void> => {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
};

const taskContract = (requiredTest: string): TaskContract =>
  TaskContractSchema.parse({
    schemaVersion: '1.0.0',
    id: 'T-G0-CORE',
    title: 'Bound legacy task',
    sourceHashes: {
      prd: '1'.repeat(64),
      requirements: '2'.repeat(64),
      audit: '3'.repeat(64),
    },
    dependencyGroup: 'G0',
    cluster: 'C-G0-IMPLEMENTATION',
    riskLevel: 'HIGH',
    autonomyLevel: 'REVIEW_REQUIRED',
    dependencies: [],
    requirements: ['FR-LEGACY-001'],
    acceptanceCriteria: ['AC-LEGACY-001'],
    invariants: ['INV-001'],
    adrs: ['ADR-001'],
    ownerPackages: ['packages/domain'],
    readSet: ['docs/spec/**'],
    writeSet: ['packages/domain/**'],
    allowedPaths: ['packages/domain/**', 'tests/**'],
    forbiddenPaths: ['docs/spec/**'],
    exclusiveLocks: ['packages/domain/public-api'],
    interfaceHashes: { 'packages/domain:contract': '4'.repeat(64) },
    deliverables: ['packages/domain/** @requirement FR-LEGACY-001'],
    constraints: ['preserve contract'],
    nonGoals: ['no activation'],
    degradedBehavior: 'fail closed',
    rollback: 'revert',
    requiredTests: [requiredTest],
    verificationCommands: [
      { command: `pnpm exec vitest run ${requiredTest}`, expected: 'pass' },
    ],
    complexityBudget: {
      maxFiles: 10,
      maxChangedLines: 1000,
      maxCyclomaticComplexity: 10,
    },
    changeBudget: {
      maxMigrations: 0,
      maxPublicInterfaces: 1,
      requiresSplitAboveBudget: true,
    },
    stopConditions: ['stop on drift'],
    completionDefinition: ['verified'],
    sourceReferences: [
      { path: 'docs/spec/prd.md', line: 1, id: 'FR-LEGACY-001' },
    ],
  });

interface Fixture {
  root: string;
  taskWorktree: string;
  clusterWorktree: string;
  baseCommit: string;
  commit: string;
  tree: string;
  oldReviewPath: string;
  oldReviewText: string;
  statePath: string;
  state: Record<string, unknown>;
  receiptPath: string;
  previousReceiptPath: string;
  legacyTask: TaskContract;
}

const createFixture = async (): Promise<Fixture> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ciag-review-refresh-')));
  temporary.push(parent);
  const root = join(parent, 'root');
  const clusterWorktree = join(parent, 'cluster');
  const taskWorktree = join(parent, 'task');
  await mkdir(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Refresh Test']);
  const legacyTask = taskContract('tests/legacy.spec.ts');
  await put(root, '.gitignore', '.worktrees/\n');
  await put(
    root,
    'tasks/G0/T-G0-CORE.contract.json',
    `${JSON.stringify(legacyTask, null, 2)}\n`,
  );
  await put(
    root,
    'artifacts/context/T-G0-CORE/context-manifest.json',
    '{"legacy":true}\n',
  );
  await put(root, 'packages/domain/src/index.ts', 'export const value = 1;\n');
  await put(root, 'tests/legacy.spec.ts', 'export const legacy = true;\n');
  await put(root, 'docs/spec/SHA256SUMS', 'trusted-spec-manifest\n');
  await put(
    root,
    'tasks/generated/interface-hashes.json',
    `${JSON.stringify({ 'T-G0-CORE': legacyTask.interfaceHashes })}\n`,
  );
  await put(root, 'artifacts/spec/acceptance-partition.json', '{}\n');
  const policyPaths = [
    'tools/task-verifier/cli.ts',
    'tools/task-verifier/verify.ts',
    'tools/task-verifier/attestation.ts',
    'tools/task-verifier/policy.ts',
    'tools/task-verifier/conformance.ts',
    'tools/task-verifier/trusted-execution.ts',
    'tools/architecture-verifier/verify.ts',
    'tools/architecture-verifier/cli.ts',
  ];
  for (const path of policyPaths)
    await put(root, path, `// trusted ${path}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'legacy base']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['tag', 'harness-v1.0.1']);
  git(root, ['worktree', 'add', '-b', 'cluster/g0', clusterWorktree, baseCommit]);
  git(root, [
    'worktree',
    'add',
    '-b',
    'task/t-g0-core',
    taskWorktree,
    baseCommit,
  ]);
  await put(
    taskWorktree,
    'packages/domain/src/index.ts',
    'export const value = 2;\n',
  );
  git(taskWorktree, ['add', 'packages/domain/src/index.ts']);
  git(taskWorktree, ['commit', '-m', 'implementation']);
  const commit = git(taskWorktree, ['rev-parse', 'HEAD']);
  const tree = git(taskWorktree, ['rev-parse', 'HEAD^{tree}']);

  const replacement = {
    ...legacyTask,
    title: 'Generated replacement',
    requiredTests: ['tests/replacement.spec.ts'],
    specificationStatus: 'SPECIFICATION_GAP' as const,
  };
  await put(
    root,
    'tasks/G0/T-G0-CORE.contract.json',
    `${JSON.stringify(replacement, null, 2)}\n`,
  );
  git(root, ['add', 'tasks/G0/T-G0-CORE.contract.json']);
  git(root, ['commit', '-m', 'generated replacement']);
  const controlPlaneCommit = git(root, ['rev-parse', 'HEAD']);
  const controlPlaneTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const runtime = runtimeRoot(root);

  const contractText = await readFile(
    join(taskWorktree, 'tasks/G0/T-G0-CORE.contract.json'),
    'utf8',
  );
  const contextText = await readFile(
    join(taskWorktree, 'artifacts/context/T-G0-CORE/context-manifest.json'),
    'utf8',
  );
  const lifecycle = {
    schemaVersion: '1.0.0',
    taskId: legacyTask.id,
    clusterId: legacyTask.cluster,
    contractMode: 'LEGACY',
    bindingRoot: taskWorktree,
    contractPath: 'tasks/G0/T-G0-CORE.contract.json',
    contractSha256: sha256(contractText),
    contextManifestPath: 'artifacts/context/T-G0-CORE/context-manifest.json',
    contextManifestSha256: sha256(contextText),
    sourceHashes: legacyTask.sourceHashes,
    baseCommit,
  };
  const lifecycleText = `${JSON.stringify(lifecycle, null, 2)}\n`;
  const lifecycleSha = sha256(lifecycleText);
  const lifecyclePath = `lifecycle-bindings/T-G0-CORE/${lifecycleSha}.json`;
  await put(runtime, lifecyclePath, lifecycleText);

  const baseline = {
    schemaVersion: '1.1.0',
    taskId: legacyTask.id,
    verifierVersion: TASK_VERIFIER_VERSION,
    verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
    lifecycleBindingSha256: lifecycleSha,
    taskContractSha256: sha256(contractText),
    contextManifestSha256: sha256(contextText),
    sourceHashManifestSha256: sha256(
      await readFile(join(root, 'docs/spec/SHA256SUMS')),
    ),
    generatedInterfaceIndexSha256: sha256(
      await readFile(join(root, 'tasks/generated/interface-hashes.json')),
    ),
    acceptancePartitionSha256: sha256(
      await readFile(join(root, 'artifacts/spec/acceptance-partition.json')),
    ),
    allowedPathsSha256: sha256(JSON.stringify(legacyTask.allowedPaths)),
    forbiddenPathsSha256: sha256(JSON.stringify(legacyTask.forbiddenPaths)),
    writeSetSha256: sha256(JSON.stringify(legacyTask.writeSet)),
    requiredTestsSha256: sha256(JSON.stringify(legacyTask.requiredTests)),
    verifierEntrypointSha256: sha256(
      await readFile(join(root, 'tools/task-verifier/cli.ts')),
    ),
    verifierPolicySha256: sha256(
      (
        await Promise.all(
          [
            'tools/task-verifier/verify.ts',
            'tools/task-verifier/attestation.ts',
            'tools/task-verifier/policy.ts',
            'tools/task-verifier/conformance.ts',
            'tools/task-verifier/trusted-execution.ts',
          ].map((path) => readFile(join(root, path), 'utf8')),
        )
      ).join('\n'),
    ),
    architecturePolicySha256: sha256(
      await readFile(join(root, 'tools/architecture-verifier/verify.ts')),
    ),
    prohibitedCapabilityPolicySha256: sha256(
      await readFile(join(root, 'tools/architecture-verifier/cli.ts')),
    ),
    controlPlaneCommit,
    controlPlaneTree,
    releaseBaseline: {
      tag: 'harness-v1.0.1',
      commit: baseCommit,
      tree: git(root, ['rev-parse', `${baseCommit}^{tree}`]),
    },
  };
  const baselineText = `${JSON.stringify(baseline, null, 2)}\n`;
  const baselineSha = sha256(baselineText);
  const baselinePath = `verification-baselines/T-G0-CORE/${baselineSha}.json`;
  await put(runtime, baselinePath, baselineText);

  const changedFiles = deriveChangedFiles(baseCommit, commit, taskWorktree);
  const acceptanceTestArtifacts = legacyTask.requiredTests.map((path) => ({
    path,
    sha256: hashPathAtCommit(commit, path, 'M', taskWorktree),
  }));
  const oldReview = LegacyTaskReviewSchema.parse({
    schemaVersion: '2.0.0',
    taskId: legacyTask.id,
    reviewer: 'zcode-orchestrator',
    reviewedBaseCommit: baseCommit,
    reviewedCommit: commit,
    reviewedTree: tree,
    changedFiles,
    dependencyInterfaceHashes: legacyTask.interfaceHashes,
    acceptanceTestArtifacts,
    leaseId: 'T-G0-CORE:2:legacy',
    leaseFencingVersion: 2,
    reviewedAt: '2030-01-01T00:00:00.000Z',
    rebase: { conflictsDetected: false, semanticChangesDetected: false },
    passes: mandatoryPasses.map((name) => ({
      name,
      status: 'PASS' as const,
      evidence: [`legacy:${name}`],
    })),
    verdict: 'PASS',
    findings: [],
  });
  const oldReviewText = `${JSON.stringify(oldReview, null, 2)}\n`;
  const oldReviewPath = `reviews/T-G0-CORE/${commit}.review.json`;
  await put(runtime, oldReviewPath, oldReviewText);

  const goal =
    'trusted correction launch goal\n- Correction required: TASK_LINE_BUDGET_EXCEEDED\n';
  const goalSha = sha256(goal);
  const goalPath = join(
    runtime,
    'agent/goals/T-G0-CORE',
    `${goalSha}.md`,
  );
  await put('/', goalPath, goal);
  const receiptId = 'antigravity-current';
  const receiptCore = {
    schemaVersion: '2.0.0',
    receiptId,
    provider: 'antigravity',
    clusterId: legacyTask.cluster,
    taskId: legacyTask.id,
    taskBranch: 'task/t-g0-core',
    clusterBranch: 'cluster/g0',
    clusterWorktree,
    taskWorktree,
    release: {
      tag: baseline.releaseBaseline.tag,
      tagObject: git(root, ['rev-parse', 'refs/tags/harness-v1.0.1']),
      commit: baseline.releaseBaseline.commit,
      tree: baseline.releaseBaseline.tree,
    },
    integrationTarget: 'main',
    leaseId: 'T-G0-CORE:3:recovery:current',
    holder: 'zcode-orchestrator',
    fencingVersion: 3,
    expiresAt: '2099-01-01T00:00:00.000Z',
    baseCommit,
    baseTree: git(root, ['rev-parse', `${baseCommit}^{tree}`]),
    goalPath,
    goalSha256: goalSha,
    contextManifestPath: lifecycle.contextManifestPath,
    contextManifestSha256: lifecycle.contextManifestSha256,
    contractPath: lifecycle.contractPath,
    contractSha256: lifecycle.contractSha256,
    lifecycleBindingPath: lifecyclePath,
    lifecycleBindingSha256: lifecycleSha,
    verificationBaselinePath: baselinePath,
    verificationBaselineSha256: baselineSha,
    controlPlaneCommit,
    controlPlaneTree,
    pathLocks: legacyTask.exclusiveLocks,
  };
  const receipt = {
    ...receiptCore,
    receiptHash: sha256(JSON.stringify(receiptCore)),
  };
  const receiptPath = join(
    runtime,
    'agent/launch-receipts/T-G0-CORE',
    `${receiptId}.json`,
  );
  await put('/', receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const previousGoal = 'trusted previous implementation launch goal\n';
  const previousGoalSha = sha256(previousGoal);
  const previousGoalPath = join(
    runtime,
    'agent/goals/T-G0-CORE',
    `${previousGoalSha}.md`,
  );
  await put('/', previousGoalPath, previousGoal);
  const previousReceiptCore = {
    ...receiptCore,
    receiptId: 'antigravity-previous',
    leaseId: 'T-G0-CORE:2:legacy',
    fencingVersion: 2,
    expiresAt: '2020-01-01T00:00:00.000Z',
    goalPath: previousGoalPath,
    goalSha256: previousGoalSha,
  };
  const previousReceipt = {
    ...previousReceiptCore,
    receiptHash: sha256(JSON.stringify(previousReceiptCore)),
  };
  const previousReceiptPath = join(
    runtime,
    'agent/launch-receipts/T-G0-CORE/antigravity-previous.json',
  );
  await put(
    '/',
    previousReceiptPath,
    `${JSON.stringify(previousReceipt, null, 2)}\n`,
  );

  const state = {
    schemaVersion: '2.0.0',
    tasks: {
      'T-G0-CORE': {
        taskId: legacyTask.id,
        state: 'SELF_REVIEWING',
        leaseVersion: 3,
        holder: 'zcode-orchestrator',
        leaseId: receiptCore.leaseId,
        expiresAt: receiptCore.expiresAt,
        leaseState: 'ACTIVE',
        baseCommit,
        branch: 'task/t-g0-core',
        worktree: taskWorktree,
        lifecycleBinding: {
          path: lifecyclePath,
          sha256: lifecycleSha,
          status: 'CURRENT',
        },
        verificationBaseline: {
          path: baselinePath,
          sha256: baselineSha,
          status: 'CURRENT',
          commit: controlPlaneCommit,
          tree: controlPlaneTree,
        },
        implementationEvidence: {
          path: `git:${commit}`,
          sha256: sha256(`${commit}:${tree}`),
          status: 'CURRENT',
          commit,
          tree,
        },
        selfReviewEvidence: {
          path: oldReviewPath,
          sha256: sha256(oldReviewText),
          status: 'CURRENT',
          commit,
          tree,
        },
        commit,
        tree,
        history: [],
      },
    },
  };
  const statePath = join(runtime, 'task-state.json');
  await put('/', statePath, `${JSON.stringify(state, null, 2)}\n`);
  await put(
    root,
    'tools/task-verifier/verify.ts',
    '// trusted tools/task-verifier/verify.ts\n// merged compatibility hotfix\n',
  );
  git(root, ['add', 'tools/task-verifier/verify.ts']);
  git(root, ['commit', '-m', 'trusted compatibility hotfix']);
  return {
    root,
    taskWorktree,
    clusterWorktree,
    baseCommit,
    commit,
    tree,
    oldReviewPath,
    oldReviewText,
    statePath,
    state,
    receiptPath,
    previousReceiptPath,
    legacyTask,
  };
};

const checks = async () => ({
  spec: 'trusted spec checks passed',
  prohibited: 'trusted prohibited checks passed',
  architecture: 'trusted architecture checks passed',
  acceptance: 'trusted legacy acceptance checks passed',
});

const bindCurrentPreviousReview = async (fixture: Fixture): Promise<void> => {
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8'));
  const target = state.tasks['T-G0-CORE'];
  const legacyReview = JSON.parse(fixture.oldReviewText);
  const previousReceiptText = await readFile(fixture.previousReceiptPath, 'utf8');
  const review = TaskReviewSchema.parse({
    ...legacyReview,
    lifecycleBindingSha256: target.lifecycleBinding.sha256,
    verificationBaselineSha256: target.verificationBaseline.sha256,
    launchReceiptId: 'antigravity-previous',
    launchReceiptSha256: sha256(previousReceiptText),
  });
  const reviewText = `${JSON.stringify(review, null, 2)}\n`;
  await writeFile(
    join(runtimeRoot(fixture.root), fixture.oldReviewPath),
    reviewText,
  );
  target.selfReviewEvidence.sha256 = sha256(reviewText);
  target.recovery = {
    previousLeaseId: review.leaseId,
    previousFencingVersion: review.leaseFencingVersion,
    previousExpiresAt: '2020-01-01T00:00:00.000Z',
    resultingLeaseId: target.leaseId,
    resultingFencingVersion: target.leaseVersion,
    previousVerificationBaseline: target.verificationBaseline,
    resultingVerificationBaseline: target.verificationBaseline,
  };
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
  await put(
    runtimeRoot(fixture.root),
    'evidence-status.json',
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        records: [
          {
            taskId: 'T-G0-CORE',
            kind: 'SELF_REVIEW',
            ...target.selfReviewEvidence,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
};

const amendCorrection = async (
  fixture: Fixture,
  content = 'export const value = 3;\n',
): Promise<{ commit: string; tree: string }> => {
  await put(fixture.taskWorktree, 'packages/domain/src/index.ts', content);
  git(fixture.taskWorktree, ['add', 'packages/domain/src/index.ts']);
  git(fixture.taskWorktree, ['commit', '--amend', '--no-edit']);
  return {
    commit: git(fixture.taskWorktree, ['rev-parse', 'HEAD']),
    tree: git(fixture.taskWorktree, ['rev-parse', 'HEAD^{tree}']),
  };
};

const correction = (
  fixture: Fixture,
  expectedPreviousCommit = fixture.commit,
  failureCode = 'TASK_LINE_BUDGET_EXCEEDED',
) =>
  correctTaskSelfReview(
    'T-G0-CORE',
    'zcode-orchestrator',
    3,
    fixture.taskWorktree,
    expectedPreviousCommit,
    failureCode,
    {
      trustedRoot: fixture.root,
      now: new Date('2030-01-01T00:01:00.000Z'),
      dependencies: { runChecks: checks },
    },
  );

describe('trusted self-review refresh', () => {
  it('rejects a legacy review under the normal current schema', async () => {
    const fixture = await createFixture();
    const value = JSON.parse(fixture.oldReviewText);
    expect(() => TaskReviewSchema.parse(value)).toThrow();
    expect(value).not.toHaveProperty('lifecycleBindingSha256');
    expect(value).not.toHaveProperty('verificationBaselineSha256');
    expect(value).not.toHaveProperty('launchReceiptId');
    expect(value).not.toHaveProperty('launchReceiptSha256');
  });

  it('writes a current immutable review from the bound legacy contract without changing product history', async () => {
    const fixture = await createFixture();
    const beforeState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const beforeHead = git(fixture.taskWorktree, ['rev-parse', 'HEAD']);
    const beforeTree = git(fixture.taskWorktree, ['rev-parse', 'HEAD^{tree}']);
    const result = await refreshTaskSelfReview(
      'T-G0-CORE',
      'zcode-orchestrator',
      3,
      fixture.taskWorktree,
      {
        trustedRoot: fixture.root,
        now: new Date('2030-01-01T00:01:00.000Z'),
        dependencies: { runChecks: checks },
      },
    );
    expect(result.contractMode).toBe('LEGACY');
    expect(result.newReview.path).toMatch(/\.refresh-[a-f0-9]{64}\.review\.json$/);
    expect(result.newReview.path).not.toBe(fixture.oldReviewPath);
    expect(await readFile(join(runtimeRoot(fixture.root), fixture.oldReviewPath), 'utf8')).toBe(
      fixture.oldReviewText,
    );
    const refreshedText = await readFile(
      join(runtimeRoot(fixture.root), result.newReview.path),
      'utf8',
    );
    const refreshed = TaskReviewSchema.parse(JSON.parse(refreshedText));
    expect(refreshed.acceptanceTestArtifacts.map((item) => item.path)).toEqual([
      'tests/legacy.spec.ts',
    ]);
    expect(refreshed.lifecycleBindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshed.verificationBaselineSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshed.launchReceiptId).toBe('antigravity-current');
    expect(refreshed.launchReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    const afterState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const beforeTarget = beforeState.tasks['T-G0-CORE'];
    const afterTarget = afterState.tasks['T-G0-CORE'];
    const newEvidence = afterTarget.selfReviewEvidence;
    delete beforeTarget.selfReviewEvidence;
    delete afterTarget.selfReviewEvidence;
    expect(afterState).toEqual(beforeState);
    expect(newEvidence).toEqual(result.newReview);
    expect(git(fixture.taskWorktree, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.taskWorktree, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(fixture.taskWorktree, ['rev-parse', 'HEAD^{tree}'])).toBe(beforeTree);
    expect(await readBoundTaskReview(fixture.root, result.newReview, {
      taskId: 'T-G0-CORE',
      baseCommit: fixture.baseCommit,
      commit: fixture.commit,
      tree: fixture.tree,
    })).toMatchObject({ review: { launchReceiptId: 'antigravity-current' } });
  });

  it.each([
    ['wrong worktree', 'TASK_WORKTREE_TARGET_MISMATCH'],
    ['wrong branch', 'TASK_BRANCH_MISMATCH'],
    ['wrong commit', 'TASK_COMMIT_MISMATCH'],
    ['wrong tree', 'TASK_TREE_MISMATCH'],
    ['wrong lease', 'SELF_REVIEW_REFRESH_RECEIPT_MATCH_COUNT:0'],
    ['wrong fencing', 'STALE_LEASE_VERSION'],
    ['wrong holder', 'WRONG_LEASE_OWNER'],
  ])('rejects %s', async (scenario, error) => {
    const fixture = await createFixture();
    const state = structuredClone(fixture.state) as {
      tasks: Record<
        string,
        { branch: string; commit: string; tree: string; leaseId: string }
      >;
    };
    let target = fixture.taskWorktree;
    let holder = 'zcode-orchestrator';
    let fencing = 3;
    const taskState = state.tasks['T-G0-CORE']!;
    if (scenario === 'wrong worktree') target = fixture.root;
    if (scenario === 'wrong branch')
      taskState.branch = 'task/wrong';
    if (scenario === 'wrong commit')
      taskState.commit = '9'.repeat(40);
    if (scenario === 'wrong tree')
      taskState.tree = '9'.repeat(40);
    if (scenario === 'wrong lease')
      taskState.leaseId = 'T-G0-CORE:3:wrong';
    if (scenario === 'wrong fencing') fencing = 4;
    if (scenario === 'wrong holder') holder = 'wrong-holder';
    await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(
      refreshTaskSelfReview('T-G0-CORE', holder, fencing, target, {
        trustedRoot: fixture.root,
        now: new Date('2030-01-01T00:01:00.000Z'),
        dependencies: { runChecks: checks },
      }),
    ).rejects.toThrow(error);
  });

  it('fails closed for zero or multiple exact current launch receipts and prints candidate IDs', () => {
    const binding = {
      taskId: 'T-G0-CORE',
      leaseId: 'lease-3',
      fencingVersion: 3,
      holder: 'zcode-orchestrator',
      taskWorktree: '/tmp/task',
    };
    const candidate = (receiptId: string): LaunchReceiptCandidate => ({
      receiptId,
      raw: '{}',
      sha256: 'a'.repeat(64),
      runtime: '/tmp/runtime',
      value: {
        schemaVersion: '2.0.0',
        receiptId,
        provider: 'antigravity',
        taskId: binding.taskId,
        leaseId: binding.leaseId,
        fencingVersion: binding.fencingVersion,
        holder: binding.holder,
        taskWorktree: binding.taskWorktree,
      },
    });
    expect(() =>
      selectSelfReviewRefreshReceipt(
        [{ ...candidate('old'), value: { receiptId: 'old' } }],
        binding,
      ),
    ).toThrow('MATCH_COUNT:0:CANDIDATES:old');
    expect(() =>
      selectSelfReviewRefreshReceipt(
        [candidate('current-a'), candidate('current-b')],
        binding,
      ),
    ).toThrow('MATCH_COUNT:2:CANDIDATES:current-a,current-b');
  });

  it('runs the selected receipt through the full validator', async () => {
    const fixture = await createFixture();
    const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'));
    receipt.receiptHash = '0'.repeat(64);
    await writeFile(fixture.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await expect(
      refreshTaskSelfReview(
        'T-G0-CORE',
        'zcode-orchestrator',
        3,
        fixture.taskWorktree,
        {
          trustedRoot: fixture.root,
          now: new Date('2030-01-01T00:01:00.000Z'),
          dependencies: { runChecks: checks },
        },
      ),
    ).rejects.toThrow('LAUNCH_RECEIPT_INTERNAL_HASH_MISMATCH');
  });
});

describe('trusted self-review correction', () => {
  it('selects the provider that performed a precisely bound correction', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'ciag-codex-correction-'));
    temporary.push(runtime);
    const goalRoot = join(runtime, 'goals/T-G0-CORE');
    await mkdir(goalRoot, { recursive: true });
    const goal = '- Correction required: TASK_LINE_BUDGET_EXCEEDED\n';
    const goalPath = join(goalRoot, 'goal.md');
    await writeFile(goalPath, goal);
    const value = {
      schemaVersion: '2.0.0', taskId: 'T-G0-CORE', leaseId: 'lease-4', fencingVersion: 4,
      holder: 'agent-orchestrator', taskWorktree: '/tmp/task', provider: 'codex', goalPath,
      goalSha256: sha256(goal), correction: { previousCommit: 'a'.repeat(40), failureCodes: ['TASK_LINE_BUDGET_EXCEEDED'] },
    };
    const raw = `${JSON.stringify(value)}\n`;
    const selected = await selectSelfReviewCorrectionReceipt(
      [{ receiptId: 'codex-current', raw, sha256: sha256(raw), runtime, value }],
      { taskId: 'T-G0-CORE', leaseId: 'lease-4', fencingVersion: 4, holder: 'agent-orchestrator', taskWorktree: '/tmp/task', previousCommit: 'a'.repeat(40) },
      'TASK_LINE_BUDGET_EXCEEDED',
    );
    expect(selected.value.provider).toBe('codex');
  });

  it('accepts one amended atomic HEAD, stales prior evidence, and leaves root verification ready', async () => {
    const fixture = await createFixture();
    await bindCurrentPreviousReview(fixture);
    const amended = await amendCorrection(fixture);
    const productBefore = await readFile(
      join(fixture.taskWorktree, 'packages/domain/src/index.ts'),
      'utf8',
    );
    const beforeState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const beforeTarget = beforeState.tasks['T-G0-CORE'];

    const result = await correction(fixture);

    expect(result).toMatchObject({
      commit: amended.commit,
      tree: amended.tree,
      state: 'SELF_REVIEWING',
      failureCode: 'TASK_LINE_BUDGET_EXCEEDED',
      previousImplementation: { status: 'STALE', commit: fixture.commit },
      previousReview: { status: 'STALE', commit: fixture.commit },
      implementationEvidence: { status: 'CURRENT', commit: amended.commit },
      selfReviewEvidence: { status: 'CURRENT', commit: amended.commit },
      launchReceiptId: 'antigravity-current',
    });
    const afterState = JSON.parse(await readFile(fixture.statePath, 'utf8'));
    const afterTarget = afterState.tasks['T-G0-CORE'];
    expect(afterTarget).toMatchObject({
      state: 'SELF_REVIEWING',
      commit: amended.commit,
      tree: amended.tree,
      implementationEvidence: result.implementationEvidence,
      selfReviewEvidence: result.selfReviewEvidence,
    });
    for (const key of [
      'baseCommit',
      'leaseId',
      'leaseVersion',
      'holder',
      'expiresAt',
      'branch',
      'worktree',
      'lifecycleBinding',
      'verificationBaseline',
      'recovery',
    ])
      expect(afterTarget[key]).toEqual(beforeTarget[key]);
    const ledger = JSON.parse(
      await readFile(join(runtimeRoot(fixture.root), 'evidence-status.json'), 'utf8'),
    );
    expect(ledger.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'IMPLEMENTATION',
          commit: fixture.commit,
          status: 'STALE',
          reason: 'SELF_REVIEW_CORRECTION',
        }),
        expect.objectContaining({
          kind: 'SELF_REVIEW',
          commit: fixture.commit,
          status: 'STALE',
          reason: 'SELF_REVIEW_CORRECTION',
        }),
        expect.objectContaining({
          kind: 'IMPLEMENTATION',
          commit: amended.commit,
          status: 'CURRENT',
        }),
        expect.objectContaining({
          kind: 'SELF_REVIEW',
          commit: amended.commit,
          status: 'CURRENT',
        }),
      ]),
    );
    const bound = await readBoundTaskReview(
      fixture.root,
      result.selfReviewEvidence,
      {
        taskId: 'T-G0-CORE',
        baseCommit: fixture.baseCommit,
        commit: amended.commit,
        tree: amended.tree,
      },
    );
    expect(bound.review).toMatchObject({
      schemaVersion: '2.0.0',
      launchReceiptId: 'antigravity-current',
      rebase: {
        previousHeadCommit: fixture.commit,
        semanticChangesDetected: true,
      },
    });
    expect(git(fixture.taskWorktree, ['rev-list', '--count', `${fixture.baseCommit}..HEAD`])).toBe(
      '1',
    );
    expect(git(fixture.taskWorktree, ['status', '--porcelain'])).toBe('');
    expect(git(fixture.taskWorktree, ['rev-parse', 'HEAD'])).toBe(amended.commit);
    expect(
      await readFile(
        join(fixture.taskWorktree, 'packages/domain/src/index.ts'),
        'utf8',
      ),
    ).toBe(productBefore);
  });

  it('rejects an unchanged implementation HEAD', async () => {
    const fixture = await createFixture();
    await bindCurrentPreviousReview(fixture);
    await expect(correction(fixture)).rejects.toThrow(
      'SELF_REVIEW_CORRECTION_HEAD_UNCHANGED',
    );
  });

  it('rejects a second commit instead of one amended atomic commit', async () => {
    const fixture = await createFixture();
    await bindCurrentPreviousReview(fixture);
    await put(
      fixture.taskWorktree,
      'packages/domain/src/index.ts',
      'export const value = 3;\n',
    );
    git(fixture.taskWorktree, ['add', 'packages/domain/src/index.ts']);
    git(fixture.taskWorktree, ['commit', '-m', 'second correction commit']);
    await expect(correction(fixture)).rejects.toThrow('TASK_COMMIT_NOT_ATOMIC');
  });

  it('rejects the wrong supplied previous commit', async () => {
    const fixture = await createFixture();
    await bindCurrentPreviousReview(fixture);
    await amendCorrection(fixture);
    await expect(correction(fixture, '9'.repeat(40))).rejects.toThrow(
      'PREVIOUS_TASK_COMMIT_BINDING_MISMATCH',
    );
  });

  it.each(['wrong receipt', 'wrong failure code'])(
    'rejects %s correction binding',
    async (scenario) => {
      const fixture = await createFixture();
      await bindCurrentPreviousReview(fixture);
      await amendCorrection(fixture);
      if (scenario === 'wrong receipt') {
        const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'));
        receipt.receiptHash = '0'.repeat(64);
        await writeFile(
          fixture.receiptPath,
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
      }
      await expect(
        correction(
          fixture,
          fixture.commit,
          scenario === 'wrong failure code'
            ? 'TASK_WRONG_FAILURE'
            : 'TASK_LINE_BUDGET_EXCEEDED',
        ),
      ).rejects.toThrow(
        scenario === 'wrong receipt'
          ? 'LAUNCH_RECEIPT_INTERNAL_HASH_MISMATCH'
          : 'SELF_REVIEW_CORRECTION_RECEIPT_MATCH_COUNT:0',
      );
    },
  );

  it('rejects an amended correction whose recomputed lines exceed budget', async () => {
    const fixture = await createFixture();
    await bindCurrentPreviousReview(fixture);
    await amendCorrection(
      fixture,
      `${Array.from({ length: 1001 }, (_, index) => `export const value${index} = ${index};`).join('\n')}\n`,
    );
    await expect(correction(fixture)).rejects.toThrow(
      'TASK_LINE_BUDGET_EXCEEDED',
    );
  });
});
