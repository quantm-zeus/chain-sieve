import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';

export const ANTIGRAVITY_AUTOPILOT_MODEL = 'Gemini 3.6 Flash (High)' as const;

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
  const result = runner.run('which', [command]);
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
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
    return `Use the chainsieve-task project skill. Load and obey the complete immutable task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, holder ${binding.holder}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source.${conformance} Preserve valid existing work. Complete exactly this task through its one atomic commit and self-review, then stop so the root control plane can run the authoritative provider-independent verifier. Do not invoke the merge queue or start another task. The launcher enforces ${ANTIGRAVITY_AUTOPILOT_MODEL}.`;
  }

  executePayload(workspace: string, payload: string) {
    const cli = commandPath(this.runner, 'agy');
    if (!cli)
      throw new AgentError(
        'ANTIGRAVITY_HEADLESS_MISSING',
        'Install the agy CLI; agy-ide alone cannot provide a blocking headless run.',
      );
    return this.runner.run(
      'agy',
      [
        '--model',
        ANTIGRAVITY_AUTOPILOT_MODEL,
        '--mode=accept-edits',
        '-p',
        payload,
        '--cwd',
        workspace,
      ],
      { cwd: workspace },
    );
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
            detection.command.endsWith('agy')
              ? ['--cwd', workspace]
              : ['--new-window', workspace],
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
