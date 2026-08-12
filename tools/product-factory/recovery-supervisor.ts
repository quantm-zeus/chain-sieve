import { existsSync } from 'node:fs';
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
import { loadAutonomyPolicy } from '../autopilot/policy.js';
import { runProductFactory, type ProductFactoryOptions } from './factory.js';
import {
  CORRECTION_LANES,
  changedPaths,
  classifyAutonomyFailure,
  computeFailureFingerprint,
  pathMatchesLane,
  type CorrectionLaneType,
  type FailureFingerprint,
  type RecoveryAction,
} from './recovery-contract.js';

const AGENT_TIMEOUT_MS = 2 * 60 * 60_000;
const CI_WAIT_TIMEOUT_MS = 90 * 60_000;
const DIAGNOSIS_FILE = '.chainsieve-recovery-diagnosis.json';
const RECOVERY_STATE_FILE = 'product-factory-supervisor-recovery.json';
const MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT = 3;

const ALL_RECOVERY_ACTIONS = new Set<RecoveryAction>([
  'REPAIR',
  'SPLIT_TASK',
  'REPLAN',
  'REGENERATE_DERIVED_TASKS',
  'REOPEN_CORRECTION',
  'RETRY_INFRASTRUCTURE',
  'SAFETY_TERMINAL',
  'EXTERNAL_BLOCKER',
]);

const ALL_LANES = new Set<CorrectionLaneType>([
  'PRODUCT_CODE',
  'TEST',
  'DEPENDENCY',
  'MIGRATION',
  'CONFIG',
  'SPECIFICATION',
  'GENERATED_CONTRACT',
  'INFRASTRUCTURE',
]);

export interface SupervisorRecoveryDiagnosis {
  action: RecoveryAction;
  reason: string;
  evidence: string[];
  target: string;
  constraints: string[];
  allowedLanes: CorrectionLaneType[];
}

export interface SupervisorRecoveryRecord {
  fingerprint: string;
  attempts: number;
  lastCommit: string;
  lastAction: RecoveryAction;
  lastReason: string;
  updatedAt: string;
}

export interface SupervisorRecoveryState {
  schemaVersion: '1.0.0';
  records: Record<string, SupervisorRecoveryRecord>;
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
    `PRODUCT_FACTORY_SUPERVISOR_GIT_FAILED:${args.join(':')}`,
  );

const gh = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('gh', args, { cwd, timeoutMilliseconds: 120_000 }),
    `PRODUCT_FACTORY_SUPERVISOR_GITHUB_FAILED:${args.join(':')}`,
  );

const pnpm = (runner: CommandRunner, cwd: string, args: string[]): string =>
  requireSuccess(
    runner.run('pnpm', ['--silent', ...args], {
      cwd,
      timeoutMilliseconds: AGENT_TIMEOUT_MS,
    }),
    `PRODUCT_FACTORY_SUPERVISOR_CHECK_FAILED:${args[0] ?? 'unknown'}`,
  );

