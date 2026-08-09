import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';
import {
  MUSE_ARGS_ENV,
  MUSE_COMMAND_ENV,
  MUSE_PERMISSION_ENV,
  MuseProvider,
  buildMuseArgs,
  parseMuseArgs,
  resolveMuseCommand,
} from '../../tools/agent/providers/muse.js';
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
    if (command === 'which' && args[0]) {
      if (args[0] === 'missing-muse')
        return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: `${args[0]}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

const binding = (): PayloadBinding =>
  ({
    task: {
      contract: { id: 'T-G0-MUSE-01', cluster: 'C-G0-IMPLEMENTATION' },
    },
    taskWorkspace: '/tmp/Chain Sieve/.worktrees/T-G0-MUSE-01',
    leaseId: 'lease-muse-1',
    holder: 'agent-orchestrator',
    fencingVersion: 7,
    goalPath: '/tmp/immutable muse goal.md',
    goalSha256: 'a'.repeat(64),
    contextManifestPath:
      'artifacts/context/T-G0-MUSE-01/context-manifest.json',
    contextManifestSha256: 'b'.repeat(64),
    baseCommit: '1'.repeat(40),
    failures: [],
  }) as unknown as PayloadBinding;

const originalCommand = process.env[MUSE_COMMAND_ENV];
const originalArgs = process.env[MUSE_ARGS_ENV];
const originalPermission = process.env[MUSE_PERMISSION_ENV];

beforeEach(() => {
  delete process.env[MUSE_COMMAND_ENV];
  delete process.env[MUSE_ARGS_ENV];
  delete process.env[MUSE_PERMISSION_ENV];
});

afterEach(() => {
  if (originalCommand === undefined) delete process.env[MUSE_COMMAND_ENV];
  else process.env[MUSE_COMMAND_ENV] = originalCommand;
  if (originalArgs === undefined) delete process.env[MUSE_ARGS_ENV];
  else process.env[MUSE_ARGS_ENV] = originalArgs;
  if (originalPermission === undefined) delete process.env[MUSE_PERMISSION_ENV];
  else process.env[MUSE_PERMISSION_ENV] = originalPermission;
});

describe('Muse Code provider', () => {
  it('registers as an explicit provider without changing the default', () => {
    const runner = new Runner();
    expect(parseProvider(['--provider', 'muse'])).toBe('muse');
    expect(createProvider('muse', runner)).toBeInstanceOf(MuseProvider);
  });

  it('requires exactly one explicit prompt binding in the one-time headless config', () => {
    expect(() => parseMuseArgs({})).toThrow('MUSE_HEADLESS_ARGS_MISSING');
    expect(() =>
      parseMuseArgs({ [MUSE_ARGS_ENV]: '["--headless"]' }),
    ).toThrow('MUSE_HEADLESS_PROMPT_BINDING_INVALID');
    expect(() =>
      parseMuseArgs({
        [MUSE_ARGS_ENV]: '["--goal={prompt}:{prompt}"]',
      }),
    ).toThrow('MUSE_HEADLESS_PROMPT_BINDING_INVALID');
    expect(
      parseMuseArgs({
        [MUSE_ARGS_ENV]: '["--headless","--goal","{prompt}","--approve-all"]',
      }),
    ).toEqual(['--headless', '--goal', '{prompt}', '--approve-all']);
    expect(
      buildMuseArgs('finish task', {
        [MUSE_ARGS_ENV]: '["--headless","--goal","{prompt}","--approve-all"]',
      }),
    ).toEqual(['--headless', '--goal', 'finish task', '--approve-all']);
  });

  it('fails closed before launch when Muse permissions were not preapproved', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    delete process.env[MUSE_PERMISSION_ENV];
    const provider = new MuseProvider(new Runner());
    expect(() => provider.executePayload('/tmp/worktree', 'goal')).toThrow(
      'MUSE_PERMISSION_NOT_PREAPPROVED',
    );
  });

  it('fails closed with MUSE_PERMISSION_NOT_PREAPPROVED even when production command is in environment', () => {
    process.env[MUSE_COMMAND_ENV] = '/home/minhquan_eth/.local/bin/muse';
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    delete process.env[MUSE_PERMISSION_ENV];
    const provider = new MuseProvider(new Runner());
    expect(() => provider.executePayload('/tmp/worktree', 'goal')).toThrow(
      'MUSE_PERMISSION_NOT_PREAPPROVED',
    );
  });

  it('default command tests use muse independently of production environment', () => {
    delete process.env[MUSE_COMMAND_ENV];
    expect(resolveMuseCommand()).toBe('muse');
  });

  it('supports explicit absolute command representation in dedicated test without breaking mock', () => {
    process.env[MUSE_COMMAND_ENV] = '/custom/bin/muse';
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    expect(provider.executePayload(binding().taskWorkspace, 'test goal')).toMatchObject({
      status: 0,
    });
    const launch = runner.calls.at(-1)!;
    expect(launch.command).toBe('/custom/bin/muse');
  });

  it('runs headlessly in the task workspace after one-time permission setup', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const payload = provider.generatePayload(binding());
    expect(payload).toContain(
      '/tmp/Chain Sieve/.worktrees/T-G0-MUSE-01/.agents/skills/chainsieve-task/SKILL.md',
    );
    expect(payload).toContain('perform a complete self-review');
    expect(payload).toContain('Never ask the human owner');
    expect(payload).toContain('Never push, merge, rebase, reset, clean, invoke gh');
    expect(provider.executePayload(binding().taskWorkspace, payload)).toMatchObject({
      status: 0,
    });
    const launch = runner.calls.at(-1)!;
    expect(launch.command).toBe('muse');
    expect(launch.args).toContain('--headless');
    expect(launch.args).toContain('--approve-all');
    expect(launch.args.join(' ')).toContain('T-G0-MUSE-01');
    expect(launch.options).toMatchObject({
      cwd: binding().taskWorkspace,
      timeoutMilliseconds: 7_200_000,
      streamOutput: true,
    });
  });
});

