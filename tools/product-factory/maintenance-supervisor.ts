import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCode } from '../agent/lib/errors.js';
import { agentRuntimeRoot } from '../agent/lib/runtime.js';
import type {
  AgentProvider,
  AgentProviderId,
  CommandResult,
  CommandRunner,
} from '../agent/lib/types.js';
import { createProvider } from '../agent/providers/index.js';
import { selectMaintenanceProvider } from '../agent/providers/routing.js';
import { changedPaths } from './recovery-contract.js';

const AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
const CI_WAIT_TIMEOUT_MS = 90 * 60_000;
const MAX_MAINTENANCE_ATTEMPTS_PER_FINGERPRINT = 3;
const MAX_PATCH_REPAIR_ROUNDS = 3;
const MAX_CI_REPAIR_ROUNDS = 3;
const REVIEW_FILE = '.chainsieve-maintenance-review.json';
const STATE_FILE = 'product-factory-maintenance-recovery.json';

const MAINTENANCE_ALLOWED_PREFIXES = [
  'tools/',
  'tests/',
  'apps/',
  'packages/',
  'config/',
  'docs/operations/',
] as const;
const MAINTENANCE_ALLOWED_EXACT = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
]);
const MAINTENANCE_FORBIDDEN_PREFIXES = [
  '.github/',
  '.agents/',
  'secrets/',
  'docs/spec/',
  'docs/adr/',
  'tasks/',
  'clusters/',
  'artifacts/',
] as const;
const MAINTENANCE_FORBIDDEN_EXACT = new Set([
  'AGENTS.md',
  'config/autonomy-policy.json',
]);
const NON_REPAIRABLE_MARKERS = [
  'PROHIBITED_CAPABILITY',
  'SECRET_EXPOSURE',
  'SPECIFICATION_DRIFT',
  'AUTONOMOUS_MERGE_DISABLED',
  'NO_HEADLESS_EXECUTOR',
  'GITHUB_AUTH',
  'AUTH_FAILED',
  'PERMISSION_DENIED',
  'PR_CLOSED',
] as const;
const FULL_CHECKS: string[][] = [
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
];

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

interface MaintenanceRecord {
  fingerprint: string;
  attempts: number;
  lastFailure: string;
  lastCommit: string;
  updatedAt: string;
}

interface MaintenanceState {
  schemaVersion: '1.0.0';
  records: Record<string, MaintenanceRecord>;
}

export interface MaintenanceReview {
  status: 'PASS' | 'FAIL';
  findings: string[];
  summary: string;
}

export interface AutonomousMaintenanceOptions {
  providerId?: AgentProviderId;
  pollMilliseconds?: number;
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const compact = (value: string, limit = 8_000): string =>
  [...value]
    .filter((character) => character !== '\r' && character.charCodeAt(0) !== 0)
    .join('')
    .trim()
    .slice(0, limit);

export const normalizeMaintenanceFailure = (error: unknown): string => {
  const rendered = compact(errorCode(error));
  if (rendered && !/^(?:undefined|null)$/i.test(rendered)) return rendered;
  if (error === undefined) return 'PRODUCT_FACTORY_UNKNOWN_FAILURE:undefined';
  if (error === null) return 'PRODUCT_FACTORY_UNKNOWN_FAILURE:null';
  if (error instanceof Error)
    return `PRODUCT_FACTORY_UNKNOWN_FAILURE:${error.name || 'Error'}:empty-message`;
  return `PRODUCT_FACTORY_UNKNOWN_FAILURE:${typeof error}`;
};

export const isAutonomousMaintenanceEligible = (failure: string): boolean => {
  const upper = failure.toUpperCase();
  return !NON_REPAIRABLE_MARKERS.some((marker) => upper.includes(marker));
};

export const maintenancePathAllowed = (path: string): boolean => {
  if (MAINTENANCE_FORBIDDEN_EXACT.has(path)) return false;
  if (MAINTENANCE_FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)))
    return false;
  return (
    MAINTENANCE_ALLOWED_EXACT.has(path) ||
    MAINTENANCE_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
};

