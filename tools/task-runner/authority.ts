import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TaskContractSchema, type TaskContract } from '@ciag/shared-schemas';
import type { EvidenceReference, TaskState } from './state.js';
import { canonicalTrustedDirectory, readTrustedFile } from '../agent/lib/trusted-path.js';
import { TASK_VERIFIER_VERSION, VERIFICATION_POLICY_VERSION } from '../task-verifier/policy.js';

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};
const commonRoot = (cwd: string): string => {
  const value = git(cwd, ['rev-parse', '--git-common-dir']);
  return resolve(cwd, isAbsolute(value) ? value : join(cwd, value));
};
const immutableWrite = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== content) throw new Error(`IMMUTABLE_AUTHORITY_COLLISION:${path}`);
  }
};

export interface LifecycleBindingDocument {
  schemaVersion: '1.0.0';
  taskId: string;
  clusterId: string;
  contractMode: 'LEGACY' | 'GENERATED';
  bindingRoot: string;
  contractPath: string;
  contractSha256: string;
  contextManifestPath: string;
  contextManifestSha256: string;
  conformanceManifestPath?: string;
  conformanceManifestSha256?: string;
  conformanceBindingRoot?: string;
  sourceHashes: TaskContract['sourceHashes'];
  baseCommit: string;
}

export interface VerificationBaselineDocument {
  schemaVersion: '1.1.0';
  taskId: string;
  verifierVersion: string;
  verificationPolicyVersion: string;
  lifecycleBindingSha256: string;
  taskContractSha256: string;
  contextManifestSha256: string;
  conformanceManifestSha256?: string;
  sourceHashManifestSha256: string;
  generatedInterfaceIndexSha256: string;
  acceptancePartitionSha256: string;
  allowedPathsSha256: string;
  forbiddenPathsSha256: string;
  writeSetSha256: string;
  requiredTestsSha256: string;
  verifierEntrypointSha256: string;
  verifierPolicySha256: string;
  architecturePolicySha256: string;
  prohibitedCapabilityPolicySha256: string;
  controlPlaneCommit: string;
  controlPlaneTree: string;
  releaseBaseline: { tag: string; commit: string; tree: string };
}

export const computeWorkingCopyHashes = async (cwd: string): Promise<{ tracked: string; untracked: string }> => {
  const trackedDiff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: null });
  if (trackedDiff.status !== 0) throw new Error('TRACKED_WORK_HASH_FAILED');
  const files = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const manifest = (await Promise.all(files.map(async (path) => `${sha256(await readFile(join(cwd, path)))}  ${path}\n`))).sort().join('');
  return { tracked: sha256(trackedDiff.stdout), untracked: sha256(manifest) };
};

export const validateRecoveryWorkspace = async (options: {
  taskWorktree: string;
  expectedBranch: string;
  expectedBaseCommit: string;
  expectedTrackedWorkSha256: string;
  expectedUntrackedWorkSha256: string;
  contractPath: string;
  expectedContractSha256: string;
  contextManifestPath: string;
  expectedContextManifestSha256: string;
}): Promise<{ contractText: string; contextManifestText: string }> => {
  const worktree = await realpath(resolve(options.taskWorktree));
  if ((await realpath(resolve(git(worktree, ['rev-parse', '--show-toplevel'])))) !== worktree)
    throw new Error('RECOVERY_WORKTREE_MISMATCH');
  if (git(worktree, ['branch', '--show-current']) !== options.expectedBranch)
    throw new Error('RECOVERY_BRANCH_MISMATCH');
  if (git(worktree, ['rev-parse', 'HEAD']) !== options.expectedBaseCommit)
    throw new Error('RECOVERY_BASE_MISMATCH');
  const contractText = (await readTrustedFile(worktree, options.contractPath, 'RECOVERY_CONTRACT')).toString('utf8');
  if (sha256(contractText) !== options.expectedContractSha256)
    throw new Error('RECOVERY_LEGACY_CONTRACT_DRIFT');
  const contextManifestText = (await readTrustedFile(worktree, options.contextManifestPath, 'RECOVERY_CONTEXT_MANIFEST')).toString('utf8');
  if (sha256(contextManifestText) !== options.expectedContextManifestSha256)
    throw new Error('RECOVERY_LEGACY_CONTEXT_DRIFT');
  const hashes = await computeWorkingCopyHashes(worktree);
  if (hashes.tracked !== options.expectedTrackedWorkSha256)
    throw new Error('RECOVERY_TRACKED_WORK_DRIFT');
  if (hashes.untracked !== options.expectedUntrackedWorkSha256)
    throw new Error('RECOVERY_UNTRACKED_WORK_DRIFT');
  return { contractText, contextManifestText };
};

