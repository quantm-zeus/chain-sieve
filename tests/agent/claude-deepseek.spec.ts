import { describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';
import {
  DEFAULT_CLAUDE_DEEPSEEK_FAST_MODEL,
  DEFAULT_CLAUDE_DEEPSEEK_MODEL,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  ClaudeDeepSeekProvider,
  claudeDeepSeekEnvironment,
} from '../../tools/agent/providers/claude-deepseek.js';
import {
  createProvider,
  parseProvider,
} from '../../tools/agent/providers/index.js';

class Runner implements CommandRunner {
  calls: Array<{
    command: string;
    args: string[];
    options: CommandOptions;
  }> = [];

  run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): CommandResult {
    this.calls.push({ command, args, options });
    if (command === 'which' && args[0] === 'claude')
      return {
        status: 0,
        stdout: '/usr/local/bin/claude\n',
        stderr: '',
      };
    return { status: 0, stdout: '', stderr: '' };
  }
}

const binding = (): PayloadBinding =>
  ({
    task: {
      contract: { id: 'T-G0-SEC-01', cluster: 'C-G0-IMPLEMENTATION' },
    },
    taskWorkspace: '/tmp/Chain Sieve/.worktrees/T-G0-SEC-01',
    leaseId: 'lease-3',
    holder: 'agent-orchestrator',
    fencingVersion: 3,
    goalPath: '/tmp/immutable goal.md',
    goalSha256: 'a'.repeat(64),
    contextManifestPath:
      'artifacts/context/T-G0-SEC-01/context-manifest.json',
    contextManifestSha256: 'b'.repeat(64),
    baseCommit: '1'.repeat(40),
    failures: [],
  }) as unknown as PayloadBinding;

describe('Claude Code DeepSeek provider', () => {
  it('registers as an explicit provider without changing the default', () => {
    const runner = new Runner();
    expect(parseProvider(['--provider', 'claude-deepseek'])).toBe(
      'claude-deepseek',
    );
    expect(createProvider('claude-deepseek', runner)).toBeInstanceOf(
      ClaudeDeepSeekProvider,
    );
  });

  it('builds the documented DeepSeek Anthropic environment without logging the key', () => {
    const environment = claudeDeepSeekEnvironment({
      DEEPSEEK_API_KEY: 'secret-deepseek-key',
    });
    expect(environment).toMatchObject({
      ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'secret-deepseek-key',
      ANTHROPIC_MODEL: DEFAULT_CLAUDE_DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_CLAUDE_DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_CLAUDE_DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_CLAUDE_DEEPSEEK_FAST_MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: DEFAULT_CLAUDE_DEEPSEEK_FAST_MODEL,
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
    expect(JSON.stringify(binding())).not.toContain('secret-deepseek-key');
  });

  it('fails closed when no DeepSeek credential is configured', () => {
    expect(() => claudeDeepSeekEnvironment({})).toThrow(
      'CLAUDE_DEEPSEEK_API_KEY_MISSING',
    );
  });

  it('uses the workspace-local task skill and a bounded headless Claude run', () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'secret-deepseek-key';
    try {
      const runner = new Runner();
      const provider = new ClaudeDeepSeekProvider(runner);
      const payload = provider.generatePayload(binding());
      expect(payload).toContain(
        '/tmp/Chain Sieve/.worktrees/T-G0-SEC-01/.agents/skills/chainsieve-task/SKILL.md',
      );
      expect(payload).toContain('Do not search for skills');
      expect(payload).not.toContain('secret-deepseek-key');
      expect(provider.executePayload(binding().taskWorkspace, payload)).toMatchObject({
        status: 0,
      });
      const launch = runner.calls.at(-1)!;
      expect(launch.command).toBe('claude');
      expect(launch.args).toContain('--print');
      expect(launch.args).toContain('stream-json');
      expect(launch.args).toContain('--allowedTools');
      expect(launch.args).toContain('--disallowedTools');
      expect(launch.args).not.toContain('secret-deepseek-key');
      expect(launch.options).toMatchObject({
        cwd: binding().taskWorkspace,
        timeoutMilliseconds: 5_400_000,
        streamOutput: true,
      });
      expect(launch.options.environment).toMatchObject({
        ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: 'secret-deepseek-key',
      });
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
