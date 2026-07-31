import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClusterContractSchema, TaskContractSchema, TaskResultSchema, TaskReviewSchema, type ClusterContract, type TaskContract } from '@ciag/shared-schemas';
import { driftCheck, loadAndValidateSpecification, sha256, waitForCompilerIdle } from '../prd-compiler/compiler.js';
import { placeholderViolations, scanPlaceholders, scanProhibitedCapabilities, verifyArchitecture } from '../architecture-verifier/verify.js';
import { registerCurrentEvidence } from '../task-runner/evidence-ledger.js';
import {
  assertLease,
  currentLeaseCredential,
  readState,
  runtimeRoot,
  transition,
  writeState,
  type EvidenceReference,
} from '../task-runner/state.js';
import { deriveAcceptanceMapping, deriveChangedFiles, deriveRequirementMapping, persistCommandEvidence, TASK_VERIFIER_VERSION, validateTaskAttestation, VERIFICATION_POLICY_VERSION } from './attestation.js';
import { verifyRuntimeBaseline } from './runtime-baseline.js';
import { taskBranch } from '../worktree-manager/identity.js';
import {
  assertConformanceProtection,
  assertConformanceTestQuality,
  readConformanceManifest,
} from './conformance.js';
import { readLifecycleBinding, validateVerificationBaseline } from '../task-runner/authority.js';
import { validateLaunchReceipt } from '../agent/lib/runtime.js';
import { SystemCommandRunner } from '../agent/lib/system.js';

export interface CommandEvidence { command: string; exitCode: number; output: string; outputSha256: string }
export const deriveEvidenceVerdict = (requiredCommands: string[], evidence: CommandEvidence[]): 'PASS' => { for (const command of requiredCommands) { const item = evidence.find((candidate) => candidate.command === command); if (!item) throw new Error(`MISSING_COMMAND_EVIDENCE:${command}`); if (item.exitCode !== 0) throw new Error(`COMMAND_FAILED:${command}`); if (sha256(item.output) !== item.outputSha256) throw new Error(`FORGED_COMMAND_EVIDENCE:${command}`); if (/^(?:PASS|ok|true)$/i.test(item.output.trim())) throw new Error(`UNSUBSTANTIATED_COMMAND_EVIDENCE:${command}`); } return 'PASS'; };

const git = (args: string[], cwd = process.cwd(), allowFailure = false): string => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0 && !allowFailure) throw new Error(`GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`); return result.stdout.trim(); };
const run = (command: string, args: string[], cwd = process.cwd()): CommandEvidence => { const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 }); const output = `${result.stdout ?? ''}${result.stderr ?? ''}`; return { command: [command, ...args].join(' '), exitCode: result.status ?? 1, output, outputSha256: sha256(output) }; };
const covers = (pattern: string, path: string): boolean => pattern.endsWith('/**') ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : pattern === path;
export const resultPath = (taskId: string, cwd = process.cwd()): string =>
  join(runtimeRoot(cwd), 'results', `${taskId}.result.json`);

export const loadTasks = async (): Promise<TaskContract[]> => { await waitForCompilerIdle(); const tasks: TaskContract[] = []; for (let index = 0; index <= 7; index += 1) { const root = join(process.cwd(), `tasks/G${index}`); for (const file of await readdir(root)) if (file.endsWith('.contract.json')) tasks.push(TaskContractSchema.parse(JSON.parse(await readFile(join(root, file), 'utf8')))); } return tasks.sort((left, right) => left.id.localeCompare(right.id)); };
export const loadClusters = async (): Promise<ClusterContract[]> => { await waitForCompilerIdle(); const clusters: ClusterContract[] = []; for (let index = 0; index <= 7; index += 1) { const root = join(process.cwd(), `clusters/G${index}`); for (const file of await readdir(root)) if (file.endsWith('.contract.json')) clusters.push(ClusterContractSchema.parse(JSON.parse(await readFile(join(root, file), 'utf8')))); } return clusters.sort((left, right) => left.id.localeCompare(right.id)); };