const fileHash = async (root: string, path: string): Promise<string> =>
  sha256(await readTrustedFile(root, path, 'CONTROL_PLANE_AUTHORITY_FILE'));

export const persistLifecycleAuthority = async (options: {
  trustedRoot: string;
  taskRoot: string;
  task: TaskContract;
  state: TaskState;
  contractPath: string;
  contextManifestPath: string;
  contractMode: 'LEGACY' | 'GENERATED';
  compatibilityConformanceManifestPath?: string;
  compatibilityConformanceManifestSha256?: string;
}): Promise<{ binding: EvidenceReference; baseline: EvidenceReference }> => {
  const { trustedRoot, taskRoot, task, state } = options;
  if (!state.baseCommit) throw new Error('AUTHORITY_BASE_COMMIT_MISSING');
  if (git(trustedRoot, ['status', '--porcelain']) !== '')
    throw new Error('TRUSTED_CONTROL_PLANE_DIRTY');
  const conformanceManifestPath =
    options.compatibilityConformanceManifestPath ?? task.conformanceManifestPath;
  const conformanceManifestSha256 =
    options.compatibilityConformanceManifestSha256 ?? task.conformanceManifestSha256;
  if (
    options.compatibilityConformanceManifestPath &&
    (!conformanceManifestSha256 ||
      (await fileHash(trustedRoot, options.compatibilityConformanceManifestPath)) !== conformanceManifestSha256)
  )
    throw new Error('COMPATIBILITY_CONFORMANCE_MANIFEST_DRIFT');
  const contractSha256 = await fileHash(taskRoot, options.contractPath);
  const contextManifestSha256 = await fileHash(taskRoot, options.contextManifestPath);
  const bindingDocument: LifecycleBindingDocument = {
    schemaVersion: '1.0.0', taskId: task.id, clusterId: task.cluster,
    contractMode: options.contractMode, bindingRoot: taskRoot,
    contractPath: options.contractPath, contractSha256,
    contextManifestPath: options.contextManifestPath, contextManifestSha256,
    ...(conformanceManifestPath ? { conformanceManifestPath } : {}),
    ...(conformanceManifestSha256 ? { conformanceManifestSha256 } : {}),
    ...(options.compatibilityConformanceManifestPath ? { conformanceBindingRoot: trustedRoot } : {}),
    sourceHashes: task.sourceHashes, baseCommit: state.baseCommit,
  };
  const bindingText = `${JSON.stringify(bindingDocument, null, 2)}\n`;
  const bindingSha256 = sha256(bindingText);
  const common = await canonicalTrustedDirectory(commonRoot(trustedRoot), 'AUTHORITY_GIT_COMMON_DIRECTORY');
  const runtime = join(common, 'ciag-runtime');
  const bindingPath = join(runtime, 'lifecycle-bindings', task.id, `${bindingSha256}.json`);
  await immutableWrite(bindingPath, bindingText);
  const verifierPolicy = `${await readFile(join(trustedRoot, 'tools/task-verifier/verify.ts'), 'utf8')}\n${await readFile(join(trustedRoot, 'tools/task-verifier/attestation.ts'), 'utf8')}\n${await readFile(join(trustedRoot, 'tools/task-verifier/policy.ts'), 'utf8')}`;
  const architecturePolicy = await readFile(join(trustedRoot, 'tools/architecture-verifier/verify.ts'));
  const prohibitedPolicy = await readFile(join(trustedRoot, 'tools/architecture-verifier/cli.ts'));
  const releaseCommit = git(trustedRoot, ['rev-parse', 'harness-v1.0.1^{commit}']);
  const baselineDocument: VerificationBaselineDocument = {
    schemaVersion: '1.1.0', taskId: task.id,
    verifierVersion: TASK_VERIFIER_VERSION,
    verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
    lifecycleBindingSha256: bindingSha256,
    taskContractSha256: contractSha256, contextManifestSha256,
    ...(bindingDocument.conformanceManifestSha256
      ? { conformanceManifestSha256: bindingDocument.conformanceManifestSha256 }
      : {}),
    sourceHashManifestSha256: await fileHash(trustedRoot, 'docs/spec/SHA256SUMS'),
    generatedInterfaceIndexSha256: await fileHash(trustedRoot, 'tasks/generated/interface-hashes.json'),
    acceptancePartitionSha256: await fileHash(trustedRoot, 'artifacts/spec/acceptance-partition.json'),
    allowedPathsSha256: sha256(JSON.stringify(task.allowedPaths)), forbiddenPathsSha256: sha256(JSON.stringify(task.forbiddenPaths)),
    writeSetSha256: sha256(JSON.stringify(task.writeSet)), requiredTestsSha256: sha256(JSON.stringify(task.requiredTests)),
    verifierEntrypointSha256: await fileHash(trustedRoot, 'tools/task-verifier/cli.ts'), verifierPolicySha256: sha256(verifierPolicy),
    architecturePolicySha256: sha256(architecturePolicy), prohibitedCapabilityPolicySha256: sha256(prohibitedPolicy),
    controlPlaneCommit: git(trustedRoot, ['rev-parse', 'HEAD']), controlPlaneTree: git(trustedRoot, ['rev-parse', 'HEAD^{tree}']),
    releaseBaseline: { tag: 'harness-v1.0.1', commit: releaseCommit, tree: git(trustedRoot, ['rev-parse', `${releaseCommit}^{tree}`]) },
  };
  const baselineText = `${JSON.stringify(baselineDocument, null, 2)}\n`;
  const baselineSha256 = sha256(baselineText);
  const baselinePath = join(runtime, 'verification-baselines', task.id, `${baselineSha256}.json`);
  await immutableWrite(baselinePath, baselineText);
  return {
    binding: { path: relative(runtime, bindingPath), sha256: bindingSha256, status: 'CURRENT' },
    baseline: { path: relative(runtime, baselinePath), sha256: baselineSha256, status: 'CURRENT', commit: baselineDocument.controlPlaneCommit, tree: baselineDocument.controlPlaneTree },
  };
};

