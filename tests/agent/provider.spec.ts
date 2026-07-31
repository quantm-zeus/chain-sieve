import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AntigravityProvider } from '../../tools/agent/providers/antigravity.js';
import { ZCodeProvider } from '../../tools/agent/providers/zcode.js';
import {
  DEFAULT_AGENT_PROVIDER,
  parseProvider,
} from '../../tools/agent/providers/index.js';
import { sha256, validateLaunchReceipt } from '../../tools/agent/lib/runtime.js';
import type {
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';
import { assertTaskWorkspaceForLaunch } from '../../tools/agent/lib/executor.js';

class Runner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; input?: string }> = [];
  responses = new Map<string, CommandResult>();

  run(
    command: string,
    args: string[],
    options: { input?: string } = {},
  ): CommandResult {
    this.calls.push({ command, args, ...(options.input ? { input: options.input } : {}) });
    return this.responses.get(`${command}:${args.join(':')}`) ?? {
      status: 0,
      stdout: '',
      stderr: '',
    };
  }
}

const binding = (): PayloadBinding =>
  ({
    task: {
      contract: { id: 'T-G0-CORE', cluster: 'C-G0-IMPLEMENTATION' },
    },
    taskWorkspace: '/tmp/Chain Sieve/.worktrees/T-G0-CORE',
    leaseId: 'lease-unchanged',
    holder: 'zcode-orchestrator',
    fencingVersion: 7,
    goalPath: '/tmp/goal with spaces.md',
    goalSha256: 'a'.repeat(64),
    contextManifestPath: 'artifacts/context/T-G0-CORE/context-manifest.json',
    contextManifestSha256: 'b'.repeat(64),
    baseCommit: '1'.repeat(40),
    failures: [],
  }) as unknown as PayloadBinding;

