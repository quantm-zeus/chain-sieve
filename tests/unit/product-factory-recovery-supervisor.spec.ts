import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitCommonDirectory } from '../../tools/agent/lib/runtime.js';
import type {
  AgentProvider,
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../../tools/agent/lib/types.js';
import {
  diagnoseSupervisorRecovery,
  extractSupervisorRecoveryDiagnosis,
  isTransientExternalBlocker,
  parseSupervisorRecoveryDiagnosis,
  readSupervisorRecoveryState,
  recoveryLanesForAction,
  runSupervisedProductFactory,
  verifyAndRepairRecoveryPatch,
  writeSupervisorRecoveryState,
} from '../../tools/product-factory/recovery-supervisor.js';
import {
  computeFailureFingerprint,
  pathMatchesLane,
} from '../../tools/product-factory/recovery-contract.js';

const ok = (stdout = ''): CommandResult => ({
  status: 0,
  stdout,
  stderr: '',
});

class RuntimeRunner implements CommandRunner {
  constructor(
    private readonly root: string,
    private readonly customGitCommonDir?: string,
  ) {}

  run(command: string, args: string[], _options?: CommandOptions): CommandResult {
    const key = `${command} ${args.join(' ')}`;
    if (command === 'which') return ok('/usr/bin/muse\n');
    if (key === 'git branch --show-current') return ok('main\n');
    if (key === 'node --version') return ok('v22.23.1\n');
    if (key === 'pnpm --version') return ok('10.13.1\n');
    if (key === 'muse --version') return ok('muse-code beta\n');
    if (key === 'muse --help') return ok('Muse Code help\n');
    if (key.startsWith('gh api repos/')) return ok('true\n');
    if (command === 'pnpm' && args[0] === 'autopilot' && args.length === 1) {
      return { status: 1, stdout: '', stderr: 'RELEASE_BASELINE_NOT_FOUND' };
    }
    if (command !== 'git') return ok();
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return ok(`${this.customGitCommonDir ?? '.git'}\n`);
    }
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
      const diagnosisExists = existsSync(join(cwd, '.chainsieve-recovery-diagnosis.json'));
      const museExists = existsSync(join(cwd, 'tools/agent/providers/muse.ts'));
      const lines: string[] = [];
      if (diagnosisExists) lines.push('?? .chainsieve-recovery-diagnosis.json');
      if (museExists) lines.push('?? tools/agent/providers/muse.ts');
      return ok(lines.length ? lines.join('\n') + '\n' : '');
    }
    return ok();
  }
}

