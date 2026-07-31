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

const fixture = async (source: string) => {
  const root = mkdtempSync(join(tmpdir(), 'conformance-quality-'));
  const manifestPath = 'artifacts/conformance/T-G0-X/manifest.json';
  const tests = [
    'tests/task-facets/T-G0-X.spec.ts',
    'tests/task-facets/T-G0-X.negative.spec.ts',
  ];
  const manifest = `${JSON.stringify({ schemaVersion: '1.0.0', taskId: 'T-G0-X', immutable: true, taskOwnedTests: tests, productionTargets: ['packages/x/**'], protectedPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'], qualityGate: 'SEEDED_FAULT_OR_PROPERTY', rejectsTrivialAssertions: true, requiresChangedProductionBehaviorInvocation: true }, null, 2)}\n`;
  const task = TaskContractSchema.parse({
    schemaVersion: '1.0.0', id: 'T-G0-X', title: 'x', sourceHashes: { prd: 'a'.repeat(64), requirements: 'b'.repeat(64), audit: 'c'.repeat(64) }, dependencyGroup: 'G0', cluster: 'C-G0-X', riskLevel: 'HIGH', autonomyLevel: 'REVIEW_REQUIRED', dependencies: [], requirements: ['FR-X-001'], acceptanceCriteria: [], taskAcceptanceFacets: [{ acceptanceId: 'AC-X', facetId: 'AC-X:T-G0-X:INTERFACE_FACET', text: 'facet', sourceAcceptanceSha256: 'd'.repeat(64) }], invariants: ['INV-001'], adrs: ['ADR-001'], ownerPackages: ['packages/x'], readSet: [], writeSet: ['packages/x/**'], allowedPaths: ['packages/x/**', 'tests/task-facets/**'], forbiddenPaths: ['tests/conformance/**', 'artifacts/conformance/T-G0-X/**'], exclusiveLocks: ['x'], interfaceHashes: { x: 'e'.repeat(64) }, deliverables: ['x'], constraints: ['x'], nonGoals: ['x'], degradedBehavior: 'x', rollback: 'x', requiredTests: tests, verificationCommands: [{ command: 'pnpm test', expected: 'pass' }], complexityBudget: { maxFiles: 1, maxChangedLines: 1, maxCyclomaticComplexity: 1 }, changeBudget: { maxMigrations: 0, maxPublicInterfaces: 1, requiresSplitAboveBudget: true }, stopConditions: ['x'], completionDefinition: ['x'], sourceReferences: [{ path: 'x', line: 1, id: 'FR-X-001' }], specificationStatus: 'READY', conformanceManifestPath: manifestPath, conformanceManifestSha256: sha256(manifest), testQualityGate: 'SEEDED_FAULT_OR_PROPERTY' });
  await mkdir(join(root, 'artifacts/conformance/T-G0-X'), { recursive: true });
  await mkdir(join(root, 'tests/task-facets'), { recursive: true });
  await writeFile(join(root, manifestPath), manifest);
  await Promise.all(tests.map((path) => writeFile(join(root, path), source)));
  return { root, task };
};

describe('immutable conformance test-quality gate', () => {
  it('rejects trivial tests that never invoke production behavior', async () => {
    const { root, task } = await fixture("import { describe, expect, it } from 'vitest';\ndescribe('x',()=>it('x',()=>expect(2).toBe(2)));\n");
    await expect(assertConformanceTestQuality(task, root)).rejects.toThrow('WEAK_OR_TRIVIAL_TEST');
  });

  it('accepts production invocation plus negative and property/seeded-fault coverage', async () => {
    const source = "import { describe, expect, it } from 'vitest';\nimport { executeThing } from '@ciag/x';\nimport fc from 'fast-check';\ndescribe('contract property', () => { it('invokes production behavior', () => { fc.assert(fc.property(fc.integer(), (value) => { expect(executeThing(value)).toBeDefined(); })); }); it('negative failure', () => { expect(() => executeThing(-1)).toThrow(); }); });\n";
    const { root, task } = await fixture(source);
    await expect(assertConformanceTestQuality(task, root)).resolves.toBeUndefined();
  });

  it('protects immutable oracle paths from task commits', async () => {
    const source = "import { expect, it } from 'vitest'; import { x } from '@ciag/x'; it('negative property',()=>expect(()=>x()).toThrow()); // fast-check\n";
    const { root, task } = await fixture(source);
    await expect(assertConformanceProtection(task, ['tests/conformance/task-oracle.spec.ts'], root)).rejects.toThrow('IMMUTABLE_CONFORMANCE_ORACLE_CHANGED');
  });
});
