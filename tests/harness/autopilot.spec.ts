import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ANTIGRAVITY_AUTOPILOT_MODEL,
  DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
  AntigravityProvider,
} from '../../tools/agent/providers/antigravity.js';
import { CodexProvider } from '../../tools/agent/providers/codex.js';
import type {
  CommandOptions,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  ANTIGRAVITY_MODEL_STATUS,
  correctionRoundAllowed,
  correctionReceiptMatches,
  DEFAULT_AUTONOMOUS_PROVIDER,
  formatPnpmCommandTag,
  MAX_PRODUCT_CORRECTION_ROUNDS,
} from '../../tools/autopilot/autopilot.js';
import { acquireAutopilotLock } from '../../tools/autopilot/lock.js';

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

class RecordingRunner implements CommandRunner {
  calls: Array<{
    command: string;
    args: string[];
    cwd?: string;
    input?: string;
    timeoutMilliseconds?: number;
    streamOutput?: boolean;
  }> = [];

  constructor(private readonly common = '/tmp/ciag-autopilot-common') {}

  run(command: string, args: string[], options: CommandOptions = {}) {
    this.calls.push({ command, args, ...options });
    if (command === 'which' && args[0] === 'agy')
      return { status: 0, stdout: '/usr/local/bin/agy\n', stderr: '' };
    if (command === 'which' && args[0] === 'codex')
      return { status: 0, stdout: '/usr/local/bin/codex\n', stderr: '' };
    if (command === 'which')
      return { status: 1, stdout: '', stderr: 'not found' };
    if (command === 'git' && args.includes('--git-common-dir'))
      return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    return { status: 0, stdout: 'completed\n', stderr: '' };
  }
}

describe('one-command autopilot', () => {
  it('uses the available Antigravity CLI model as the bounded headless default', () => {
    const runner = new RecordingRunner();
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    expect(DEFAULT_AUTONOMOUS_PROVIDER).toBe('antigravity');
    expect(provider.detect()).toMatchObject({
      available: true,
      mechanism: 'command',
    });
    expect(provider.executePayload('/repo/task', 'bound goal')).toMatchObject({
      status: 0,
    });
    expect(runner.calls.at(-1)).toEqual({
      command: '/usr/local/bin/agy',
      args: [
        '--model',
        DEFAULT_ANTIGRAVITY_AUTOPILOT_MODEL,
        '--mode=accept-edits',
        '--print-timeout',
        DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT,
        '-p',
        'bound goal',
      ],
      cwd: '/repo/task',
      timeoutMilliseconds: 5_400_000,
      streamOutput: false,
    });
  });

  it('keeps Codex as an explicit bounded fallback with global approval disabled', () => {
    const runner = new RecordingRunner();
    const provider = new CodexProvider(runner);
    expect(provider.executePayload('/repo/task', 'bound goal')).toMatchObject({
      status: 0,
    });
    expect(runner.calls.at(-1)).toEqual({
      command: 'codex',
      args: [
        '--ask-for-approval',
        'never',
        'exec',
        '--cd',
        '/repo/task',
        '--sandbox',
        'danger-full-access',
        '--color',
        'never',
        '-',
      ],
      cwd: '/repo/task',
      input: 'bound goal',
      timeoutMilliseconds: 5_400_000,
    });
  });

  it('enforces one repository process lock and releases it cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ciag-autopilot-root-'));
    const common = await mkdtemp(join(tmpdir(), 'ciag-autopilot-common-'));
    temporary.push(root, common);
    const runner = new RecordingRunner(common);
    const release = await acquireAutopilotLock(root, runner);
    await expect(acquireAutopilotLock(root, runner)).rejects.toThrow(
      'AUTOPILOT_ALREADY_RUNNING',
    );
    await release();
    const releaseAgain = await acquireAutopilotLock(root, runner);
    await releaseAgain();
  });

  it('limits automatic product correction to three rounds', () => {
    expect(MAX_PRODUCT_CORRECTION_ROUNDS).toBe(3);
    expect(correctionRoundAllowed(2)).toBe(true);
    expect(correctionRoundAllowed(3)).toBe(false);
    expect(() => correctionRoundAllowed(Number.NaN)).not.toThrow();
  });

  it('matches provider-neutral corrections against the prior commit and failure code', () => {
    const value = {
      provider: 'antigravity',
      taskId: 'T-G0-DATA',
      holder: 'agent-orchestrator',
      leaseId: 'lease-7',
      fencingVersion: 7,
      taskWorktree: '/repo/task',
      correction: {
        previousCommit: 'a'.repeat(40),
        failureCodes: ['VERIFY_FAILED'],
      },
    };
    const binding = {
      taskId: 'T-G0-DATA',
      holder: 'agent-orchestrator',
      leaseId: 'lease-7',
      fencingVersion: 7,
      worktree: '/repo/task',
      previousCommit: 'a'.repeat(40),
      failureCode: 'VERIFY_FAILED',
    };
    expect(correctionReceiptMatches(value, binding)).toBe(true);
    expect(correctionReceiptMatches({ ...value, provider: 'muse' }, binding)).toBe(true);
    expect(
      correctionReceiptMatches({ ...value, provider: 'claude-deepseek' }, binding),
    ).toBe(true);
    expect(
      correctionReceiptMatches(value, {
        ...binding,
        previousCommit: 'b'.repeat(40),
      }),
    ).toBe(false);
    expect(
      correctionReceiptMatches(value, { ...binding, leaseId: 'lease-8' }),
    ).toBe(false);
    expect(correctionReceiptMatches({ ...value, provider: 'unknown' })).toBe(
      false,
    );
  });

  it('reports the Antigravity model enforced by the CLI launch', () => {
    expect(ANTIGRAVITY_MODEL_STATUS).toBe(
      'GEMINI_3_6_FLASH_HIGH_ENFORCED_BY_CLI',
    );
  });

  it('formats pnpm command tags concisely without exposing long argument lists', () => {
    expect(
      formatPnpmCommandTag([
        'agent:recover',
        '--',
        'T-G0-SEC-01',
        '--expected-expired-lease-id',
        'T-G0-SEC-01:2:1785856641331',
      ]),
    ).toBe('agent:recover');
    expect(formatPnpmCommandTag(['--', 'agent:renew'])).toBe('agent:renew');
    expect(formatPnpmCommandTag(['task:validate', 'T-G0-SEC-01'])).toBe('task:validate');
  });
});
