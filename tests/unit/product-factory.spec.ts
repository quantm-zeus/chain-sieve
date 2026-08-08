import { describe, expect, it } from 'vitest';
import {
  classifyAutonomyFailure,
  classifyGapLanes,
  classifyPathLane,
  computeFailureFingerprint,
  isProductCorrectionPath,
  parseConvergenceReport,
  pathMatchesLane,
} from '../../tools/product-factory/factory.js';

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

describe('product factory correction scope', () => {
  it('allows product, tests, and operational docs only', () => {
    expect(isProductCorrectionPath('apps/api/src/index.ts')).toBe(true);
    expect(isProductCorrectionPath('packages/domain/src/model.ts')).toBe(true);
    expect(isProductCorrectionPath('tests/system/product.spec.ts')).toBe(true);
    expect(isProductCorrectionPath('docs/operations/runbook.md')).toBe(true);
  });

  it('rejects normative and control-plane paths', () => {
    expect(isProductCorrectionPath('docs/spec/requirements.json')).toBe(false);
    expect(isProductCorrectionPath('tasks/G1/T-1.contract.json')).toBe(false);
    expect(isProductCorrectionPath('tools/autopilot/autopilot.ts')).toBe(false);
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
