import { describe, expect, it } from 'vitest';
import { simulateGitLifecycle } from '../../tools/merge-queue/simulation.js';

describe('Git lifecycle simulation', () => {
  it('uses one atomic task commit and automatically reverts a failed post-merge integration', async () => { const result = await simulateGitLifecycle(); expect(result.atomicCommits).toBe(1); expect(result.states).toEqual(['READY', 'LEASED', 'VERIFIED', 'MERGED', 'REVERTED_AFTER_INTEGRATION_FAILURE']); expect(result).toMatchObject({ staleLeaseRejected: true, pathLockRejected: true, failureCommitReverted: true }); });
});
