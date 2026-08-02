import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskContractSchema } from '@ciag/shared-schemas';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import {
  assertConformanceProtection,
  assertConformanceTestQuality,
} from '../../tools/task-verifier/conformance.js';

const fixture = async (
  source: string,
  qualityGate:
    'NEGATIVE_CASE' | 'SEEDED_FAULT_OR_PROPERTY' = 'SEEDED_FAULT_OR_PROPERTY',
  evidence?: Record<string, unknown>,
  productionSource = "export const executeThing = (value: number, faultId?: 'FAULT_ADD_TWO'): number => { if (value < 0) throw new Error('invalid'); return faultId === 'FAULT_ADD_TWO' ? value + 2 : value + 1; }; export const mutationFault = (value: number): number => executeThing(value); export const seededFault = (value: number): number => executeThing(value); export const acquireLifecycleMutationLock = (value: number): number => executeThing(value); export type ProductionType = { value: number };\n",
  productionTargets = ['packages/x/**'],
  configure?: (root: string) => Promise<void>,
) => {
  const root = mkdtempSync(join(tmpdir(), 'conformance-quality-'));
  const manifestPath = 'artifacts/conformance/T-G0-X/manifest.json';
  const tests = [
    'tests/task-facets/T-G0-X.spec.ts',
    'tests/task-facets/T-G0-X.negative.spec.ts',
  ];
  const manifest = `${JSON.stringify({ schemaVersion: '1.0.0', taskId: 'T-G0-X', immutable: true, taskOwnedTests: tests, productionTargets, protectedPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'], qualityGate, rejectsTrivialAssertions: true, requiresChangedProductionBehaviorInvocation: true }, null, 2)}\n`;
  const task = TaskContractSchema.parse({
    schemaVersion: '1.0.0',
    id: 'T-G0-X',
    title: 'x',
    sourceHashes: {
      prd: 'a'.repeat(64),
      requirements: 'b'.repeat(64),
      audit: 'c'.repeat(64),
    },
    dependencyGroup: 'G0',
    cluster: 'C-G0-X',
    riskLevel: qualityGate === 'SEEDED_FAULT_OR_PROPERTY' ? 'HIGH' : 'MEDIUM',
    autonomyLevel: 'REVIEW_REQUIRED',
    dependencies: [],
    requirements: ['FR-X-001'],
    acceptanceCriteria: [],
    taskAcceptanceFacets: [
      {
        acceptanceId: 'AC-X',
        facetId: 'AC-X:T-G0-X:INTERFACE_FACET',
        text: 'facet',
        sourceAcceptanceSha256: 'd'.repeat(64),
      },
    ],
    invariants: ['INV-001'],
    adrs: ['ADR-001'],
    ownerPackages: ['packages/x'],
    readSet: [],
    writeSet: ['packages/x/**'],
    allowedPaths: ['packages/x/**', 'tests/task-facets/**'],
    forbiddenPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'],
    exclusiveLocks: ['x'],
    interfaceHashes: { x: 'e'.repeat(64) },
    deliverables: ['x'],
    constraints: ['x'],
    nonGoals: ['x'],
    degradedBehavior: 'x',
    rollback: 'x',
    requiredTests: tests,
    verificationCommands: [{ command: 'pnpm test', expected: 'pass' }],
    complexityBudget: {
      maxFiles: 1,
      maxChangedLines: 1,
      maxCyclomaticComplexity: 1,
    },
    changeBudget: {
      maxMigrations: 0,
      maxPublicInterfaces: 1,
      requiresSplitAboveBudget: true,
    },
    stopConditions: ['x'],
    completionDefinition: ['x'],
    sourceReferences: [{ path: 'x', line: 1, id: 'FR-X-001' }],
    specificationStatus: 'READY',
    conformanceManifestPath: manifestPath,
    conformanceManifestSha256: sha256(manifest),
    testQualityGate: qualityGate,
  });
  await mkdir(join(root, 'artifacts/conformance/T-G0-X'), { recursive: true });
  await mkdir(join(root, 'tests/task-facets'), { recursive: true });
  await mkdir(join(root, 'packages/x'), { recursive: true });
  await writeFile(join(root, 'packages/x/index.ts'), productionSource);
  await writeFile(join(root, manifestPath), manifest);
  await Promise.all(tests.map((path) => writeFile(join(root, path), source)));
  await configure?.(root);
  if (evidence)
    await writeFile(
      join(root, 'tests/task-facets/T-G0-X.conformance-evidence.json'),
      `${JSON.stringify({ schemaVersion: '1.0.0', taskId: 'T-G0-X', ...evidence }, null, 2)}\n`,
    );
  return { root, task };
};

