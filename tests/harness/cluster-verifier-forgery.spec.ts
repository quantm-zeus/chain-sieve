import { describe, expect, it } from 'vitest';
import { loadClusters, loadTasks } from '../../tools/task-verifier/verify.js';
import { validateClusterResult } from '../../tools/cluster-verifier/verification.js';
import type { LifecycleDocument } from '../../tools/task-runner/state.js';

describe('proof-carrying cluster verification', () => {
  it('rejects a forged cluster PASS with empty task and command evidence', async () => {
    const cluster = (await loadClusters())[0]!;
    const tasks = await loadTasks();
    const state: LifecycleDocument = { schemaVersion: '2.0.0', tasks: {} };
    const forged = {
      schemaVersion: '2.0.0',
      clusterId: cluster.id,
      status: 'PASS',
      clusterContractSha256: '0'.repeat(64),
      headCommitSha: '0'.repeat(40),
      headTreeSha: '0'.repeat(40),
      taskAttestations: [],
      commandEvidence: [],
      verifierVersion: 'cluster-2.0.0',
      verificationPolicyVersion: 'cluster-harness-task-proof-v2',
      verificationTimestamp: '2026-07-21T00:00:00.000Z',
    };
    await expect(validateClusterResult(cluster, forged, tasks, state)).rejects.toThrow('CLUSTER_RESULT_SCHEMA_INVALID');
  });
});
