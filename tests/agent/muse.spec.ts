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
  classifyAgentWork,
  shouldRouteMusePayloadToMaintenance,
} from '../../tools/agent/providers/routing.js';
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

class NoAntigravityRunner extends Runner {
  override run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): CommandResult {
    if (command === 'which' && args[0] === 'agy') {
      this.calls.push({ command, args, options });
      return { status: 1, stdout: '', stderr: 'not found' };
    }
    return super.run(command, args, options);
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

  it('runs semantic task payloads through Muse', () => {
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

  it('routes isolated CI repair to Antigravity when agy is available', () => {
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const payload =
      'You are isolated CI repair session session-1. Inspect failed checks and leave changes uncommitted.';
    expect(provider.executePayload('/tmp/worktree', payload)).toMatchObject({ status: 0 });
    const launch = runner.calls.at(-1)!;
    expect(launch.command).toBe('agy');
    expect(launch.args).toContain('--mode=accept-edits');
    expect(launch.args).toContain(payload);
  });

  it('routes mechanical recovery diagnosis to Antigravity but keeps convergence diagnosis on Muse', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const mechanical =
      'You are the independent fresh-context recovery diagnostician for ChainSieve. Failure: PRODUCT_FACTORY_CHECK_FAILED:test:ENOTDIR .git/ciag-runtime. Fingerprint: fp. Frozen commit: abc.';
    provider.executePayload('/tmp/worktree', mechanical);
    expect(runner.calls.at(-1)!.command).toBe('agy');

    const semantic =
      'You are the independent fresh-context recovery diagnostician for ChainSieve. Failure: PRODUCT_FACTORY_CONVERGENCE_LIMIT:REQ-1. Fingerprint: fp2. Frozen commit: abc.';
    provider.executePayload('/tmp/worktree', semantic);
    expect(runner.calls.at(-1)!.command).toBe('muse');
  });

  it('falls back to Muse for maintenance work when agy is unavailable', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new NoAntigravityRunner();
    const provider = new MuseProvider(runner);
    provider.executePayload(
      '/tmp/worktree',
      'Recovery PR CI failed: Tier 0. Repair only the existing recovery implementation.',
    );
    expect(runner.calls.at(-1)!.command).toBe('muse');
  });
});

describe('hybrid agent routing policy', () => {
  it('classifies deterministic tooling failures as maintenance and semantic convergence as Muse work', () => {
    expect(classifyAgentWork('PRODUCT_FACTORY_CHECK_FAILED:test:ENOTDIR')).toBe(
      'MAINTENANCE',
    );
    expect(classifyAgentWork('AUTOPILOT_CI_FAILED:Tier 0')).toBe('MAINTENANCE');
    expect(classifyAgentWork('PRODUCT_FACTORY_CONVERGENCE_LIMIT:REQ-42')).toBe(
      'SEMANTIC',
    );
  });

  it('does not route ordinary implementation or independent review prompts away from Muse', () => {
    expect(shouldRouteMusePayloadToMaintenance('Implement task T-1 from its immutable contract.')).toBe(
      false,
    );
    expect(
      shouldRouteMusePayloadToMaintenance(
        'Independent review session 1. Review frozen product commit and return PASS or FAIL.',
      ),
    ).toBe(false);
  });
});
