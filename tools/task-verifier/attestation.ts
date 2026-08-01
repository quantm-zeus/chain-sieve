import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskResultSchema, TaskReviewSchema, type TaskContract } from '@ciag/shared-schemas';
import { loadAndValidateSpecification, sha256 } from '../prd-compiler/compiler.js';
import { assertEvidenceCurrent } from '../task-runner/evidence-ledger.js';
import { runtimeRoot, type TaskState } from '../task-runner/state.js';
import { readLifecycleBinding, readVerificationBaseline } from '../task-runner/authority.js';
import { readTrustedFile } from '../agent/lib/trusted-path.js';
import { TASK_VERIFIER_VERSION, VERIFICATION_POLICY_VERSION } from './policy.js';

export { TASK_VERIFIER_VERSION, VERIFICATION_POLICY_VERSION } from './policy.js';

type TaskResult = ReturnType<typeof TaskResultSchema.parse>;
type CommandEvidence = TaskResult['commandEvidence'][number];

const gitText = (args: string[], cwd = process.cwd(), allowFailure = false): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};

const gitBytes = (args: string[], cwd = process.cwd()): Uint8Array => {
  const result = spawnSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}:${String(result.stderr).trim()}`);
  return result.stdout;
};

const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**') ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : pattern === path;
const sameJson = (left: unknown, right: unknown): boolean => isDeepStrictEqual(left, right);
const deletedHash = (path: string): string => sha256(`DELETED\0${path}`);

export const hashPathAtCommit = (commit: string, path: string, status = 'M', cwd = process.cwd()): string =>
  status === 'D' ? deletedHash(path) : sha256(gitBytes(['show', `${commit}:${path}`], cwd));

export const deriveChangedFiles = (
  base: string,
  head: string,
  cwd = process.cwd(),
): TaskResult['bindings']['changedFiles'] => {
  const output = gitText(['diff', '--name-status', '--find-renames', `${base}..${head}`], cwd);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      const status = fields[0]?.slice(0, 1) as TaskResult['bindings']['changedFiles'][number]['status'];
      const path = status === 'R' || status === 'C' ? fields[2] : fields[1];
      if (!path || !['A', 'C', 'M', 'R', 'T', 'U', 'X', 'B', 'D'].includes(status))
        throw new Error(`CHANGED_FILE_STATUS_INVALID:${line}`);
      return { path, status, sha256: hashPathAtCommit(head, path, status, cwd) };
    });
};

const contractPath = (task: TaskContract): string => `tasks/${task.dependencyGroup}/${task.id}.contract.json`;
const hashedPath = (head: string, path: string, cwd: string): { path: string; sha256: string } => ({
  path,
  sha256: hashPathAtCommit(head, path, 'M', cwd),
});

export const deriveRequirementMapping = (
  task: TaskContract,
  changedFiles: TaskResult['bindings']['changedFiles'],
  head: string,
  cwd = process.cwd(),
): TaskResult['bindings']['requirementToCode'] =>
  task.requirements.map((requirementId) => {
    const patterns = task.deliverables
      .filter((item) => item.endsWith(`@requirement ${requirementId}`))
      .map((item) => item.slice(0, item.lastIndexOf(' @requirement ')));
    const paths = changedFiles
      .filter(
        (file) =>
          file.status !== 'D' &&
          !file.path.startsWith('tests/') &&
          patterns.some((pattern) => covers(pattern, file.path)),
      )
      .map((file) => hashedPath(head, file.path, cwd));
    if (paths.length === 0) throw new Error(`EMPTY_REQUIREMENT_TO_CODE_MAPPING:${requirementId}`);
    return { requirementId, files: paths };
  });

export const deriveAcceptanceMapping = async (
  task: TaskContract,
  head: string,
  cwd = process.cwd(),
): Promise<TaskResult['bindings']['acceptanceToTests']> => {
  const specification = await loadAndValidateSpecification();
  const taskCriteria = task.acceptanceCriteria.map((acceptanceId) => {
    const acceptance = specification.manifest.acceptanceCriteria.find((item) => item.id === acceptanceId);
    if (!acceptance) throw new Error(`UNKNOWN_ACCEPTANCE:${acceptanceId}`);
    const paths = [acceptance.positiveTestRef, acceptance.negativeOrFailureTestRef];
    if (paths.some((path) => !task.requiredTests.includes(path)))
      throw new Error(`MISSING_ACCEPTANCE_MAPPING:${acceptanceId}`);
    return { acceptanceId, tests: [...new Set(paths)].map((path) => hashedPath(head, path, cwd)) };
  });
  const facetPaths = [
    `tests/task-facets/${task.id}.spec.ts`,
    `tests/task-facets/${task.id}.negative.spec.ts`,
  ];
  const facets = task.taskAcceptanceFacets.map((facet) => {
    if (facetPaths.some((path) => !task.requiredTests.includes(path)))
      throw new Error(`MISSING_ACCEPTANCE_FACET_MAPPING:${facet.facetId}`);
    return {
      acceptanceId: facet.facetId,
      tests: facetPaths.map((path) => hashedPath(head, path, cwd)),
    };
  });
  return [...taskCriteria, ...facets];
};

export const persistCommandEvidence = async (
  taskId: string,
  head: string,
  evidence: Array<{ command: string; exitCode: number; output: string; outputSha256: string }>,
  cwd = process.cwd(),
): Promise<CommandEvidence[]> => {
  const root = runtimeRoot(cwd);
  return Promise.all(
    evidence.map(async (item, index) => {
      const artifactPath = `evidence/${taskId}/${head}/${String(index).padStart(2, '0')}.log`;
      const absolute = join(root, artifactPath);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, item.output, { mode: 0o600 });
      return {
        command: item.command,
        exitCode: item.exitCode,
        outputSha256: item.outputSha256,
        artifactPath,
        artifactSha256: sha256(item.output),
      };
    }),
  );
};

export const validateCommandEvidenceArtifact = async (item: CommandEvidence, cwd: string): Promise<void> => {
  const root = resolve(runtimeRoot(cwd));
  const absolute = resolve(root, item.artifactPath);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) throw new Error(`EVIDENCE_PATH_ESCAPE:${item.command}`);
  let output: string;
  try {
    output = (await readTrustedFile(root, absolute, 'COMMAND_EVIDENCE_ARTIFACT')).toString('utf8');
  } catch {
    throw new Error(`MISSING_REQUIRED_TEST_ARTIFACT:${item.command}`);
  }
  if (sha256(output) !== item.artifactSha256 || sha256(output) !== item.outputSha256)
    throw new Error(`REQUIRED_TEST_ARTIFACT_HASH_MISMATCH:${item.command}`);
  if (item.exitCode !== 0) throw new Error(`COMMAND_FAILED:${item.command}`);
};

const requiredReviewPasses = [
  'requirement-coverage',
  'acceptance-test-coverage',
  'scope-and-forbidden-path-review',
  'dependency-interface-review',
  'adversarial-review',
  'test-quality-review',
  'architecture-boundary-review',
  'clean-worktree-review',
];

const validateSelfReview = async (result: TaskResult, cwd: string, state?: TaskState): Promise<void> => {
  const root = resolve(runtimeRoot(cwd));
  const absolute = resolve(root, result.bindings.selfReviewPath);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) throw new Error('SELF_REVIEW_PATH_ESCAPE');
  let text: string;
  try {
    text = (await readTrustedFile(root, absolute, 'SELF_REVIEW_EVIDENCE')).toString('utf8');
  } catch {
    throw new Error('SELF_REVIEW_EVIDENCE_MISSING');
  }
  if (sha256(text) !== result.bindings.selfReviewSha256) throw new Error('SELF_REVIEW_HASH_MISMATCH');
  const review = TaskReviewSchema.parse(JSON.parse(text));
  if (
    review.taskId !== result.taskId ||
    review.reviewedBaseCommit !== result.bindings.baseCommitSha ||
    review.reviewedCommit !== result.bindings.headCommitSha ||
    review.reviewedTree !== result.bindings.headTreeSha
  )
    throw new Error('SELF_REVIEW_BINDING_MISMATCH');
  for (const name of requiredReviewPasses)
    if (!review.passes.some((pass) => pass.name === name)) throw new Error(`SELF_REVIEW_PASS_MISSING:${name}`);
  if (!sameJson(review.changedFiles, result.bindings.changedFiles))
    throw new Error('SELF_REVIEW_CHANGED_FILES_MISMATCH');
  if (!sameJson(review.dependencyInterfaceHashes, result.bindings.dependencyInterfaceHashes))
    throw new Error('SELF_REVIEW_DEPENDENCY_INTERFACES_MISMATCH');
  if (
    review.leaseId !== result.bindings.leaseId ||
    review.leaseFencingVersion !== result.bindings.leaseFencingVersion
  )
    throw new Error('SELF_REVIEW_LEASE_BINDING_MISMATCH');
  if (
    review.lifecycleBindingSha256 !== result.bindings.lifecycleBindingSha256 ||
    review.verificationBaselineSha256 !== result.bindings.verificationBaselineSha256 ||
    review.launchReceiptId !== result.bindings.launchReceiptId ||
    review.launchReceiptSha256 !== result.bindings.launchReceiptSha256
  )
    throw new Error('SELF_REVIEW_TRUSTED_AUTHORITY_BINDING_MISMATCH');
  if (Date.parse(review.reviewedAt) > Date.parse(result.bindings.verificationTimestamp))
    throw new Error('TASK_RESULT_PREDATES_FRESH_SELF_REVIEW');
  if (
    review.verdict !== 'PASS' ||
    review.findings.some((finding) => !finding.resolved && (finding.severity === 'P0' || finding.severity === 'P1'))
  )
    throw new Error('UNRESOLVED_P0_P1_SELF_REVIEW');
  if (state?.selfReviewEvidence)
    await assertEvidenceCurrent(result.taskId, 'SELF_REVIEW', state.selfReviewEvidence, cwd);
};

export interface ValidateTaskAttestationOptions {
  cwd?: string;
  currentHeadRequired?: boolean;
  clusterHead?: string;
  state?: TaskState;
}

export const validateTaskAttestation = async (
  task: TaskContract,
  raw: unknown,
  options: ValidateTaskAttestationOptions = {},
): Promise<TaskResult> => {
  const cwd = options.cwd ?? process.cwd();
  let result: TaskResult;
  try {
    result = TaskResultSchema.parse(raw);
  } catch (error) {
    throw new Error(`TASK_RESULT_SCHEMA_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.status !== 'PASS') throw new Error(`TASK_RESULT_NOT_PASS:${result.taskId}`);
  if (result.taskId !== task.id) throw new Error(`TASK_RESULT_COPIED_FROM_ANOTHER_TASK:${result.taskId}`);
  const specification = await loadAndValidateSpecification();
  const bindings = result.bindings;
  const lifecycleEvidence = options.state?.lifecycleBinding ?? options.state?.completedLifecycleBinding;
  const baselineEvidence = options.state?.verificationBaseline ?? options.state?.completedVerificationBaseline;
  if (
    options.state &&
    (lifecycleEvidence?.sha256 !== bindings.lifecycleBindingSha256 ||
      baselineEvidence?.sha256 !== bindings.verificationBaselineSha256)
  )
    throw new Error('TASK_RESULT_TRUSTED_AUTHORITY_MISMATCH');
  const lifecycle = options.state ? await readLifecycleBinding(cwd, options.state, true) : undefined;
  const verificationBaseline = options.state
    ? await readVerificationBaseline(cwd, options.state, true)
    : undefined;
  if (options.state && !verificationBaseline) throw new Error('TASK_RESULT_VERIFICATION_BASELINE_MISSING');
  if (
    verificationBaseline &&
    (bindings.verifierVersion !== verificationBaseline.verifierVersion ||
      bindings.verificationPolicyVersion !== verificationBaseline.verificationPolicyVersion)
  )
    throw new Error('TASK_RESULT_BASELINE_VERSION_MISMATCH');
  let contractText: string;
  try {
    contractText = (await readTrustedFile(
      lifecycle?.bindingRoot ?? cwd,
      lifecycle?.contractPath ?? contractPath(task),
      'ATTESTATION_TASK_CONTRACT',
    )).toString('utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !lifecycle) throw error;
    const archived = spawnSync('git', ['show', `${bindings.headCommitSha}:${lifecycle.contractPath}`], {
      cwd,
      encoding: 'utf8',
    });
    if (archived.status !== 0) throw new Error('COMPLETED_LIFECYCLE_CONTRACT_MISSING');
    contractText = archived.stdout;
  }
  if (sha256(contractText) !== bindings.taskContractSha256) throw new Error('WRONG_TASK_CONTRACT_HASH');
  if (task.conformanceManifestPath && task.conformanceManifestSha256) {
    if (
      bindings.conformanceManifestPath !== task.conformanceManifestPath ||
      bindings.conformanceManifestSha256 !== task.conformanceManifestSha256
    )
      throw new Error('CONFORMANCE_RESULT_BINDING_MISMATCH');
    const conformanceText = (await readTrustedFile(
      lifecycle?.conformanceBindingRoot ?? cwd,
      task.conformanceManifestPath,
      'ATTESTATION_CONFORMANCE_MANIFEST',
    )).toString('utf8');
    if (sha256(conformanceText) !== task.conformanceManifestSha256)
      throw new Error('CONFORMANCE_RESULT_HASH_MISMATCH');
  }
  if (bindings.prdSha256 !== specification.hashes.prd) throw new Error('WRONG_PRD_HASH');
  if (bindings.requirementManifestSha256 !== specification.hashes.requirements)
    throw new Error('WRONG_REQUIREMENT_MANIFEST_HASH');
  if (bindings.auditSha256 !== specification.hashes.audit) throw new Error('WRONG_AUDIT_HASH');
  if (
    gitText(['cat-file', '-e', `${bindings.headCommitSha}^{commit}`], cwd, true) === '' &&
    spawnSync('git', ['cat-file', '-e', `${bindings.headCommitSha}^{commit}`], { cwd }).status !== 0
  )
    throw new Error('TASK_COMMIT_MISSING');
  const derivedTree = gitText(['rev-parse', `${bindings.headCommitSha}^{tree}`], cwd);
  if (derivedTree !== bindings.headTreeSha) throw new Error('WRONG_TREE_HASH');
  if (gitText(['merge-base', '--is-ancestor', bindings.baseCommitSha, bindings.headCommitSha], cwd, true) !== '') {
    /* git emits no output on success */
  }
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', bindings.baseCommitSha, bindings.headCommitSha], { cwd })
      .status !== 0
  )
    throw new Error('TASK_BASE_NOT_ANCESTOR');
  if (options.currentHeadRequired && gitText(['rev-parse', 'HEAD'], cwd) !== bindings.headCommitSha)
    throw new Error('HEAD_COMMIT_MISMATCH');
  if (options.currentHeadRequired && gitText(['status', '--porcelain'], cwd) !== '')
    throw new Error('DIRTY_WORKTREE');
  if (
    options.clusterHead &&
    spawnSync('git', ['merge-base', '--is-ancestor', bindings.headCommitSha, options.clusterHead], { cwd }).status !== 0
  )
    throw new Error('TASK_COMMIT_NOT_REACHABLE_FROM_CLUSTER_HEAD');
  const changed = deriveChangedFiles(bindings.baseCommitSha, bindings.headCommitSha, cwd);
  if (!sameJson(changed, bindings.changedFiles)) throw new Error('CHANGED_FILE_EVIDENCE_MISMATCH');
  if (changed.length === 0) throw new Error('EMPTY_CHANGED_FILE_EVIDENCE');
  if (options.clusterHead) for (const file of changed) {
    const existsAtClusterHead = spawnSync('git', ['cat-file', '-e', `${options.clusterHead}:${file.path}`], { cwd }).status === 0;
    if (file.status === 'D' ? existsAtClusterHead : !existsAtClusterHead || hashPathAtCommit(options.clusterHead, file.path, 'M', cwd) !== file.sha256)
      throw new Error(`SOURCE_CHANGED_AFTER_RESULT_GENERATION:${file.path}`);
  }
  const requirements = deriveRequirementMapping(task, changed, bindings.headCommitSha, cwd);
  if (!sameJson(requirements, bindings.requirementToCode)) throw new Error('REQUIREMENT_TO_CODE_MAPPING_MISMATCH');
  const acceptance = await deriveAcceptanceMapping(task, bindings.headCommitSha, cwd);
  if (!sameJson(acceptance, bindings.acceptanceToTests)) throw new Error('ACCEPTANCE_TO_TEST_MAPPING_MISMATCH');
  const interfaceIndex = JSON.parse(
    await readFile(join(cwd, 'tasks/generated/interface-hashes.json'), 'utf8'),
  ) as Record<string, Record<string, string>>;
  if (
    !sameJson(interfaceIndex[task.id], bindings.dependencyInterfaceHashes) ||
    !sameJson(task.interfaceHashes, bindings.dependencyInterfaceHashes)
  )
    throw new Error('STALE_INTERFACE_HASHES');
  if (bindings.verifierVersion !== TASK_VERIFIER_VERSION) throw new Error('STALE_VERIFIER_VERSION');
  if (bindings.verificationPolicyVersion !== VERIFICATION_POLICY_VERSION) throw new Error('STALE_VERIFICATION_POLICY');
  if (options.state) {
    if (options.state.leaseVersion !== bindings.leaseFencingVersion) throw new Error('STALE_LEASE');
    if (options.state.leaseId !== bindings.leaseId) throw new Error('LOST_LEASE');
    if (options.state.commit && options.state.commit !== bindings.headCommitSha)
      throw new Error('TASK_STATE_COMMIT_MISMATCH');
  }
  if (result.commandEvidence.length === 0) throw new Error('MISSING_COMMAND_EVIDENCE');
  for (const item of result.commandEvidence) await validateCommandEvidenceArtifact(item, cwd);
  if (bindings.requiredTestArtifacts.length === 0) throw new Error('MISSING_REQUIRED_TEST_ARTIFACT');
  for (const item of bindings.requiredTestArtifacts) {
    if (!result.commandEvidence.some((candidate) => sameJson(candidate, item)))
      throw new Error(`MISSING_REQUIRED_TEST_ARTIFACT:${item.command}`);
    await validateCommandEvidenceArtifact(item, cwd);
  }
  await validateSelfReview(result, cwd, options.state);
  if (options.state?.taskResultEvidence)
    await assertEvidenceCurrent(result.taskId, 'TASK_RESULT', options.state.taskResultEvidence, cwd);
  if (options.state?.verificationEvidence)
    await assertEvidenceCurrent(result.taskId, 'VERIFICATION', options.state.verificationEvidence, cwd);
  return result;
};

export const relativeRuntimePath = (absolute: string, cwd = process.cwd()): string =>
  relative(runtimeRoot(cwd), absolute);