const actualMutation = (
  expectedFailurePattern: string,
  affectedExport = 'executeThing',
  originalText = 'value + 1',
) => ({
  mechanism: 'ACTUAL_MUTATION',
  target: 'packages/x/index.ts',
  operator: 'ARITHMETIC_PLUS_TO_MINUS',
  testPath: 'tests/task-facets/T-G0-X.spec.ts',
  expectedFailurePattern,
  affectedExport,
  originalText,
});

describe('immutable conformance test-quality gate', () => {
  it('rejects trivial tests that never invoke production behavior', async () => {
    const trivialAssertion = 'expect(' + '2).toBe(2)';
    const { root, task } = await fixture(
      `import { describe, expect, it } from 'vitest';\ndescribe('x',()=>it('x',()=>${trivialAssertion}));\n`,
    );
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED',
    );
  });

  it('runs and kills a deterministic mutant for production, negative, and property coverage', async () => {
    const source =
      "import { describe, expect, it } from 'vitest';\nimport { executeThing } from '../../packages/x/index.js';\ndescribe('contract property', () => { it('checks seeded values', () => { for (const value of [0, 1, 2, 100]) expect(executeThing(value)).toBe(value + 1); }); it('negative failure', () => { expect(() => executeThing(-1)).toThrow(); }); });\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('expected -1 to be 1'),
    );
    const evidence = await assertConformanceTestQuality(task, root);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      mechanism: 'ACTUAL_MUTATION',
      operator: 'ARITHMETIC_PLUS_TO_MINUS',
    });
    expect(evidence[0]!.exitCode).not.toBe(0);
    expect(evidence[0]).toMatchObject({
      controlExitCode: 0,
      affectedProductionExport: 'executeThing',
      originalNodeKind: 'BinaryExpression',
      originalText: 'value + 1',
      mutatedText: 'value - 1',
    });
    expect(evidence[0]!.originalSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence[0]!.mutatedSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence[0]!.targetSourceRange).toMatchObject({
      start: expect.any(Number),
      end: expect.any(Number),
    });
  });

  it('runs mutation controls against materialized workspace package entries', async () => {
    const source =
      "import { describe, expect, it } from 'vitest'; import { workspaceOnlyValue } from '@ciag/evidence'; import { executeThing } from '../../packages/x/index.js'; describe('workspace control', () => { it('observes the mutant', () => expect(executeThing(workspaceOnlyValue)).toBe(2)); it('keeps a negative path', () => expect(() => executeThing(-1)).toThrow()); });\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('expected +0 to be 2'),
      undefined,
      ['packages/x/**', 'packages/evidence/**'],
      async (target) => {
        await mkdir(join(target, 'packages/evidence/src'), { recursive: true });
        await writeFile(
          join(target, 'packages/evidence/src/index.ts'),
          'export const workspaceOnlyValue = 1;\n',
        );
        await mkdir(join(target, 'node_modules/@ciag'), { recursive: true });
        await symlink(
          join(target, 'packages/evidence'),
          join(target, 'node_modules/@ciag/evidence'),
          'dir',
        );
      },
    );
    const evidence = await assertConformanceTestQuality(task, root);
    expect(evidence[0]).toMatchObject({
      controlExitCode: 0,
      mutantExitCode: 1,
    });
  });

  it('rejects a location-forged mutation kill that does not reach production output', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; it('forges a kill from the copied location',()=>{ if (import.meta.url.includes('ciag-mutant-')) throw new Error('LOCATION_ONLY_KILL'); expect(executeThing(3)).toBe(6); expect(()=>executeThing(-1)).toThrow(); });\n";
    const production =
      "export const executeThing = (value: number): number => { const unused = 1 + 1; void unused; if (value < 0) throw new Error('invalid'); return value * 2; };\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('LOCATION_ONLY_KILL', 'executeThing', '1 + 1'),
      production,
    );
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      'CONFORMANCE_MUTATION_NOT_BEHAVIORALLY_OBSERVED',
    );
  });

  it.each([
    [
      'process cwd',
      "if (process.cwd().includes('ciag-mutant-')) throw new Error('LOCATION_ONLY_KILL');",
    ],
    [
      'environment variable',
      "if (process.env.CIAG_MUTANT_ACTIVE) throw new Error('ENVIRONMENT_ONLY_KILL');",
    ],
    [
      'configuration file',
      "if (import.meta.url.endsWith('vitest.config.mutant.ts')) throw new Error('CONFIG_ONLY_KILL');",
    ],
  ])('rejects a %s-only mutation detector', async (_name, detector) => {
    const source = `import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; it('cannot detect mutation environment',()=>{ ${detector} expect(executeThing(3)).toBe(6); expect(()=>executeThing(-1)).toThrow(); });\n`;
    const production =
      "export const executeThing = (value: number): number => { const unused = value + 1; void unused; if (value < 0) throw new Error('invalid'); return value * 2; };\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('ONLY_KILL'),
      production,
    );
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      'CONFORMANCE_MUTATION_NOT_BEHAVIORALLY_OBSERVED',
    );
  });

  it('rejects an unreachable mutated expression', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; it('observes production',()=>{ expect(executeThing(3)).toBe(6); expect(()=>executeThing(-1)).toThrow(); });\n";
    const production =
      "export const unreachable = (value: number): number => value + 1; export const executeThing = (value: number): number => { if (value < 0) throw new Error('invalid'); return value * 2; };\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('failure', 'executeThing'),
      production,
    );
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      'CONFORMANCE_MUTATION_TARGET_UNREACHABLE',
    );
  });

  it('rejects a startup failure unrelated to a production assertion', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; throw new Error('UNRELATED_STARTUP'); it('observes production',()=>{ expect(executeThing(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('UNRELATED_STARTUP'),
    );
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      'CONFORMANCE_MUTATION_CONTROL_FAILED',
    );
  });

  it('protects immutable oracle paths from task commits', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { x } from '@ciag/x'; it('negative property',()=>expect(()=>x()).toThrow()); // fast-check\n";
    const { root, task } = await fixture(source);
    await expect(
      assertConformanceProtection(
        task,
        ['tests/conformance/task-oracle.spec.ts'],
        root,
      ),
    ).rejects.toThrow('IMMUTABLE_CONFORMANCE_ORACLE_CHANGED');
  });

  it.each([
    [
      'long Vitest-only test',
      "import { expect, it } from 'vitest';\nit('trivial', () => { const padding = 'x'.repeat(5000); expect(padding.length).toBe(5000); });\n",
      'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED',
    ],
    [
      'comment-only mutation claim',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; // mutation seededFault property\nit('negative',()=>expect(()=>executeThing(-1)).toThrow());\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'string-only negative claim',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('words',()=>expect(executeThing(1)).toBe(2)); const words = 'negative failure invalid';\n",
      'CONFORMANCE_NEGATIVE_CASE_MISSING',
    ],
    [
      'unused production import',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('unused',()=>expect(2).toBe(2));\n",
      'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED',
    ],
    [
      'type-only production import',
      "import { expect, it } from 'vitest'; import type { ProductionType } from '../../packages/x/index.js';\nit('type only',()=>{ const value: ProductionType = { value: 1 }; expect(value.value).toBe(1); });\n",
      'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED',
    ],
    [
      'fully mocked production module',
      "import { expect, it, vi } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; vi.mock('../../packages/x/index.js',()=>({executeThing:vi.fn(()=>2)}));\nit('mocked',()=>expect(executeThing(1)).toBe(2));\n",
      'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED',
    ],
    [
      'method named mutationFault with no mutation',
      "import { expect, it } from 'vitest'; import { mutationFault, executeThing } from '../../packages/x/index.js'; it('name only',()=>{ expect(mutationFault(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'method named seededFault with no activation',
      "import { expect, it } from 'vitest'; import { seededFault, executeThing } from '../../packages/x/index.js'; it('name only',()=>{ expect(seededFault(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'ordinary acquireLifecycleMutationLock invocation',
      "import { expect, it } from 'vitest'; import { acquireLifecycleMutationLock, executeThing } from '../../packages/x/index.js'; it('name only',()=>{ expect(acquireLifecycleMutationLock(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'comment claiming mutant killed',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; // mutant killed\nit('name only',()=>{ expect(executeThing(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'string containing mutation keywords',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; const claim = 'mutation fault seed killed'; it('name only',()=>{ expect(claim).toContain('mutation'); expect(executeThing(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
    [
      'normal wrapper with mutation-like name',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; const mutationWrapper = (value: number) => executeThing(value); it('name only',()=>{ expect(mutationWrapper(1)).toBe(2); expect(()=>executeThing(-1)).toThrow(); });\n",
      'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING',
    ],
  ])('rejects %s', async (_name, source, error) => {
    const { root, task } = await fixture(source);
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(
      error,
    );
  });

  it.each([
    [
      'real negative behavior',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('negative',()=>expect(()=>executeThing(-1)).toThrow('invalid'));\n",
      'NEGATIVE_CASE',
    ],
    [
      'real production invocation',
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('negative real output',()=>expect(()=>executeThing(-1)).toThrow());\n",
      'NEGATIVE_CASE',
    ],
  ] as const)('accepts %s', async (_name, source, gate) => {
    const { root, task } = await fixture(source, gate);
    await expect(assertConformanceTestQuality(task, root)).resolves.toEqual([]);
  });

  it('accepts a real registered seeded fault only when activation and differing behavior are asserted', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; it('activates registered fault',()=>{ const normal = executeThing(1); const faulty = executeThing(1, 'FAULT_ADD_TWO'); expect(faulty).not.toBe(normal); expect(()=>executeThing(-1)).toThrow(); });\n";
    const { root, task } = await fixture(source, 'SEEDED_FAULT_OR_PROPERTY', {
      mechanism: 'SEEDED_FAULT',
      target: 'packages/x/index.ts',
      faultId: 'FAULT_ADD_TWO',
      testPath: 'tests/task-facets/T-G0-X.spec.ts',
    });
    const evidence = await assertConformanceTestQuality(task, root);
    expect(evidence[0]).toMatchObject({
      mechanism: 'SEEDED_FAULT',
      faultId: 'FAULT_ADD_TWO',
      exitCode: 0,
    });
    expect(evidence[0]!.activationEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence[0]!.assertionEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a property test only after it finds the seeded mutant violation', async () => {
    const source =
      "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; it('property over deterministic seeds',()=>{ for (const value of [0, 1, 2, 3, 100]) expect(executeThing(value)).toBe(value + 1); expect(()=>executeThing(-1)).toThrow(); });\n";
    const { root, task } = await fixture(
      source,
      'SEEDED_FAULT_OR_PROPERTY',
      actualMutation('expected -1 to be 1'),
    );
    const evidence = await assertConformanceTestQuality(task, root);
    expect(evidence[0]).toMatchObject({
      mechanism: 'ACTUAL_MUTATION',
      target: 'packages/x/index.ts',
    });
  });
});
