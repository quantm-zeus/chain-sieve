import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProvider,
  AgentProviderId,
  CommandResult,
  CommandRunner,
} from '../agent/lib/types.js';
import { createProvider } from '../agent/providers/index.js';
import {
  MAX_PRODUCT_CORRECTION_ROUNDS,
  runAutopilot,
} from '../autopilot/autopilot.js';
import { assertAutopilotDoctor } from '../autopilot/doctor.js';

const AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
const CI_WAIT_TIMEOUT_MS = 90 * 60_000;

const PRODUCT_CORRECTION_PREFIXES = [
  'apps/',
  'packages/',
  'tests/',
  'docs/operations/',
] as const;

const CONVERGENCE_CHECKS = [
  ['build'],
  ['lint'],
  ['typecheck'],
  ['test'],
  ['spec:verify'],
  ['prd:drift-check'],
  ['requirements:coverage'],
  ['architecture:verify'],
  ['placeholders:scan'],
  ['prohibited-capabilities:scan'],
  ['migration:verify'],
  ['harness:verify'],
] as const;

export interface ProductConvergenceGap {
  requirementIds: string[];
  summary: string;
  evidence: string[];
  suggestedPaths: string[];
}

export interface ProductConvergenceReport {
  schemaVersion: '1.0.0';
  status: 'PASS' | 'GAPS';
  productCommit: string;
  gaps: ProductConvergenceGap[];
  notes: string[];
}

export interface ProductFactoryOptions {
  providerId?: AgentProviderId;
  pollMilliseconds?: number;
  maxCorrectionRounds?: number;
}

interface PullRequestCheck {
  name?: string;
  context?: string;
  conclusion?: string;
  state?: string;
  status?: string;
}

interface PullRequestProbe {
  number: number;
  url: string;
  state?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: PullRequestCheck[];
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0)
    throw new Error(
      `${code}:${result.timedOut ? 'TIMEOUT:' : ''}${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
};

const git = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('git', args, { cwd, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_GIT_FAILED:${args.join(':')}`,
  );

