import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../tools/agent/lib/types.js';
import {
  classifyAutonomyFailure,
  classifyGapLanes,
  classifyPathLane,
  computeFailureFingerprint,
  isProductCorrectionPath,
  parseConvergenceReport,
  pathMatchesLane,
  runProductFactory,
} from '../../tools/product-factory/factory.js';
import { parsePorcelainLine } from '../../tools/product-factory/recovery-contract.js';

const ok = (stdout = ''): CommandResult => ({
  status: 0,
  stdout,
  stderr: '',
});

describe('product factory convergence contract', () => {
  it('accepts a commit-bound PASS report with no gaps', () => {
    expect(
      parseConvergenceReport(
        {
          schemaVersion: '1.0.0',
          status: 'PASS',
          productCommit: 'abc123',
          gaps: [],
          notes: ['all normative acceptance criteria have evidence'],
        },
        'abc123',
      ).status,
    ).toBe('PASS');
  });

  it('accepts concrete requirement-bound gaps', () => {
    const report = parseConvergenceReport(
      {
        schemaVersion: '1.0.0',
        status: 'GAPS',
        productCommit: 'abc123',
        gaps: [
          {
            requirementIds: ['REQ-42'],
            summary: 'recovery path is not implemented',
            evidence: ['no negative-path test exists'],
            suggestedPaths: ['packages/runtime/src/recovery.ts'],
          },
        ],
        notes: [],
      },
      'abc123',
    );
    expect(report.gaps[0]?.requirementIds).toEqual(['REQ-42']);
  });

  it('rejects PASS with hidden gaps, gap reports without IDs, and stale commits', () => {
    expect(() =>
      parseConvergenceReport({
        schemaVersion: '1.0.0',
        status: 'PASS',
        productCommit: 'abc123',
        gaps: [
          {
            requirementIds: ['REQ-1'],
            summary: 'hidden gap',
            evidence: [],
            suggestedPaths: [],
          },
        ],
        notes: [],
      }),
    ).toThrow('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');

    expect(() =>
      parseConvergenceReport({
        schemaVersion: '1.0.0',
        status: 'GAPS',
        productCommit: 'abc123',
        gaps: [
          {
            requirementIds: [],
            summary: 'unbound gap',
            evidence: [],
            suggestedPaths: [],
          },
        ],
        notes: [],
      }),
    ).toThrow('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');

    expect(() =>
      parseConvergenceReport(
        {
          schemaVersion: '1.0.0',
          status: 'PASS',
          productCommit: 'old',
          gaps: [],
          notes: [],
        },
        'new',
      ),
    ).toThrow('PRODUCT_FACTORY_CONVERGENCE_REPORT_INVALID');
  });
});

describe('product factory correction scope and control plane safety', () => {
  it('allows product, tests, and operational docs only', () => {
    expect(isProductCorrectionPath('apps/api/src/index.ts')).toBe(true);
    expect(isProductCorrectionPath('packages/domain/src/model.ts')).toBe(true);
    expect(isProductCorrectionPath('tests/system/product.spec.ts')).toBe(true);
    expect(isProductCorrectionPath('docs/operations/runbook.md')).toBe(true);
  });

  it('rejects normative and control-plane paths including tools/** and config/autonomy-policy.json', () => {
    expect(isProductCorrectionPath('docs/spec/requirements.json')).toBe(false);
    expect(isProductCorrectionPath('tasks/G1/T-1.contract.json')).toBe(false);
    expect(isProductCorrectionPath('tools/autopilot/autopilot.ts')).toBe(false);
    expect(isProductCorrectionPath('tools/product-factory/factory.ts')).toBe(false);
    expect(isProductCorrectionPath('.github/workflows/ci.yml')).toBe(false);
    expect(isProductCorrectionPath('config/autonomy-policy.json')).toBe(false);
    expect(isProductCorrectionPath('package.json')).toBe(false);
  });
});