export const parseMaintenanceReview = (value: unknown): MaintenanceReview => {
  if (!value || typeof value !== 'object')
    throw new Error('PRODUCT_FACTORY_MAINTENANCE_REVIEW_INVALID');
  const review = value as Partial<MaintenanceReview>;
  if (
    (review.status !== 'PASS' && review.status !== 'FAIL') ||
    !Array.isArray(review.findings) ||
    !review.findings.every((finding) => typeof finding === 'string') ||
    typeof review.summary !== 'string' ||
    review.summary.trim().length === 0
  )
    throw new Error('PRODUCT_FACTORY_MAINTENANCE_REVIEW_INVALID');
  return {
    status: review.status,
    findings: review.findings.map((finding) => finding.trim()).filter(Boolean),
    summary: review.summary.trim(),
  };
};

export const maintenanceFingerprint = (failure: string, commit: string): string => {
  const digest = createHash('sha256')
    .update(`${commit}\n${compact(failure, 4_000)}`)
    .digest('hex')
    .slice(0, 16);
  return `maintenance:${commit}:${digest}`;
};

const requireSuccess = (result: CommandResult, code: string): string => {
  if (result.status !== 0) {
    const detail = compact(result.stderr || result.stdout || 'no-command-output', 12_000);
    throw new Error(`${code}:${result.timedOut ? 'TIMEOUT:' : ''}${detail}`);
  }
  return result.stdout.trim();
};

const git = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('git', args, { cwd, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_MAINTENANCE_GIT_FAILED:${args.join(':')}`,
  );

const gh = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('gh', args, { cwd, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_MAINTENANCE_GITHUB_FAILED:${args.join(':')}`,
  );

const pnpm = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], {
      cwd,
      timeoutMilliseconds: AGENT_TIMEOUT_MS,
    }),
    `PRODUCT_FACTORY_MAINTENANCE_CHECK_FAILED:${args[0] ?? 'unknown'}`,
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

const createDetachedWorktree = async (
  root: string,
  runner: CommandRunner,
  prefix: string,
  ref: string,
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

const statePath = (root: string, runner: CommandRunner): string =>
  join(agentRuntimeRoot(root, runner), STATE_FILE);

const readState = async (
  root: string,
  runner: CommandRunner,
): Promise<MaintenanceState> => {
  try {
    const parsed = JSON.parse(await readFile(statePath(root, runner), 'utf8')) as MaintenanceState;
    if (parsed.schemaVersion !== '1.0.0' || !parsed.records) throw new Error('invalid');
    return parsed;
  } catch {
    return { schemaVersion: '1.0.0', records: {} };
  }
};

const writeState = async (
  root: string,
  runner: CommandRunner,
  state: MaintenanceState,
): Promise<void> => {
  const runtime = agentRuntimeRoot(root, runner);
  await mkdir(runtime, { recursive: true });
  const finalPath = statePath(root, runner);
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, finalPath);
  } finally {
    await rm(temporary, { force: true });
  }
};

const recordAttempt = async (
  root: string,
  runner: CommandRunner,
  fingerprint: string,
  failure: string,
  commit: string,
): Promise<number> => {
  const state = await readState(root, runner);
  const existing = state.records[fingerprint];
  if (existing && existing.attempts >= MAX_MAINTENANCE_ATTEMPTS_PER_FINGERPRINT)
    throw new Error(`PRODUCT_FACTORY_MAINTENANCE_LIMIT:${fingerprint}`);
  const attempts = (existing?.attempts ?? 0) + 1;
  state.records[fingerprint] = {
    fingerprint,
    attempts,
    lastFailure: compact(failure, 4_000),
    lastCommit: commit,
    updatedAt: new Date().toISOString(),
  };
  await writeState(root, runner, state);
  return attempts;
};

