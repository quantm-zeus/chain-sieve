import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';

interface ConformanceManifest {
  schemaVersion: '1.0.0';
  taskId: string;
  immutable: true;
  taskOwnedTests: string[];
  productionTargets: string[];
  protectedPaths: string[];
  qualityGate: 'NEGATIVE_CASE' | 'SEEDED_FAULT_OR_PROPERTY';
  rejectsTrivialAssertions: true;
  requiresChangedProductionBehaviorInvocation: true;
}

const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : pattern === path;

export const readConformanceManifest = async (
  task: TaskContract,
  cwd = process.cwd(),
): Promise<ConformanceManifest | undefined> => {
  if (!task.conformanceManifestPath || !task.conformanceManifestSha256)
    return undefined;
  const text = await readFile(join(cwd, task.conformanceManifestPath), 'utf8');
  if (sha256(text) !== task.conformanceManifestSha256)
    throw new Error(`CONFORMANCE_MANIFEST_HASH_MISMATCH:${task.id}`);
  const manifest = JSON.parse(text) as ConformanceManifest;
  if (
    manifest.schemaVersion !== '1.0.0' ||
    manifest.taskId !== task.id ||
    manifest.immutable !== true
  )
    throw new Error(`CONFORMANCE_MANIFEST_BINDING_MISMATCH:${task.id}`);
  return manifest;
};

export const assertConformanceProtection = async (
  task: TaskContract,
  changedPaths: string[],
  cwd = process.cwd(),
): Promise<void> => {
  const manifest = await readConformanceManifest(task, cwd);
  if (!manifest) return;
  for (const path of changedPaths)
    if (manifest.protectedPaths.some((pattern) => covers(pattern, path)))
      throw new Error(`IMMUTABLE_CONFORMANCE_ORACLE_CHANGED:${path}`);
};

const importedIdentifiers = (source: string): string[] =>
  [...source.matchAll(/import\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_$][\w$]*))\s+from\s+['"][^'"]+['"]/g)]
    .flatMap((match) =>
      match[1]
        ? match[1].split(',').map((value) => value.trim().split(/\s+as\s+/).at(-1)!)
        : [match[2]!],
    )
    .filter(Boolean);

export const assertConformanceTestQuality = async (
  task: TaskContract,
  cwd = process.cwd(),
): Promise<void> => {
  const manifest = await readConformanceManifest(task, cwd);
  if (!manifest) return;
  const sources = await Promise.all(
    manifest.taskOwnedTests.map(async (path) => ({
      path,
      source: await readFile(join(cwd, path), 'utf8'),
    })),
  );
  if (sources.length === 0) throw new Error(`CONFORMANCE_TASK_TESTS_MISSING:${task.id}`);
  for (const { path, source } of sources) {
    if (
      source.replace(/\s+/g, '').length < 120 ||
      /expect\((?:true|1|['"]PASS['"])\)\.to(?:Be|Equal)\((?:true|1|['"]PASS['"])/.test(source) ||
      !/\b(?:it|test)\s*\(/.test(source) ||
      !/\bexpect\s*\(/.test(source)
    )
      throw new Error(`WEAK_OR_TRIVIAL_TEST:${path}`);
  }
  const combined = sources.map((item) => item.source).join('\n');
  const invoked = uniqueImportedInvocations(combined);
  if (invoked.length === 0)
    throw new Error(`CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED:${task.id}`);
  const negative = sources
    .filter((item) => /negative|failure/i.test(item.path))
    .map((item) => item.source)
    .join('\n');
  if (!/\b(?:rejects|toThrow|not\.|error|invalid|unavailable|failure)\b/i.test(negative))
    throw new Error(`CONFORMANCE_NEGATIVE_CASE_MISSING:${task.id}`);
  if (
    manifest.qualityGate === 'SEEDED_FAULT_OR_PROPERTY' &&
    !/\b(?:fast-check|fc\.|seededFault|faultSeed|mutation|property\s*\()/.test(combined)
  )
    throw new Error(`CONFORMANCE_HIGH_RISK_QUALITY_GATE_MISSING:${task.id}`);
};

const uniqueImportedInvocations = (source: string): string[] => {
  const identifiers = importedIdentifiers(source);
  return [...new Set(identifiers)].filter((identifier) => {
    const occurrences = source.match(new RegExp(`\\b${identifier}\\b`, 'g'))?.length ?? 0;
    return occurrences > 1 && new RegExp(`\\b${identifier}\\s*(?:\\(|\\.|<)`).test(source);
  });
};