const providerWriting = (
  value: unknown,
  calls: { count: number },
  extraFile?: string,
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
    if (extraFile) {
      const extraPath = join(workspace, extraFile);
      mkdirSync(dirname(extraPath), { recursive: true });
      writeFileSync(extraPath, 'illegal modification\n');
    }
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

  it('rejects recovery diagnosis that modifies control-plane files like tools/agent/providers/muse.ts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-scope-test-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const calls = { count: 0 };
    try {
      await expect(
        diagnoseSupervisorRecovery(
          root,
          new RuntimeRunner(root),
          providerWriting(
            {
              action: 'REPAIR',
              reason: 'attempting illegal provider modification',
              evidence: [],
              target: 'T-99',
              constraints: [],
              allowedLanes: ['PRODUCT_CODE'],
            },
            calls,
            'tools/agent/providers/muse.ts',
          ),
          {
            code: 'AUTOPILOT_CORRECTION_LIMIT',
            targetId: 'commit',
            hash: 'AUTOPILOT_CORRECTION_LIMIT:commit:scope',
          },
          'deadbeef',
          'AUTOPILOT_CORRECTION_LIMIT:T-99:3',
        ),
      ).rejects.toThrow('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_SCOPE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('succeeds via stdout JSON transport when 0 git files are modified in diagnosis worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-stdout-test-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const calls = { count: 0 };
    const providerStdout: AgentProvider = {
      id: 'antigravity',
      detect: () => ({ available: true, mechanism: 'command', detail: 'test' }),
      generatePayload: () => '',
      copyPayload: () => undefined,
      openWorkspace: () => undefined,
      renderOwnerInstruction: () => '',
      executePayload: () => {
        calls.count += 1;
        return {
          status: 0,
          stdout: `Agent analysis completed.\n\`\`\`json\n${JSON.stringify({
            action: 'REPAIR',
            reason: 'stdout structured diagnosis',
            evidence: ['test failure'],
            target: 'T-G0-COL-01',
            constraints: ['keep PRD authority'],
            allowedLanes: ['PRODUCT_CODE', 'TEST'],
          })}\n\`\`\`\n`,
          stderr: '',
        };
      },
    };
    try {
      const diagnosis = await diagnoseSupervisorRecovery(
        root,
        new RuntimeRunner(root),
        providerStdout,
        {
          code: 'AUTOPILOT_CORRECTION_LIMIT',
          targetId: 'commit',
          hash: 'AUTOPILOT_CORRECTION_LIMIT:commit:stdout',
        },
        'deadbeef',
        'AUTOPILOT_CORRECTION_LIMIT:T-G0-COL-01:3',
      );
      expect(calls.count).toBe(1);
      expect(diagnosis.action).toBe('REPAIR');
      expect(diagnosis.reason).toBe('stdout structured diagnosis');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts diagnosis from file content, raw stdout, markdown block, or embedded JSON substring', () => {
    const validObj = {
      action: 'REPAIR',
      reason: 'test reason',
      evidence: ['ev'],
      target: 'T-1',
      constraints: ['c'],
      allowedLanes: ['PRODUCT_CODE'],
    };
    const jsonStr = JSON.stringify(validObj);

    // 1. File content precedence
    expect(extractSupervisorRecoveryDiagnosis('some text', jsonStr).action).toBe('REPAIR');

    // 2. Pure JSON stdout
    expect(extractSupervisorRecoveryDiagnosis(`  ${jsonStr}\n`).reason).toBe('test reason');

    // 3. Markdown JSON block
    expect(extractSupervisorRecoveryDiagnosis(`Here is response:\n\`\`\`json\n${jsonStr}\n\`\`\``).target).toBe('T-1');

    // 4. Embedded JSON object
    expect(extractSupervisorRecoveryDiagnosis(`Leading note ${jsonStr} Trailing text`).action).toBe('REPAIR');

    // 5. Invalid throws
    expect(() => extractSupervisorRecoveryDiagnosis('no json at all')).toThrow('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
    expect(() => extractSupervisorRecoveryDiagnosis('{"action":"INVALID"}')).toThrow('PRODUCT_FACTORY_RECOVERY_DIAGNOSIS_INVALID');
  });

  it('repairs recovery patch when initial deterministic check fails and succeeds on repair round', () => {
    const workspace = '/tmp/test-recovery-workspace';
    let checkAttempts = 0;
    let agentRepairCalls = 0;

    class FailingCheckRunner implements CommandRunner {
      run(command: string, args: string[]): CommandResult {
        if (command === 'git' && args[0] === 'status') {
          return ok(' M apps/collector/src/registry.ts\n');
        }
        if (command === 'pnpm') {
          checkAttempts += 1;
          if (checkAttempts === 1) {
            return {
              status: 1,
              stdout: '',
              stderr: 'apps/collector/src/registry.ts(30,18): error TS2345: Property finality is missing',
            };
          }
          return ok();
        }
        return ok();
      }
    }

    const provider: AgentProvider = {
      id: 'antigravity',
      detect: () => ({ available: true, mechanism: 'command', detail: 'test' }),
      generatePayload: () => '',
      copyPayload: () => undefined,
      openWorkspace: () => undefined,
      renderOwnerInstruction: () => '',
      executePayload: () => {
        agentRepairCalls += 1;
        return ok();
      },
    };

    const paths = verifyAndRepairRecoveryPatch(
      new FailingCheckRunner(),
      provider,
      workspace,
      ['PRODUCT_CODE'],
    );

    expect(agentRepairCalls).toBe(1);
    expect(paths).toEqual(['apps/collector/src/registry.ts']);
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

  it('strictly rejects tools/agent/providers/muse.ts across all recovery lanes', () => {
    const lanes = [
      'PRODUCT_CODE',
      'TEST',
      'DEPENDENCY',
      'MIGRATION',
      'CONFIG',
      'SPECIFICATION',
      'GENERATED_CONTRACT',
      'INFRASTRUCTURE',
    ] as const;
    for (const lane of lanes) {
      expect(pathMatchesLane('tools/agent/providers/muse.ts', lane)).toBe(false);
    }
  });
});

describe('product factory recovery supervisor durable state & attempt bounds (Requirements G, H)', () => {
  it('correctly resolves git common dir for both absolute and relative mock outputs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-common-dir-'));
    const realGitDir = join(tempDir, '.git');
    mkdirSync(realGitDir, { recursive: true });
    try {
      const runnerRel = new RuntimeRunner(tempDir, '.git');
      const runnerAbs = new RuntimeRunner(tempDir, realGitDir);
      expect(gitCommonDirectory(tempDir, runnerRel)).toBe(realGitDir);
      expect(gitCommonDirectory(tempDir, runnerAbs)).toBe(realGitDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('atomically replaces durable recovery state and leaves no temp file behind with relative git common dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-state-rel-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    const runner = new RuntimeRunner(root, '.git');
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

  it('atomically replaces durable recovery state and leaves no temp file behind with absolute git common dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-state-abs-'));
    const absGit = join(root, '.git');
    mkdirSync(absGit, { recursive: true });
    const runner = new RuntimeRunner(root, absGit);
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
      const runtime = join(absGit, 'ciag-runtime', 'agent');
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
    const root = await mkdtemp(join(tmpdir(), 'chainsieve-supervisor-max-attempts-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    for (const dir of ['config', 'docs/spec', 'tasks', 'clusters', 'artifacts']) {
      if (existsSync(join(process.cwd(), dir))) {
        cpSync(join(process.cwd(), dir), join(root, dir), { recursive: true });
      }
    }
    const commit = 'ab68083ee116665c40e804447fa2e0cd87be1ccf';
    const runner = new RuntimeRunner(root);
    const fp = computeFailureFingerprint(
      'RELEASE_BASELINE_NOT_FOUND',
      commit,
      ['RELEASE_BASELINE_NOT_FOUND'],
    );
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
