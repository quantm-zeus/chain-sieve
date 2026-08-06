import { join } from 'node:path';
import { AgentError } from '../lib/errors.js';
import type {
  AgentProvider,
  CommandRunner,
  ProviderDetection,
  TaskLaunchBinding,
} from '../lib/types.js';

export const DEEPSEEK_ANTHROPIC_BASE_URL =
  'https://api.deepseek.com/anthropic' as const;
export const DEFAULT_CLAUDE_DEEPSEEK_MODEL =
  'deepseek-v4-pro[1m]' as const;
export const DEFAULT_CLAUDE_DEEPSEEK_FAST_MODEL =
  'deepseek-v4-flash' as const;
export const CLAUDE_DEEPSEEK_MODEL_ENV =
  'CHAINSIEVE_CLAUDE_DEEPSEEK_MODEL' as const;
export const CLAUDE_DEEPSEEK_FAST_MODEL_ENV =
  'CHAINSIEVE_CLAUDE_DEEPSEEK_FAST_MODEL' as const;
const CLAUDE_TIMEOUT_MS = 90 * 60_000;

const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(pwd)',
  'Bash(ls:*)',
  'Bash(find:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(sed:*)',
  'Bash(rg:*)',
  'Bash(node:*)',
  'Bash(pnpm:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git branch:*)',
  'Bash(git ls-files:*)',
  'Bash(git grep:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
].join(',');

const DISALLOWED_TOOLS = [
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git reset:*)',
  'Bash(git clean:*)',
  'Bash(gh:*)',
  'Bash(rm:*)',
  'Bash(sudo:*)',
].join(',');

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

export const resolveClaudeDeepSeekModel = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  environment[CLAUDE_DEEPSEEK_MODEL_ENV]?.trim() ||
  DEFAULT_CLAUDE_DEEPSEEK_MODEL;

export const resolveClaudeDeepSeekFastModel = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  environment[CLAUDE_DEEPSEEK_FAST_MODEL_ENV]?.trim() ||
  DEFAULT_CLAUDE_DEEPSEEK_FAST_MODEL;

export const resolveClaudeDeepSeekToken = (
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined =>
  environment.DEEPSEEK_API_KEY?.trim() ||
  environment.ANTHROPIC_AUTH_TOKEN?.trim() ||
  environment.ANTHROPIC_API_KEY?.trim() ||
  undefined;

export const claudeDeepSeekEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const token = resolveClaudeDeepSeekToken(environment);
  if (!token)
    throw new AgentError(
      'CLAUDE_DEEPSEEK_API_KEY_MISSING',
      'Set DEEPSEEK_API_KEY or ANTHROPIC_AUTH_TOKEN.',
    );
  const model = resolveClaudeDeepSeekModel(environment);
  const fastModel = resolveClaudeDeepSeekFastModel(environment);
  return {
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fastModel,
    CLAUDE_CODE_SUBAGENT_MODEL: fastModel,
    CLAUDE_CODE_EFFORT_LEVEL:
      environment.CLAUDE_CODE_EFFORT_LEVEL?.trim() || 'max',
  };
};

export class ClaudeDeepSeekProvider implements AgentProvider {
  readonly id = 'claude-deepseek' as const;

  constructor(private readonly runner: CommandRunner) {}

  detect(): ProviderDetection {
    const cli = commandPath(this.runner, 'claude');
    return cli
      ? {
          available: true,
          mechanism: 'command',
          command: cli,
          detail: 'Claude Code CLI using the DeepSeek Anthropic endpoint',
        }
      : {
          available: false,
          mechanism: 'missing',
          detail: 'Claude Code CLI command `claude` was not detected.',
        };
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
    return `Read and obey the exact ChainSieve task skill at "${taskSkillPath}". Do not search for skills, instructions, or repositories outside "${binding.taskWorkspace}". Load and obey the complete immutable task execution goal at ${binding.goalPath} (SHA-256 ${binding.goalSha256}). Work only in ${binding.taskWorkspace}. Confirm task ${binding.task.contract.id}, cluster ${binding.task.contract.cluster}, lease ${binding.leaseId}, holder ${binding.holder}, fencing version ${binding.fencingVersion}, context manifest ${binding.contextManifestPath} (SHA-256 ${binding.contextManifestSha256}), and the receipt-bound base commit before changing source.${conformance} Treat the immutable task contract and context manifest as the only authority for required tests and repository paths. Preserve valid existing work. Complete exactly this task through its one atomic commit and self-review, then stop so the root control plane can run the authoritative provider-independent verifier. Never ask the owner to renew, approve, review, push, merge, or choose a task. Do not invoke the merge queue or start another task.`;
  }

  executePayload(workspace: string, payload: string) {
    if (!commandPath(this.runner, 'claude'))
      throw new AgentError(
        'CLAUDE_CODE_MISSING',
        'Install @anthropic-ai/claude-code and ensure `claude` is on PATH.',
      );
    return this.runner.run(
      'claude',
      [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        ALLOWED_TOOLS,
        '--disallowedTools',
        DISALLOWED_TOOLS,
        '--max-turns',
        '200',
        payload,
      ],
      {
        cwd: workspace,
        timeoutMilliseconds: CLAUDE_TIMEOUT_MS,
        streamOutput: true,
        environment: claudeDeepSeekEnvironment(),
      },
    );
  }

  copyPayload(payload: string): void {
    const result = this.runner.run('pbcopy', [], { input: payload });
    if (result.status !== 0)
      throw new AgentError('CLIPBOARD_FAILED', result.stderr.trim());
  }

  openWorkspace(workspace: string): void {
    if (!commandPath(this.runner, 'claude'))
      throw new AgentError('CLAUDE_CODE_MISSING', 'Claude Code CLI is unavailable.');
    const result = this.runner.run('claude', [], {
      cwd: workspace,
      environment: claudeDeepSeekEnvironment(),
    });
    if (result.status !== 0)
      throw new AgentError('CLAUDE_CODE_OPEN_FAILED', result.stderr.trim());
  }

  renderOwnerInstruction(taskId: string, clusterId: string): string {
    return `Claude Code with DeepSeek completed its headless run for ${taskId} in ${clusterId}.`;
  }
}