export const verifyCoverage = async (): Promise<{ requirements: number; acceptanceCriteria: number; tasks: number }> => { const spec = await loadAndValidateSpecification(); const tasks = await loadTasks(); const requirementCounts = new Map<string, number>(); for (const task of tasks) for (const id of task.requirements) requirementCounts.set(id, (requirementCounts.get(id) ?? 0) + 1); const levels = JSON.parse(await readFile('tasks/generated/acceptance-level-map.json', 'utf8')) as Record<string, { level: 'TASK' | 'CLUSTER' | 'PROJECT'; owner: string }>; const badRequirements = spec.manifest.requirements.filter((item) => requirementCounts.get(item.id) !== 1); const badAcceptance = spec.manifest.acceptanceCriteria.filter((item) => !levels[item.id]); const unknownAcceptance = Object.keys(levels).filter((id) => !spec.manifest.acceptanceCriteria.some((item) => item.id === id)); const taskIds = new Set(tasks.map((task) => task.id)); const clusters = await loadClusters(); const clusterIds = new Set(clusters.map((cluster) => cluster.id)); const invalidOwners = Object.entries(levels).filter(([, value]) => value.level === 'TASK' ? !taskIds.has(value.owner) : value.level === 'CLUSTER' ? !clusterIds.has(value.owner) : value.owner !== 'PROJECT'); if (badRequirements.length || badAcceptance.length || unknownAcceptance.length || invalidOwners.length) throw new Error(`INCOMPLETE_OR_DUPLICATE_COVERAGE:R=${badRequirements.length}:A=${badAcceptance.length + unknownAcceptance.length + invalidOwners.length}`); return { requirements: requirementCounts.size, acceptanceCriteria: Object.keys(levels).length, tasks: tasks.length }; };

export const verifyTaskContract = async (taskId: string): Promise<{ taskId: string; evidenceHash: string }> => {
  const spec = await loadAndValidateSpecification(); const task = (await loadTasks()).find((item) => item.id === taskId); if (!task) throw new Error('TASK_NOT_FOUND'); if (JSON.stringify(task.sourceHashes) !== JSON.stringify(spec.hashes)) throw new Error('TASK_SOURCE_HASH_DRIFT');
  for (const requirement of task.requirements) if (!spec.manifest.requirements.some((item) => item.id === requirement)) throw new Error(`UNKNOWN_REQUIREMENT:${requirement}`);
  const acceptance = spec.manifest.acceptanceCriteria.filter((item) => task.acceptanceCriteria.includes(item.id)); for (const id of task.acceptanceCriteria) if (!acceptance.some((item) => item.id === id)) throw new Error(`UNKNOWN_ACCEPTANCE:${id}`);
  const expectedTests = [...new Set([...acceptance.flatMap((item) => [item.positiveTestRef, item.negativeOrFailureTestRef]), ...(task.taskAcceptanceFacets.length > 0 ? [`tests/task-facets/${task.id}.spec.ts`, `tests/task-facets/${task.id}.negative.spec.ts`] : [])])]; if (JSON.stringify(task.requiredTests) !== JSON.stringify(expectedTests)) throw new Error(`TASK_TEST_MAPPING_DRIFT:${task.id}`);
  for (const path of task.writeSet) if (!task.allowedPaths.some((pattern) => covers(pattern, path.replace(/\/\*\*$/, '')) || pattern === path)) throw new Error(`WRITE_SET_OUTSIDE_ALLOWED:${task.id}:${path}`);
  if (task.changeBudget.maxMigrations === 0 && !task.forbiddenPaths.includes('infra/migrations/**')) throw new Error(`MIGRATION_OWNERSHIP_MISSING:${task.id}`);
  if (task.verificationCommands.some((item) => item.command.includes('task:verify'))) throw new Error(`RECURSIVE_TASK_VERIFICATION:${task.id}`);
  const conformance = await readConformanceManifest(task); if (!conformance) throw new Error(`CONFORMANCE_MANIFEST_MISSING:${task.id}`); if (!task.forbiddenPaths.includes('tests/conformance/**') || !task.forbiddenPaths.includes(`artifacts/conformance/${task.id}/**`)) throw new Error(`CONFORMANCE_ORACLE_NOT_PROTECTED:${task.id}`);
  const index = JSON.parse(await readFile('tasks/generated/interface-hashes.json', 'utf8')) as Record<string, Record<string, string>>; if (JSON.stringify(index[task.id]) !== JSON.stringify(task.interfaceHashes)) throw new Error(`STALE_INTERFACE_HASH:${task.id}`);
  return { taskId, evidenceHash: createHash('sha256').update(JSON.stringify(task)).digest('hex') };
};

