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

export type CorrectionLaneType =
  | 'PRODUCT_CODE'
  | 'TEST'
  | 'DEPENDENCY'
  | 'MIGRATION'
  | 'CONFIG'
  | 'SPECIFICATION'
  | 'GENERATED_CONTRACT'
  | 'INFRASTRUCTURE';

export interface CorrectionLaneDefinition {
  type: CorrectionLaneType;
  allowedPrefixes: string[];
  allowedExactFiles?: string[];
  forbiddenPrefixes: string[];
  deterministicChecks: string[][];
}

export const CORRECTION_LANES: Record<CorrectionLaneType, CorrectionLaneDefinition> = {
  PRODUCT_CODE: {
    type: 'PRODUCT_CODE',
    allowedPrefixes: ['apps/', 'packages/'],
    forbiddenPrefixes: ['tests/', 'docs/spec/', '.github/', 'tools/'],
    deterministicChecks: [
      ['build'],
      ['lint'],
      ['typecheck'],
      ['test'],
      ['architecture:verify'],
      ['placeholders:scan'],
      ['prohibited-capabilities:scan'],
    ],
  },
  TEST: {
    type: 'TEST',
    allowedPrefixes: ['tests/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/'],
    deterministicChecks: [['lint'], ['typecheck'], ['test'], ['harness:verify']],
  },
  DEPENDENCY: {
    type: 'DEPENDENCY',
    allowedPrefixes: ['apps/', 'packages/'],
    allowedExactFiles: ['package.json', 'pnpm-lock.yaml'],
    forbiddenPrefixes: ['docs/spec/', '.github/', 'tools/'],
    deterministicChecks: [['install', '--frozen-lockfile'], ['build'], ['typecheck'], ['test']],
  },
  MIGRATION: {
    type: 'MIGRATION',
    allowedPrefixes: ['drizzle/', 'packages/persistence/src/db/migrations/'],
    forbiddenPrefixes: ['docs/spec/', 'apps/'],
    deterministicChecks: [['migration:verify'], ['build'], ['typecheck'], ['test']],
  },
  CONFIG: {
    type: 'CONFIG',
    allowedPrefixes: ['config/', 'docs/operations/'],
    forbiddenPrefixes: ['docs/spec/', 'apps/', 'packages/'],
    deterministicChecks: [['build'], ['lint'], ['typecheck'], ['test'], ['placeholders:scan']],
  },
  SPECIFICATION: {
    type: 'SPECIFICATION',
    allowedPrefixes: ['docs/spec/', 'docs/adr/', 'tasks/', 'clusters/', 'artifacts/spec/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'tests/'],
    deterministicChecks: [['prd:compile'], ['spec:verify'], ['prd:drift-check'], ['requirements:coverage']],
  },
  GENERATED_CONTRACT: {
    type: 'GENERATED_CONTRACT',
    allowedPrefixes: ['tasks/', 'clusters/', 'artifacts/context/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/'],
    deterministicChecks: [['spec:verify'], ['prd:drift-check']],
  },
  INFRASTRUCTURE: {
    type: 'INFRASTRUCTURE',
    allowedPrefixes: ['.github/', 'config/', 'docs/operations/'],
    forbiddenPrefixes: ['apps/', 'packages/', 'docs/spec/'],
    deterministicChecks: [['build'], ['lint'], ['typecheck']],
  },
};

export const pathMatchesLane = (path: string, laneType: CorrectionLaneType): boolean => {
  const lane = CORRECTION_LANES[laneType];
  if (!lane) return false;
  const isForbidden = lane.forbiddenPrefixes.some((prefix) => path.startsWith(prefix));
  if (isForbidden) return false;
  const matchesPrefix = lane.allowedPrefixes.some((prefix) => path.startsWith(prefix));
  const matchesExact = lane.allowedExactFiles?.includes(path) ?? false;
  return matchesPrefix || matchesExact;
};

export const classifyPathLane = (path: string): CorrectionLaneType => {
  if (path === 'package.json' || path === 'pnpm-lock.yaml' || path.endsWith('/package.json'))
    return 'DEPENDENCY';
  if (path.startsWith('drizzle/') || path.includes('/migrations/')) return 'MIGRATION';
  if (path.startsWith('tests/')) return 'TEST';
  if (path.startsWith('config/') || path.startsWith('docs/operations/')) return 'CONFIG';
  if (path.startsWith('docs/spec/') || path.startsWith('docs/adr/')) return 'SPECIFICATION';
  if (path.startsWith('tasks/') || path.startsWith('clusters/')) return 'GENERATED_CONTRACT';
  if (path.startsWith('.github/')) return 'INFRASTRUCTURE';
  return 'PRODUCT_CODE';
};

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

export const classifyGapLanes = (gap: ProductConvergenceGap): CorrectionLaneType[] => {
  const lanes = new Set<CorrectionLaneType>();
  for (const path of gap.suggestedPaths) {
    lanes.add(classifyPathLane(path));
  }
  if (lanes.size === 0) lanes.add('PRODUCT_CODE');
  return Array.from(lanes);
};

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

export const isProductCorrectionPath = (
  path: string,
  allowedLanes?: CorrectionLaneType[],
): boolean => {
  if (allowedLanes && allowedLanes.length > 0) {
    return allowedLanes.some((lane) => pathMatchesLane(path, lane));
  }
  return PRODUCT_CORRECTION_PREFIXES.some((prefix) => path.startsWith(prefix));
};

export const assertProductCorrectionScope = (
  paths: string[],
  allowedLanes?: CorrectionLaneType[],
): void => {
  if (paths.length === 0) throw new Error('PRODUCT_FACTORY_CORRECTION_NO_CHANGES');
  const invalid = paths.filter((path) => !isProductCorrectionPath(path, allowedLanes));
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
  const workspace = await createDetachedWorktree(
    root,
    runner,
    'convergence-audit',
    productCommit,
  );
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

const commitCorrection = (
  runner: CommandRunner,
  workspace: string,
  paths: string[],
  message: string,
): void => {
  git(runner, workspace, ['add', '--', ...paths]);
  git(runner, workspace, ['commit', '-m', message]);
};

const repairCorrectionCi = (
  runner: CommandRunner,
  provider: AgentProvider,
  workspace: string,
  branch: string,
  failures: string[],
  repairRound: number,
): void => {
  executeAgent(
    provider,
    workspace,
    `The product-convergence pull request failed CI checks: ${failures.join(', ')}. Reproduce the failing behavior locally and repair it. Preserve the completed product convergence changes. Modify only apps/**, packages/**, tests/**, and docs/operations/**. Do not modify normative PRD/spec/ADR authority, generated tasks or clusters, artifacts, config, workflows, tools/control-plane, manifests, lockfiles, migrations, or secrets. Do not weaken tests. Do not run git commit, git push, gh, reset, clean, rebase, or merge. Leave the repair uncommitted and stop.`,
    'PRODUCT_FACTORY_CORRECTION_CI_AGENT_FAILED',
  );
  const paths = changedPaths(runner, workspace);
  assertProductCorrectionScope(paths);
  runDeterministicConvergenceChecks(workspace, runner);
  commitCorrection(
    runner,
    workspace,
    paths,
    `fix(product): repair convergence CI round ${repairRound}`,
  );
  git(runner, workspace, ['push', 'origin', `HEAD:${branch}`]);
};

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
  const gapLanes = report.gaps.flatMap((gap) => classifyGapLanes(gap));
  const allowedLanes: CorrectionLaneType[] = Array.from(
    new Set<CorrectionLaneType>(['PRODUCT_CODE', 'TEST', 'CONFIG', ...gapLanes]),
  );
  try {
    pnpm(runner, workspace, ['install', '--frozen-lockfile']);
    executeAgent(
      provider,
      workspace,
      `You are product correction round ${round} for frozen main ${frozenMain}. The independent convergence verifier found these normative product gaps:\n${JSON.stringify(report.gaps, null, 2)}\nRepair every listed gap with the smallest coherent implementation within allowed correction lanes (${allowedLanes.join(', ')}). The immutable PRD, docs/spec, accepted ADR authority, generated tasks/clusters, workflows, tools/control-plane, and secrets are forbidden unless explicitly authorized. Do not weaken tests or requirements. Add or strengthen tests proving each corrected behavior. Run relevant tests and self-review the complete diff. Do not run git commit, git push, gh, reset, clean, rebase, or merge. Leave valid changes uncommitted and stop.`,
      'PRODUCT_FACTORY_CORRECTION_AGENT_FAILED',
    );
    const paths = changedPaths(runner, workspace);
    assertProductCorrectionScope(paths, allowedLanes);
    runDeterministicConvergenceChecks(workspace, runner);
    commitCorrection(
      runner,
      workspace,
      paths,
      `fix(product): converge PRD round ${round}`,
    );
    git(runner, workspace, ['push', '-u', 'origin', branch]);
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
    ]);
    const created = JSON.parse(
      gh(runner, root, ['pr', 'view', branch, '--json', 'number,url']),
    ) as { number: number; url: string };
    for (
      let repairRound = 0;
      repairRound <= MAX_PRODUCT_CORRECTION_ROUNDS;
      repairRound += 1
    ) {
      const completed = await waitForPullRequest(
        root,
        runner,
        created.number,
        pollMilliseconds,
      );
      const failures = failedChecks(completed);
      if (failures.length > 0) {
        if (repairRound >= MAX_PRODUCT_CORRECTION_ROUNDS)
          throw new Error(
            `PRODUCT_FACTORY_CORRECTION_CI_LIMIT:${failures.join(',')}`,
          );
        repairCorrectionCi(
          runner,
          provider,
          workspace,
          branch,
          failures,
          repairRound + 1,
        );
        continue;
      }
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
      break;
    }
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

export type AutonomyStateClassification =
  | 'SUCCESS'
  | 'AUTO_RECOVERABLE'
  | 'SAFETY_TERMINAL'
  | 'EXTERNAL_BLOCKER'
  | 'AUTONOMY_GAP';

export interface FailureFingerprint {
  code: string;
  targetId: string;
  hash: string;
}

export const computeFailureFingerprint = (
  code: string,
  targetId: string,
  details: string[] = [],
): FailureFingerprint => {
  const raw = `${code}:${targetId}:${[...details].sort().join('|')}`;
  return { code, targetId, hash: `${code}:${targetId}:${raw}` };
};

export const classifyAutonomyFailure = (code: string): AutonomyStateClassification => {
  if (code.startsWith('AUTOPILOT_COMPLETE') || code.startsWith('PRODUCT_FACTORY_COMPLETE')) {
    return 'SUCCESS';
  }
  if (
    code.includes('NO_HEADLESS_EXECUTOR') ||
    code.includes('AUTONOMOUS_MERGE_DISABLED') ||
    code.includes('PROHIBITED_CAPABILITY') ||
    code.includes('SECRET_EXPOSURE') ||
    code.includes('SPECIFICATION_DRIFT')
  ) {
    return 'SAFETY_TERMINAL';
  }
  if (
    code.includes('GITHUB_FAILED') ||
    code.includes('PR_CLOSED') ||
    code.includes('CI_TIMEOUT') ||
    code.includes('FINAL_MAIN_CI_FAILED')
  ) {
    return 'EXTERNAL_BLOCKER';
  }
  if (
    code.includes('CORRECTION_SCOPE') ||
    code.includes('CONVERGENCE_AUDIT_SCOPE') ||
    code.includes('CONVERGENCE_REPORT_INVALID')
  ) {
    return 'AUTONOMY_GAP';
  }
  return 'AUTO_RECOVERABLE';
};
