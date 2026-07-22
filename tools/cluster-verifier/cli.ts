import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClusterResultSchema, ClusterReviewSchema } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { loadClusters, loadTasks } from '../task-verifier/verify.js';
import { persistCommandEvidence } from '../task-verifier/attestation.js';
import { readState, runtimeRoot } from '../task-runner/state.js';
import { CLUSTER_POLICY_VERSION, CLUSTER_VERIFIER_VERSION, deriveClusterTaskAttestations, validateClusterResult } from './verification.js';

const git = (args: string[]): string => { const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); if (result.status !== 0) throw new Error(`CLUSTER_GIT_FAILED:${args.join(':')}:${result.stderr.trim()}`); return result.stdout.trim(); };
const run = (args: string[]): { command: string; exitCode: number; output: string; outputSha256: string } => { const result = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); const output = `${result.stdout ?? ''}${result.stderr ?? ''}`; if (result.status !== 0) throw new Error(`CLUSTER_COMMAND_FAILED:pnpm ${args.join(' ')}:${output.slice(-2000)}`); return { command: `pnpm ${args.join(' ')}`, exitCode: 0, output, outputSha256: sha256(output) }; };
const resultPath = (clusterId: string): string => join(runtimeRoot(), 'cluster-results', `${clusterId}.result.json`);
const clusterContractPath = (group: string, id: string): string => `clusters/${group}/${id}.contract.json`;
const command = process.argv[2] ?? 'list'; const clusterId = process.argv[3];
try {
  const clusters = await loadClusters();
  if (command === 'list') console.log(JSON.stringify(clusters.map((cluster) => ({ id: cluster.id, tasks: cluster.tasks.length })), null, 2));
  else if (command === 'ready') console.log(JSON.stringify(clusters.filter((cluster) => cluster.dependencies.length === 0).map((cluster) => cluster.id), null, 2));
  else {
    const cluster = clusters.find((item) => item.id === clusterId); if (!cluster) throw new Error('CLUSTER_NOT_FOUND'); const tasks = await loadTasks(); const state = await readState(tasks);
    if (command === 'verify') {
      const head = git(['rev-parse', 'HEAD']); const tree = git(['rev-parse', 'HEAD^{tree}']); if (git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('DIRTY_TRACKED_SOURCE'); const taskAttestations = await deriveClusterTaskAttestations(cluster, tasks, state, head);
      for (const dependency of cluster.dependencies) { const dependencyContract = clusters.find((item) => item.id === dependency); if (!dependencyContract) throw new Error(`CLUSTER_DEPENDENCY_MISSING:${dependency}`); let raw: unknown; try { raw = JSON.parse(await readFile(resultPath(dependency), 'utf8')); } catch { throw new Error(`CLUSTER_DEPENDENCY_NOT_VERIFIED:${dependency}`); } await validateClusterResult(dependencyContract, raw, tasks, state); }
      const evidence = [run(['test:integration']), run(['test:system']), run(['architecture:verify']), run(['placeholders:scan']), run(['prohibited-capabilities:scan']), run(['migration:verify'])]; const commandEvidence = await persistCommandEvidence(cluster.id, head, evidence); const contractText = await readFile(clusterContractPath(cluster.group, cluster.id), 'utf8'); const result = ClusterResultSchema.parse({ schemaVersion: '2.0.0', clusterId: cluster.id, status: 'PASS', clusterContractSha256: sha256(contractText), headCommitSha: head, headTreeSha: tree, taskAttestations, commandEvidence, verifierVersion: CLUSTER_VERIFIER_VERSION, verificationPolicyVersion: CLUSTER_POLICY_VERSION, verificationTimestamp: new Date().toISOString() }); await validateClusterResult(cluster, result, tasks, state); const path = resultPath(cluster.id); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ clusterId: cluster.id, status: 'VERIFIED', taskResults: taskAttestations.length, resultSha256: sha256(JSON.stringify(result)) }, null, 2));
    } else if (command === 'report') {
      const result = await validateClusterResult(cluster, JSON.parse(await readFile(resultPath(cluster.id), 'utf8')), tasks, state); const review = ClusterReviewSchema.parse(JSON.parse(await readFile(join('artifacts/reviews/clusters', `${cluster.id}.review.json`), 'utf8'))); if (review.verdict !== 'PASS') throw new Error('CLUSTER_INDEPENDENT_REVIEW_REQUIRED'); console.log(JSON.stringify({ clusterId: cluster.id, status: 'REVIEWED', result, review }, null, 2));
    } else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
