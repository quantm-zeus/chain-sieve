import { describe, expect, it } from 'vitest';
import {
  isProductCorrectionPath,
  parseConvergenceReport,
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
