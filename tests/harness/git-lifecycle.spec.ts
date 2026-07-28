import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  deriveLifecycleVerdict,
  requiredLifecycleCommands,
  requiredLifecycleScenarios,
  requiredLifecycleStates,
  type ObservedLifecycleManifest,
  type ObservedScenario,
} from '../../tools/merge-queue/lifecycle-manifest.js';

const scenario = (scenarioId: (typeof requiredLifecycleScenarios)[number]): ObservedScenario => ({
  scenarioId,
  commandsExecuted: [],
  stateTransitionsObserved: scenarioId === 'A' ? [...requiredLifecycleStates] : [],
  commitShas: ['1'.repeat(40)],
  gitTreeShas: ['2'.repeat(40)],
  leaseVersions: scenarioId === 'B' ? [1, 2] : [],
  evidenceHashes: scenarioId === 'D' ? ['3'.repeat(64), '4'.repeat(64), '5'.repeat(64)] : ['3'.repeat(64)],
  queueOperations: scenarioId === 'D' ? ['ran-real-task-verifier'] : [],
  rebaseResult: scenarioId === 'D' ? 'REBASING_WITH_FRESH_EVIDENCE' : 'NOT_APPLICABLE',
  verificationResult:
    scenarioId === 'E'
      ? 'ALL_PRE_REBASE_EVIDENCE_REJECTED'
      : scenarioId === 'F'
        ? 'DIRTY_TRACKED_SOURCE_REJECTED'
        : 'PASS',
  mergeResult: scenarioId === 'A' ? 'MERGED_THROUGH_REAL_QUEUE' : 'NOT_APPLICABLE',
  revertResult:
    scenarioId === 'G' ? 'AUTOMATIC_REVERT_CREATED_AND_TREE_RESTORED' : 'NOT_APPLICABLE',
  cleanupResult:
    scenarioId === 'H' ? 'WORKTREES_LEASES_LOCKS_QUEUE_BRANCHES_CLEAN' : 'NOT_APPLICABLE',
});

export const validLifecycleManifest = (): ObservedLifecycleManifest => {
  const scenarios = requiredLifecycleScenarios.map(scenario);
  scenarios[0]!.commandsExecuted = requiredLifecycleCommands.map((command) => ({
    command,
    exitCode: 0,
    outputSha256: '6'.repeat(64),
  }));
  scenarios[1]!.commandsExecuted.push({
    command: 'task:begin',
    exitCode: 1,
    outputSha256: '7'.repeat(64),
    expectedRejection: 'STALE_LEASE_VERSION',
  });
  return {
    schemaVersion: '1.0.0',
    harness: 'production-lifecycle',
    repository: 'isolated-temporary-git-repository',
    scenarios,
    generatedAt: '2026-07-28T00:00:00.000Z',
  };
};

describe('evidence-derived lifecycle harness', () => {
  it('derives PASS only from complete observed production evidence', () => {
    expect(deriveLifecycleVerdict(validLifecycleManifest())).toMatchObject({
      status: 'PASS',
      scenarios: 8,
    });
  });

  it('routes pnpm harness:lifecycle to the production lifecycle harness, not the deleted simulation', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['harness:lifecycle']).toBe('tsx tools/merge-queue/lifecycle-cli.ts');
    await expect(readFile('tools/merge-queue/simulation-cli.ts', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
