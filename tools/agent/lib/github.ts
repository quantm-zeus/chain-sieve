import { ZCodeError } from './errors.js';
import type {
  ClusterRecord,
  CommandRunner,
  PullRequestState,
} from './types.js';

interface GhPullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeCommit?: { oid?: string } | null;
  mergeStateStatus?: string;
  statusCheckRollup?: Array<{
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }>;
}

interface RequiredCheck {
  name: string;
  state?: string;
  bucket?: string;
}

const runJson = <T>(runner: CommandRunner, root: string, args: string[]): T => {
  const result = runner.run('gh', args, {
    cwd: root,
    timeoutMilliseconds: 120_000,
  });
  if (result.status !== 0)
    throw new ZCodeError('GITHUB_COMMAND_FAILED', args.join(' '), [
      result.stderr,
    ]);
  return JSON.parse(result.stdout) as T;
};

const checkState = (value: string): 'PENDING' | 'PASS' | 'FAIL' => {
  const normalized = value.toUpperCase();
  if (['SUCCESS', 'PASS', 'NEUTRAL', 'SKIPPED'].includes(normalized))
    return 'PASS';
  if (
    [
      'FAIL',
      'FAILURE',
      'ERROR',
      'CANCELLED',
      'TIMED_OUT',
      'ACTION_REQUIRED',
    ].includes(normalized)
  )
    return 'FAIL';
  return 'PENDING';
};

const normalize = (
  pr: GhPullRequest,
  requiredChecks?: RequiredCheck[],
): PullRequestState => ({
  number: pr.number,
  url: pr.url,
  state: pr.state,
  checks: requiredChecks
    ? requiredChecks.map((check) => ({
        name: check.name,
        state: checkState(check.bucket ?? check.state ?? ''),
        required: true,
      }))
    : (pr.statusCheckRollup ?? []).map((check) => ({
        name: check.name ?? check.context ?? check.__typename ?? 'unnamed-check',
        state: checkState(
          check.conclusion ?? check.state ?? check.status ?? '',
        ),
        required: false,
      })),
  ...(pr.mergeCommit?.oid ? { mergeCommit: pr.mergeCommit.oid } : {}),
});

export const findClusterPullRequest = (
  runner: CommandRunner,
  root: string,
  cluster: ClusterRecord,
): PullRequestState | undefined => {
  const values = runJson<GhPullRequest[]>(runner, root, [
    'pr',
    'list',
    '--head',
    cluster.branch.branch,
    '--base',
    cluster.branch.integrationTarget,
    '--state',
    'all',
    '--limit',
    '1',
    '--json',
    'number,url,state,mergeCommit,mergeStateStatus,statusCheckRollup',
  ]);
  return values[0] ? normalize(values[0]) : undefined;
};

export const createClusterPullRequest = (
  runner: CommandRunner,
  root: string,
  cluster: ClusterRecord,
): PullRequestState => {
  const body = `Tool-generated implementation-cluster integration.

- Cluster: ${cluster.contract.id}
- Source branch: ${cluster.branch.branch}
- Integration target: ${cluster.branch.integrationTarget}
- Every task has proof-carrying verification evidence.
- Cluster verification and independent review are required.
- Capability activation is not included.`;
  const result = runner.run(
    'gh',
    [
      'pr',
      'create',
      '--head',
      cluster.branch.branch,
      '--base',
      cluster.branch.integrationTarget,
      '--title',
      `merge(${cluster.contract.id}): integrate verified cluster`,
      '--body',
      body,
    ],
    { cwd: root, timeoutMilliseconds: 120_000 },
  );
  if (result.status !== 0)
    throw new ZCodeError('CLUSTER_PR_CREATE_FAILED', result.stderr.trim());
  const created = findClusterPullRequest(runner, root, cluster);
  if (!created) throw new ZCodeError('CLUSTER_PR_NOT_FOUND_AFTER_CREATE');
  return created;
};

export const refreshPullRequest = (
  runner: CommandRunner,
  root: string,
  number: number,
): PullRequestState & { mergeStateStatus: string } => {
  const pr = runJson<GhPullRequest>(runner, root, [
    'pr',
    'view',
    String(number),
    '--json',
    'number,url,state,mergeCommit,mergeStateStatus,statusCheckRollup',
  ]);
  let required: RequiredCheck[] | undefined;
  const checks = runner.run(
    'gh',
    [
      'pr',
      'checks',
      String(number),
      '--required',
      '--json',
      'name,state,bucket',
    ],
    { cwd: root, timeoutMilliseconds: 120_000 },
  );
  if (checks.status === 0) required = JSON.parse(checks.stdout) as RequiredCheck[];
  return {
    ...normalize(pr, required),
    mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
  };
};

export const classifyPullRequest = (
  pr: PullRequestState & { mergeStateStatus?: string },
): 'MERGED' | 'FAILED' | 'PENDING' | 'READY' | 'CLOSED' => {
  if (pr.state === 'MERGED') return 'MERGED';
  if (pr.state === 'CLOSED') return 'CLOSED';
  if (pr.checks.length === 0) return 'PENDING';
  if (pr.checks.some((check) => check.required && check.state === 'FAIL'))
    return 'FAILED';
  if (pr.checks.some((check) => check.required && check.state === 'PENDING'))
    return 'PENDING';
  if (['DIRTY', 'BLOCKED'].includes(pr.mergeStateStatus ?? '')) return 'FAILED';
  if (['BEHIND', 'UNKNOWN', 'UNSTABLE'].includes(pr.mergeStateStatus ?? ''))
    return 'PENDING';
  return pr.mergeStateStatus === 'CLEAN' ? 'READY' : 'PENDING';
};

export const mergePullRequest = (
  runner: CommandRunner,
  root: string,
  number: number,
): void => {
  const repository = runJson<{
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
  }>(runner, root, [
    'repo',
    'view',
    '--json',
    'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
  ]);
  const method = repository.mergeCommitAllowed
    ? '--merge'
    : repository.squashMergeAllowed
      ? '--squash'
      : repository.rebaseMergeAllowed
        ? '--rebase'
        : undefined;
  if (!method) throw new ZCodeError('CLUSTER_PR_NO_ALLOWED_MERGE_METHOD');
  const result = runner.run(
    'gh',
    ['pr', 'merge', String(number), method, '--delete-branch=false'],
    { cwd: root, timeoutMilliseconds: 120_000 },
  );
  if (result.status !== 0)
    throw new ZCodeError('CLUSTER_PR_MERGE_FAILED', result.stderr.trim());
};
