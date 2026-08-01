import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  CommandRunner,
  AgentProviderId,
  PayloadBinding,
  ProjectInventory,
} from './types.js';
import { ZCodeError } from './errors.js';
import {
  canonicalTrustedDirectory,
  listTrustedDirectory,
  readTrustedFile,
} from './trusted-path.js';

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

export const gitCommonDirectory = (
  root: string,
  runner: CommandRunner,
): string => {
  const result = runner.run('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
  });
  if (result.status !== 0)
    throw new ZCodeError('GIT_COMMON_DIR_UNAVAILABLE', result.stderr.trim());
  const value = result.stdout.trim();
  return resolve(root, isAbsolute(value) ? value : join(root, value));
};

export const agentRuntimeRoot = (root: string, runner: CommandRunner): string =>
  join(gitCommonDirectory(root, runner), 'ciag-runtime', 'agent');

export const legacyZCodeRuntimeRoot = (
  root: string,
  runner: CommandRunner,
): string => join(gitCommonDirectory(root, runner), 'ciag-runtime', 'zcode');

/** @deprecated Read-only compatibility name. New evidence is stored under agent/. */
export const zcodeRuntimeRoot = agentRuntimeRoot;

export interface LaunchReceiptCandidate {
  receiptId?: string;
  raw: string;
  sha256: string;
  runtime: string;
  value: Record<string, unknown>;
}

export const listLaunchReceiptCandidates = async (
  root: string,
  runner: CommandRunner,
  taskId: string,
): Promise<LaunchReceiptCandidate[]> => {
  const common = await canonicalTrustedDirectory(
    gitCommonDirectory(root, runner),
    'GIT_COMMON_DIRECTORY',
  );
  const runtimes = [
    join(common, 'ciag-runtime', 'agent'),
    join(common, 'ciag-runtime', 'zcode'),
  ];
  const candidates: LaunchReceiptCandidate[] = [];
  for (const runtime of runtimes) {
    const directory = join(runtime, 'launch-receipts', taskId);
    const discovered = await listTrustedDirectory(
      common,
      directory,
      'LAUNCH_RECEIPT_ROOT',
    );
    for (const entry of discovered.entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile())
        throw new ZCodeError(
          'TRUSTED_PATH_CONTAINMENT',
          `LAUNCH_RECEIPT_CANDIDATE:${entry.name}`,
        );
      const raw = (
        await readTrustedFile(
          discovered.canonicalDirectory!,
          entry.name,
          'LAUNCH_RECEIPT_CANDIDATE',
        )
      ).toString('utf8');
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        value = {};
      }
      candidates.push({
        ...(typeof value.receiptId === 'string'
          ? { receiptId: value.receiptId }
          : {}),
        raw,
        sha256: sha256(raw),
        runtime: await canonicalTrustedDirectory(
          runtime,
          'AGENT_RUNTIME_ROOT',
        ),
        value,
      });
    }
  }
  return candidates;
};

const writeImmutable = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== content)
      throw new ZCodeError('IMMUTABLE_AGENT_EVIDENCE_COLLISION', path);
  }
};

export const generateGoal = (
  binding: Omit<PayloadBinding, 'goalPath' | 'goalSha256'>,
): string => {
  const task = binding.task.contract;
  return `# ${task.id} task execution goal

Implement exactly one task, \`${task.id}\`, in cluster \`${task.cluster}\`.

## Immutable execution bindings

- Cluster branch: \`${binding.task.cluster.branch.branch}\`
- Cluster worktree: \`${binding.task.cluster.branch.worktree}\`
- Task worktree: \`${binding.taskWorkspace}\`
- Release baseline: \`${binding.release.tag}\`
- Release commit: \`${binding.release.commit}\`
- Release tree: \`${binding.release.tree}\`
- Integration target: \`${binding.task.cluster.branch.integrationTarget}\`
- Base commit: \`${binding.baseCommit}\`
- Base tree: \`${binding.baseTree}\`
- Lease ID: \`${binding.leaseId}\`
- Lease holder: \`${binding.holder}\`
- Fencing version: \`${binding.fencingVersion}\`
- Lease expiry: \`${binding.expiresAt}\`
- Context pack: \`${binding.task.contextPath}\`
- Context manifest: \`${binding.contextManifestPath}\`
- Context manifest SHA-256: \`${binding.contextManifestSha256}\`
- Task contract: \`${binding.taskContractPath}\`
- Task contract SHA-256: \`${binding.taskContractSha256}\`
- Lifecycle binding: \`${binding.lifecycleBindingPath}\`
- Lifecycle binding SHA-256: \`${binding.lifecycleBindingSha256}\`
- Trusted verification baseline: \`${binding.verificationBaselinePath}\`
- Trusted verification baseline SHA-256: \`${binding.verificationBaselineSha256}\`
- Trusted control-plane commit/tree: \`${binding.controlPlaneCommit}\` / \`${binding.controlPlaneTree}\`
- Launch receipt ID: \`${binding.launchReceiptId ?? 'pending'}\`
- Immutable conformance manifest: ${binding.conformanceManifestPath ? `\`${binding.conformanceManifestPath}\`` : 'legacy compatibility task'}
- Immutable conformance manifest SHA-256: ${binding.conformanceManifestSha256 ? `\`${binding.conformanceManifestSha256}\`` : 'legacy compatibility task'}
- Path-lock bindings: ${task.exclusiveLocks.length === 0 ? 'none' : task.exclusiveLocks.map((lock) => `\`${lock}\``).join(', ')}

