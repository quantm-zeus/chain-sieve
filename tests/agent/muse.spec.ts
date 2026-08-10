import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  PayloadBinding,
} from '../../tools/agent/lib/types.js';
import {
  DEFAULT_MUSE_SEMANTIC_CALL_LIMIT,
  DEFAULT_MUSE_TASK_CALL_LIMIT,
  MUSE_ARGS_ENV,
  MUSE_COMMAND_ENV,
  MUSE_PERMISSION_ENV,
  MUSE_SEMANTIC_CALL_LIMIT_ENV,
  MUSE_SUPERVISOR_CONFIG_ENV,
  MUSE_TASK_CALL_LIMIT_ENV,
  MuseProvider,
  buildMuseArgs,
  parseMuseArgs,
  resolveMuseCommand,
  resolveMuseSemanticCallLimit,
  resolveMuseTaskCallLimit,
} from '../../tools/agent/providers/muse.js';
import {
  DEFAULT_MUSE_HARD_TIMEOUT_MS,
  MUSE_HARD_TIMEOUT_ENV,
  MUSE_RETRY_STORM_LIMIT_ENV,
  museLifecycleIsDurableCheckpoint,
  museOutputIsRetrySignal,
  resolveMuseSupervision,
} from '../../tools/agent/providers/muse-supervision.js';
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
  private readonly common = `/tmp/chainsieve-muse-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  private head = 'f'.repeat(40);

  setHead(head: string): void {
    this.head = head;
  }

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
    if (command === 'git' && args.join(' ') === 'rev-parse --git-common-dir')
      return { status: 0, stdout: `${this.common}\n`, stderr: '' };
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD')
      return { status: 0, stdout: `${this.head}\n`, stderr: '' };
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
    launchReceiptId: 'muse-receipt-1',
    failures: [],
  }) as unknown as PayloadBinding;

const supervisorConfig = (call: Runner['calls'][number]) =>
  JSON.parse(
    call.options.environment?.[MUSE_SUPERVISOR_CONFIG_ENV] ?? '{}',
  ) as {
    command?: string;
    args?: string[];
    workspace?: string;
    taskId?: string;
    baseCommit?: string;
    hardTimeoutMilliseconds?: number;
  };

const supervisedLaunch = (runner: Runner): Runner['calls'][number] => {
  const launch = [...runner.calls]
    .reverse()
    .find(
      (call) =>
        call.command === process.execPath &&
        call.args[0]?.includes('muse-supervisor.mjs'),
    );
  if (!launch) throw new Error('TEST_MUSE_SUPERVISOR_LAUNCH_MISSING');
  return launch;
};

const originalCommand = process.env[MUSE_COMMAND_ENV];
const originalArgs = process.env[MUSE_ARGS_ENV];
const originalPermission = process.env[MUSE_PERMISSION_ENV];
const originalHardTimeout = process.env[MUSE_HARD_TIMEOUT_ENV];
const originalRetryLimit = process.env[MUSE_RETRY_STORM_LIMIT_ENV];
const originalTaskCallLimit = process.env[MUSE_TASK_CALL_LIMIT_ENV];
const originalSemanticCallLimit = process.env[MUSE_SEMANTIC_CALL_LIMIT_ENV];

beforeEach(() => {
  delete process.env[MUSE_COMMAND_ENV];
  delete process.env[MUSE_ARGS_ENV];
  delete process.env[MUSE_PERMISSION_ENV];
  delete process.env[MUSE_HARD_TIMEOUT_ENV];
  delete process.env[MUSE_RETRY_STORM_LIMIT_ENV];
  delete process.env[MUSE_TASK_CALL_LIMIT_ENV];
  delete process.env[MUSE_SEMANTIC_CALL_LIMIT_ENV];
});

afterEach(() => {
  if (originalCommand === undefined) delete process.env[MUSE_COMMAND_ENV];
  else process.env[MUSE_COMMAND_ENV] = originalCommand;
  if (originalArgs === undefined) delete process.env[MUSE_ARGS_ENV];
  else process.env[MUSE_ARGS_ENV] = originalArgs;
  if (originalPermission === undefined) delete process.env[MUSE_PERMISSION_ENV];
  else process.env[MUSE_PERMISSION_ENV] = originalPermission;
  if (originalHardTimeout === undefined) delete process.env[MUSE_HARD_TIMEOUT_ENV];
  else process.env[MUSE_HARD_TIMEOUT_ENV] = originalHardTimeout;
  if (originalRetryLimit === undefined) delete process.env[MUSE_RETRY_STORM_LIMIT_ENV];
  else process.env[MUSE_RETRY_STORM_LIMIT_ENV] = originalRetryLimit;
  if (originalTaskCallLimit === undefined) delete process.env[MUSE_TASK_CALL_LIMIT_ENV];
  else process.env[MUSE_TASK_CALL_LIMIT_ENV] = originalTaskCallLimit;
  if (originalSemanticCallLimit === undefined)
    delete process.env[MUSE_SEMANTIC_CALL_LIMIT_ENV];
  else process.env[MUSE_SEMANTIC_CALL_LIMIT_ENV] = originalSemanticCallLimit;
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

  it('uses bounded configurable task and semantic Muse call limits', () => {
    expect(resolveMuseTaskCallLimit({})).toBe(DEFAULT_MUSE_TASK_CALL_LIMIT);
    expect(resolveMuseSemanticCallLimit({})).toBe(DEFAULT_MUSE_SEMANTIC_CALL_LIMIT);
    expect(resolveMuseTaskCallLimit({ [MUSE_TASK_CALL_LIMIT_ENV]: '2' })).toBe(2);
    expect(
      resolveMuseSemanticCallLimit({ [MUSE_SEMANTIC_CALL_LIMIT_ENV]: '9' }),
    ).toBe(9);
    expect(() => resolveMuseTaskCallLimit({ [MUSE_TASK_CALL_LIMIT_ENV]: '0' })).toThrow(
      'MUSE_CALL_LIMIT_INVALID',
    );
    expect(() =>
      resolveMuseSemanticCallLimit({ [MUSE_SEMANTIC_CALL_LIMIT_ENV]: '51' }),
    ).toThrow('MUSE_CALL_LIMIT_INVALID');
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

  it('wraps an explicit Muse command in the liveness supervisor', () => {
    process.env[MUSE_COMMAND_ENV] = '/custom/bin/muse';
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    expect(provider.executePayload('/tmp/worktree', 'test goal')).toMatchObject({
      status: 0,
    });
    const launch = supervisedLaunch(runner);
    expect(supervisorConfig(launch).command).toBe('/custom/bin/muse');
  });

  it('dedupes semantic sessions for the same prompt and HEAD but allows new HEAD evidence', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const payload = 'Review semantic convergence evidence for REQ-1.';
    expect(provider.executePayload('/tmp/worktree', payload)).toMatchObject({ status: 0 });
    const before = runner.calls.filter((call) => call.command === process.execPath).length;
    const duplicate = provider.executePayload('/tmp/worktree', payload);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('MUSE_DUPLICATE_SEMANTIC_EVIDENCE_BLOCKED');
    expect(runner.calls.filter((call) => call.command === process.execPath)).toHaveLength(before);
    runner.setHead('d'.repeat(40));
    expect(provider.executePayload('/tmp/worktree', payload)).toMatchObject({ status: 0 });
  });

  it('runs semantic task payloads through bounded supervised Muse', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const taskBinding = binding();
    const payload = provider.generatePayload(taskBinding);
    expect(payload).toContain(
      '/tmp/Chain Sieve/.worktrees/T-G0-MUSE-01/.agents/skills/chainsieve-task/SKILL.md',
    );
    expect(payload).toContain('exactly one clean atomic implementation commit');
    expect(payload).toContain('Do not run any ChainSieve lifecycle command');
    expect(payload).toContain('Never ask the human owner');
    expect(provider.executePayload(taskBinding.taskWorkspace, payload)).toMatchObject({
      status: 0,
    });
    const launch = supervisedLaunch(runner);
    const config = supervisorConfig(launch);
    expect(config.command).toBe('muse');
    expect(config.args).toContain('--headless');
    expect(config.args).toContain('--approve-all');
    expect(config.args?.join(' ')).toContain('T-G0-MUSE-01');
    expect(config.taskId).toBe('T-G0-MUSE-01');
    expect(config.baseCommit).toBe(taskBinding.baseCommit);
    expect(config.hardTimeoutMilliseconds).toBe(DEFAULT_MUSE_HARD_TIMEOUT_MS);
  });

  it('blocks the same task receipt only when workspace evidence is unchanged', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    const first = binding();
    provider.executePayload(first.taskWorkspace, provider.generatePayload(first));
    const before = runner.calls.filter((call) => call.command === process.execPath).length;
    const duplicate = binding();
    const blocked = provider.executePayload(
      duplicate.taskWorkspace,
      provider.generatePayload(duplicate),
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('MUSE_DUPLICATE_TASK_EVIDENCE_BLOCKED');
    expect(runner.calls.filter((call) => call.command === process.execPath)).toHaveLength(before);

    runner.setHead('e'.repeat(40));
    const changed = binding();
    expect(
      provider.executePayload(changed.taskWorkspace, provider.generatePayload(changed)),
    ).toMatchObject({ status: 0 });
    expect(runner.calls.filter((call) => call.command === process.execPath)).toHaveLength(
      before + 1,
    );
  });

  it('blocks task sessions after the configured Muse budget is exhausted', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    process.env[MUSE_TASK_CALL_LIMIT_ENV] = '2';
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    for (const receipt of ['muse-receipt-1', 'muse-receipt-2']) {
      const item = binding();
      item.launchReceiptId = receipt;
      expect(
        provider.executePayload(item.taskWorkspace, provider.generatePayload(item)),
      ).toMatchObject({ status: 0 });
    }
    const blocked = binding();
    blocked.launchReceiptId = 'muse-receipt-3';
    const result = provider.executePayload(
      blocked.taskWorkspace,
      provider.generatePayload(blocked),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MUSE_TASK_CALL_BUDGET_EXHAUSTED');
  });

  it('routes cluster and product-convergence CI repair to Antigravity when agy is available', () => {
    const runner = new Runner();
    const provider = new MuseProvider(runner);
    for (const payload of [
      'You are isolated CI repair session session-1. Inspect failed checks and leave changes uncommitted.',
      'The product-convergence pull request failed CI checks: Tier 0. Reproduce the failing behavior locally and repair it.',
      'Recovery PR CI failed: Tier 0. Repair only the existing recovery implementation.',
    ]) {
      expect(provider.executePayload('/tmp/worktree', payload)).toMatchObject({ status: 0 });
      expect(runner.calls.at(-1)!.command).toBe('agy');
    }
  });

  it('routes mechanical recovery diagnosis to Antigravity but keeps convergence diagnosis on supervised Muse', () => {
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
    expect(supervisorConfig(supervisedLaunch(runner)).command).toBe('muse');
  });

  it('falls back to supervised Muse for maintenance work when agy is unavailable', () => {
    process.env[MUSE_ARGS_ENV] =
      '["--headless","--goal","{prompt}","--approve-all"]';
    process.env[MUSE_PERMISSION_ENV] = 'preapproved';
    const runner = new NoAntigravityRunner();
    const provider = new MuseProvider(runner);
    provider.executePayload(
      '/tmp/worktree',
      'Recovery PR CI failed: Tier 0. Repair only the existing recovery implementation.',
    );
    expect(supervisorConfig(supervisedLaunch(runner)).command).toBe('muse');
  });
});

describe('Muse liveness policy', () => {
  it('uses bounded defaults and validates overrides', () => {
    expect(resolveMuseSupervision({}).hardTimeoutMilliseconds).toBe(
      DEFAULT_MUSE_HARD_TIMEOUT_MS,
    );
    expect(
      resolveMuseSupervision({
        [MUSE_HARD_TIMEOUT_ENV]: String(20 * 60_000),
        [MUSE_RETRY_STORM_LIMIT_ENV]: '5',
      }),
    ).toMatchObject({
      hardTimeoutMilliseconds: 20 * 60_000,
      retryStormLimit: 5,
    });
    expect(() =>
      resolveMuseSupervision({ [MUSE_HARD_TIMEOUT_ENV]: '1000' }),
    ).toThrow('MUSE_SUPERVISION_CONFIG_INVALID');
  });

  it('recognizes retry storms and durable lifecycle checkpoints', () => {
    expect(museOutputIsRetrySignal('muse: retrying meta model stream')).toBe(true);
    expect(museOutputIsRetrySignal('normal implementation progress')).toBe(false);
    expect(museLifecycleIsDurableCheckpoint('SELF_REVIEWING')).toBe(true);
    expect(museLifecycleIsDurableCheckpoint('MERGED')).toBe(true);
    expect(museLifecycleIsDurableCheckpoint('IMPLEMENTING')).toBe(false);
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

  it('keeps implementation and semantic review on Muse while routing mechanical CI prompts', () => {
    expect(
      shouldRouteMusePayloadToMaintenance(
        'Implement task T-1 from its immutable contract.',
      ),
    ).toBe(false);
    expect(
      shouldRouteMusePayloadToMaintenance(
        'Independent review session 1. Review frozen product commit and return PASS or FAIL.',
      ),
    ).toBe(false);
    expect(
      shouldRouteMusePayloadToMaintenance(
        'You are isolated CI repair session session-1. Inspect failed checks.',
      ),
    ).toBe(true);
  });
});
