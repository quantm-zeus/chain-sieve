import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentProvider,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  computeFailureFingerprint,
  diagnoseSupervisorRecovery,
  isTransientExternalBlocker,
  parseSupervisorRecoveryDiagnosis,
  readSupervisorRecoveryState,
  recoveryLanesForAction,
  runSupervisedProductFactory,
  writeSupervisorRecoveryState,
} from '../../tools/product-factory/recovery-supervisor.js';

const ok = (stdout = ''): CommandResult => ({
  status: 0,
  stdout,
  stderr: '',
});

class RuntimeRunner implements CommandRunner {
  constructor(private readonly root: string) {}

  run(command: string, args: string[], _options?: CommandOptions): CommandResult {
    const key = `${command} ${args.join(' ')}`;
    if (command === 'which') return ok('/usr/bin/muse\n');
    if (key === 'git branch --show-current') return ok('main\n');
    if (key === 'node --version') return ok('v22.23.1\n');
    if (key === 'pnpm --version') return ok('10.13.1\n');
    if (key === 'muse --version') return ok('muse-code beta\n');
    if (key === 'muse --help') return ok('Muse Code help\n');
    if (key.startsWith('gh api repos/')) return ok('true\n');
    if (key.startsWith('pnpm --silent autopilot')) return { status: 1, stdout: '', stderr: 'PRODUCT_FACTORY_CHECK_FAILED:autopilot' };
    if (command !== 'git') return ok();
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok('.git\n');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('ab68083ee116665c40e804447fa2e0cd87be1ccf\n');
    if (args[0] === 'worktree' && args[1] === 'add') {
      const workspace = args[3];
      if (!workspace) return { status: 1, stdout: '', stderr: 'workspace missing' };
      mkdirSync(workspace, { recursive: true });
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'remove') return ok();
    if (args[0] === 'status') {
      const cwd = _options?.cwd ?? this.root;
      return existsSync(join(cwd, '.chainsieve-recovery-diagnosis.json'))
        ? ok('?? .chainsieve-recovery-diagnosis.json\n')
        : ok();
    }
    return ok();
  }
}

const providerWriting = (
  value: unknown,
  calls: { count: number },
): AgentProvider => ({
  id: 'muse',
  detect: () => ({ available: true, mechanism: 'command', detail: 'test' }),
  generatePayload: () => '',
  copyPayload: () => undefined,
  openWorkspace: () => undefined,
  renderOwnerInstruction: () => '',
  executePayload: (workspace) => {
    calls.count += 1;
    writeFileSync(
      join(workspace, '.chainsieve-recovery-diagnosis.json'),
      `${JSON.stringify(value)}\n`,
    );
    return ok();
  },
});