describe('provider-neutral agent adapters', () => {
  it('defaults to Antigravity and accepts explicit compatibility providers', () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe('antigravity');
    expect(parseProvider([])).toBe('antigravity');
    expect(parseProvider(['--provider', 'antigravity'])).toBe('antigravity');
    expect(parseProvider(['--provider', 'zcode'])).toBe('zcode');
  });

  it('generates a direct Antigravity prompt without a /goal dependency', () => {
    const provider = new AntigravityProvider(new Runner(), {
      applicationCandidates: [],
    });
    const payload = provider.generatePayload(binding());
    expect(payload).toContain('immutable task execution goal');
    expect(payload).toContain('Gemini 3.6 Flash');
    expect(payload).not.toMatch(/^\/goal\b/);
  });

  it('prefers agy-ide and opens the exact path with spaces', () => {
    const runner = new Runner();
    runner.responses.set('which:agy-ide', {
      status: 0,
      stdout: '/opt/bin/agy-ide\n',
      stderr: '',
    });
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    expect(provider.detect().command).toBe('/opt/bin/agy-ide');
    provider.openWorkspace('/tmp/Task Worktree With Spaces');
    expect(runner.calls.at(-1)).toEqual({
      command: '/opt/bin/agy-ide',
      args: ['--new-window', '/tmp/Task Worktree With Spaces'],
    });
  });

  it('reports Antigravity missing without opening a process', () => {
    const runner = new Runner();
    runner.responses.set('which:agy-ide', { status: 1, stdout: '', stderr: '' });
    runner.responses.set('which:agy', { status: 1, stdout: '', stderr: '' });
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    expect(provider.detect()).toMatchObject({ available: false, mechanism: 'missing' });
    expect(() => provider.openWorkspace('/tmp/task')).toThrow('ANTIGRAVITY_MISSING');
    expect(runner.calls.every((call) => call.command === 'which')).toBe(true);
  });

  it('does not require ZCode when Antigravity is available', () => {
    const runner = new Runner();
    runner.responses.set('which:agy-ide', {
      status: 0,
      stdout: '/opt/bin/agy-ide\n',
      stderr: '',
    });
    const antigravity = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    const zcode = new ZCodeProvider(runner);
    expect(antigravity.detect().available).toBe(true);
    expect(zcode.id).toBe('zcode');
  });

  it('fails closed on clipboard errors', () => {
    const runner = new Runner();
    runner.responses.set('pbcopy:', {
      status: 1,
      stdout: '',
      stderr: 'clipboard unavailable',
    });
    const provider = new AntigravityProvider(runner, {
      applicationCandidates: [],
    });
    expect(() => provider.copyPayload('payload')).toThrow('CLIPBOARD_FAILED');
  });

  it('switches providers near expiry in a temporary repository without lifecycle mutation', async () => {
    const value = binding();
    const root = mkdtempSync(join(tmpdir(), 'agent-provider-switch-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    const statePath = join(root, '.git/ciag-runtime/task-state.json');
    await mkdir(join(root, '.git/ciag-runtime'), { recursive: true });
    const lifecycleState = {
      schemaVersion: '2.0.0',
      tasks: {
        'T-G0-CORE': {
          taskId: 'T-G0-CORE',
          state: 'IMPLEMENTING',
          leaseId: value.leaseId,
          leaseVersion: value.fencingVersion,
          expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
        },
      },
    };
    await writeFile(statePath, `${JSON.stringify(lifecycleState, null, 2)}\n`);
    const stateBefore = await readFile(statePath, 'utf8');
    const antigravityRunner = new Runner();
    const zcodeRunner = new Runner();
    const before = { leaseId: value.leaseId, fencingVersion: value.fencingVersion };
    new AntigravityProvider(antigravityRunner).generatePayload(value);
    new ZCodeProvider(zcodeRunner).generatePayload(value);
    expect({ leaseId: value.leaseId, fencingVersion: value.fencingVersion }).toEqual(before);
    expect(await readFile(statePath, 'utf8')).toBe(stateBefore);
    expect([...antigravityRunner.calls, ...zcodeRunner.calls].some((call) => call.command === 'pnpm' && call.args.includes('task:renew'))).toBe(false);
  });

  it('rejects root main as an implementation workspace', () => {
    const inventory = { root: '/tmp/Chain Sieve' } as never;
    const task = {
      cluster: {
        branch: {
          branch: 'cluster/g0',
          worktree: '/tmp/Chain Sieve-worktrees/g0',
        },
      },
    } as never;
    expect(() =>
      assertTaskWorkspaceForLaunch(inventory, task, '/tmp/Chain Sieve'),
    ).toThrow('IMPLEMENTATION_WORKSPACE_NOT_TASK_ISOLATED');
  });

  it('reads an existing valid ZCode launch receipt from the legacy runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-legacy-receipt-'));
    const value = binding();
    const goal = 'legacy immutable task goal\n';
    const goalSha = sha256(goal);
    const goalPath = join(root, '.git/ciag-runtime/zcode/goals/T-G0-CORE', `${goalSha}.md`);
    const receiptPath = join(root, '.git/ciag-runtime/zcode/launch-receipts/T-G0-CORE/legacy.json');
    await mkdir(join(root, '.git/ciag-runtime/zcode/goals/T-G0-CORE'), { recursive: true });
    await mkdir(join(root, '.git/ciag-runtime/zcode/launch-receipts/T-G0-CORE'), { recursive: true });
    await writeFile(goalPath, goal);
    await writeFile(receiptPath, `${JSON.stringify({ schemaVersion: '1.0.0', taskId: 'T-G0-CORE', clusterId: 'C-G0-IMPLEMENTATION', leaseId: value.leaseId, fencingVersion: value.fencingVersion, contextManifestSha256: value.contextManifestSha256, goalPath, goalSha256: goalSha })}\n`);
    const runner = new Runner();
    runner.responses.set('git:rev-parse:--git-common-dir', { status: 0, stdout: '.git\n', stderr: '' });
    await expect(validateLaunchReceipt(root, runner, { taskId: 'T-G0-CORE', clusterId: 'C-G0-IMPLEMENTATION', leaseId: value.leaseId, fencingVersion: value.fencingVersion, contextManifestSha256: value.contextManifestSha256 })).resolves.toBeUndefined();
    expect(await readFile(receiptPath, 'utf8')).toContain('T-G0-CORE');
  });
});