const assertMaintenanceScope = (paths: string[]): void => {
  if (paths.length === 0) throw new Error('PRODUCT_FACTORY_MAINTENANCE_NO_CHANGES');
  const invalid = paths.filter((path) => !maintenancePathAllowed(path));
  if (invalid.length > 0)
    throw new Error(`PRODUCT_FACTORY_MAINTENANCE_SCOPE:${invalid.join(',')}`);
};

const runFullChecks = (runner: CommandRunner, workspace: string): void => {
  for (const args of FULL_CHECKS) pnpm(runner, workspace, args);
};

const maintenancePrompt = (failure: string, commit: string): string =>
  `You are the trusted ChainSieve autonomous MAINTENANCE repair executor. The product factory failed at frozen main ${commit} with:\n${failure}\n\nReproduce and repair the mechanical/control-plane/tooling cause so the factory can resume without human intervention. Inspect deterministic evidence first. You may repair only non-normative maintenance surfaces: tools/**, tests/**, apps/**, packages/**, config/** except config/autonomy-policy.json, docs/operations/**, and root package/tooling files. Never modify AGENTS.md, .github/**, .agents/**, secrets/**, docs/spec/**, docs/adr/**, tasks/**, clusters/**, artifacts/**, or immutable requirements. Never weaken a verifier, requirement, safety gate, test assertion, or capability restriction merely to make checks pass. Prefer the narrowest root-cause fix. Run relevant deterministic checks, self-review the complete diff, and leave valid changes uncommitted. Do not run git commit, git push, gh, reset, clean, rebase, merge, or product:autopilot.`;

const repairPrompt = (failure: string): string =>
  `The current autonomous maintenance patch failed deterministic verification with:\n${failure}\n\nRepair the patch itself while preserving the original root-cause fix and all safety/authority boundaries. Do not broaden scope, weaken tests or requirements, or touch forbidden paths. Leave changes uncommitted. Do not run git/gh/reset/clean/rebase/merge.`;

const verifyAndRepairPatch = (
  runner: CommandRunner,
  provider: AgentProvider,
  workspace: string,
): string[] => {
  for (let round = 0; round <= MAX_PATCH_REPAIR_ROUNDS; round += 1) {
    const paths = changedPaths(runner, workspace);
    assertMaintenanceScope(paths);
    try {
      runFullChecks(runner, workspace);
      return paths;
    } catch (error) {
      const failure = normalizeMaintenanceFailure(error);
      if (round >= MAX_PATCH_REPAIR_ROUNDS)
        throw new Error(`PRODUCT_FACTORY_MAINTENANCE_VERIFICATION_LIMIT:${failure}`);
      console.error(`CHAINSIEVE_AUTO_MAINTENANCE_PATCH_REPAIR:${round + 1}:${failure}`);
      executeAgent(
        provider,
        workspace,
        repairPrompt(failure),
        'PRODUCT_FACTORY_MAINTENANCE_PATCH_REPAIR_AGENT_FAILED',
      );
    }
  }
  throw new Error('PRODUCT_FACTORY_MAINTENANCE_VERIFICATION_LIMIT');
};

const runIndependentReview = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  commit: string,
  originalFailure: string,
): Promise<MaintenanceReview> => {
  const workspace = await createDetachedWorktree(
    root,
    runner,
    'maintenance-review',
    commit,
  );
  try {
    executeAgent(
      provider,
      workspace,
      `You are a fresh-context independent ChainSieve MAINTENANCE reviewer. Review frozen maintenance commit ${commit} created to repair:\n${originalFailure}\n\nDo not modify source, tests, policy, specs, generated contracts, or git state. Do not run package commands; deterministic verification already ran outside the agent sandbox. Inspect the commit and its parent diff, authority boundaries, and whether the change addresses the failure without weakening safety or normative behavior. Create exactly one file ${REVIEW_FILE} containing strict JSON: {"status":"PASS|FAIL","findings":["specific finding"],"summary":"evidence-backed review summary"}. PASS only with no material findings.`,
      'PRODUCT_FACTORY_MAINTENANCE_REVIEW_AGENT_FAILED',
    );
    const paths = changedPaths(runner, workspace);
    if (paths.length !== 1 || paths[0] !== REVIEW_FILE)
      throw new Error(`PRODUCT_FACTORY_MAINTENANCE_REVIEW_SCOPE:${paths.join(',')}`);
    return parseMaintenanceReview(
      JSON.parse(await readFile(join(workspace, REVIEW_FILE), 'utf8')),
    );
  } finally {
    await removeWorktree(root, runner, workspace);
  }
};