describe('product factory recovery supervisor diagnosis', () => {
  it('requires a strict structured diagnosis', () => {
    expect(
      parseSupervisorRecoveryDiagnosis({
        action: 'REPAIR',
        reason: 'task correction exhausted on a deterministic test failure',
        evidence: ['unit test X fails'],
        target: 'T-42',
        constraints: ['preserve immutable PRD'],
        allowedLanes: ['PRODUCT_CODE', 'TEST'],
      }).action,
    ).toBe('REPAIR');

    expect(() =>
      parseSupervisorRecoveryDiagnosis({
        action: 'DO_ANYTHING',
        reason: 'bad',
        evidence: [],
        target: 'x',
        constraints: [],
        allowedLanes: [],
      }),
    ).toThrow('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
  });

  it('actually invokes the provider in a fresh detached diagnosis workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-diagnosis-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const calls = { count: 0 };
    try {
      const diagnosis = await diagnoseSupervisorRecovery(
        root,
        new RuntimeRunner(root),
        providerWriting(
          {
            action: 'REPAIR',
            reason: 'bounded correction exhausted',
            evidence: ['failure evidence'],
            target: 'T-99',
            constraints: ['no normative drift'],
            allowedLanes: ['PRODUCT_CODE', 'TEST'],
          },
          calls,
        ),
        {
          code: 'AUTOPILOT_CORRECTION_LIMIT',
          targetId: 'commit',
          hash: 'AUTOPILOT_CORRECTION_LIMIT:commit:abc',
        },
        'deadbeef',
        'AUTOPILOT_CORRECTION_LIMIT:T-99:3',
      );
      expect(calls.count).toBe(1);
      expect(diagnosis.action).toBe('REPAIR');
      expect(diagnosis.target).toBe('T-99');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('product factory recovery supervisor policy & authority (Requirements D, E)', () => {
  it('retries transient infrastructure failures but fails closed for permanent blockers', () => {
    expect(isTransientExternalBlocker('PRODUCT_FACTORY_GITHUB_FAILED:temporary 502')).toBe(true);
    expect(isTransientExternalBlocker('PRODUCT_FACTORY_CI_TIMEOUT:https://example.test')).toBe(true);
    expect(isTransientExternalBlocker('PRODUCT_FACTORY_PR_CLOSED:https://example.test')).toBe(false);
    expect(isTransientExternalBlocker('GITHUB_AUTH_FAILED')).toBe(false);
  });

  it('narrows requested lanes to the authority of each recovery action and strips forbidden lanes (Requirement E)', () => {
    expect(
      recoveryLanesForAction('REPAIR', [
        'PRODUCT_CODE',
        'TEST',
        'SPECIFICATION',
        'INFRASTRUCTURE',
      ]),
    ).toEqual(['PRODUCT_CODE', 'TEST']);
    expect(recoveryLanesForAction('SPLIT_TASK', ['PRODUCT_CODE', 'GENERATED_CONTRACT'])).toEqual([
      'GENERATED_CONTRACT',
    ]);
    expect(recoveryLanesForAction('RETRY_INFRASTRUCTURE', ['PRODUCT_CODE'])).toEqual([]);
  });
});

describe('product factory recovery supervisor durable state & attempt bounds (Requirements G, H)', () => {
  it('atomically replaces durable recovery state and leaves no temp file behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-state-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const runner = new RuntimeRunner(root);
    try {
      await writeSupervisorRecoveryState(root, runner, {
        schemaVersion: '1.0.0',
        records: {
          fp: {
            fingerprint: 'fp',
            attempts: 1,
            lastCommit: 'abc',
            lastAction: 'REPAIR',
            lastReason: 'test',
            updatedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      });
      const restored = await readSupervisorRecoveryState(root, runner);
      expect(restored.records.fp?.attempts).toBe(1);
      const runtime = join(root, '.git', 'ciag-runtime', 'agent');
      expect(
        readdirSync(runtime).filter((name) => name.includes('product-factory-supervisor-recovery.json.') && name.endsWith('.tmp')),
      ).toEqual([]);
      expect(
        JSON.parse(
          await readFile(join(runtime, 'product-factory-supervisor-recovery.json'), 'utf8'),
        ).schemaVersion,
      ).toBe('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounces same fingerprint when max attempts are reached without invoking model (Requirement H)', async () => {
    const root = process.cwd();
    const commit = 'ab68083ee116665c40e804447fa2e0cd87be1ccf';
    const runner = new RuntimeRunner(root);
    const fp = computeFailureFingerprint('PRODUCT_FACTORY_CHECK_FAILED', commit, ['autopilot']);
    const oldEnvArgs = process.env.CHAINSIEVE_MUSE_ARGS_JSON;
    const oldEnvPerm = process.env.CHAINSIEVE_MUSE_PERMISSION_MODE;
    process.env.CHAINSIEVE_MUSE_ARGS_JSON = JSON.stringify(['--non-interactive', '{prompt}']);
    process.env.CHAINSIEVE_MUSE_PERMISSION_MODE = 'preapproved';
    try {
      await writeSupervisorRecoveryState(root, runner, {
        schemaVersion: '1.0.0',
        records: {
          [fp.hash]: {
            fingerprint: fp.hash,
            attempts: 3,
            lastCommit: commit,
            lastAction: 'REPAIR',
            lastReason: 'already attempted 3 times',
            updatedAt: new Date().toISOString(),
          },
        },
      });

      await expect(
        runSupervisedProductFactory(root, runner, { providerId: 'muse' }),
      ).rejects.toThrow('PRODUCT_FACTORY_SUPERVISOR_RECOVERY_LIMIT');
    } finally {
      if (oldEnvArgs === undefined) delete process.env.CHAINSIEVE_MUSE_ARGS_JSON;
      else process.env.CHAINSIEVE_MUSE_ARGS_JSON = oldEnvArgs;
      if (oldEnvPerm === undefined) delete process.env.CHAINSIEVE_MUSE_PERMISSION_MODE;
      else process.env.CHAINSIEVE_MUSE_PERMISSION_MODE = oldEnvPerm;
    }
  });
});