describe('typed correction lanes and failure classification', () => {
  it('correctly classifies paths into appropriate typed correction lanes', () => {
    expect(classifyPathLane('package.json')).toBe('DEPENDENCY');
    expect(classifyPathLane('pnpm-lock.yaml')).toBe('DEPENDENCY');
    expect(classifyPathLane('drizzle/0001_init.sql')).toBe('MIGRATION');
    expect(classifyPathLane('tests/unit/foo.spec.ts')).toBe('TEST');
    expect(classifyPathLane('config/autonomy-policy.json')).toBe('CONFIG');
    expect(classifyPathLane('docs/spec/requirements.json')).toBe('SPECIFICATION');
    expect(classifyPathLane('tasks/G1/T-1.contract.json')).toBe('GENERATED_CONTRACT');
    expect(classifyPathLane('.github/workflows/ci.yml')).toBe('INFRASTRUCTURE');
    expect(classifyPathLane('apps/web/src/App.tsx')).toBe('PRODUCT_CODE');
  });

  it('matches paths against specific allowed correction lanes while maintaining forbidden path boundaries', () => {
    expect(pathMatchesLane('package.json', 'DEPENDENCY')).toBe(true);
    expect(pathMatchesLane('docs/spec/requirements.json', 'DEPENDENCY')).toBe(false);
    expect(pathMatchesLane('drizzle/0001_init.sql', 'MIGRATION')).toBe(true);
    expect(pathMatchesLane('apps/api/src/index.ts', 'MIGRATION')).toBe(false);
    expect(pathMatchesLane('tools/product-factory/factory.ts', 'PRODUCT_CODE')).toBe(false);
    expect(pathMatchesLane('config/autonomy-policy.json', 'CONFIG')).toBe(false);
  });

  it('classifies gap suggested paths into allowed lanes', () => {
    const gap = {
      requirementIds: ['REQ-100'],
      summary: 'missing dependency update',
      evidence: ['package.json missing dep'],
      suggestedPaths: ['package.json', 'apps/api/src/index.ts'],
    };
    const lanes = classifyGapLanes(gap);
    expect(lanes).toContain('DEPENDENCY');
    expect(lanes).toContain('PRODUCT_CODE');
  });

  it('computes deterministic failure fingerprints and classifies autonomy failure state types', () => {
    const fp1 = computeFailureFingerprint('PRODUCT_FACTORY_CONVERGENCE_LIMIT', 'commit-1', ['REQ-1', 'REQ-2']);
    const fp2 = computeFailureFingerprint('PRODUCT_FACTORY_CONVERGENCE_LIMIT', 'commit-1', ['REQ-2', 'REQ-1']);
    expect(fp1.hash).toBe(fp2.hash);

    expect(classifyAutonomyFailure('PRODUCT_FACTORY_COMPLETE')).toBe('SUCCESS');
    expect(classifyAutonomyFailure('AUTOPILOT_CORRECTION_LIMIT:T-1:3')).toBe('AUTO_RECOVERABLE');
    expect(classifyAutonomyFailure('AUTONOMOUS_MERGE_DISABLED')).toBe('SAFETY_TERMINAL');
    expect(classifyAutonomyFailure('PRODUCT_FACTORY_CI_TIMEOUT:https://github.com/...')).toBe('EXTERNAL_BLOCKER');
    expect(classifyAutonomyFailure('PRODUCT_FACTORY_CORRECTION_SCOPE:invalid/path')).toBe('AUTONOMY_GAP');
  });
});

describe('porcelain path parsing (Requirement F)', () => {
  it('exact extraction for tracked, staged, untracked, added, and renamed records without slicing errors', () => {
    expect(parsePorcelainLine(' M tools/product-factory/factory.ts')).toBe('tools/product-factory/factory.ts');
    expect(parsePorcelainLine('M  tools/product-factory/factory.ts')).toBe('tools/product-factory/factory.ts');
    expect(parsePorcelainLine('?? tools/product-factory/factory.ts')).toBe('tools/product-factory/factory.ts');
    expect(parsePorcelainLine('A  tools/product-factory/factory.ts')).toBe('tools/product-factory/factory.ts');
    expect(parsePorcelainLine('R  old.ts -> tools/product-factory/factory.ts')).toBe('tools/product-factory/factory.ts');
    expect(parsePorcelainLine(' M "tools/product-factory/factory.ts"')).toBe('tools/product-factory/factory.ts');
  });
});

describe('factory bubble-up & no legacy inner recovery loop (Requirements A, C)', () => {
  class DoctorPassingFailingRunner implements CommandRunner {
    run(command: string, args: string[]): CommandResult {
      const key = `${command} ${args.join(' ')}`;
      if (command === 'which') return ok('/usr/bin/muse\n');
      if (key === 'git branch --show-current') return ok('main\n');
      if (key === 'git status --porcelain=v1') return ok('');
      if (key === 'node --version') return ok('v22.23.1\n');
      if (key === 'pnpm --version') return ok('10.13.1\n');
      if (key === 'muse --version') return ok('muse-code beta\n');
      if (key === 'muse --help') return ok('Muse Code help\n');
      if (key.startsWith('gh api repos/')) return ok('true\n');
      if (command === 'git' && args[0] === 'rev-parse') return ok('deadbeef\n');
      if (command === 'pnpm' && args[0] === 'autopilot' && args.length === 1) {
        return { status: 1, stdout: '', stderr: 'AUTOPILOT_CORRECTION_LIMIT:T-1:3' };
      }
      return ok();
    }
  }

  it('runProductFactory throws failures directly upward without catching or diagnosing internally', async () => {
    const root = process.cwd();
    const oldEnvArgs = process.env.CHAINSIEVE_MUSE_ARGS_JSON;
    const oldEnvPerm = process.env.CHAINSIEVE_MUSE_PERMISSION_MODE;
    process.env.CHAINSIEVE_MUSE_ARGS_JSON = JSON.stringify(['--non-interactive', '{prompt}']);
    process.env.CHAINSIEVE_MUSE_PERMISSION_MODE = 'preapproved';
    try {
      const runner = new DoctorPassingFailingRunner();
      await expect(runProductFactory(root, runner, { providerId: 'muse' })).rejects.toThrow('RELEASE_BASELINE_NOT_FOUND');
    } finally {
      if (oldEnvArgs === undefined) delete process.env.CHAINSIEVE_MUSE_ARGS_JSON;
      else process.env.CHAINSIEVE_MUSE_ARGS_JSON = oldEnvArgs;
      if (oldEnvPerm === undefined) delete process.env.CHAINSIEVE_MUSE_PERMISSION_MODE;
      else process.env.CHAINSIEVE_MUSE_PERMISSION_MODE = oldEnvPerm;
    }
  });
});