## Contract scope

- Requirements: ${task.requirements.map((id) => `\`${id}\``).join(', ')}
- Acceptance criteria: ${task.acceptanceCriteria.map((id) => `\`${id}\``).join(', ')}
- Task-local acceptance facets: ${(task.taskAcceptanceFacets ?? []).map((facet) => `\`${facet.facetId}\``).join(', ') || 'none'}
- Dependencies: ${task.dependencies.length === 0 ? 'none' : task.dependencies.map((id) => `\`${id}\``).join(', ')}

Allowed paths:
${task.allowedPaths.map((path) => `- \`${path}\``).join('\n')}

Forbidden paths:
${task.forbiddenPaths.map((path) => `- \`${path}\``).join('\n')}

Required tests:
${task.requiredTests.map((path) => `- \`${path}\``).join('\n')}

Required verification commands:
${task.verificationCommands.map((item) => `- \`${item.command}\` — ${item.expected}`).join('\n')}

## Required lifecycle

1. Run \`pnpm spec:verify\` and stop on drift.
2. Validate the receipt-bound lease ID, holder, fencing version, expiry, task branch, worktree, base commit, context hash, and path locks.
3. Run \`pnpm task:begin ${task.id} --holder ${binding.holder} --lease-version ${binding.fencingVersion}\` if the task is still LEASED.
4. Implement positive, negative, degraded, replay, recovery, rollback, and observability behavior required by the contract.
5. Run every declared test and verification command.
   The immutable conformance oracle is control-plane-owned and must not be modified.
6. Create exactly one atomic implementation commit.
7. Self-review the entire committed diff for scope, point-in-time leakage, fabricated success, unsafe fallback, activation, secrets, migration reversibility, and missing observability.
8. Run \`pnpm task:self-review ${task.id} --holder ${binding.holder} --lease-version ${binding.fencingVersion} --launch-receipt-id ${binding.launchReceiptId ?? '<receipt-id>'}\`.
9. Stop. The root orchestrator performs authoritative verification from the clean trusted control plane, then owns merge-queue and next-task actions.

The orchestration receipt and proof-carrying task result together must bind the task ID, cluster ID, contract hash, commit SHA, Git tree SHA, lease ID, fencing version, goal hash, context-pack hash, test-artifact hashes, requirements, and acceptance criteria. A manually authored PASS field is not evidence.

Do not renew or recover a lease inside this agent runtime. Pause before the renewal window and ask the owner to use the explicit root lifecycle command printed by the orchestrator.

## Atomicity, merge, and stopping conditions

- Do not implement any other task.
- Do not work on \`main\` or directly merge into \`main\`.
- Do not invoke the merge queue; the root orchestrator does that after independent verification.
- Do not modify the PRD, generated contracts, generated manifests, acceptance mappings, or CI gates.
- Do not weaken tests, convert required tests to todo, fabricate evidence, activate capability or alpha state, or use prohibited financial capabilities.
${task.stopConditions.map((condition) => `- ${condition}`).join('\n')}
- Stop on any wrong, missing, expired, stale, or conflicting binding.
${binding.failures.map((failure) => `- Correction required: ${failure}`).join('\n')}
`;
};

export const generatePayload = (binding: PayloadBinding): string =>
  `/goal Load and obey the complete task goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source. Complete exactly this task through its atomic commit and self-review, then stop so the root control plane can run the authoritative verifier. Do not invoke the merge queue or start another task.`;