const immutableControlPlanePaths = [
  'docs/spec/**', 'tasks/**', 'clusters/**', 'artifacts/spec/**', 'artifacts/conformance/**',
  'tests/conformance/**', 'tools/task-verifier/**', 'tools/architecture-verifier/**',
  'tools/task-runner/**', 'tools/merge-queue/**', 'tools/agent/**',
  'tools/prd-compiler/**', 'tools/cluster-verifier/**', 'tools/worktree-manager/**',
  'docs/schemas/**', '.github/**',
  'package.json', 'pnpm-lock.yaml',
];
export const assertTrustedTargetPaths = (changed: string[]): void => {
  for (const path of changed)
    if (immutableControlPlanePaths.some((pattern) => covers(pattern, path)))
      throw new Error(`UNTRUSTED_CONTROL_PLANE_CHANGE:${path}`);
};

const worktreeForBranch = (root: string, branch: string): string => {
  const block = git(['worktree', 'list', '--porcelain'], root)
    .split('\n\n')
    .find((item) => item.split('\n').includes(`branch refs/heads/${branch}`));
  const path = block?.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
  if (!path) throw new Error(`BOUND_WORKTREE_NOT_FOUND:${branch}`);
  return path;
};

export const verifyTask = async (
  taskId: string,
  holder: string,
  leaseVersion: number,
  options: { trustedRoot?: string; targetWorktree?: string } = {},
): Promise<{ taskId: string; commit: string; evidenceHash: string }> => {
  const trustedRoot = options.trustedRoot ?? process.cwd();
  const generatedTasks = await loadTasks();
  const state = await readState(generatedTasks, trustedRoot);
  const target = assertLease(state, taskId, leaseVersion, holder, new Date());
  if (target.state !== 'SELF_REVIEWING') throw new Error(`SELF_REVIEW_REQUIRED:${target.state}`);
  if (!target.worktree) throw new Error('TASK_WORKTREE_MISSING');
  const authorizedWorktree = await realpath(target.worktree);
  const requestedWorktree = await realpath(options.targetWorktree ?? target.worktree);
  if (requestedWorktree !== authorizedWorktree) throw new Error('TASK_WORKTREE_TARGET_MISMATCH');
  const targetWorktree = authorizedWorktree;
  const lifecycle = await readLifecycleBinding(trustedRoot, target);
  if (!lifecycle) throw new Error('LIFECYCLE_BINDING_MISSING');
  const baseline = await validateVerificationBaseline(trustedRoot, target);
  const contractText = await readFile(join(lifecycle.bindingRoot, lifecycle.contractPath), 'utf8');
  if (sha256(contractText) !== lifecycle.contractSha256 || lifecycle.contractSha256 !== baseline.taskContractSha256)
    throw new Error('TRUSTED_TASK_CONTRACT_BINDING_MISMATCH');
  const boundTask = TaskContractSchema.parse(JSON.parse(contractText));
  const task: TaskContract =
    lifecycle.contractMode === 'LEGACY' &&
    lifecycle.conformanceManifestPath &&
    lifecycle.conformanceManifestSha256
      ? {
          ...boundTask,
          conformanceManifestPath: lifecycle.conformanceManifestPath,
          conformanceManifestSha256: lifecycle.conformanceManifestSha256,
          testQualityGate:
            boundTask.riskLevel === 'HIGH' || boundTask.riskLevel === 'CRITICAL'
              ? 'SEEDED_FAULT_OR_PROPERTY'
              : 'NEGATIVE_CASE',
        }
      : boundTask;
  if (task.id !== taskId || task.cluster !== lifecycle.clusterId) throw new Error('TRUSTED_TASK_CONTRACT_ID_MISMATCH');
  const contextText = await readFile(join(lifecycle.bindingRoot, lifecycle.contextManifestPath), 'utf8');
  if (
    sha256(contextText) !== lifecycle.contextManifestSha256 ||
    lifecycle.contextManifestSha256 !== baseline.contextManifestSha256
  )
    throw new Error('TRUSTED_TASK_CONTEXT_BINDING_MISMATCH');
  if (
    sha256(JSON.stringify(task.allowedPaths)) !== baseline.allowedPathsSha256 ||
    sha256(JSON.stringify(task.forbiddenPaths)) !== baseline.forbiddenPathsSha256 ||
    sha256(JSON.stringify(task.writeSet)) !== baseline.writeSetSha256 ||
    sha256(JSON.stringify(task.requiredTests)) !== baseline.requiredTestsSha256
  )
    throw new Error('TRUSTED_TASK_POLICY_BASELINE_MISMATCH');
  if (JSON.stringify(task.sourceHashes) !== JSON.stringify(lifecycle.sourceHashes))
    throw new Error('TRUSTED_TASK_SOURCE_BINDING_MISMATCH');
  if (task.conformanceManifestPath || task.conformanceManifestSha256) {
    if (
      task.conformanceManifestPath !== lifecycle.conformanceManifestPath ||
      task.conformanceManifestSha256 !== lifecycle.conformanceManifestSha256 ||
      task.conformanceManifestSha256 !== baseline.conformanceManifestSha256
    )
      throw new Error('TRUSTED_TASK_CONFORMANCE_BINDING_MISMATCH');
    const conformanceText = await readFile(
      join(lifecycle.conformanceBindingRoot ?? lifecycle.bindingRoot, task.conformanceManifestPath!),
      'utf8',
    );
    if (sha256(conformanceText) !== task.conformanceManifestSha256)
      throw new Error('TRUSTED_TASK_CONFORMANCE_HASH_MISMATCH');
  }
  const interfaceIndex = JSON.parse(
    await readFile(join(trustedRoot, 'tasks/generated/interface-hashes.json'), 'utf8'),
  ) as Record<string, Record<string, string>>;
  if (JSON.stringify(interfaceIndex[taskId]) !== JSON.stringify(task.interfaceHashes))
    throw new Error('TRUSTED_TASK_INTERFACE_BINDING_MISMATCH');
  const expectedBranch = taskBranch(taskId);
  const branch = git(['branch', '--show-current'], targetWorktree);
  if (branch !== expectedBranch || target.branch !== expectedBranch) throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
  if (git(['status', '--porcelain'], targetWorktree) !== '') throw new Error('DIRTY_WORKTREE');
  const base = target.baseCommit;
  if (!base || base !== lifecycle.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING_OR_DRIFTED');
  const commit = git(['rev-parse', 'HEAD'], targetWorktree);
  if (commit === base) throw new Error('TASK_COMMIT_MISSING');
  if (Number(git(['rev-list', '--count', `${base}..${commit}`], targetWorktree)) !== 1) throw new Error('TASK_COMMIT_NOT_ATOMIC');
  const changed = git(['diff', '--name-only', `${base}..${commit}`], targetWorktree).split('\n').filter(Boolean);
  if (changed.length === 0) throw new Error('TASK_DIFF_EMPTY');
  assertTrustedTargetPaths(changed);
  if (changed.length > task.complexityBudget.maxFiles) throw new Error('TASK_FILE_BUDGET_EXCEEDED');
  const conformanceRoot = lifecycle.conformanceBindingRoot ?? targetWorktree;
  await assertConformanceProtection(task, changed, targetWorktree, conformanceRoot);
  for (const path of changed) {
    if (task.forbiddenPaths.some((pattern) => covers(pattern, path))) throw new Error(`FORBIDDEN_PATH_CHANGE:${path}`);
    if (!task.allowedPaths.some((pattern) => covers(pattern, path))) throw new Error(`PATH_OUTSIDE_TASK_SCOPE:${path}`);
  }
  const reviewCommit = commit;
  const reviewTree = git(['rev-parse', 'HEAD^{tree}'], targetWorktree);
  if (!target.selfReviewEvidence) throw new Error('SELF_REVIEW_EVIDENCE_MISSING');
  const reviewPath = join(runtimeRoot(trustedRoot), 'reviews', taskId, `${commit}.review.json`);
  const reviewText = await readFile(reviewPath, 'utf8');
  const review = TaskReviewSchema.parse(JSON.parse(reviewText));
  if (
    !target.leaseId ||
    !target.holder ||
    !target.expiresAt ||
    !target.lifecycleBinding ||
    !target.verificationBaseline
  )
    throw new Error('VERIFICATION_BINDING_MISSING');
  const receiptExpiry = target.expiresAt;
  const provider = review.launchReceiptId.startsWith('antigravity-')
    ? 'antigravity'
    : review.launchReceiptId.startsWith('zcode-')
      ? 'zcode'
      : undefined;
  if (!provider) throw new Error('LAUNCH_RECEIPT_PROVIDER_UNBOUND');
  const clusterBranch = `cluster/${task.dependencyGroup.toLowerCase()}`;
  await validateLaunchReceipt(trustedRoot, new SystemCommandRunner(), {
    taskId,
    clusterId: task.cluster,
    leaseId: target.leaseId,
    fencingVersion: target.leaseVersion,
    contextManifestSha256: lifecycle.contextManifestSha256,
    ...(lifecycle.conformanceManifestSha256
      ? { conformanceManifestSha256: lifecycle.conformanceManifestSha256 }
      : {}),
    receiptId: review.launchReceiptId,
    receiptSha256: review.launchReceiptSha256,
    provider,
    holder: target.holder,
    expiresAt: receiptExpiry,
    taskBranch: expectedBranch,
    taskWorktree: targetWorktree,
    clusterBranch,
    clusterWorktree: worktreeForBranch(trustedRoot, clusterBranch),
    baseCommit: base,
    baseTree: git(['rev-parse', `${base}^{tree}`], targetWorktree),
    release: {
      ...baseline.releaseBaseline,
      tagObject: git(['rev-parse', `refs/tags/${baseline.releaseBaseline.tag}`], trustedRoot),
    },
    integrationTarget: 'main',
    contextManifestPath: lifecycle.contextManifestPath,
    ...(lifecycle.conformanceManifestPath
      ? { conformanceManifestPath: lifecycle.conformanceManifestPath }
      : {}),
    contractPath: lifecycle.contractPath,
    contractSha256: lifecycle.contractSha256,
    lifecycleBindingPath: target.lifecycleBinding.path,
    lifecycleBindingSha256: target.lifecycleBinding.sha256,
    verificationBaselinePath: target.verificationBaseline.path,
    verificationBaselineSha256: target.verificationBaseline.sha256,
    pathLocks: task.exclusiveLocks,
    controlPlaneCommit: baseline.controlPlaneCommit,
    controlPlaneTree: baseline.controlPlaneTree,
    requireProviderNeutral: true,
  });
  const credential = currentLeaseCredential(target);
  transition(target, ['SELF_REVIEWING'], 'VERIFYING', { command: 'trusted-root:task:verify', credential, evidence: target.selfReviewEvidence, currentCommit: reviewCommit, currentTree: reviewTree });
  await writeState(state, trustedRoot);
  try {
    const changedLines = git(['diff', '--numstat', `${base}..${commit}`], targetWorktree).split('\n').filter(Boolean).reduce((sum, line) => sum + line.split('\t').slice(0, 2).reduce((count, value) => count + (Number(value) || 0), 0), 0);
    if (changedLines > task.complexityBudget.maxChangedLines) throw new Error('TASK_LINE_BUDGET_EXCEEDED');
    for (const path of task.requiredTests) {
      if (!path.startsWith('tests/') || path.includes('..')) throw new Error(`UNSAFE_TEST_PATH:${path}`);
      await access(join(targetWorktree, path));
      const text = await readFile(join(targetWorktree, path), 'utf8');
      const violations = placeholderViolations(path, text);
      if (violations.length > 0) throw new Error(`INVALID_TASK_TEST:${violations.join(',')}`);
    }
    await assertConformanceTestQuality(task, targetWorktree, conformanceRoot);
    const trustedTsx = (path: string, args: string[] = []): [string, string[]] => ['pnpm', ['exec', 'tsx', join(trustedRoot, path), ...args]];
    const commands: Array<[string, string[]]> = [
      ['pnpm', ['exec', 'vitest', 'run', ...task.requiredTests]],
      ['pnpm', ['exec', 'vitest', 'run', 'tests/conformance/task-oracle.spec.ts']],
      trustedTsx('tools/architecture-verifier/cli.ts', ['architecture']),
      trustedTsx('tools/architecture-verifier/cli.ts', ['placeholders']),
      trustedTsx('tools/architecture-verifier/cli.ts', ['prohibited']),
      trustedTsx('tools/task-verifier/cli.ts', ['spec:verify']),
      trustedTsx('tools/prd-compiler/cli.ts', ['drift-check']),
    ];
    const evidence = commands.map(([command, args]) => run(command, args, targetWorktree));
    deriveEvidenceVerdict(evidence.map((item) => item.command), evidence);
    const changedFiles = deriveChangedFiles(base, commit, targetWorktree);
    const commandEvidence = await persistCommandEvidence(taskId, commit, evidence, trustedRoot);
    const specification = await loadAndValidateSpecification();
    const result = TaskResultSchema.parse({ schemaVersion: '2.0.0', taskId, status: 'PASS', bindings: {
      taskContractSha256: lifecycle.contractSha256, prdSha256: specification.hashes.prd,
      requirementManifestSha256: specification.hashes.requirements, auditSha256: specification.hashes.audit,
      baseCommitSha: base, headCommitSha: commit, headTreeSha: reviewTree, changedFiles,
      requirementToCode: deriveRequirementMapping(task, changedFiles, commit, targetWorktree),
      acceptanceToTests: await deriveAcceptanceMapping(task, commit, targetWorktree),
      requiredTestArtifacts: commandEvidence.filter((item) => item.command.includes('vitest run')),
      dependencyInterfaceHashes: task.interfaceHashes, verifierVersion: TASK_VERIFIER_VERSION,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION, leaseId: target.leaseId,
      leaseFencingVersion: target.leaseVersion, verificationTimestamp: new Date().toISOString(),
      selfReviewPath: `reviews/${taskId}/${commit}.review.json`, selfReviewSha256: sha256(reviewText),
      conformanceManifestPath: task.conformanceManifestPath, conformanceManifestSha256: task.conformanceManifestSha256,
      lifecycleBindingSha256: target.lifecycleBinding.sha256, verificationBaselineSha256: target.verificationBaseline.sha256,
      launchReceiptId: review.launchReceiptId, launchReceiptSha256: review.launchReceiptSha256,
    }, commandEvidence });
    await validateTaskAttestation(task, result, { cwd: targetWorktree, currentHeadRequired: true, state: target });
    const path = resultPath(taskId, trustedRoot);
    const resultText = `${JSON.stringify(result, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, resultText, { mode: 0o600 });
    const evidenceHash = sha256(resultText); const relativePath = `results/${taskId}.result.json`;
    const resultEvidence: EvidenceReference = { path: relativePath, sha256: evidenceHash, status: 'CURRENT', commit, tree: reviewTree };
    const verificationEvidence: EvidenceReference = { ...resultEvidence };
    await registerCurrentEvidence(taskId, 'TASK_RESULT', resultEvidence, trustedRoot);
    await registerCurrentEvidence(taskId, 'VERIFICATION', verificationEvidence, trustedRoot);
    target.taskResultEvidence = resultEvidence; target.commit = commit; target.tree = reviewTree;
    transition(target, ['VERIFYING'], 'VERIFIED', { command: 'trusted-root:task:verify:proof-carrying', credential, evidence: verificationEvidence, currentCommit: commit, currentTree: reviewTree });
    await writeState(state, trustedRoot); return { taskId, commit, evidenceHash };
  } catch (error) { target.state = 'SELF_REVIEWING'; await writeState(state, trustedRoot); throw error; }
};

export const readTaskResult = async (taskId: string, cwd = process.cwd()): Promise<ReturnType<typeof TaskResultSchema.parse>> => TaskResultSchema.parse(JSON.parse(await readFile(resultPath(taskId, cwd), 'utf8')));

export const verifyHarness = async (): Promise<Record<string, unknown>> => {
  const specification = await loadAndValidateSpecification(); const drift = await driftCheck(); const coverage = await verifyCoverage(); const runtime = await verifyRuntimeBaseline(); const architecture = await verifyArchitecture(); const placeholders = await scanPlaceholders(); const prohibited = await scanProhibitedCapabilities(); const tasks = await loadTasks(); const clusters = await loadClusters();
  const taskIds = new Set(tasks.map((task) => task.id)); if (taskIds.size !== tasks.length) throw new Error('DUPLICATE_TASK_ID'); for (const task of tasks) { await verifyTaskContract(task.id); for (const dependency of task.dependencies) if (!taskIds.has(dependency)) throw new Error(`UNKNOWN_TASK_DEPENDENCY:${task.id}:${dependency}`); }
  const assignments = new Map<string, number>(); for (const cluster of clusters) { if (JSON.stringify(cluster.sourceHashes) !== JSON.stringify(specification.hashes)) throw new Error(`CLUSTER_SOURCE_HASH_DRIFT:${cluster.id}`); for (const taskId of cluster.tasks) assignments.set(taskId, (assignments.get(taskId) ?? 0) + 1); } if (tasks.some((task) => assignments.get(task.id) !== 1)) throw new Error('TASK_CLUSTER_ASSIGNMENT_INVALID');
  const semantic = JSON.parse(await readFile('artifacts/spec/semantic-stage.v1.json', 'utf8')) as Record<string, unknown>; const { artifactId, payloadSha256, liveModelCalls, ...payload } = semantic; const semanticHash = sha256(`${JSON.stringify(payload, null, 2)}\n`); if (payloadSha256 !== semanticHash || artifactId !== `semantic-stage-v1-${semanticHash}` || liveModelCalls !== false) throw new Error('SEMANTIC_ARTIFACT_INVALID');
  return { sourceHashes: specification.hashes, drift, coverage, runtime, architecture, placeholders, prohibited, taskContracts: tasks.length, clusterContracts: clusters.length, semanticArtifact: artifactId };
};
