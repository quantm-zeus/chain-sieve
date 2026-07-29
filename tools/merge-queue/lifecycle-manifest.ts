import { LifecycleManifestSchema } from '@ciag/shared-schemas';

export const requiredLifecycleStates = [
  'DRAFT',
  'VALIDATED',
  'READY',
  'LEASED',
  'IMPLEMENTING',
  'SELF_REVIEWING',
  'VERIFYING',
  'VERIFIED',
  'MERGE_QUEUED',
  'MERGED',
] as const;

export const requiredLifecycleScenarios = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

export const requiredLifecycleCommands = [
  'task:validate',
  'task:mark-ready',
  'worktree:create',
  'task:acquire',
  'task:renew',
  'task:begin',
  'task:self-review',
  'task:verify',
  'merge-queue:add',
  'merge-queue:process',
  'cluster:verify-integration',
  'worktree:cleanup',
] as const;

export interface ObservedCommand {
  command: string;
  exitCode: number;
  outputSha256: string;
  expectedRejection?: string;
}

export interface ObservedScenario {
  scenarioId: (typeof requiredLifecycleScenarios)[number];
  commandsExecuted: ObservedCommand[];
  stateTransitionsObserved: string[];
  commitShas: string[];
  gitTreeShas: string[];
  leaseVersions: number[];
  evidenceHashes: string[];
  queueOperations: string[];
  rebaseResult: string;
  verificationResult: string;
  mergeResult: string;
  revertResult: string;
  cleanupResult: string;
}

export interface ObservedLifecycleManifest {
  schemaVersion: '1.0.0';
  harness: 'production-lifecycle';
  repository: string;
  scenarios: ObservedScenario[];
  generatedAt: string;
}

export interface LifecycleVerdict {
  status: 'PASS';
  scenarios: number;
  commands: number;
  evidenceHashes: number;
}

const assertHash = (value: string, label: string): void => {
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`LIFECYCLE_MANIFEST_INVALID_${label}:${value}`);
};

export const deriveLifecycleVerdict = (manifest: ObservedLifecycleManifest): LifecycleVerdict => {
  if (manifest.harness !== 'production-lifecycle') throw new Error('REAL_MERGE_QUEUE_NOT_USED');
  for (const id of requiredLifecycleScenarios)
    if (!manifest.scenarios.some((scenario) => scenario.scenarioId === id))
      throw new Error(`LIFECYCLE_SCENARIO_MISSING:${id}`);
  LifecycleManifestSchema.parse(manifest);
  const commands = manifest.scenarios.flatMap((scenario) => scenario.commandsExecuted);
  for (const required of requiredLifecycleCommands)
    if (!commands.some((item) => item.command === required))
      throw new Error(`LIFECYCLE_REQUIRED_COMMAND_MISSING:${required}`);
  const successful = manifest.scenarios.find((scenario) => scenario.scenarioId === 'A');
  if (!successful) throw new Error('LIFECYCLE_SCENARIO_MISSING:A');
  for (const state of requiredLifecycleStates)
    if (!successful.stateTransitionsObserved.includes(state))
      throw new Error(`LIFECYCLE_REQUIRED_STATE_MISSING:${state}`);
  const renewal = manifest.scenarios.find((scenario) => scenario.scenarioId === 'B')!;
  if (renewal.leaseVersions.length < 2 || renewal.leaseVersions[1]! <= renewal.leaseVersions[0]!)
    throw new Error('LEASE_RENEWAL_NOT_OBSERVED');
  if (!renewal.commandsExecuted.some((item) => item.expectedRejection === 'STALE_LEASE_VERSION'))
    throw new Error('OLD_LEASE_REJECTION_NOT_OBSERVED');
  const rebase = manifest.scenarios.find((scenario) => scenario.scenarioId === 'D')!;
  if (rebase.rebaseResult !== 'REBASING_WITH_FRESH_EVIDENCE')
    throw new Error('POST_REBASE_VERIFICATION_MISSING');
  if (!rebase.queueOperations.includes('ran-real-task-verifier'))
    throw new Error('REAL_POST_REBASE_TASK_VERIFY_MISSING');
  if (rebase.evidenceHashes.length < 3) throw new Error('FRESH_POST_REBASE_EVIDENCE_MISSING');
  const stale = manifest.scenarios.find((scenario) => scenario.scenarioId === 'E')!;
  if (stale.verificationResult !== 'ALL_PRE_REBASE_EVIDENCE_REJECTED')
    throw new Error('STALE_EVIDENCE_REJECTION_MISSING');
  const mutation = manifest.scenarios.find((scenario) => scenario.scenarioId === 'F')!;
  if (mutation.verificationResult !== 'DIRTY_TRACKED_SOURCE_REJECTED')
    throw new Error('POST_REBASE_MUTATION_REJECTION_MISSING');
  const failure = manifest.scenarios.find((scenario) => scenario.scenarioId === 'G')!;
  if (failure.revertResult !== 'AUTOMATIC_REVERT_CREATED_AND_TREE_RESTORED')
    throw new Error('AUTOMATIC_REVERT_MISSING');
  const cleanup = manifest.scenarios.find((scenario) => scenario.scenarioId === 'H')!;
  if (cleanup.cleanupResult !== 'WORKTREES_LEASES_LOCKS_QUEUE_BRANCHES_CLEAN')
    throw new Error('LIFECYCLE_CLEANUP_INCOMPLETE');
  for (const scenario of manifest.scenarios) {
    for (const commit of scenario.commitShas) assertHash(commit, 'COMMIT');
    for (const tree of scenario.gitTreeShas) assertHash(tree, 'TREE');
    for (const hash of scenario.evidenceHashes) assertHash(hash, 'EVIDENCE');
  }
  if (commands.some((item) => item.exitCode !== 0 && !item.expectedRejection))
    throw new Error('UNEXPECTED_LIFECYCLE_COMMAND_FAILURE');
  return {
    status: 'PASS',
    scenarios: manifest.scenarios.length,
    commands: commands.length,
    evidenceHashes: manifest.scenarios.flatMap((scenario) => scenario.evidenceHashes).length,
  };
};