const executeAgent = (
  provider: AgentProvider,
  workspace: string,
  prompt: string,
  code: string,
  options?: { streamOutput?: boolean },
): CommandResult => {
  if (!provider.executePayload) throw new Error(`${code}:NO_HEADLESS_EXECUTOR`);
  const result = provider.executePayload(workspace, prompt, options);
  if (result.status !== 0)
    throw new Error(
      `${code}:${result.timedOut ? 'TIMEOUT:' : ''}${(result.stderr || result.stdout).trim()}`,
    );
  return result;
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

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export const parseSupervisorRecoveryDiagnosis = (
  value: unknown,
): SupervisorRecoveryDiagnosis => {
  if (!value || typeof value !== 'object')
    throw new Error('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
  const diagnosis = value as Partial<SupervisorRecoveryDiagnosis>;
  if (
    typeof diagnosis.action !== 'string' ||
    !ALL_RECOVERY_ACTIONS.has(diagnosis.action as RecoveryAction) ||
    typeof diagnosis.reason !== 'string' ||
    diagnosis.reason.trim().length === 0 ||
    typeof diagnosis.target !== 'string' ||
    diagnosis.target.trim().length === 0 ||
    !stringArray(diagnosis.evidence) ||
    !stringArray(diagnosis.constraints) ||
    !Array.isArray(diagnosis.allowedLanes) ||
    !diagnosis.allowedLanes.every(
      (lane) => typeof lane === 'string' && ALL_LANES.has(lane as CorrectionLaneType),
    )
  )
    throw new Error('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
  return {
    action: diagnosis.action as RecoveryAction,
    reason: diagnosis.reason.trim(),
    evidence: diagnosis.evidence,
    target: diagnosis.target.trim(),
    constraints: diagnosis.constraints,
    allowedLanes: Array.from(new Set(diagnosis.allowedLanes as CorrectionLaneType[])),
  };
};

export const isTransientExternalBlocker = (code: string): boolean => {
  const upper = code.toUpperCase();
  if (
    upper.includes('PR_CLOSED') ||
    upper.includes('AUTH') ||
    upper.includes('PERMISSION') ||
    upper.includes('AUTONOMOUS_MERGE_DISABLED') ||
    upper.includes('PROHIBITED_CAPABILITY') ||
    upper.includes('SECRET_EXPOSURE')
  )
    return false;
  return (
    upper.includes('GITHUB_FAILED') ||
    upper.includes('GIT_FAILED') ||
    upper.includes('CI_TIMEOUT') ||
    upper.includes('FINAL_MAIN_CI_TIMEOUT') ||
    upper.includes('NETWORK') ||
    upper.includes('DNS') ||
    upper.includes('ORIGIN_REACHABLE')
  );
};

export const recoveryLanesForAction = (
  action: RecoveryAction,
  requested: CorrectionLaneType[],
): CorrectionLaneType[] => {
  const allowedByAction: Record<RecoveryAction, CorrectionLaneType[]> = {
    REPAIR: ['PRODUCT_CODE', 'TEST', 'DEPENDENCY', 'MIGRATION', 'CONFIG'],
    REPLAN: ['SPECIFICATION', 'GENERATED_CONTRACT'],
    SPLIT_TASK: ['SPECIFICATION', 'GENERATED_CONTRACT'],
    REGENERATE_DERIVED_TASKS: ['GENERATED_CONTRACT'],
    REOPEN_CORRECTION: [],
    RETRY_INFRASTRUCTURE: [],
    SAFETY_TERMINAL: [],
    EXTERNAL_BLOCKER: [],
  };
  const permitted = new Set(allowedByAction[action]);
  const narrowed = requested.filter((lane) => permitted.has(lane));
  if (action === 'REPLAN' || action === 'SPLIT_TASK') {
    if (narrowed.includes('SPECIFICATION') && !narrowed.includes('GENERATED_CONTRACT'))
      narrowed.push('GENERATED_CONTRACT');
  }
  return narrowed.length > 0 ? Array.from(new Set(narrowed)) : allowedByAction[action];
};

export const deterministicRecoveryDiagnosis = (
  rawFailure: string,
): SupervisorRecoveryDiagnosis | undefined => {
  if (!rawFailure.trimStart().startsWith('GENERATED_CONTRACT_DRIFT')) return undefined;
  const evidence = rawFailure
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    action: 'REGENERATE_DERIVED_TASKS',
    reason: 'deterministic generated-contract drift must be reconciled by the trusted PRD compiler before semantic recovery',
    evidence,
    target: 'generated-contracts',
    constraints: [
      'do not edit immutable PRD or ADR authority',
      'accept a zero-diff reconciliation only after the frozen worktree and live main worktree both pass spec:verify and prd:drift-check',
    ],
    allowedLanes: ['GENERATED_CONTRACT'],
  };
};

const mainWorktreeFrom = (runner: CommandRunner, workspace: string): string => {
  const listing = git(runner, workspace, ['worktree', 'list', '--porcelain']);
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (!lines.includes('branch refs/heads/main')) continue;
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
    if (path) return path;
  }
  throw new Error('PRODUCT_FACTORY_RECOVERY_MAIN_WORKTREE_MISSING');
};

export const verifyGeneratedRecoveryNoop = (
  runner: CommandRunner,
  workspace: string,
  action: RecoveryAction,
  paths: string[],
): boolean => {
  if (action !== 'REGENERATE_DERIVED_TASKS' || paths.length !== 0) return false;

  // First prove the frozen commit is canonically generated. This prevents a live-root
  // cleanup from hiding a tracked generated-contract mismatch that belongs in a PR.
  pnpm(runner, workspace, ['spec:verify']);
  pnpm(runner, workspace, ['prd:drift-check']);

  // Drift can be caused by stale ignored/generated runtime files that exist only in
  // the live main worktree and therefore are absent from a detached recovery worktree.
  // Reconcile that worktree with the trusted deterministic compiler, then prove the
  // compiler did not alter tracked/untracked Git-visible content and the live drift is gone.
  const root = mainWorktreeFrom(runner, workspace);
  const before = changedPaths(runner, root);
  if (before.length > 0)
    throw new Error(`PRODUCT_FACTORY_RECOVERY_ROOT_DIRTY_BEFORE_RECONCILE:${before.join(',')}`);
  pnpm(runner, root, ['prd:compile']);
  const after = changedPaths(runner, root);
  if (after.length > 0)
    throw new Error(`PRODUCT_FACTORY_RECOVERY_ROOT_DIRTY_AFTER_RECONCILE:${after.join(',')}`);
  pnpm(runner, root, ['spec:verify']);
  pnpm(runner, root, ['prd:drift-check']);

  console.log('CHAINSIEVE_RECOVERY_NOOP_VERIFIED:REGENERATE_DERIVED_TASKS');
  return true;
};

const supervisorStatePath = (root: string, runner: CommandRunner): string =>
  join(agentRuntimeRoot(root, runner), RECOVERY_STATE_FILE);

export const readSupervisorRecoveryState = async (
  root: string,
  runner: CommandRunner,
): Promise<SupervisorRecoveryState> => {
  try {
    const parsed = JSON.parse(
      await readFile(supervisorStatePath(root, runner), 'utf8'),
    ) as SupervisorRecoveryState;
    if (parsed.schemaVersion !== '1.0.0' || !parsed.records) throw new Error('invalid');
    return parsed;
  } catch {
    return { schemaVersion: '1.0.0', records: {} };
  }
};

export const writeSupervisorRecoveryState = async (
  root: string,
  runner: CommandRunner,
  state: SupervisorRecoveryState,
): Promise<void> => {
  const runtimeRoot = agentRuntimeRoot(root, runner);
  await mkdir(runtimeRoot, { recursive: true });
  const finalPath = supervisorStatePath(root, runner);
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, finalPath);
  } finally {
    await rm(tmp, { force: true });
  }
};

