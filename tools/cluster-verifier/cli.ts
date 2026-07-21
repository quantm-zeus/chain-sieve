import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClusterResultSchema, ClusterReviewSchema } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { loadClusters, loadTasks, readTaskResult } from '../task-verifier/verify.js';
import { readState, runtimeRoot } from '../task-runner/state.js';

const run = (args: string[]): { command: string; exitCode: number; outputSha256: string } => { const result = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); const output = `${result.stdout ?? ''}${result.stderr ?? ''}`; if (result.status !== 0) throw new Error(`CLUSTER_COMMAND_FAILED:pnpm ${args.join(' ')}:${output.slice(-2000)}`); return { command: `pnpm ${args.join(' ')}`, exitCode: 0, outputSha256: sha256(output) }; };
const resultPath = (clusterId: string): string => join(runtimeRoot(), 'cluster-results', `${clusterId}.result.json`);
const command = process.argv[2] ?? 'list'; const clusterId = process.argv[3];
try {
  const clusters = await loadClusters();
  if (command === 'list') console.log(JSON.stringify(clusters.map((cluster) => ({ id: cluster.id, tasks: cluster.tasks.length })), null, 2));
  else if (command === 'ready') console.log(JSON.stringify(clusters.filter((cluster) => cluster.dependencies.length === 0).map((cluster) => cluster.id), null, 2));
  else {
    const cluster = clusters.find((item) => item.id === clusterId); if (!cluster) throw new Error('CLUSTER_NOT_FOUND'); const tasks = await loadTasks(); const state = await readState(tasks);
    if (command === 'verify') {
      const taskResults: string[] = []; for (const taskId of cluster.tasks) { const taskState = state.tasks[taskId]; if (taskState?.state !== 'MERGED' || !taskState.commit) throw new Error(`CLUSTER_TASK_NOT_MERGED:${taskId}:${taskState?.state ?? 'MISSING'}`); const result = await readTaskResult(taskId); if (result.status !== 'PASS' || result.commit !== taskState.commit) throw new Error(`CLUSTER_TASK_RESULT_INVALID:${taskId}`); taskResults.push(taskId); }
      for (const dependency of cluster.dependencies) { try { const dependencyResult = ClusterResultSchema.parse(JSON.parse(await readFile(resultPath(dependency), 'utf8'))); if (dependencyResult.status !== 'PASS') throw new Error('not-pass'); } catch { throw new Error(`CLUSTER_DEPENDENCY_NOT_VERIFIED:${dependency}`); } }
      const evidence = [run(['test:integration']), run(['test:system']), run(['architecture:verify']), run(['placeholders:scan']), run(['prohibited-capabilities:scan']), run(['migration:verify'])]; const result = ClusterResultSchema.parse({ schemaVersion: '1.0.0', clusterId: cluster.id, taskResults, evidenceHash: sha256(JSON.stringify(evidence)), status: 'PASS' }); const path = resultPath(cluster.id); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ clusterId: cluster.id, status: 'VERIFIED', taskResults: taskResults.length, evidenceHash: result.evidenceHash }, null, 2));
    } else if (command === 'report') {
      const result = ClusterResultSchema.parse(JSON.parse(await readFile(resultPath(cluster.id), 'utf8'))); const review = ClusterReviewSchema.parse(JSON.parse(await readFile(join('artifacts/reviews/clusters', `${cluster.id}.review.json`), 'utf8'))); if (result.status !== 'PASS' || review.verdict !== 'PASS') throw new Error('CLUSTER_INDEPENDENT_REVIEW_REQUIRED'); console.log(JSON.stringify({ clusterId: cluster.id, status: 'REVIEWED', result, review }, null, 2));
    } else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
