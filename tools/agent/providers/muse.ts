import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { AgentError } from '../lib/errors.js';
import {
  readTaskLifecycleState,
  reconcileCommittedTaskCheckpoint,
} from '../lib/task-checkpoint.js';
import type {
  AgentProvider,
  CommandResult,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';
import {
  selectMaintenanceProvider,
  shouldRouteMusePayloadToMaintenance,
} from './routing.js';
import { resolveMuseSupervision } from './muse-supervision.js';

export const MUSE_COMMAND_ENV = 'CHAINSIEVE_MUSE_COMMAND' as const;
export const MUSE_ARGS_ENV = 'CHAINSIEVE_MUSE_ARGS_JSON' as const;
export const MUSE_PERMISSION_ENV = 'CHAINSIEVE_MUSE_PERMISSION_MODE' as const;
export const MUSE_PERMISSION_PREAPPROVED = 'preapproved' as const;
export const MUSE_PROMPT_TOKEN = '{prompt}' as const;
export const MUSE_SUPERVISOR_CONFIG_ENV =
  'CHAINSIEVE_MUSE_SUPERVISOR_CONFIG' as const;
export const MUSE_TASK_CALL_LIMIT_ENV = 'CHAINSIEVE_MUSE_TASK_CALL_LIMIT' as const;
export const MUSE_SEMANTIC_CALL_LIMIT_ENV =
  'CHAINSIEVE_MUSE_SEMANTIC_CALL_LIMIT' as const;
export const DEFAULT_MUSE_TASK_CALL_LIMIT = 3;
export const DEFAULT_MUSE_SEMANTIC_CALL_LIMIT = 12;
const SUPERVISOR_EXIT_CHECKPOINT = 72;
const SUPERVISOR_EXIT_RETRY_STORM = 75;
const SUPERVISOR_EXIT_HARD_TIMEOUT = 76;

const commandPath = (
  runner: CommandRunner,
  command: string,
): string | undefined => {
  const result = runner.run('which', [command], {
    timeoutMilliseconds: 10_000,
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
};

export const resolveMuseCommand = (
  environment: NodeJS.ProcessEnv = process.env,
): string => environment[MUSE_COMMAND_ENV]?.trim() || 'muse';

const boundedCallLimit = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number => {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new AgentError(
      'MUSE_CALL_LIMIT_INVALID',
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  return value;
};

export const parseMuseArgs = (
  environment: NodeJS.ProcessEnv = process.env,
): string[] => {
  const raw = environment[MUSE_ARGS_ENV]?.trim();
  if (!raw)
    throw new AgentError(
      'MUSE_HEADLESS_ARGS_MISSING',
      `Set ${MUSE_ARGS_ENV} once to a JSON array containing ${MUSE_PROMPT_TOKEN} and Muse Code's non-interactive/auto-approval flags.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentError(
      'MUSE_HEADLESS_ARGS_INVALID',
      `${MUSE_ARGS_ENV} must be a JSON string array.`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((value) => typeof value !== 'string' || value.length === 0)
  )
    throw new AgentError(
      'MUSE_HEADLESS_ARGS_INVALID',
      `${MUSE_ARGS_ENV} must be a non-empty JSON string array.`,
    );
  const args = parsed as string[];
  const promptBindings = args.reduce(
    (count, arg) => count + arg.split(MUSE_PROMPT_TOKEN).length - 1,
    0,
  );
  if (promptBindings !== 1)
    throw new AgentError(
      'MUSE_HEADLESS_PROMPT_BINDING_INVALID',
      `${MUSE_ARGS_ENV} must contain ${MUSE_PROMPT_TOKEN} exactly once.`,
    );
  return args;
};

export const musePermissionConfigured = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  environment[MUSE_PERMISSION_ENV]?.trim().toLowerCase() ===
  MUSE_PERMISSION_PREAPPROVED;

export const resolveMuseTaskCallLimit = (
  environment: NodeJS.ProcessEnv = process.env,
): number =>
  boundedCallLimit(
    environment,
    MUSE_TASK_CALL_LIMIT_ENV,
    DEFAULT_MUSE_TASK_CALL_LIMIT,
    10,
  );

export const resolveMuseSemanticCallLimit = (
  environment: NodeJS.ProcessEnv = process.env,
): number =>
  boundedCallLimit(
    environment,
    MUSE_SEMANTIC_CALL_LIMIT_ENV,
    DEFAULT_MUSE_SEMANTIC_CALL_LIMIT,
    50,
  );

export const wrapMusePrompt = (payload: string): string =>
  `You are running inside ChainSieve FULL_AUTONOMY mode. This session must never ask a human to approve, review, grant a tool permission, renew a lease, choose a task, rerun the orchestrator, push, or merge. Any legacy compatibility instruction in a goal or review package that says to ask the owner or to run pnpm agent again is superseded by this FULL_AUTONOMY instruction. Lifecycle state is owned exclusively by the trusted host control plane: never run task:begin, task:self-review, task:verify, agent:renew, agent:recover, merge-queue commands, or any other lifecycle mutation. For an implementation task, produce exactly one clean atomic implementation commit after task-authorized development checks, then terminate successfully; the host performs self-review and authoritative verification. Do not push, merge, rebase, reset, clean, invoke gh, or bypass ChainSieve verification and lifecycle authority.\n\n${payload}`;

export const buildMuseArgs = (
  payload: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] =>
  parseMuseArgs(environment).map((arg) =>
    arg.replace(MUSE_PROMPT_TOKEN, payload),
  );

const supervisorPath = (): string =>
  fileURLToPath(new URL('./muse-supervisor.mjs', import.meta.url));

const safeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);

const gitCommonDirectory = (
  runner: CommandRunner,
  workspace: string,
): string | undefined => {
  const result = runner.run('git', ['rev-parse', '--git-common-dir'], {
    cwd: workspace,
    timeoutMilliseconds: 10_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  const value = result.stdout.trim();
  return resolve(workspace, isAbsolute(value) ? value : join(workspace, value));
};

const workspaceHead = (
  runner: CommandRunner,
  workspace: string,
): string | undefined => {
  const result = runner.run('git', ['rev-parse', 'HEAD'], {
    cwd: workspace,
    timeoutMilliseconds: 10_000,
  });
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
};

const claimMuseTaskAttempt = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  if (!binding.launchReceiptId) return undefined;
  const common = gitCommonDirectory(runner, binding.taskWorkspace);
  if (!common)
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_TASK_BUDGET_RUNTIME_UNAVAILABLE:${binding.task.contract.id}`,
    };
  const head = workspaceHead(runner, binding.taskWorkspace);
  if (!head)
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_TASK_BUDGET_HEAD_UNAVAILABLE:${binding.task.contract.id}`,
    };
  const directory = join(
    common,
    'ciag-runtime',
    'agent',
    'provider-attempts',
    'muse',
    'task',
    safeSegment(binding.task.contract.id),
  );
  mkdirSync(directory, { recursive: true });
  const receipt = safeSegment(binding.launchReceiptId);
  const marker = join(directory, `${receipt}.${safeSegment(head)}.json`);
  if (existsSync(marker))
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_DUPLICATE_TASK_EVIDENCE_BLOCKED:${binding.task.contract.id}:${binding.launchReceiptId}:${head}`,
    };
  const used = readdirSync(directory).filter((name) => name.endsWith('.json')).length;
  const limit = resolveMuseTaskCallLimit();
  if (used >= limit)
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_TASK_CALL_BUDGET_EXHAUSTED:${binding.task.contract.id}:${used}/${limit}`,
    };
  writeFileSync(
    marker,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        role: 'TASK',
        taskId: binding.task.contract.id,
        receiptId: binding.launchReceiptId,
        workspaceHead: head,
        leaseId: binding.leaseId,
        fencingVersion: binding.fencingVersion,
        baseCommit: binding.baseCommit,
        claimedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `CHAINSIEVE_MUSE_TASK_BUDGET:${binding.task.contract.id}:${used + 1}/${limit}:${binding.launchReceiptId}:${head}`,
  );
  return undefined;
};

const claimMuseSemanticAttempt = (
  runner: CommandRunner,
  workspace: string,
  payload: string,
): CommandResult | undefined => {
  const common = gitCommonDirectory(runner, workspace);
  const head = workspaceHead(runner, workspace);
  if (!common || !head)
    return {
      status: 1,
      stdout: '',
      stderr: 'MUSE_SEMANTIC_BUDGET_EVIDENCE_UNAVAILABLE',
    };
  const directory = join(
    common,
    'ciag-runtime',
    'agent',
    'provider-attempts',
    'muse',
    'semantic',
    safeSegment(head),
  );
  mkdirSync(directory, { recursive: true });
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const marker = join(directory, `${payloadHash}.json`);
  if (existsSync(marker))
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_DUPLICATE_SEMANTIC_EVIDENCE_BLOCKED:${head}:${payloadHash}`,
    };
  const used = readdirSync(directory).filter((name) => name.endsWith('.json')).length;
  const limit = resolveMuseSemanticCallLimit();
  if (used >= limit)
    return {
      status: 1,
      stdout: '',
      stderr: `MUSE_SEMANTIC_CALL_BUDGET_EXHAUSTED:${head}:${used}/${limit}`,
    };
  writeFileSync(
    marker,
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        role: 'SEMANTIC',
        workspaceHead: head,
        payloadSha256: payloadHash,
        claimedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    `CHAINSIEVE_MUSE_SEMANTIC_BUDGET:${used + 1}/${limit}:${head}:${payloadHash}`,
  );
  return undefined;
};

const beginTaskBeforeMuse = (
  runner: CommandRunner,
  binding: TaskLaunchBinding,
): CommandResult | undefined => {
  if (readTaskLifecycleState(runner, binding) !== 'LEASED') return undefined;
  const result = runner.run(
    'pnpm',
    [
      '--silent',
      'task:begin',
      binding.task.contract.id,
      '--holder',
      binding.holder,
      '--lease-version',
      String(binding.fencingVersion),
    ],
    {
      cwd: binding.taskWorkspace,
      timeoutMilliseconds: 30 * 60_000,
      streamOutput: true,
    },
  );
  if (result.status !== 0)
    return {
      ...result,
      stderr: `TASK_BEGIN_BEFORE_MUSE_FAILED:${binding.task.contract.id}:${result.stderr || result.stdout}`,
    };
  console.log(`CHAINSIEVE_TASK_BEGUN_BEFORE_MUSE:${binding.task.contract.id}`);
  return undefined;
};

export class MuseProvider implements AgentProvider {
  readonly id = 'muse' as const;
  private pendingTaskBinding: TaskLaunchBinding | undefined;

  constructor(private readonly runner: CommandRunner) {}

  detect(): ProviderDetection {
    const command = resolveMuseCommand();
    const cli = commandPath(this.runner, command);
    return cli
      ? {
          available: true,
          mechanism: 'command',
          command: cli,
          detail: `Muse Code CLI command ${command}`,
        }
      : {
          available: false,
          mechanism: 'missing',
          detail: `Muse Code CLI command \`${command}\` was not detected.`,
        };
  }

  generatePayload(binding: TaskLaunchBinding): string {
    this.pendingTaskBinding = binding;
    const conformance = binding.conformanceManifestSha256
      ? ` Immutable conformance manifest: ${binding.conformanceManifestPath} (SHA-256 ${binding.conformanceManifestSha256}).`
      : '';
    const taskSkillPath = join(
      binding.taskWorkspace,
      '.agents',
      'skills',
      'chainsieve-task',
      'SKILL.md',
    );
    const failures = binding.failures.length
      ? ` This is an autonomous correction run. Resolve only these new authoritative verifier failures before completing: ${binding.failures.join(', ')}.`
      : '';
    return `Read and obey the exact ChainSieve task skill at "${taskSkillPath}". Do not search for skills, instructions, or repositories outside "${binding.taskWorkspace}". Load the immutable task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}) only as task scope and evidence; any lifecycle commands in legacy goal text are host-owned and must not be executed by this session. Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and receipt-bound base commit before changing source.${conformance}${failures} Use the supplied context pack and targeted file reads; do not reread unchanged authority or scan the whole repository. Preserve valid existing work. Implement exactly this task, run focused task-authorized development checks, inspect full output only for failures, self-review the code diff conceptually, fix material issues, and create exactly one clean atomic implementation commit. Do not run any ChainSieve lifecycle command; the trusted host will adopt the checkpoint, run deterministic self-review, authoritative verification, integration, CI repair, and continuation. Never ask the human owner for review, approval, permission, task selection, lease renewal, pushing, merging, or decisions. Never push, merge, rebase, reset, clean, invoke gh, invoke the merge queue, or start another task. When the atomic commit is complete, terminate successfully.`;
  }

  executePayload(workspace: string, payload: string): CommandResult {
    if (shouldRouteMusePayloadToMaintenance(payload)) {
      const maintenance = selectMaintenanceProvider(this.runner, this);
      if (maintenance !== this && maintenance.executePayload) {
        console.log(`CHAINSIEVE_AGENT_ROUTE:MAINTENANCE:${maintenance.id}`);
        return maintenance.executePayload(workspace, payload);
      }
    }

    const binding =
      this.pendingTaskBinding?.taskWorkspace === workspace
        ? this.pendingTaskBinding
        : undefined;
    this.pendingTaskBinding = undefined;
    if (binding) {
      const reconciled = reconcileCommittedTaskCheckpoint(this.runner, binding);
      if (reconciled) return reconciled;
    }

    const command = resolveMuseCommand();
    if (!commandPath(this.runner, command))
      throw new AgentError(
        'MUSE_CODE_MISSING',
        `Install Muse Code and ensure \`${command}\` is on PATH.`,
      );
    if (!musePermissionConfigured())
      throw new AgentError(
        'MUSE_PERMISSION_NOT_PREAPPROVED',
        `Configure Muse Code permissions once, then set ${MUSE_PERMISSION_ENV}=${MUSE_PERMISSION_PREAPPROVED}.`,
      );

    if (binding) {
      const beginFailure = beginTaskBeforeMuse(this.runner, binding);
      if (beginFailure) return beginFailure;
      const budgetFailure = claimMuseTaskAttempt(this.runner, binding);
      if (budgetFailure) return budgetFailure;
    } else {
      const budgetFailure = claimMuseSemanticAttempt(this.runner, workspace, payload);
      if (budgetFailure) return budgetFailure;
    }

    const args = buildMuseArgs(wrapMusePrompt(payload));
    const supervision = resolveMuseSupervision();
    console.log(
      `CHAINSIEVE_MUSE_SUPERVISED_START:${binding?.task.contract.id ?? 'semantic-session'}`,
    );
    const result: CommandResult = this.runner.run(
      process.execPath,
      [supervisorPath()],
      {
        cwd: workspace,
        timeoutMilliseconds: supervision.hardTimeoutMilliseconds + 60_000,
        streamOutput: true,
        environment: {
          [MUSE_SUPERVISOR_CONFIG_ENV]: JSON.stringify({
            command,
            args,
            workspace,
            ...(binding
              ? {
                  taskId: binding.task.contract.id,
                  baseCommit: binding.baseCommit,
                }
              : {}),
            ...supervision,
          }),
        },
      },
    );

    if (
      binding &&
      (result.status === 0 || result.status === SUPERVISOR_EXIT_CHECKPOINT)
    ) {
      const reconciled = reconcileCommittedTaskCheckpoint(this.runner, binding);
      if (reconciled) return reconciled;
    }
    if (result.status === SUPERVISOR_EXIT_CHECKPOINT)
      return { status: 0, stdout: '', stderr: '' };
    if (result.status === SUPERVISOR_EXIT_RETRY_STORM)
      return {
        ...result,
        stderr: 'MUSE_PROVIDER_RETRY_STORM:CIRCUIT_OPEN',
      };
    if (result.status === SUPERVISOR_EXIT_HARD_TIMEOUT)
      return {
        ...result,
        timedOut: true,
        stderr: 'MUSE_HARD_TIMEOUT:CIRCUIT_OPEN',
      };
    return result;
  }

  copyPayload(payload: string): void {
    const result = this.runner.run('pbcopy', [], { input: payload });
    if (result.status !== 0)
      throw new AgentError('CLIPBOARD_FAILED', result.stderr.trim());
  }

  openWorkspace(workspace: string): void {
    const command = resolveMuseCommand();
    if (!commandPath(this.runner, command))
      throw new AgentError('MUSE_CODE_MISSING', 'Muse Code CLI is unavailable.');
    const result = this.runner.run(command, [], { cwd: workspace });
    if (result.status !== 0)
      throw new AgentError('MUSE_CODE_OPEN_FAILED', result.stderr.trim());
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return `Muse Code completed its autonomous headless run for ${taskId} in ${clusterId}.`;
  }
}
