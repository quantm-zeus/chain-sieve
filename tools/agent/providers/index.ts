import { AgentError } from '../lib/errors.js';
import {
  beginTaskBeforeProvider,
  reconcileCommittedTaskCheckpoint,
} from '../lib/task-checkpoint.js';
import type {
  AgentProvider,
  AgentProviderId,
  CommandResult,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';
import { AntigravityProvider } from './antigravity.js';
import { ClaudeDeepSeekProvider } from './claude-deepseek.js';
import { CodexProvider } from './codex.js';
import { MuseProvider } from './muse.js';
import { ZCodeProvider } from './zcode.js';

export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'antigravity';

class HostLifecycleProvider implements AgentProvider {
  readonly id: AgentProviderId;
  private pendingTaskBinding: TaskLaunchBinding | undefined;

  constructor(
    private readonly inner: AgentProvider,
    private readonly runner: CommandRunner,
  ) {
    this.id = inner.id;
  }

  detect(): ProviderDetection {
    return this.inner.detect();
  }

  generatePayload(binding: TaskLaunchBinding): string {
    this.pendingTaskBinding = binding;
    return this.inner.generatePayload(binding);
  }

  copyPayload(payload: string): void {
    this.inner.copyPayload(payload);
  }

  openWorkspace(workspace: string): void {
    this.inner.openWorkspace(workspace);
  }

  executePayload(
    workspace: string,
    payload: string,
    options?: { streamOutput?: boolean },
  ): CommandResult {
    const binding =
      this.pendingTaskBinding?.taskWorkspace === workspace
        ? this.pendingTaskBinding
        : undefined;
    this.pendingTaskBinding = undefined;

    if (binding && binding.failures.length === 0) {
      const checkpoint = reconcileCommittedTaskCheckpoint(this.runner, binding);
      if (checkpoint) {
        console.log(
          `CHAINSIEVE_HOST_PROVIDER_SKIPPED:${binding.task.contract.id}:DURABLE_CHECKPOINT`,
        );
        return checkpoint;
      }
      const begun = beginTaskBeforeProvider(this.runner, binding);
      if (begun) return begun;
    }

    if (!this.inner.executePayload) {
      return {
        status: 1,
        stdout: '',
        stderr: `AUTONOMOUS_PROVIDER_NO_HEADLESS_EXECUTOR:${this.inner.id}`,
      };
    }

    const result = this.inner.executePayload(workspace, payload, options);
    if (result.status !== 0 || !binding || binding.failures.length > 0)
      return result;

    const checkpoint = reconcileCommittedTaskCheckpoint(this.runner, binding);
    if (checkpoint) return checkpoint;
    return result;
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return this.inner.renderOwnerInstruction(taskId, clusterId);
  }
}

const HOST_LIFECYCLE_METHODS = new Set<PropertyKey>([
  'detect',
  'generatePayload',
  'copyPayload',
  'openWorkspace',
  'executePayload',
  'renderOwnerInstruction',
]);

export const withHostLifecycle = (
  provider: AgentProvider,
  runner: CommandRunner,
): AgentProvider => {
  const lifecycle = new HostLifecycleProvider(provider, runner);
  return new Proxy(provider, {
    get(target, property) {
      if (HOST_LIFECYCLE_METHODS.has(property)) {
        const value = Reflect.get(lifecycle, property, lifecycle) as unknown;
        return typeof value === 'function'
          ? value.bind(lifecycle)
          : value;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const rawProvider = (
  id: AgentProviderId,
  runner: CommandRunner,
): AgentProvider => {
  if (id === 'antigravity') return new AntigravityProvider(runner);
  if (id === 'claude-deepseek') return new ClaudeDeepSeekProvider(runner);
  if (id === 'codex') return new CodexProvider(runner);
  if (id === 'muse') return new MuseProvider(runner);
  if (id === 'zcode') return new ZCodeProvider(runner);
  throw new AgentError('UNKNOWN_AGENT_PROVIDER', id);
};

export const createProvider = (
  id: AgentProviderId,
  runner: CommandRunner,
): AgentProvider => withHostLifecycle(rawProvider(id, runner), runner);

export const parseProvider = (argv: string[]): AgentProviderId => {
  const index = argv.indexOf('--provider');
  const value = index < 0 ? DEFAULT_AGENT_PROVIDER : argv[index + 1];
  if (
    value !== 'antigravity' &&
    value !== 'claude-deepseek' &&
    value !== 'codex' &&
    value !== 'muse' &&
    value !== 'zcode'
  )
    throw new AgentError('UNKNOWN_AGENT_PROVIDER', value ?? 'missing');
  return value;
};