export const persistGoalAndPayload = async (
  root: string,
  runner: CommandRunner,
  binding: Omit<PayloadBinding, 'goalPath' | 'goalSha256'>,
  provider: AgentProviderId = 'zcode',
  payloadFactory: (binding: PayloadBinding) => string = generatePayload,
): Promise<{ binding: PayloadBinding; payload: string }> => {
  const runtime = agentRuntimeRoot(root, runner);
  const launchReceiptId = `${provider}-${sha256(`${binding.task.contract.id}:${binding.leaseId}:${binding.fencingVersion}:${binding.controlPlaneCommit}`).slice(0, 32)}`;
  const receiptBound = { ...binding, launchReceiptId };
  const initialGoal = generateGoal(receiptBound);
  const goalSha256 = sha256(initialGoal);
  const goalPath = join(
    runtime,
    'goals',
    binding.task.contract.id,
    `${goalSha256}.md`,
  );
  const completeBinding: PayloadBinding = { ...receiptBound, goalPath, goalSha256 };
  const goal = generateGoal(completeBinding);
  const finalGoalSha256 = sha256(goal);
  const finalGoalPath =
    finalGoalSha256 === goalSha256
      ? goalPath
      : join(
          runtime,
          'goals',
          binding.task.contract.id,
          `${finalGoalSha256}.md`,
        );
  const finalBinding: PayloadBinding = {
    ...completeBinding,
    goalPath: finalGoalPath,
    goalSha256: finalGoalSha256,
  };
  const finalGoal = generateGoal(finalBinding);
  const stableHash = sha256(finalGoal);
  if (stableHash !== finalBinding.goalSha256)
    throw new ZCodeError('GOAL_HASH_BINDING_NOT_STABLE');
  const payload = payloadFactory(finalBinding);
  const payloadPath = join(
    runtime,
    'payloads',
    binding.task.contract.id,
    `${sha256(payload)}.txt`,
  );
  await writeImmutable(finalGoalPath, finalGoal);
  await writeImmutable(payloadPath, `${payload}\n`);
  const receiptPath = join(
    runtime,
    'launch-receipts',
    binding.task.contract.id,
    `${launchReceiptId}.json`,
  );
  const receiptCore = {
    schemaVersion: '2.0.0',
    receiptId: launchReceiptId,
    provider,
    clusterId: binding.task.contract.cluster,
    taskId: binding.task.contract.id,
    taskBranch: binding.task.workspaceBranch ?? binding.task.state.branch,
    clusterBranch: binding.task.cluster.branch.branch,
    clusterWorktree: binding.task.cluster.branch.worktree,
    taskWorktree: binding.taskWorkspace,
    release: binding.release,
    integrationTarget: binding.task.cluster.branch.integrationTarget,
    leaseId: binding.leaseId,
    holder: binding.holder,
    fencingVersion: binding.fencingVersion,
    expiresAt: binding.expiresAt,
    baseCommit: binding.baseCommit,
    baseTree: binding.baseTree,
    goalPath: finalBinding.goalPath,
    goalSha256: finalBinding.goalSha256,
    contextManifestPath: binding.contextManifestPath,
    contextManifestSha256: binding.contextManifestSha256,
    contractPath: binding.taskContractPath,
    contractSha256: binding.taskContractSha256,
    lifecycleBindingPath: binding.lifecycleBindingPath,
    lifecycleBindingSha256: binding.lifecycleBindingSha256,
    verificationBaselinePath: binding.verificationBaselinePath,
    verificationBaselineSha256: binding.verificationBaselineSha256,
    controlPlaneCommit: binding.controlPlaneCommit,
    controlPlaneTree: binding.controlPlaneTree,
    ...(binding.conformanceManifestPath
      ? { conformanceManifestPath: binding.conformanceManifestPath }
      : {}),
    ...(binding.conformanceManifestSha256
      ? { conformanceManifestSha256: binding.conformanceManifestSha256 }
      : {}),
    pathLocks: binding.task.contract.exclusiveLocks,
  };
  const receipt = { ...receiptCore, receiptHash: sha256(JSON.stringify(receiptCore)) };
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeImmutable(receiptPath, receiptText);
  return { binding: { ...finalBinding, launchReceiptSha256: sha256(receiptText) }, payload };
};