const recordSupervisorAttempt = async (
  root: string,
  runner: CommandRunner,
  fingerprint: FailureFingerprint,
  commit: string,
  diagnosis: SupervisorRecoveryDiagnosis,
): Promise<SupervisorRecoveryRecord> => {
  const state = await readSupervisorRecoveryState(root, runner);
  const existing = state.records[fingerprint.hash];
  const updated: SupervisorRecoveryRecord = {
    fingerprint: fingerprint.hash,
    attempts: (existing?.attempts ?? 0) + 1,
    lastCommit: commit,
    lastAction: diagnosis.action,
    lastReason: diagnosis.reason,
    updatedAt: new Date().toISOString(),
  };
  state.records[fingerprint.hash] = updated;
  await writeSupervisorRecoveryState(root, runner, state);
  return updated;
};

export const extractSupervisorRecoveryDiagnosis = (
  stdoutText?: string,
  fileContent?: string,
): SupervisorRecoveryDiagnosis => {
  if (fileContent) {
    try {
      return parseSupervisorRecoveryDiagnosis(JSON.parse(fileContent));
    } catch {
      // fallback to stdout parsing
    }
  }
  if (stdoutText) {
    try {
      return parseSupervisorRecoveryDiagnosis(JSON.parse(stdoutText.trim()));
    } catch {
      // fallback
    }
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(stdoutText);
    if (codeBlockMatch?.[1]) {
      try {
        return parseSupervisorRecoveryDiagnosis(JSON.parse(codeBlockMatch[1]));
      } catch {
        // fallback
      }
    }
    const matches = stdoutText.match(/\{[\s\S]*?\}/g);
    if (matches) {
      for (const match of matches) {
        try {
          return parseSupervisorRecoveryDiagnosis(JSON.parse(match));
        } catch {
          // try next candidate match
        }
      }
    }
  }
  throw new Error('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
};

export const diagnoseSupervisorRecovery = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  fingerprint: FailureFingerprint,
  commit: string,
  rawFailure: string,
): Promise<SupervisorRecoveryDiagnosis> => {
  const workspace = await createDetachedWorktree(
    root,
    runner,
    'recovery-diagnosis',
    commit,
  );
  try {
    const result = executeAgent(
      provider,
      workspace,
      `You are the independent fresh-context recovery diagnostician for ChainSieve. Failure: ${rawFailure}. Fingerprint: ${fingerprint.hash}. Frozen commit: ${commit}. Read the immutable PRD, requirements, accepted ADRs, generated task/cluster contracts, implementation, tests, and relevant evidence. Do not modify product/spec/task/control-plane files. Output strict JSON (either written to ${DIAGNOSIS_FILE} in your workspace or output directly as strict JSON): {"action":"REPAIR|SPLIT_TASK|REPLAN|REGENERATE_DERIVED_TASKS|REOPEN_CORRECTION|RETRY_INFRASTRUCTURE|SAFETY_TERMINAL|EXTERNAL_BLOCKER","reason":"specific diagnosis","evidence":["concrete evidence"],"target":"task/cluster/requirement/failure target","constraints":["safety or authority constraint"],"allowedLanes":["PRODUCT_CODE|TEST|DEPENDENCY|MIGRATION|CONFIG|SPECIFICATION|GENERATED_CONTRACT"]}. Choose the narrowest safe action. Never request INFRASTRUCTURE lane from recovery. Stop after providing the JSON response.`,
      'PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_AGENT_FAILED',
      { streamOutput: false },
    );
    const paths = changedPaths(runner, workspace);
    const invalidPaths = paths.filter((p) => p !== DIAGNOSIS_FILE);
    if (invalidPaths.length > 0)
      throw new Error(`PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_SCOPE:${invalidPaths.join(',')}`);

    let fileContent: string | undefined;
    const diagFilePath = join(workspace, DIAGNOSIS_FILE);
    if (existsSync(diagFilePath)) {
      fileContent = await readFile(diagFilePath, 'utf8');
    }
    return extractSupervisorRecoveryDiagnosis(result.stdout, fileContent);
  } finally {
    await removeWorktree(root, runner, workspace);
  }
};

