import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AgentError } from '../lib/errors.js';
import { reconcileCommittedTaskCheckpoint } from '../lib/task-checkpoint.js';
import type {
  AgentProvider,
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

export const wrapMusePrompt = (payload: string): string =>
  `You are running inside ChainSieve FULL_AUTONOMY mode. This session must never ask a human to approve, review, grant a tool permission, renew a lease, choose a task, rerun the orchestrator, push, or merge. Any legacy compatibility instruction in a goal or review package that says to ask the owner or to run pnpm agent again is superseded by this FULL_AUTONOMY instruction. Complete only the role assigned by the payload, then terminate successfully so the root autonomous control plane can immediately continue. Do not push, merge, rebase, reset, clean, invoke gh, or bypass ChainSieve verification and lifecycle authority.\n\n${payload}`;

export const buildMuseArgs = (
  payload: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] =>
  parseMuseArgs(environment).map((arg) =>
    arg.replace(MUSE_PROMPT_TOKEN, payload),
  );

const supervisorPath = (): string =>
  fileURLToPath(new URL('./muse-supervisor.mjs', import.meta.url));

export class MuseProvider implements AgentProvider {
  readonly id = 'muse' as const;
  private pendingTaskBinding?: TaskLaunchBinding;

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
      ? ` This is an autonomous correction run. Resolve these authoritative verifier failures before completing: ${binding.failures.join(', ')}.`
      : '';
    return `Read and obey the exact ChainSieve task skill at "${taskSkillPath}". Do not search for skills, instructions, or repositories outside "${binding.taskWorkspace}". Load and obey the complete immutable task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, holder ${binding.holder}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source.${conformance}${failures} Treat the immutable task contract and context manifest as the only authority for required tests and repository paths. Preserve valid existing work. Implement exactly this task, run every task-authorized validation, perform a complete self-review, fix every issue found by that self-review, and create exactly one atomic task commit. Never ask the human owner for review, approval, permission, task selection, lease renewal, pushing, merging, or decisions. Never push, merge, rebase, reset, clean, invoke gh, invoke the merge queue, or start another task. When the task is complete, terminate successfully. The autonomous ChainSieve control plane will immediately verify, integrate, invoke correction if needed, perform independent cluster review, repair CI, merge, and continue to the next task without human handoff.`;
  }

  executePayload(workspace: string, payload: string) {
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
    const args = buildMuseArgs(wrapMusePrompt(payload));
    const supervision = resolveMuseSupervision();
    console.log(
      `CHAINSIEVE_MUSE_SUPERVISED_START:${binding?.task.contract.id ?? 'semantic-session'}`,
    );
    const result = this.runner.run(process.execPath, [supervisorPath()], {
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
    });

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