const commitWithIndependentReview = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  workspace: string,
  originalFailure: string,
  message: string,
): Promise<string> => {
  let paths = verifyAndRepairPatch(runner, provider, workspace);
  git(runner, workspace, ['add', '--', ...paths]);
  git(runner, workspace, ['commit', '-m', message]);

  for (let round = 0; round <= MAX_PATCH_REPAIR_ROUNDS; round += 1) {
    const head = git(runner, workspace, ['rev-parse', 'HEAD']);
    const review = await runIndependentReview(root, runner, provider, head, originalFailure);
    if (review.status === 'PASS') {
      console.log(`CHAINSIEVE_AUTO_MAINTENANCE_REVIEW:PASS:${head}`);
      return head;
    }
    if (round >= MAX_PATCH_REPAIR_ROUNDS)
      throw new Error(
        `PRODUCT_FACTORY_MAINTENANCE_REVIEW_LIMIT:${review.findings.join(' | ')}`,
      );
    console.error(
      `CHAINSIEVE_AUTO_MAINTENANCE_REVIEW:FAIL:${review.findings.join(' | ')}`,
    );
    executeAgent(
      provider,
      workspace,
      `Independent maintenance review failed with findings:\n${review.findings.join('\n')}\n\nRepair every material finding while preserving maintenance scope and safety boundaries. Leave changes uncommitted and do not run git/gh/reset/clean/rebase/merge.`,
      'PRODUCT_FACTORY_MAINTENANCE_REVIEW_REPAIR_AGENT_FAILED',
    );
    paths = verifyAndRepairPatch(runner, provider, workspace);
    git(runner, workspace, ['add', '--', ...paths]);
    git(runner, workspace, [
      'commit',
      '-m',
      `fix(autonomy): address maintenance review round ${round + 1}`,
    ]);
  }
  throw new Error('PRODUCT_FACTORY_MAINTENANCE_REVIEW_LIMIT');
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
    if (pr.state === 'CLOSED')
      throw new Error(`PRODUCT_FACTORY_MAINTENANCE_PR_CLOSED:${pr.url}`);
    if (!pendingChecks(pr)) return pr;
    if (Date.now() >= deadline)
      throw new Error(`PRODUCT_FACTORY_MAINTENANCE_CI_TIMEOUT:${pr.url}`);
    await sleep(pollMilliseconds);
  }
};

const repairCi = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  workspace: string,
  branch: string,
  failures: string[],
  originalFailure: string,
  round: number,
): Promise<void> => {
  executeAgent(
    provider,
    workspace,
    `Autonomous maintenance PR CI failed: ${failures.join(', ')}. Repair only the mechanical CI regression. Preserve all authority boundaries and the original root-cause fix. Do not weaken tests, specs, safety gates, or policy. Leave changes uncommitted and do not run git/gh/reset/clean/rebase/merge.`,
    'PRODUCT_FACTORY_MAINTENANCE_CI_REPAIR_AGENT_FAILED',
  );
  await commitWithIndependentReview(
    root,
    runner,
    provider,
    workspace,
    originalFailure,
    `fix(autonomy): repair maintenance CI round ${round}`,
  );
  git(runner, workspace, ['push', 'origin', `HEAD:${branch}`]);
};