const runLaneChecks = (
  root: string,
  runner: CommandRunner,
  lanes: CorrectionLaneType[],
): void => {
  const seen = new Set<string>();
  for (const lane of lanes) {
    for (const args of CORRECTION_LANES[lane].deterministicChecks) {
      const key = args.join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      pnpm(runner, root, [...args]);
    }
  }
};

const runFullChecks = (root: string, runner: CommandRunner): void => {
  for (const args of [
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
  ])
    pnpm(runner, root, args);
};

const assertRecoveryScope = (
  paths: string[],
  lanes: CorrectionLaneType[],
): void => {
  if (paths.length === 0) throw new Error('PRODUCT_FACTORY_RECOVERY_NO_CHANGES');
  const invalid = paths.filter(
    (path) => !lanes.some((lane) => pathMatchesLane(path, lane)),
  );
  if (invalid.length > 0)
    throw new Error(`PRODUCT_FACTORY_RECOVERY_SCOPE:${invalid.join(',')}`);
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
    if (pr.state === 'CLOSED') throw new Error(`PRODUCT_FACTORY_RECOVERY_PR_CLOSED:${pr.url}`);
    if (!pendingChecks(pr)) return pr;
    if (Date.now() >= deadline)
      throw new Error(`PRODUCT_FACTORY_RECOVERY_CI_TIMEOUT:${pr.url}`);
    await sleep(pollMilliseconds);
  }
};

