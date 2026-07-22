import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClusterResultSchema, type ClusterContract, type TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import {
  TASK_VERIFIER_VERSION,
  validateCommandEvidenceArtifact,
  validateTaskAttestation,
  VERIFICATION_POLICY_VERSION,
} from '../task-verifier/attestation.js';
import { runtimeRoot, type LifecycleDocument } from '../task-runner/state.js';

export const CLUSTER_VERIFIER_VERSION = `cluster-${TASK_VERIFIER_VERSION}`;
export const CLUSTER_POLICY_VERSION = `cluster-${VERIFICATION_POLICY_VERSION}`;
const git = (args: string[], cwd = process.cwd()): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`CLUSTER_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`);
  return result.stdout.trim();
};
const taskResultPath = (taskId: string, cwd: string): string =>
  join(runtimeRoot(cwd), 'results', `${taskId}.result.json`);
const clusterContractPath = (cluster: ClusterContract): string =>
  `clusters/${cluster.group}/${cluster.id}.contract.json`;

export const deriveClusterTaskAttestations = async (
  cluster: ClusterContract,
  tasks: TaskContract[],
  state: LifecycleDocument,
  clusterHead: string,
  cwd = process.cwd(),
): Promise<Array<{ taskId: string; taskCommitSha: string; taskTreeSha: string; resultSha256: string }>> => {
  const attestations: Array<{ taskId: string; taskCommitSha: string; taskTreeSha: string; resultSha256: string }> = [];
  for (const taskId of cluster.tasks) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`CLUSTER_TASK_CONTRACT_MISSING:${taskId}`);
    const taskState = state.tasks[taskId];
    if (taskState?.state !== 'MERGED' || !taskState.commit)
      throw new Error(`CLUSTER_TASK_NOT_MERGED:${taskId}:${taskState?.state ?? 'MISSING'}`);
    let text: string;
    try {
      text = await readFile(taskResultPath(taskId, cwd), 'utf8');
    } catch {
      throw new Error(`MISSING_TASK_VERIFICATION_ARTIFACT:${taskId}`);
    }
    const result = await validateTaskAttestation(task, JSON.parse(text), { cwd, clusterHead, state: taskState });
    if (result.bindings.headCommitSha !== taskState.commit)
      throw new Error(`TASK_RESULT_GENERATED_FOR_ANOTHER_COMMIT:${taskId}`);
    attestations.push({
      taskId,
      taskCommitSha: result.bindings.headCommitSha,
      taskTreeSha: result.bindings.headTreeSha,
      resultSha256: sha256(text),
    });
  }
  if (attestations.length === 0) throw new Error('EMPTY_CLUSTER_TASK_EVIDENCE');
  return attestations;
};

export const validateClusterResult = async (
  cluster: ClusterContract,
  raw: unknown,
  tasks: TaskContract[],
  state: LifecycleDocument,
  cwd = process.cwd(),
): Promise<ReturnType<typeof ClusterResultSchema.parse>> => {
  let result: ReturnType<typeof ClusterResultSchema.parse>;
  try {
    result = ClusterResultSchema.parse(raw);
  } catch (error) {
    throw new Error(`CLUSTER_RESULT_SCHEMA_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.status !== 'PASS' || result.clusterId !== cluster.id) throw new Error('FORGED_CLUSTER_PASS');
  const head = git(['rev-parse', 'HEAD'], cwd);
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd);
  if (result.headCommitSha !== head) throw new Error('CLUSTER_HEAD_COMMIT_MISMATCH');
  if (result.headTreeSha !== tree) throw new Error('CLUSTER_TREE_MISMATCH');
  if (git(['status', '--porcelain', '--untracked-files=no'], cwd) !== '') throw new Error('DIRTY_TRACKED_SOURCE');
  const contractText = await readFile(join(cwd, clusterContractPath(cluster)), 'utf8');
  if (result.clusterContractSha256 !== sha256(contractText)) throw new Error('WRONG_CLUSTER_CONTRACT_HASH');
  const attestations = await deriveClusterTaskAttestations(cluster, tasks, state, head, cwd);
  if (JSON.stringify(attestations) !== JSON.stringify(result.taskAttestations))
    throw new Error('CLUSTER_TASK_ATTESTATION_MISMATCH');
  if (result.commandEvidence.length === 0) throw new Error('EMPTY_CLUSTER_COMMAND_EVIDENCE');
  for (const item of result.commandEvidence) await validateCommandEvidenceArtifact(item, cwd);
  if (
    result.verifierVersion !== CLUSTER_VERIFIER_VERSION ||
    result.verificationPolicyVersion !== CLUSTER_POLICY_VERSION
  )
    throw new Error('STALE_CLUSTER_VERIFICATION_POLICY');
  return result;
};
