import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexProvider } from '../../tools/agent/providers/codex.js';
import type { CommandRunner } from '../../tools/agent/lib/types.js';
import {
  ANTIGRAVITY_MODEL_STATUS,
  correctionRoundAllowed,
  correctionReceiptMatches,
  DEFAULT_AUTONOMOUS_PROVIDER,
  MAX_PRODUCT_CORRECTION_ROUNDS,
} from '../../tools/autopilot/autopilot.js';
import { acquireAutopilotLock } from '../../tools/autopilot/lock.js';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];
  constructor(private readonly common = '/tmp/ciag-autopilot-common') {}
  run(command: string, args: string[], options: { cwd?: string; input?: string } = {}) {
    this.calls.push({ command, args, ...options });
    if (command === 'which') return { status: 0, stdout: '/usr/local/bin/codex\n', stderr: '' };
    if (command === 'git' && args.includes('--git-common-dir')) return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    return { status: 0, stdout: 'completed\n', stderr: '' };
  }
}

describe('one-command autopilot', () => {
  it('uses Codex CLI as a blocking headless default without desktop automation', () => {
    const runner = new RecordingRunner();
    const provider = new CodexProvider(runner);
    expect(DEFAULT_AUTONOMOUS_PROVIDER).toBe('codex');
    expect(provider.detect()).toMatchObject({ available: true, mechanism: 'command' });
    expect(provider.executePayload!('/repo/task', 'bound goal')).toMatchObject({ status: 0 });
    expect(runner.calls.at(-1)).toEqual({
      command: 'codex',
      args: ['--ask-for-approval', 'never', 'exec', '--cd', '/repo/task', '--sandbox', 'danger-full-access', '--color', 'never', '-'],
      cwd: '/repo/task',
      input: 'bound goal',
    });
  });

  it('enforces one repository process lock and releases it cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ciag-autopilot-root-'));
    const common = await mkdtemp(join(tmpdir(), 'ciag-autopilot-common-'));
    temporary.push(root, common);
    const runner = new RecordingRunner(common);
    const release = await acquireAutopilotLock(root, runner);
    await expect(acquireAutopilotLock(root, runner)).rejects.toThrow('AUTOPILOT_ALREADY_RUNNING');
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
      provider: 'codex',
      taskId: 'T-G0-DATA',
      holder: 'agent-orchestrator',
      leaseId: 'lease-7',
      fencingVersion: 7,
      taskWorktree: '/repo/task',
      correction: { previousCommit: 'a'.repeat(40), failureCodes: ['VERIFY_FAILED'] },
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
    expect(correctionReceiptMatches(value, { previousCommit: 'b'.repeat(40), failureCode: 'VERIFY_FAILED' })).toBe(false);
    expect(correctionReceiptMatches(value, { ...binding, leaseId: 'lease-8' })).toBe(false);
    expect(correctionReceiptMatches({ ...value, provider: 'unknown' })).toBe(false);
  });

  it('reports unsupported Antigravity model control without substituting a model', () => {
    expect(ANTIGRAVITY_MODEL_STATUS).toBe('ANTIGRAVITY_MODEL_NOT_PROGRAMMATICALLY_ENFORCEABLE');
  });
});