const repairRecoveryCi = (
  runner: CommandRunner,
  provider: AgentProvider,
  workspace: string,
  branch: string,
  failures: string[],
  lanes: CorrectionLaneType[],
  round: number,
): void => {
  executeAgent(
    provider,
    workspace,
    `Recovery PR CI failed: ${failures.join(', ')}. Repair only the existing recovery implementation. Allowed lanes: ${lanes.join(', ')}. Do not widen scope, weaken requirements/tests, touch secrets, or run git/gh. Leave changes uncommitted.`,
    'PRODUCT_FACTORY_RECOVERY_CI_AGENT_FAILED',
  );
  const paths = changedPaths(runner, workspace);
  assertRecoveryScope(paths, lanes);
  runLaneChecks(workspace, runner, lanes);
  runFullChecks(workspace, runner);
  git(runner, workspace, ['add', '--', ...paths]);
  git(runner, workspace, ['commit', '-m', `fix(autonomy): repair recovery CI round ${round}`]);
  git(runner, workspace, ['push', 'origin', `HEAD:${branch}`]);
};

const publishRecoveryChanges = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  diagnosis: SupervisorRecoveryDiagnosis,
  fingerprint: FailureFingerprint,
  commit: string,
  attempt: number,
  pollMilliseconds: number,
): Promise<void> => {
  const action = diagnosis.action;
  const lanes = recoveryLanesForAction(action, diagnosis.allowedLanes);
  if (lanes.length === 0) throw new Error(`PRODUCT_FACTORY_RECOVERY_ACTION_SCOPE:${action}`);
  const suffix = fingerprint.hash.replace(/[^a-zA-Z0-9-]/g, '-').slice(-28);
  const branch = `autonomy/recovery-${action.toLowerCase()}-${attempt}-${suffix}`;
  const workspace = await mkdtemp(join(tmpdir(), 'chainsieve-recovery-action-'));
  await rm(workspace, { recursive: true, force: true });
  git(runner, root, ['worktree', 'add', '-b', branch, workspace, commit]);
  try {
    pnpm(runner, workspace, ['install', '--frozen-lockfile']);
    if (action === 'REGENERATE_DERIVED_TASKS') {
      pnpm(runner, workspace, ['prd:compile']);
    } else {
      executeAgent(
        provider,
        workspace,
        `You are executing approved ChainSieve recovery action ${action} for ${diagnosis.target}. Diagnosis: ${diagnosis.reason}. Evidence: ${JSON.stringify(diagnosis.evidence)}. Constraints: ${JSON.stringify(diagnosis.constraints)}. Allowed lanes: ${lanes.join(', ')}. Make the smallest coherent recovery changes. Immutable PRD authority cannot be weakened. For REPLAN or SPLIT_TASK, edit only legally mutable specification/ADR source, never generated tasks/contracts by hand; the trusted controller will run prd:compile afterward. For REPAIR, fix the concrete implementation/test/dependency/migration/config failure only. Do not touch workflows/tools/control-plane/secrets. Do not run git, gh, reset, clean, rebase, or merge. Leave valid changes uncommitted.`,
        'PRODUCT_FACTORY_RECOVERY_ACTION_AGENT_FAILED',
      );
      if (action === 'REPLAN' || action === 'SPLIT_TASK')
        pnpm(runner, workspace, ['prd:compile']);
    }
    const paths = changedPaths(runner, workspace);
    if (verifyGeneratedRecoveryNoop(runner, workspace, action, paths)) return;
    if (paths.length === 0) {
      console.error(`CHAINSIEVE_RECOVERY_NO_CHANGE_RETRY:${action}:${fingerprint.hash}`);
      return;
    }
    assertRecoveryScope(paths, lanes);
    runLaneChecks(workspace, runner, lanes);
    runFullChecks(workspace, runner);
    git(runner, workspace, ['add', '--', ...paths]);
    git(runner, workspace, ['commit', '-m', `fix(autonomy): execute ${action.toLowerCase()} recovery`]);
    git(runner, workspace, ['push', '-u', 'origin', branch]);
    gh(runner, root, [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      'main',
      '--title',
      `fix(autonomy): ${action.toLowerCase()} recovery`,
      '--body',
      `Autonomous recovery for ${fingerprint.hash}. Action: ${action}. Reason: ${diagnosis.reason}`,
    ]);
    const created = JSON.parse(
      gh(runner, root, ['pr', 'view', branch, '--json', 'number,url']),
    ) as { number: number; url: string };
    for (let repairRound = 0; repairRound <= 3; repairRound += 1) {
      const completed = await waitForPullRequest(
        root,
        runner,
        created.number,
        pollMilliseconds,
      );
      const failures = failedChecks(completed);
      if (failures.length > 0) {
        if (repairRound >= 3)
          throw new Error(`PRODUCT_FACTORY_RECOVERY_CI_LIMIT:${failures.join(',')}`);
        repairRecoveryCi(
          runner,
          provider,
          workspace,
          branch,
          failures,
          lanes,
          repairRound + 1,
        );
        continue;
      }
      if (completed.mergeStateStatus !== 'CLEAN')
        throw new Error(
          `PRODUCT_FACTORY_RECOVERY_PR_NOT_CLEAN:${completed.mergeStateStatus ?? 'UNKNOWN'}`,
        );
      gh(runner, root, ['pr', 'merge', String(created.number), '--merge', '--delete-branch']);
      break;
    }
  } finally {
    await removeWorktree(root, runner, workspace);
  }
  git(runner, root, ['fetch', 'origin', 'main']);
  git(runner, root, ['merge', '--ff-only', 'origin/main']);
};

