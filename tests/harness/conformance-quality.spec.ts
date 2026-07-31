import { mkdir, writeFile } from 'node:fs/promises';
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

const fixture = async (source: string, qualityGate: 'NEGATIVE_CASE' | 'SEEDED_FAULT_OR_PROPERTY' = 'SEEDED_FAULT_OR_PROPERTY') => {
  const root = mkdtempSync(join(tmpdir(), 'conformance-quality-'));
  const manifestPath = 'artifacts/conformance/T-G0-X/manifest.json';
  const tests = [
    'tests/task-facets/T-G0-X.spec.ts',
    'tests/task-facets/T-G0-X.negative.spec.ts',
  ];
  const manifest = `${JSON.stringify({ schemaVersion: '1.0.0', taskId: 'T-G0-X', immutable: true, taskOwnedTests: tests, productionTargets: ['packages/x/**'], protectedPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'], qualityGate, rejectsTrivialAssertions: true, requiresChangedProductionBehaviorInvocation: true }, null, 2)}\n`;
  const task = TaskContractSchema.parse({
    schemaVersion: '1.0.0', id: 'T-G0-X', title: 'x', sourceHashes: { prd: 'a'.repeat(64), requirements: 'b'.repeat(64), audit: 'c'.repeat(64) }, dependencyGroup: 'G0', cluster: 'C-G0-X', riskLevel: qualityGate === 'SEEDED_FAULT_OR_PROPERTY' ? 'HIGH' : 'MEDIUM', autonomyLevel: 'REVIEW_REQUIRED', dependencies: [], requirements: ['FR-X-001'], acceptanceCriteria: [], taskAcceptanceFacets: [{ acceptanceId: 'AC-X', facetId: 'AC-X:T-G0-X:INTERFACE_FACET', text: 'facet', sourceAcceptanceSha256: 'd'.repeat(64) }], invariants: ['INV-001'], adrs: ['ADR-001'], ownerPackages: ['packages/x'], readSet: [], writeSet: ['packages/x/**'], allowedPaths: ['packages/x/**', 'tests/task-facets/**'], forbiddenPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'], exclusiveLocks: ['x'], interfaceHashes: { x: 'e'.repeat(64) }, deliverables: ['x'], constraints: ['x'], nonGoals: ['x'], degradedBehavior: 'x', rollback: 'x', requiredTests: tests, verificationCommands: [{ command: 'pnpm test', expected: 'pass' }], complexityBudget: { maxFiles: 1, maxChangedLines: 1, maxCyclomaticComplexity: 1 }, changeBudget: { maxMigrations: 0, maxPublicInterfaces: 1, requiresSplitAboveBudget: true }, stopConditions: ['x'], completionDefinition: ['x'], sourceReferences: [{ path: 'x', line: 1, id: 'FR-X-001' }], specificationStatus: 'READY', conformanceManifestPath: manifestPath, conformanceManifestSha256: sha256(manifest), testQualityGate: qualityGate });
  await mkdir(join(root, 'artifacts/conformance/T-G0-X'), { recursive: true });
  await mkdir(join(root, 'tests/task-facets'), { recursive: true });
  await mkdir(join(root, 'packages/x'), { recursive: true });
  await writeFile(join(root, 'packages/x/index.ts'), "export const executeThing = (value: number): number => { if (value < 0) throw new Error('invalid'); return value + 1; }; export const mutationFault = (value: number): number => executeThing(value); export type ProductionType = { value: number };\n");
  await writeFile(join(root, manifestPath), manifest);
  await Promise.all(tests.map((path) => writeFile(join(root, path), source)));
  return { root, task };
};

describe('immutable conformance test-quality gate', () => {
  it('rejects trivial tests that never invoke production behavior', async () => {
    const trivialAssertion = 'expect(' + '2).toBe(2)';
    const { root, task } = await fixture(`import { describe, expect, it } from 'vitest';\ndescribe('x',()=>it('x',()=>${trivialAssertion}));\n`);
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow('CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED');
  });

  it('accepts production invocation plus negative and property/seeded-fault coverage', async () => {
    const source = "import { describe, expect, it } from 'vitest';\nimport { executeThing } from '../../packages/x/index.js';\nimport fc from 'fast-check';\ndescribe('contract property', () => { it('invokes production behavior', () => { fc.assert(fc.property(fc.integer(), (value) => { expect(executeThing(value)).toBeDefined(); })); }); it('negative failure', () => { expect(() => executeThing(-1)).toThrow(); }); });\n";
    const { root, task } = await fixture(source);
    await expect(assertConformanceTestQuality(task, root)).resolves.toBeUndefined();
  });

  it('protects immutable oracle paths from task commits', async () => {
    const source = "import { expect, it } from 'vitest'; import { x } from '@ciag/x'; it('negative property',()=>expect(()=>x()).toThrow()); // fast-check\n";
    const { root, task } = await fixture(source);
    await expect(assertConformanceProtection(task, ['tests/conformance/task-oracle.spec.ts'], root)).rejects.toThrow('IMMUTABLE_CONFORMANCE_ORACLE_CHANGED');
  });

  it.each([
    ['long Vitest-only test', "import { expect, it } from 'vitest';\nit('trivial', () => { const padding = 'x'.repeat(5000); expect(padding.length).toBe(5000); });\n", 'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED'],
    ['comment-only mutation claim', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; // mutation seededFault property\nit('negative',()=>expect(()=>executeThing(-1)).toThrow());\n", 'CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING'],
    ['string-only negative claim', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('words',()=>expect(executeThing(1)).toBe(2)); const words = 'negative failure invalid';\n", 'CONFORMANCE_NEGATIVE_CASE_MISSING'],
    ['unused production import', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('unused',()=>expect(2).toBe(2));\n", 'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED'],
    ['type-only production import', "import { expect, it } from 'vitest'; import type { ProductionType } from '../../packages/x/index.js';\nit('type only',()=>{ const value: ProductionType = { value: 1 }; expect(value.value).toBe(1); });\n", 'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED'],
    ['fully mocked production module', "import { expect, it, vi } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; vi.mock('../../packages/x/index.js',()=>({executeThing:vi.fn(()=>2)}));\nit('mocked',()=>expect(executeThing(1)).toBe(2));\n", 'CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED'],
  ])('rejects %s', async (_name, source, error) => {
    const { root, task } = await fixture(source);
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow(error);
  });

  it.each([
    ['real production invocation', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('negative real output',()=>expect(()=>executeThing(-1)).toThrow());\n", 'NEGATIVE_CASE'],
    ['real negative behavior', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js';\nit('negative',()=>expect(()=>executeThing(-1)).toThrow('invalid'));\n", 'NEGATIVE_CASE'],
    ['real seeded-fault detection', "import { expect, it } from 'vitest'; import { executeThing } from '../../packages/x/index.js'; import fc from 'fast-check';\nit('property and negative',()=>{ fc.assert(fc.property(fc.nat(), value => expect(executeThing(value)).toBe(value + 1))); expect(()=>executeThing(-1)).toThrow(); });\n", 'SEEDED_FAULT_OR_PROPERTY'],
    ['real mutation kill', "import { expect, it } from 'vitest'; import * as production from '../../packages/x/index.js';\nit('mutation and negative',()=>{ expect(production.mutationFault(1)).toBe(2); expect(()=>production.executeThing(-1)).toThrow(); });\n", 'SEEDED_FAULT_OR_PROPERTY'],
  ] as const)('accepts %s', async (_name, source, gate) => {
    const { root, task } = await fixture(source, gate);
    await expect(assertConformanceTestQuality(task, root)).resolves.toBeUndefined();
  });
});
