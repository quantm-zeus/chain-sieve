import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  ANTIGRAVITY_PRINT_TIMEOUT_ENV,
  AntigravityProvider,
  DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  resolveAntigravityPrintTimeout,
} from '../../tools/agent/providers/antigravity.js';

class Runner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  agyResult: CommandResult = { status: 0, stdout: '', stderr: '' };

  run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    if (command === 'which' && args[0] === 'agy') {
      return { status: 0, stdout: '/home/test/.local/bin/agy\n', stderr: '' };
    }
    if (command === '/home/test/.local/bin/agy') return this.agyResult;
    return { status: 0, stdout: '', stderr: '' };
  }
}

const original = process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV];
  else process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV] = original;
});

describe('Antigravity headless print timeout', () => {
  it('defaults to a duration longer than agy print mode default', () => {
    delete process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV];
    expect(resolveAntigravityPrintTimeout()).toBe(DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT);
    expect(DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT).toBe('60m');
  });

  it('uses a fresh project, explicit workspace folder, process cwd, and scoped prompt', () => {
    process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV] = '45m';
    const runner = new Runner();
    const provider = new AntigravityProvider(runner, { applicationCandidates: [] });

    provider.executePayload?.('/tmp/workspace', 'repair this failure');

    const agy = runner.calls.find(
      (call) => call.command === '/home/test/.local/bin/agy',
    );
    expect(agy?.args.slice(0, 7)).toEqual([
      '--new-project',
      '--add-dir',
      '/tmp/workspace',
      '--model',
      'Gemini 3.6 Flash (High)',
      '--mode=accept-edits',
      '--print-timeout',
    ]);
    expect(agy?.args).not.toContain('--cwd');
    expect(agy?.args).toContain('45m');
    const promptIndex = agy?.args.indexOf('-p') ?? -1;
    expect(promptIndex).toBeGreaterThan(-1);
    expect(agy?.args[promptIndex + 1]).toContain(
      'The only writable workspace for this run is "/tmp/workspace"',
    );
    expect(agy?.args[promptIndex + 1]).toContain('repair this failure');
    expect(agy?.options?.cwd).toBe('/tmp/workspace');
    expect(agy?.options?.timeoutMilliseconds).toBe(90 * 60_000);
    expect(agy?.options?.streamOutput).toBe(false);
  });

  it('returns a captured provider failure without blind client-side retries', () => {
    const runner = new Runner();
    runner.agyResult = {
      status: 1,
      stdout: '',
      stderr: 'Our servers are experiencing high traffic right now',
    };
    const provider = new AntigravityProvider(runner, { applicationCandidates: [] });

    expect(
      provider.executePayload('/tmp/workspace', 'repair', { streamOutput: false }),
    ).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('high traffic'),
    });
    expect(
      runner.calls.filter(
        (call) => call.command === '/home/test/.local/bin/agy',
      ),
    ).toHaveLength(1);
  });

  it('rejects malformed configured durations before launching agy', () => {
    process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV] = 'forever';
    const runner = new Runner();
    const provider = new AntigravityProvider(runner, { applicationCandidates: [] });

    expect(() => provider.executePayload?.('/tmp/workspace', 'repair')).toThrow(
      'ANTIGRAVITY_PRINT_TIMEOUT_INVALID',
    );
    expect(
      runner.calls.filter(
        (call) => call.command === '/home/test/.local/bin/agy',
      ),
    ).toHaveLength(0);
  });
});