const executeSupervisorRecoveryAction = async (
  root: string,
  runner: CommandRunner,
  provider: AgentProvider,
  diagnosis: SupervisorRecoveryDiagnosis,
  fingerprint: FailureFingerprint,
  commit: string,
  attempt: number,
  pollMilliseconds: number,
): Promise<void> => {
  switch (diagnosis.action) {
    case 'RETRY_INFRASTRUCTURE':
      await sleep(Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1)));
      return;
    case 'REOPEN_CORRECTION':
      pnpm(runner, root, ['spec:verify']);
      pnpm(runner, root, ['prd:drift-check']);
      return;
    case 'REPAIR':
    case 'REPLAN':
    case 'SPLIT_TASK':
    case 'REGENERATE_DERIVED_TASKS':
      await publishRecoveryChanges(
        root,
        runner,
        provider,
        diagnosis,
        fingerprint,
        commit,
        attempt,
        pollMilliseconds,
      );
      return;
    case 'SAFETY_TERMINAL':
    case 'EXTERNAL_BLOCKER':
      throw new Error(`PRODUCT_FACTORY_RECOVERY_TERMINAL:${diagnosis.action}:${diagnosis.reason}`);
  }
};

const detailsFromFailure = (rawFailure: string): string[] => {
  const detail = rawFailure.includes(':')
    ? rawFailure.split(':').slice(1).join(':')
    : rawFailure;
  return detail
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 20);
};