export const runAutonomousMaintenance = async (
  root: string,
  runner: CommandRunner,
  failure: string,
  options: AutonomousMaintenanceOptions = {},
): Promise<string> => {
  const normalizedFailure = normalizeMaintenanceFailure(failure);
  if (!isAutonomousMaintenanceEligible(normalizedFailure))
    throw new Error(`PRODUCT_FACTORY_MAINTENANCE_NOT_ELIGIBLE:${normalizedFailure}`);

  const dirty = git(runner, root, ['status', '--porcelain=v1']);
  if (dirty) throw new Error(`PRODUCT_FACTORY_MAINTENANCE_ROOT_DIRTY:${dirty}`);
  const commit = git(runner, root, ['rev-parse', 'HEAD']);
  const fingerprint = maintenanceFingerprint(normalizedFailure, commit);
  const attempt = await recordAttempt(
    root,
    runner,
    fingerprint,
    normalizedFailure,
    commit,
  );

  const semanticProvider = createProvider(options.providerId ?? 'muse', runner);
  const provider = selectMaintenanceProvider(runner, semanticProvider);
  console.log(`CHAINSIEVE_AGENT_ROUTE:MAINTENANCE:${provider.id}`);
  const detection = provider.detect();
  if (!detection.available || !provider.executePayload)
    throw new Error(
      `PRODUCT_FACTORY_MAINTENANCE_PROVIDER_UNAVAILABLE:${provider.id}:${detection.detail}`,
    );

  const suffix = createHash('sha256').update(fingerprint).digest('hex').slice(0, 10);
  const branch = `autonomy/maintenance-${attempt}-${suffix}-${randomUUID().slice(0, 8)}`;
  const workspace = await mkdtemp(join(tmpdir(), 'chainsieve-maintenance-action-'));
  await rm(workspace, { recursive: true, force: true });
  git(runner, root, ['worktree', 'add', '-b', branch, workspace, commit]);

  try {
    pnpm(runner, workspace, ['install', '--frozen-lockfile']);
    executeAgent(
      provider,
      workspace,
      maintenancePrompt(normalizedFailure, commit),
      'PRODUCT_FACTORY_MAINTENANCE_AGENT_FAILED',
    );
    await commitWithIndependentReview(
      root,
      runner,
      provider,
      workspace,
      normalizedFailure,
      'fix(autonomy): self-heal product factory maintenance failure',
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
      'fix(autonomy): self-heal product factory maintenance failure',
      '--body',
      `Autonomous Antigravity maintenance recovery for ${fingerprint}. Original failure: ${compact(normalizedFailure, 2_000)}`,
    ]);
    const created = JSON.parse(
      gh(runner, root, ['pr', 'view', branch, '--json', 'number,url']),
    ) as { number: number; url: string };
    console.log(`CHAINSIEVE_AUTO_MAINTENANCE_PR:${created.url}`);

    const pollMilliseconds = options.pollMilliseconds ?? 15_000;
    for (let round = 0; round <= MAX_CI_REPAIR_ROUNDS; round += 1) {
      const pr = await waitForPullRequest(root, runner, created.number, pollMilliseconds);
      const failures = failedChecks(pr);
      if (failures.length > 0) {
        if (round >= MAX_CI_REPAIR_ROUNDS)
          throw new Error(
            `PRODUCT_FACTORY_MAINTENANCE_CI_LIMIT:${failures.join(',')}`,
          );
        await repairCi(
          root,
          runner,
          provider,
          workspace,
          branch,
          failures,
          normalizedFailure,
          round + 1,
        );
        continue;
      }
      if (pr.mergeStateStatus !== 'CLEAN')
        throw new Error(
          `PRODUCT_FACTORY_MAINTENANCE_PR_NOT_CLEAN:${pr.mergeStateStatus ?? 'UNKNOWN'}`,
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
    runner.run('git', ['branch', '-D', branch], {
      cwd: root,
      timeoutMilliseconds: 120_000,
    });
  }

  git(runner, root, ['fetch', 'origin', 'main']);
  git(runner, root, ['merge', '--ff-only', 'origin/main']);
  const merged = git(runner, root, ['rev-parse', 'HEAD']);
  console.log(`CHAINSIEVE_AUTO_MAINTENANCE_MERGED:${merged}`);
  return merged;
};
