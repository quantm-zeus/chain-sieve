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

const runJson = <T>(runner: CommandRunner, root: string, args: string[]): T => {
  const result = runner.run('gh', args, { cwd: root });
  if (result.status !== 0)
    throw new ZCodeError('GITHUB_COMMAND_FAILED', args.join(' '), [
      result.stderr,
    ]);
  return JSON.parse(result.stdout) as T;
};

const checkState = (
  check: NonNullable<GhPullRequest['statusCheckRollup']>[number],
): 'PENDING' | 'PASS' | 'FAIL' => {
  const value = (
    check.conclusion ??
    check.state ??
    check.status ??
    ''
  ).toUpperCase();
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) return 'PASS';
  if (
    ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(
      value,
    )
  )
    return 'FAIL';
  return 'PENDING';
};

const normalize = (pr: GhPullRequest): PullRequestState => ({
  number: pr.number,
  url: pr.url,
  state: pr.state,
  checks: (pr.statusCheckRollup ?? []).map((check) => ({
    name: check.name ?? check.context ?? check.__typename ?? 'unnamed-check',
    state: checkState(check),
    required: true,
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
    { cwd: root },
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
  return {
    ...normalize(pr),
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
  if (
    pr.checks.some((check) => check.required && check.state === 'PENDING') ||
    (pr.mergeStateStatus !== undefined && pr.mergeStateStatus !== 'CLEAN')
  )
    return 'PENDING';
  return 'READY';
};

export const mergePullRequest = (
  runner: CommandRunner,
  root: string,
  number: number,
): void => {
  const result = runner.run(
    'gh',
    ['pr', 'merge', String(number), '--merge', '--delete-branch=false'],
    { cwd: root },
  );
  if (result.status !== 0)
    throw new ZCodeError('CLUSTER_PR_MERGE_FAILED', result.stderr.trim());
};
