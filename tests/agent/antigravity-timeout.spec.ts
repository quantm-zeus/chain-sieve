import { afterEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  ANTIGRAVITY_PRINT_TIMEOUT_ENV,
  ANTIGRAVITY_TRANSIENT_RETRY_ATTEMPTS,
  AntigravityProvider,
  DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  antigravityFailureIsTransient,
  resolveAntigravityPrintTimeout,
} from '../../tools/agent/providers/antigravity.js';

class Runner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];

  run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    if (command === 'which' && args[0] === 'agy') {
      return { status: 0, stdout: '/home/test/.local/bin/agy\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

class TransientFailureRunner extends Runner {
  private agyAttempts = 0;

  override run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): CommandResult {
    if (command !== 'agy') return super.run(command, args, options);
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    this.agyAttempts += 1;
    if (this.agyAttempts < ANTIGRAVITY_TRANSIENT_RETRY_ATTEMPTS)
      return { status: 1, stdout: '', stderr: '' };
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

  it('passes an explicit print timeout to agy headless execution', () => {
    process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV] = '45m';
    const runner = new Runner();
    const provider = new AntigravityProvider(runner, { applicationCandidates: [] });

    provider.executePayload?.('/tmp/workspace', 'repair this failure');

    const agy = runner.calls.find((call) => call.command === 'agy');
    expect(agy?.args).toEqual([
      '--model',
      'Gemini 3.6 Flash (High)',
      '--mode=accept-edits',
      '--print-timeout',
      '45m',
      '-p',
      'repair this failure',
    ]);
    expect(agy?.options?.timeoutMilliseconds).toBe(90 * 60_000);
    expect(agy?.options?.streamOutput).toBe(true);
  });

  it('retries bounded quick inherited-output failures such as transient service overload', () => {
    const runner = new TransientFailureRunner();
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
      transientRetryDelayMilliseconds: 0,
    });

    expect(provider.executePayload('/tmp/workspace', 'repair')).toMatchObject({
      status: 0,
    });
    expect(runner.calls.filter((call) => call.command === 'agy')).toHaveLength(
      ANTIGRAVITY_TRANSIENT_RETRY_ATTEMPTS,
    );
  });

  it('does not retry failures with captured diagnostics or timeouts', () => {
    expect(
      antigravityFailureIsTransient(
        { status: 1, stdout: '', stderr: 'invalid model' },
        100,
      ),
    ).toBe(false);
    expect(
      antigravityFailureIsTransient(
        { status: 1, stdout: '', stderr: '', timedOut: true },
        100,
      ),
    ).toBe(false);
  });

  it('rejects malformed configured durations before launching agy', () => {
    process.env[ANTIGRAVITY_PRINT_TIMEOUT_ENV] = 'forever';
    const runner = new Runner();
    const provider = new AntigravityProvider(runner, { applicationCandidates: [] });

    expect(() => provider.executePayload?.('/tmp/workspace', 'repair')).toThrow(
      'ANTIGRAVITY_PRINT_TIMEOUT_INVALID',
    );
    expect(runner.calls.filter((call) => call.command === 'agy')).toHaveLength(0);
  });
});
