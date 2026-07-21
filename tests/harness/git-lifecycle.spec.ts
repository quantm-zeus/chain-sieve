import { describe, expect, it } from 'vitest';
import { simulateGitLifecycle } from '../../tools/merge-queue/simulation.js';

describe('Git lifecycle simulation', () => {
  it('uses an isolated worktree, complete lifecycle, one rebased atomic task commit and automatic revert', async () => { const result = await simulateGitLifecycle(); expect(result.atomicCommits).toBe(1); expect(result.states).toEqual(['READY', 'LEASED', 'IMPLEMENTING', 'SELF_REVIEWING', 'VERIFYING', 'VERIFIED', 'MERGE_QUEUED', 'MERGED', 'REVERTED_AFTER_INTEGRATION_FAILURE']); expect(result).toMatchObject({ staleLeaseRejected: true, lostLeaseRejected: true, pathLockRejected: true, rebaseApplied: true, injectedFailureDetected: true, failureCommitReverted: true, worktreeIsolated: true }); });
});
