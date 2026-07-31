import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';
import { detectZCodeApplication, openZCodeWorkspace } from './zcode-desktop.js';

export class ZCodeProvider implements AgentProvider {
  readonly id = 'zcode' as const;
  private detection?: ProviderDetection;

  constructor(private readonly runner: CommandRunner) {}

  detect(): ProviderDetection {
    const application = detectZCodeApplication();
    return (this.detection = application
      ? {
          available: true,
          mechanism: 'application',
          application,
          detail: 'ZCode compatibility application',
        }
      : {
          available: false,
          mechanism: 'missing',
          detail: 'ZCode is optional and was not detected.',
        });
  }

  generatePayload(binding: TaskLaunchBinding): string {
    return `/goal Load and obey the complete task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source. Complete exactly this task through its atomic commit, self-review, and real task verifier, then stop without invoking the merge queue or starting another task.`;
  }

  copyPayload(payload: string): void {
    const result = this.runner.run('pbcopy', [], { input: payload });
    if (result.status !== 0)
      throw new AgentError('CLIPBOARD_FAILED', result.stderr.trim());
  }

  openWorkspace(workspace: string): void {
    const detection = this.detection ?? this.detect();
    if (!detection.available || !detection.application)
      throw new AgentError('ZCODE_APPLICATION_MISSING', detection.detail);
    openZCodeWorkspace(this.runner, detection.application, workspace);
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return `Task ${taskId} in ${clusterId} is ready in ZCode compatibility mode. Press Cmd+V, then Enter.`;
  }
}