const gh = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('gh', args, { cwd, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_GITHUB_FAILED:${args.join(':')}`,
  );

const pnpm = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], {
      cwd,
      timeoutMilliseconds: AGENT_TIMEOUT_MS,
      streamOutput: true,
    }),
    `PRODUCT_FACTORY_CHECK_FAILED:${args[0] ?? 'unknown'}`,
  );

const executeAgent = (
  provider: AgentProvider,
  workspace: string,
  prompt: string,
  code: string,
): void => {
  if (!provider.executePayload) throw new Error(`${code}:NO_HEADLESS_EXECUTOR`);
  requireSuccess(provider.executePayload(workspace, prompt), code);
};

const changedPaths = (runner: CommandRunner, cwd: string): string[] =>
  git(runner, cwd, ['status', '--porcelain=v1'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(' -> ').at(-1)!)
    .filter(Boolean)
    .sort();

export const isProductCorrectionPath = (path: string): boolean =>
  PRODUCT_CORRECTION_PREFIXES.some((prefix) => path.startsWith(prefix));

const assertProductCorrectionScope = (paths: string[]): void => {
  if (paths.length === 0) throw new Error('PRODUCT_FACTORY_CORRECTION_NO_CHANGES');
  const invalid = paths.filter((path) => !isProductCorrectionPath(path));
  if (invalid.length > 0)
    throw new Error(`PRODUCT_FACTORY_CORRECTION_SCOPE:${invalid.join(',')}`);
};

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const parseConvergenceReport = (
  value: unknown,
  expectedCommit?: string,
): ProductConvergenceReport => {
  if (!value || typeof value !== 'object')
    throw new Error('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  const report = value as Partial<ProductConvergenceReport>;
  if (
    report.schemaVersion !== '1.0.0' ||
    (report.status !== 'PASS' && report.status !== 'GAPS') ||
    typeof report.productCommit !== 'string' ||
    !Array.isArray(report.gaps) ||
    !stringArray(report.notes) ||
    (expectedCommit && report.productCommit !== expectedCommit)
  )
    throw new Error('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  for (const gap of report.gaps) {
    if (
      !gap ||
      typeof gap !== 'object' ||
      !stringArray(gap.requirementIds) ||
      gap.requirementIds.length === 0 ||
      typeof gap.summary !== 'string' ||
      gap.summary.trim().length === 0 ||
      !stringArray(gap.evidence) ||
      !stringArray(gap.suggestedPaths)
    )
      throw new Error('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  }
  if (report.status === 'PASS' && report.gaps.length !== 0)
    throw new Error('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  if (report.status === 'GAPS' && report.gaps.length === 0)
    throw new Error('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  return report as ProductConvergenceReport;
};

const runDeterministicConvergenceChecks = (
  root: string,
  runner: CommandRunner,
): void => {
  for (const args of CONVERGENCE_CHECKS) pnpm(runner, root, [...args]);
};

const createDetachedWorktree = async (
  root: string,
  runner: CommandRunner,
  prefix: string,
  ref = 'main',
): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), `chainsieve-${prefix}-`));
  await rm(workspace, { recursive: true, force: true });
  git(runner, root, ['worktree', 'add', '--detach', workspace, ref]);
  return workspace;
};

const removeWorktree = async (
  root: string,
  runner: CommandRunner,
  workspace: string,
): Promise<void> => {
  runner.run('git', ['worktree', 'remove', '--force', workspace], {
    cwd: root,
    timeoutMilliseconds: 120_000,
  });
  await rm(workspace, { recursive: true, force: true });
};

const auditProduct = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
): Promise<ProductConvergenceReport> => {
  const productCommit = git(runner, root, ['rev-parse', 'HEAD']);
  const workspace = await createDetachedWorktree(root, runner, 'convergence-audit', productCommit);
  const relativeReport = 'artifacts/convergence/product-convergence.json';
  try {
    executeAgent(
      provider,
      workspace,
      `You are the independent product convergence verifier for frozen commit ${productCommit}. Read the immutable PRD/normative prose, requirements manifest, accepted ADRs, generated task and cluster contracts, implementation, tests, and available verification evidence. Determine whether the delivered product actually satisfies every normative requirement and acceptance criterion; completed tasks alone are not proof. Do not modify product code, tests, specs, contracts, policy, workflows, or control-plane files. Create exactly one file: ${relativeReport}. JSON schema: {"schemaVersion":"1.0.0","status":"PASS|GAPS","productCommit":"${productCommit}","gaps":[{"requirementIds":["REQ-ID"],"summary":"specific missing behavior","evidence":["concrete observed evidence"],"suggestedPaths":["apps/... or packages/... or tests/..."]}],"notes":["optional observations"]}. PASS requires gaps=[]. GAPS requires one or more concrete gaps tied to normative IDs. Never weaken or reinterpret requirements. Do not run git commit, git push, gh, reset, clean, rebase, or merge. Stop after writing the report.`,
      'PRODUCT_FACTORY_CONVERGENCE_AUDIT_FAILED',
    );
    const paths = changedPaths(runner, workspace);
    if (paths.length !== 1 || paths[0] !== relativeReport)
      throw new Error(`PRODUCT_FACTORY_CONVERGENCE_AUDIT_SCOPE:${paths.join(',')}`);
    return parseConvergenceReport(
      JSON.parse(await readFile(join(workspace, relativeReport), 'utf8')),
      productCommit,
    );
  } finally {
    await removeWorktree(root, runner, workspace);
  }
};

const checkValue = (check: PullRequestCheck): string =>
  String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase();

const failedChecks = (pr: PullRequestProbe): string[] =>
  (pr.statusCheckRollup ?? [])
    .filter((check) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(
        checkValue(check),
      ),
    )
    .map((check) => check.name ?? check.context ?? 'unnamed-check');

const pendingChecks = (pr: PullRequestProbe): boolean =>
  (pr.statusCheckRollup ?? []).length === 0 ||
  (pr.statusCheckRollup ?? []).some(
    (check) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(checkValue(check)),
  );

const waitForPullRequest = async (
  root: string,
  runner: CommandRunner,
  number: number,
  pollMilliseconds: number,
): Promise<PullRequestProbe> => {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  for (;;) {
    const pr = JSON.parse(
      gh(runner, root, [
        'pr',
        'view',
        String(number),
        '--json',
        'number,url,state,mergeStateStatus,statusCheckRollup',
      ]),
    ) as PullRequestProbe;
    const failures = failedChecks(pr);
    if (failures.length > 0) return pr;
    if (pr.state === 'MERGED') return pr;
    if (pr.state === 'CLOSED') throw new Error(`PRODUCT_FACTORY_PR_CLOSED:${pr.url}`);
    if (!pendingChecks(pr)) return pr;
    if (Date.now() >= deadline) throw new Error(`PRODUCT_FACTORY_CI_TIMEOUT:${pr.url}`);
    await sleep(pollMilliseconds);
  }
};

const correctionBranch = (round: number, commit: string): string =>
  `autonomy/product-convergence-${round}-${commit.slice(0, 8)}`;

const applyProductCorrection = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  report: ProductConvergenceReport,
  round: number,
  pollMilliseconds: number,
): Promise<void> => {
  const frozenMain = git(runner, root, ['rev-parse', 'HEAD']);
  if (frozenMain !== report.productCommit)
    throw new Error('PRODUCT_FACTORY_MAIN_MOVED_BEFORE_CORRECTION');
  const branch = correctionBranch(round, frozenMain);
  const workspace = await mkdtemp(join(tmpdir(), 'chainsieve-product-correction-'));
  await rm(workspace, { recursive: true, force: true });
  git(runner, root, ['worktree', 'add', '-b', branch, workspace, frozenMain]);
  try {
    pnpm(runner, workspace, ['install', '--frozen-lockfile']);
    executeAgent(
      provider,
      workspace,
      `You are product correction round ${round} for frozen main ${frozenMain}. The independent convergence verifier found these normative product gaps:\n${JSON.stringify(report.gaps, null, 2)}\nRepair every listed gap with the smallest coherent implementation. You may modify only apps/**, packages/**, tests/**, and docs/operations/**. The immutable PRD, docs/spec, accepted ADR authority, generated tasks/clusters, artifacts, config, workflows, tools/control-plane, dependency manifests, lockfiles, migrations, and secrets are forbidden. Do not weaken tests or requirements. Add or strengthen tests proving each corrected behavior. Run relevant tests and self-review the complete diff. Do not run git commit, git push, gh, reset, clean, rebase, or merge. Leave valid changes uncommitted and stop.`,
      'PRODUCT_FACTORY_CORRECTION_AGENT_FAILED',
    );
    const paths = changedPaths(runner, workspace);
    assertProductCorrectionScope(paths);
    runDeterministicConvergenceChecks(workspace, runner);
    git(runner, workspace, ['add', '--', ...paths]);
    git(runner, workspace, [
      'commit',
      '-m',
      `fix(product): converge PRD round ${round}`,
    ]);
    git(runner, workspace, ['push', '-u', 'origin', branch]);
    const created = JSON.parse(
      gh(runner, root, [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        'main',
        '--title',
        `fix(product): converge PRD round ${round}`,
        '--body',
        `Autonomous product-convergence correction generated from an independent Muse audit of ${frozenMain}. Normative specs and control-plane files are unchanged.`,
        '--json',
        'number,url',
      ]),
    ) as { number: number; url: string };
    const completed = await waitForPullRequest(
      root,
      runner,
      created.number,
      pollMilliseconds,
    );
    const failures = failedChecks(completed);
    if (failures.length > 0)
      throw new Error(`PRODUCT_FACTORY_CORRECTION_CI_FAILED:${failures.join(',')}`);
    if (completed.mergeStateStatus !== 'CLEAN')
      throw new Error(
        `PRODUCT_FACTORY_CORRECTION_PR_NOT_CLEAN:${completed.mergeStateStatus ?? 'UNKNOWN'}`,
      );
    gh(runner, root, [
      'pr',
      'merge',
      String(created.number),
      '--merge',
      '--delete-branch',
    ]);
  } finally {
    await removeWorktree(root, runner, workspace);
  }
  git(runner, root, ['fetch', 'origin', 'main']);
  git(runner, root, ['merge', '--ff-only', 'origin/main']);
};

export const runProductFactory = async (
  root: string,
  runner: CommandRunner,
  options: ProductFactoryOptions = {},
): Promise<string> => {
  const providerId = options.providerId ?? 'muse';
  const provider = createProvider(providerId, runner);
  const pollMilliseconds = options.pollMilliseconds ?? 15_000;
  const maxCorrectionRounds =
    options.maxCorrectionRounds ?? MAX_PRODUCT_CORRECTION_ROUNDS;
  if (
    !Number.isInteger(maxCorrectionRounds) ||
    maxCorrectionRounds < 0 ||
    maxCorrectionRounds > MAX_PRODUCT_CORRECTION_ROUNDS
  )
    throw new Error('PRODUCT_FACTORY_CORRECTION_LIMIT_INVALID');
  await assertAutopilotDoctor(root, runner, providerId);
  for (let round = 0; round <= maxCorrectionRounds; round += 1) {
    const autopilot = await runAutopilot(root, runner, { providerId });
    if (autopilot !== 'AUTOPILOT_COMPLETE')
      throw new Error(`PRODUCT_FACTORY_AUTOPILOT_INCOMPLETE:${autopilot}`);
    runDeterministicConvergenceChecks(root, runner);
    const report = await auditProduct(root, runner, provider);
    if (report.status === 'PASS') return 'PRODUCT_FACTORY_COMPLETE';
    if (round >= maxCorrectionRounds)
      throw new Error(
        `PRODUCT_FACTORY_CONVERGENCE_LIMIT:${report.gaps.map((gap) => gap.requirementIds.join('+')).join(',')}`,
      );
    await applyProductCorrection(
      root,
      runner,
      provider,
      report,
      round + 1,
      pollMilliseconds,
    );
  }
  throw new Error('PRODUCT_FACTORY_CONVERGENCE_LIMIT');
};
