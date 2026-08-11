import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  CommandResult,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';

export const DEFAULT_ANTIGRAVITY_AUTOPILOT_MODEL =
  'Gemini 3.6 Flash (High)' as const;
export const ANTIGRAVITY_MODEL_ENV = 'CHAINSIEVE_ANTIGRAVITY_MODEL' as const;
export const resolveAntigravityAutopilotModel = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  environment[ANTIGRAVITY_MODEL_ENV]?.trim() ||
  DEFAULT_ANTIGRAVITY_AUTOPILOT_MODEL;

export const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = '60m' as const;
export const ANTIGRAVITY_PRINT_TIMEOUT_ENV =
  'CHAINSIEVE_ANTIGRAVITY_PRINT_TIMEOUT' as const;
export const resolveAntigravityPrintTimeout = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const configured = environment[ANTIGRAVITY_PRINT_TIMEOUT_ENV]?.trim();
  if (!configured) return DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT;
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(configured))
    throw new AgentError(
      'ANTIGRAVITY_PRINT_TIMEOUT_INVALID',
      `${ANTIGRAVITY_PRINT_TIMEOUT_ENV} must be a Go duration such as 20m, 60m, or 1h30m.`,
    );
  return configured;
};

const ANTIGRAVITY_TIMEOUT_MS = 90 * 60_000;

const APPLICATIONS = [
  {
    path: '/Applications/Antigravity IDE.app',
    bundleIdentifier: 'com.google.antigravity-ide',
  },
  {
    path: '/Applications/Antigravity.app',
    bundleIdentifier: 'com.google.antigravity',
  },
  {
    path: join(homedir(), 'Applications', 'Antigravity IDE.app'),
    bundleIdentifier: 'com.google.antigravity-ide',
  },
  {
    path: join(homedir(), 'Applications', 'Antigravity.app'),
    bundleIdentifier: 'com.google.antigravity',
  },
] as const;

export interface AntigravityAdapterOptions {
  applicationCandidates?: Array<{
    path: string;
    bundleIdentifier: string;
  }>;
}

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

const streamCapturedResult = (result: CommandResult): void => {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
};

export class AntigravityProvider implements AgentProvider {
  readonly id = 'antigravity' as const;
  private detection?: ProviderDetection;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: AntigravityAdapterOptions = {},
  ) {}

  detect(): ProviderDetection {
    const cli = commandPath(this.runner, 'agy');
    if (cli)
      return (this.detection = {
        available: true,
        mechanism: 'command',
        command: cli,
        detail: 'agy CLI headless prompt command',
      });
    const ide = commandPath(this.runner, 'agy-ide');
    if (ide)
      return (this.detection = {
        available: true,
        mechanism: 'command',
        command: ide,
        detail: 'agy-ide workspace command without headless execution',
      });
    const application = (
      this.options.applicationCandidates ?? APPLICATIONS
    ).find((candidate) => existsSync(candidate.path));
    if (application)
      return (this.detection = {
        available: true,
        mechanism: 'application',
        application: application.path,
        bundleIdentifier: application.bundleIdentifier,
        detail: `macOS application ${application.bundleIdentifier}`,
      });
    return (this.detection = {
      available: false,
      mechanism: 'missing',
      detail:
        'No agy CLI, agy-ide command, or Antigravity macOS application was detected.',
    });
  }

  generatePayload(binding: TaskLaunchBinding): string {
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
    return `Read and obey the exact ChainSieve task skill at "${taskSkillPath}". Do not search for skills, instructions, or repositories outside "${binding.taskWorkspace}". Load and obey the complete immutable task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, holder ${binding.holder}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source.${conformance} Treat the immutable task contract and context manifest as the only authority for required tests and repository paths. Do not invent conventional test paths such as tests/task-facets/${binding.task.contract.id}.spec.ts when they are not explicitly listed. A missing non-required path is absent evidence, not permission to scan outside the task worktree. Preserve valid existing work. Complete exactly this task through its one atomic commit and self-review, then stop so the root control plane can run the authoritative provider-independent verifier. Never ask the owner to renew, approve, review, push, merge, or choose a task. Do not invoke the merge queue or start another task. The launcher enforces ${resolveAntigravityAutopilotModel()}.`;
  }

  executePayload(
    workspace: string,
    payload: string,
    options?: { streamOutput?: boolean },
  ): CommandResult {
    const cli = commandPath(this.runner, 'agy');
    if (!cli)
      throw new AgentError(
        'ANTIGRAVITY_HEADLESS_MISSING',
        'Install the agy CLI; agy-ide alone cannot provide a blocking headless run.',
      );

    const result = this.runner.run(
      cli,
      [
        '--model',
        resolveAntigravityAutopilotModel(),
        '--mode=accept-edits',
        '--cwd',
        workspace,
        '--print-timeout',
        resolveAntigravityPrintTimeout(),
        '-p',
        payload,
      ],
      {
        cwd: workspace,
        timeoutMilliseconds: ANTIGRAVITY_TIMEOUT_MS,
        streamOutput: false,
      },
    );
    if (options?.streamOutput ?? true) streamCapturedResult(result);
    return result;
  }

  copyPayload(payload: string): void {
    const result = this.runner.run('pbcopy', [], { input: payload });
    if (result.status !== 0)
      throw new AgentError('CLIPBOARD_FAILED', result.stderr.trim());
  }

  openWorkspace(workspace: string): void {
    const detection = this.detection ?? this.detect();
    if (!detection.available)
      throw new AgentError('ANTIGRAVITY_MISSING', detection.detail);
    const result =
      detection.mechanism === 'command' && detection.command
        ? this.runner.run(
            detection.command,
            detection.command.endsWith('agy') ? [] : ['--new-window', workspace],
            detection.command.endsWith('agy') ? { cwd: workspace } : undefined,
          )
        : this.runner.run('open', [
            '-b',
            detection.bundleIdentifier!,
            '--args',
            '--new-window',
            workspace,
          ]);
    if (result.status !== 0)
      throw new AgentError('ANTIGRAVITY_OPEN_FAILED', result.stderr.trim());
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return `Antigravity completed its headless run for ${taskId} in ${clusterId}.`;
  }
}