export const readLifecycleBinding = async (
  root: string,
  state: TaskState,
  includeCompleted = false,
): Promise<LifecycleBindingDocument | undefined> => {
  const evidence = state.lifecycleBinding ?? (includeCompleted ? state.completedLifecycleBinding : undefined);
  if (!evidence) return undefined;
  const common = await canonicalTrustedDirectory(commonRoot(root), 'LIFECYCLE_GIT_COMMON_DIRECTORY');
  const runtime = join(common, 'ciag-runtime');
  const text = (await readTrustedFile(runtime, evidence.path, 'LIFECYCLE_BINDING')).toString('utf8');
  if (sha256(text) !== evidence.sha256) throw new Error('LIFECYCLE_BINDING_HASH_MISMATCH');
  return JSON.parse(text) as LifecycleBindingDocument;
};

export const readBoundTaskContract = async (
  root: string,
  state: TaskState,
  includeCompleted = false,
): Promise<TaskContract | undefined> => {
  const binding = await readLifecycleBinding(root, state, includeCompleted);
  if (!binding) return undefined;
  let text: string;
  try {
    text = (await readTrustedFile(binding.bindingRoot, binding.contractPath, 'BOUND_TASK_CONTRACT')).toString('utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !state.commit) throw error;
    const result = spawnSync('git', ['show', `${state.commit}:${binding.contractPath}`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('COMPLETED_LIFECYCLE_CONTRACT_MISSING');
    text = result.stdout;
  }
  if (sha256(text) !== binding.contractSha256) throw new Error('LIFECYCLE_CONTRACT_HASH_MISMATCH');
  const task = TaskContractSchema.parse(JSON.parse(text));
  if (task.id !== state.taskId || task.cluster !== binding.clusterId)
    throw new Error('LIFECYCLE_CONTRACT_ID_MISMATCH');
  return task;
};

export const readVerificationBaseline = async (
  root: string,
  state: TaskState,
  includeCompleted = false,
): Promise<VerificationBaselineDocument | undefined> => {
  const evidence = state.verificationBaseline ?? (includeCompleted ? state.completedVerificationBaseline : undefined);
  if (!evidence) return undefined;
  const common = await canonicalTrustedDirectory(commonRoot(root), 'BASELINE_GIT_COMMON_DIRECTORY');
  const runtime = join(common, 'ciag-runtime');
  const text = (await readTrustedFile(runtime, evidence.path, 'VERIFICATION_BASELINE')).toString('utf8');
  if (sha256(text) !== evidence.sha256) throw new Error('VERIFICATION_BASELINE_HASH_MISMATCH');
  const value = JSON.parse(text) as Partial<VerificationBaselineDocument>;
  if (!value.verifierVersion) throw new Error('VERIFICATION_BASELINE_VERIFIER_VERSION_MISSING');
  if (!value.verificationPolicyVersion) throw new Error('VERIFICATION_BASELINE_POLICY_VERSION_MISSING');
  if (value.schemaVersion !== '1.1.0') throw new Error('VERIFICATION_BASELINE_SCHEMA_VERSION_INVALID');
  return value as VerificationBaselineDocument;
};

export const validateVerificationBaseline = async (trustedRoot: string, state: TaskState): Promise<VerificationBaselineDocument> => {
  const baseline = await readVerificationBaseline(trustedRoot, state);
  if (!baseline || !state.lifecycleBinding) throw new Error('VERIFICATION_BASELINE_MISSING');
  if (baseline.verifierVersion !== TASK_VERIFIER_VERSION) throw new Error('VERIFICATION_BASELINE_VERIFIER_VERSION_MISMATCH');
  if (baseline.verificationPolicyVersion !== VERIFICATION_POLICY_VERSION) throw new Error('VERIFICATION_BASELINE_POLICY_VERSION_MISMATCH');
  if (baseline.lifecycleBindingSha256 !== state.lifecycleBinding.sha256) throw new Error('VERIFICATION_BASELINE_LIFECYCLE_MISMATCH');
  if (git(trustedRoot, ['status', '--porcelain']) !== '') throw new Error('TRUSTED_CONTROL_PLANE_DIRTY');
  if (git(trustedRoot, ['rev-parse', 'HEAD']) !== baseline.controlPlaneCommit || git(trustedRoot, ['rev-parse', 'HEAD^{tree}']) !== baseline.controlPlaneTree)
    throw new Error('TRUSTED_CONTROL_PLANE_COMMIT_MISMATCH');
  if (await fileHash(trustedRoot, 'docs/spec/SHA256SUMS') !== baseline.sourceHashManifestSha256) throw new Error('VERIFICATION_BASELINE_SOURCE_HASH_DRIFT');
  if (await fileHash(trustedRoot, 'tasks/generated/interface-hashes.json') !== baseline.generatedInterfaceIndexSha256) throw new Error('VERIFICATION_BASELINE_INTERFACE_INDEX_DRIFT');
  if (await fileHash(trustedRoot, 'artifacts/spec/acceptance-partition.json') !== baseline.acceptancePartitionSha256) throw new Error('VERIFICATION_BASELINE_ACCEPTANCE_PARTITION_DRIFT');
  if (await fileHash(trustedRoot, 'tools/task-verifier/cli.ts') !== baseline.verifierEntrypointSha256) throw new Error('VERIFICATION_BASELINE_ENTRYPOINT_DRIFT');
  const verifierPolicy = `${await readFile(join(trustedRoot, 'tools/task-verifier/verify.ts'), 'utf8')}\n${await readFile(join(trustedRoot, 'tools/task-verifier/attestation.ts'), 'utf8')}\n${await readFile(join(trustedRoot, 'tools/task-verifier/policy.ts'), 'utf8')}`;
  if (sha256(verifierPolicy) !== baseline.verifierPolicySha256) throw new Error('VERIFICATION_BASELINE_POLICY_DRIFT');
  if (await fileHash(trustedRoot, 'tools/architecture-verifier/verify.ts') !== baseline.architecturePolicySha256) throw new Error('VERIFICATION_BASELINE_ARCHITECTURE_DRIFT');
  if (await fileHash(trustedRoot, 'tools/architecture-verifier/cli.ts') !== baseline.prohibitedCapabilityPolicySha256) throw new Error('VERIFICATION_BASELINE_PROHIBITED_POLICY_DRIFT');
  return baseline;
};
