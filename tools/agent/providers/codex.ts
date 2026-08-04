import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';

const CODEX_TIMEOUT_MS = 90 * 60_000;

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;

  constructor(private readonly runner: CommandRunner) {}

  detect(): ProviderDetection {
    const result = this.runner.run('which', ['codex'], {
      timeoutMilliseconds: 10_000,
    });
    const command = result.stdout.trim();
    return result.status === 0 && command
      ? {
          available: true,
          mechanism: 'command',
          command,
          detail: 'Codex CLI headless exec',
        }
      : {
          available: false,
          mechanism: 'missing',
          detail: 'codex executable was not found on PATH',
        };
  }

  generatePayload(binding: TaskLaunchBinding): string {
    const correction =
      binding.failures.length > 0
        ? ` This is a correction round. Fix only: ${binding.failures.join(' ')} Amend the existing single task commit and stop; the root autopilot will bind corrected self-review evidence.`
        : ' Complete the task through its one atomic commit and supported self-review command, then stop.';
    return `Use the chainsieve-task project skill. Read and obey ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Operate autonomously without asking the owner for commands, approval, review, worktree selection, lease handling, push, or merge.${correction}`;
  }

  copyPayload(): void {
    throw new AgentError('CODEX_HEADLESS_EXEC_REQUIRED');
  }

  openWorkspace(): void {
    throw new AgentError('CODEX_HEADLESS_EXEC_REQUIRED');
  }

  executePayload(workspace: string, payload: string) {
    return this.runner.run(
      'codex',
      [
        '--ask-for-approval',
        'never',
        'exec',
        '--cd',
        workspace,
        '--sandbox',
        'danger-full-access',
        '--color',
        'never',
        '-',
      ],
      {
        cwd: workspace,
        input: payload,
        timeoutMilliseconds: CODEX_TIMEOUT_MS,
      },
    );
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return `Codex completed its headless run for ${taskId} in ${clusterId}.`;
  }
}