export const validateLaunchReceipt = async (
  root: string,
  runner: CommandRunner,
  binding: {
    taskId: string;
    clusterId: string;
    leaseId: string;
    fencingVersion: number;
    contextManifestSha256: string;
    conformanceManifestSha256?: string;
    receiptId?: string;
    receiptSha256?: string;
    provider?: AgentProviderId;
    holder?: string;
    expiresAt?: string;
    taskBranch?: string;
    taskWorktree?: string;
    clusterBranch?: string;
    clusterWorktree?: string;
    baseCommit?: string;
    baseTree?: string;
    release?: PayloadBinding['release'];
    integrationTarget?: string;
    contextManifestPath?: string;
    conformanceManifestPath?: string;
    contractPath?: string;
    contractSha256?: string;
    lifecycleBindingPath?: string;
    lifecycleBindingSha256?: string;
    verificationBaselinePath?: string;
    verificationBaselineSha256?: string;
    pathLocks?: string[];
    controlPlaneCommit?: string;
    controlPlaneTree?: string;
    requireProviderNeutral?: boolean;
  },
): Promise<void> => {
  const candidates = await listLaunchReceiptCandidates(
    root,
    runner,
    binding.taskId,
  );
  const selected = candidates.find(({ value }) =>
    value.taskId === binding.taskId &&
    value.clusterId === binding.clusterId &&
    value.leaseId === binding.leaseId &&
    value.fencingVersion === binding.fencingVersion &&
    (!binding.receiptId || value.receiptId === binding.receiptId),
  );
  if (!selected)
    throw new ZCodeError('LAUNCH_RECEIPT_MISSING', binding.taskId);
  const receipt = JSON.parse(selected.raw) as {
    schemaVersion?: string;
    receiptId?: string;
    receiptHash?: string;
    provider?: AgentProviderId;
    taskId?: string;
    clusterId?: string;
    leaseId?: string;
    fencingVersion?: number;
    contextManifestSha256?: string;
    goalPath?: string;
    goalSha256?: string;
    conformanceManifestSha256?: string;
    holder?: string;
    expiresAt?: string;
    taskBranch?: string;
    taskWorktree?: string;
    clusterBranch?: string;
    clusterWorktree?: string;
    baseCommit?: string;
    baseTree?: string;
    release?: PayloadBinding['release'];
    integrationTarget?: string;
    contextManifestPath?: string;
    conformanceManifestPath?: string;
    contractPath?: string;
    contractSha256?: string;
    lifecycleBindingPath?: string;
    lifecycleBindingSha256?: string;
    verificationBaselinePath?: string;
    verificationBaselineSha256?: string;
    pathLocks?: string[];
    controlPlaneCommit?: string;
    controlPlaneTree?: string;
  };
  if (binding.receiptSha256 && sha256(selected.raw) !== binding.receiptSha256)
    throw new ZCodeError('LAUNCH_RECEIPT_FILE_HASH_MISMATCH');
  if (binding.requireProviderNeutral && receipt.schemaVersion !== '2.0.0')
    throw new ZCodeError('PROVIDER_NEUTRAL_LAUNCH_RECEIPT_REQUIRED');
  if (receipt.schemaVersion === '2.0.0') {
    if (!receipt.receiptId || !receipt.receiptHash)
      throw new ZCodeError('LAUNCH_RECEIPT_ID_OR_HASH_MISSING');
    const { receiptHash, ...core } = receipt;
    if (sha256(JSON.stringify(core)) !== receiptHash)
      throw new ZCodeError('LAUNCH_RECEIPT_INTERNAL_HASH_MISMATCH');
  }
  if (
    receipt.taskId !== binding.taskId ||
    receipt.clusterId !== binding.clusterId
  )
    throw new ZCodeError('LAUNCH_RECEIPT_TASK_BINDING_MISMATCH');
  if (
    receipt.leaseId !== binding.leaseId ||
    receipt.fencingVersion !== binding.fencingVersion
  )
    throw new ZCodeError('LAUNCH_RECEIPT_LEASE_BINDING_MISMATCH');
  if (receipt.contextManifestSha256 !== binding.contextManifestSha256)
    throw new ZCodeError('LAUNCH_RECEIPT_CONTEXT_BINDING_MISMATCH');
  if (
    binding.conformanceManifestSha256 &&
    receipt.conformanceManifestSha256 !== binding.conformanceManifestSha256
  )
    throw new ZCodeError('LAUNCH_RECEIPT_CONFORMANCE_BINDING_MISMATCH');
  if (!receipt.goalPath || !receipt.goalSha256)
    throw new ZCodeError('LAUNCH_RECEIPT_GOAL_BINDING_MISSING');
  const expectedGoalRoot = join(selected.runtime, 'goals', binding.taskId);
  let goal: Buffer;
  try {
    goal = await readTrustedFile(expectedGoalRoot, receipt.goalPath, 'LAUNCH_RECEIPT_GOAL');
  } catch (error) {
    throw new ZCodeError(
      'LAUNCH_RECEIPT_GOAL_PATH_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (sha256(goal) !== receipt.goalSha256)
    throw new ZCodeError('LAUNCH_RECEIPT_GOAL_HASH_MISMATCH');
  if (receipt.schemaVersion === '2.0.0') {
    const comparisons: Array<[unknown, unknown, string]> = [
      [receipt.receiptId, binding.receiptId, 'ID'],
      [receipt.provider, binding.provider, 'PROVIDER'],
      [receipt.holder, binding.holder, 'HOLDER'],
      [receipt.expiresAt, binding.expiresAt, 'EXPIRY'],
      [receipt.taskBranch, binding.taskBranch, 'TASK_BRANCH'],
      [receipt.taskWorktree, binding.taskWorktree, 'TASK_WORKTREE'],
      [receipt.clusterBranch, binding.clusterBranch, 'CLUSTER_BRANCH'],
      [receipt.clusterWorktree, binding.clusterWorktree, 'CLUSTER_WORKTREE'],
      [receipt.baseCommit, binding.baseCommit, 'BASE_COMMIT'],
      [receipt.baseTree, binding.baseTree, 'BASE_TREE'],
      [receipt.integrationTarget, binding.integrationTarget, 'INTEGRATION_TARGET'],
      [receipt.contextManifestPath, binding.contextManifestPath, 'CONTEXT_PATH'],
      [receipt.conformanceManifestPath, binding.conformanceManifestPath, 'CONFORMANCE_PATH'],
      [receipt.contractPath, binding.contractPath, 'CONTRACT_PATH'],
      [receipt.contractSha256, binding.contractSha256, 'CONTRACT_HASH'],
      [receipt.lifecycleBindingPath, binding.lifecycleBindingPath, 'LIFECYCLE_BINDING_PATH'],
      [receipt.lifecycleBindingSha256, binding.lifecycleBindingSha256, 'LIFECYCLE_BINDING_HASH'],
      [receipt.verificationBaselinePath, binding.verificationBaselinePath, 'VERIFICATION_BASELINE_PATH'],
      [receipt.verificationBaselineSha256, binding.verificationBaselineSha256, 'VERIFICATION_BASELINE_HASH'],
      [receipt.controlPlaneCommit, binding.controlPlaneCommit, 'CONTROL_PLANE_COMMIT'],
      [receipt.controlPlaneTree, binding.controlPlaneTree, 'CONTROL_PLANE_TREE'],
    ];
    for (const [actual, expected, name] of comparisons)
      if ((binding.requireProviderNeutral || expected !== undefined) && actual !== expected)
        throw new ZCodeError(`LAUNCH_RECEIPT_${name}_MISMATCH`);
    if (binding.release && JSON.stringify(receipt.release) !== JSON.stringify(binding.release))
      throw new ZCodeError('LAUNCH_RECEIPT_RELEASE_MISMATCH');
    if (binding.pathLocks && JSON.stringify(receipt.pathLocks) !== JSON.stringify(binding.pathLocks))
      throw new ZCodeError('LAUNCH_RECEIPT_LOCK_MISMATCH');
    if (!receipt.expiresAt || Date.parse(receipt.expiresAt) <= Date.now())
      throw new ZCodeError('LAUNCH_RECEIPT_EXPIRED');
  }
};

export const persistProjectMapping = async (
  inventory: ProjectInventory,
  runner: CommandRunner,
): Promise<void> => {
  const path = join(
    agentRuntimeRoot(inventory.root, runner),
    'project-map.json',
  );
  const value = {
    schemaVersion: '1.0.0',
    root: inventory.root,
    rootHead: inventory.rootHead,
    release: inventory.release,
    clusters: inventory.clusters.map((cluster) => ({
      clusterId: cluster.contract.id,
      canonicalBranch: cluster.branch.branch,
      integrationBase: cluster.branch.integrationTarget,
      worktreePath: cluster.branch.worktree,
      branchHead: cluster.branchHead ?? null,
      worktreeState: cluster.worktreeDirty
        ? 'DIRTY'
        : cluster.worktreeHead
          ? 'CLEAN'
          : 'ABSENT',
      clusterLifecycleState: cluster.state,
    })),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