const effectiveClassification = (rawFailure: string) => {
  if (rawFailure.includes('FINAL_MAIN_CI_FAILED')) return 'AUTO_RECOVERABLE' as const;
  return classifyAutonomyFailure(rawFailure);
};

export const runSupervisedProductFactory = async (
  root: string,
  runner: CommandRunner,
  options: ProductFactoryOptions = {},
): Promise<string> => {
  const providerId: AgentProviderId = options.providerId ?? 'muse';
  const provider = createProvider(providerId, runner);
  const policy = await loadAutonomyPolicy(root);
  const pollMilliseconds = options.pollMilliseconds ?? 15_000;
  let supervisorAttempts = 0;

  for (;;) {
    try {
      return await runProductFactory(root, runner, options);
    } catch (error) {
      const rawFailure = errorCode(error);
      const classification = effectiveClassification(rawFailure);
      if (classification === 'SUCCESS') throw error;
      if (classification === 'SAFETY_TERMINAL' || classification === 'AUTONOMY_GAP')
        throw error;
      const commit = git(runner, root, ['rev-parse', 'HEAD']);
      const code = rawFailure.split(/[:\n]/)[0] ?? rawFailure;
      const fingerprint = computeFailureFingerprint(
        code,
        commit,
        detailsFromFailure(rawFailure),
      );
      const state = await readSupervisorRecoveryState(root, runner);
      const existing = state.records[fingerprint.hash];
      if (existing && existing.attempts >= MAX_RECOVERY_ATTEMPTS_PER_FINGERPRINT)
        throw new Error(`PRODUCT_FACTORY_SUPERVISOR_RECOVERY_LIMIT:${fingerprint.hash}`);

      let diagnosis: SupervisorRecoveryDiagnosis;
      const deterministicDiagnosis = deterministicRecoveryDiagnosis(rawFailure);
      if (classification === 'EXTERNAL_BLOCKER') {
        if (!isTransientExternalBlocker(rawFailure)) throw error;
        diagnosis = {
          action: 'RETRY_INFRASTRUCTURE',
          reason: `bounded retry for transient external blocker: ${code}`,
          evidence: [rawFailure.slice(0, 500)],
          target: code,
          constraints: ['do not change source while external service is transiently unavailable'],
          allowedLanes: [],
        };
      } else if (deterministicDiagnosis) {
        diagnosis = deterministicDiagnosis;
        console.log(`CHAINSIEVE_DETERMINISTIC_RECOVERY:${code}:${diagnosis.action}`);
      } else {
        diagnosis = await diagnoseSupervisorRecovery(
          root,
          runner,
          provider,
          fingerprint,
          commit,
          rawFailure,
        );
        if (
          diagnosis.action === 'RETRY_INFRASTRUCTURE' &&
          !isTransientExternalBlocker(rawFailure)
        )
          throw new Error('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_UNSAFE_RETRY');
      }

      const attempt = (existing?.attempts ?? 0) + 1;
      if (
        diagnosis.action === 'RETRY_INFRASTRUCTURE' &&
        attempt > policy.limits.infrastructureRetryRounds
      )
        throw new Error(`PRODUCT_FACTORY_INFRASTRUCTURE_RETRY_LIMIT:${fingerprint.hash}`);

      await recordSupervisorAttempt(root, runner, fingerprint, commit, diagnosis);
      await executeSupervisorRecoveryAction(
        root,
        runner,
        provider,
        diagnosis,
        fingerprint,
        commit,
        attempt,
        pollMilliseconds,
      );
      supervisorAttempts += 1;
      if (supervisorAttempts > 12)
        throw new Error('PRODUCT_FACTORY_SUPERVISOR_GLOBAL_RECOVERY_LIMIT');
    }
  }
};
