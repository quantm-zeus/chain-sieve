import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { readTrustedFile } from '../agent/lib/trusted-path.js';

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

export interface TestBehaviorAnalysis {
  path: string;
  importedModules: string[];
  resolvedModulePaths: string[];
  importedIdentifiers: string[];
  productionIdentifiers: string[];
  mockedModules: string[];
  invokedProductionIdentifiers: string[];
  assertionsConsumingProductionOutputs: number;
  negativePaths: number;
  executableFaultChecks: number;
  mutationTargets: string[];
}

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const frameworkModules = new Set(['vitest', '@jest/globals', 'jest', 'node:test']);
const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : pattern === path;

export const readConformanceManifest = async (
  task: TaskContract,
  cwd = process.cwd(),
): Promise<ConformanceManifest | undefined> => {
  if (!task.conformanceManifestPath || !task.conformanceManifestSha256) return undefined;
  const text = (await readTrustedFile(cwd, task.conformanceManifestPath, 'CONFORMANCE_MANIFEST')).toString('utf8');
  if (sha256(text) !== task.conformanceManifestSha256)
    throw new Error(`CONFORMANCE_MANIFEST_HASH_MISMATCH:${task.id}`);
  const manifest = JSON.parse(text) as ConformanceManifest;
  if (manifest.schemaVersion !== '1.0.0' || manifest.taskId !== task.id || manifest.immutable !== true)
    throw new Error(`CONFORMANCE_MANIFEST_BINDING_MISMATCH:${task.id}`);
  return manifest;
};

export const assertConformanceProtection = async (
  task: TaskContract,
  changedPaths: string[],
  cwd = process.cwd(),
  manifestRoot = cwd,
): Promise<void> => {
  const manifest = await readConformanceManifest(task, manifestRoot);
  if (!manifest) return;
  for (const path of changedPaths)
    if (manifest.protectedPaths.some((pattern) => covers(pattern, path)))
      throw new Error(`IMMUTABLE_CONFORMANCE_ORACLE_CHANGED:${path}`);
};

const rootIdentifier = (expression: ts.Expression): ts.Identifier | undefined => {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    return rootIdentifier(expression.expression);
  if (ts.isCallExpression(expression)) return rootIdentifier(expression.expression);
  return undefined;
};
const contains = (node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean => {
  if (predicate(node)) return true;
  let found = false;
  node.forEachChild((child) => { if (!found && contains(child, predicate)) found = true; });
  return found;
};
const propertyNamesAbove = (node: ts.Node): string[] => {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  for (let index = 0; current && index < 5; index += 1, current = current.parent) {
    if (ts.isPropertyAccessExpression(current)) names.push(current.name.text);
  }
  return names;
};

export const analyzeTestBehavior = (
  source: string,
  path: string,
  cwd: string,
  productionTargets: string[],
): TestBehaviorAnalysis => {
  const absolute = join(cwd, path);
  const file = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const compilerOptions: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, allowImportingTsExtensions: true };
  const imports = new Map<string, { module: string; resolved?: string; typeOnly: boolean }>();
  const importedModules = new Set<string>();
  const resolvedModulePaths = new Set<string>();
  const mockedModules = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    importedModules.add(module);
    const resolvedModule = ts.resolveModuleName(module, absolute, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    const resolvedPath = resolvedModule ? relative(cwd, resolvedModule).replaceAll('\\', '/') : undefined;
    if (resolvedPath) resolvedModulePaths.add(resolvedPath);
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, { module, ...(resolvedPath ? { resolved: resolvedPath } : {}), typeOnly: clause.isTypeOnly });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        imports.set(element.name.text, { module, ...(resolvedPath ? { resolved: resolvedPath } : {}), typeOnly: clause.isTypeOnly || element.isTypeOnly });
    if (bindings && ts.isNamespaceImport(bindings))
      imports.set(bindings.name.text, { module, ...(resolvedPath ? { resolved: resolvedPath } : {}), typeOnly: clause.isTypeOnly });
  }
  const visitMocks = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['vi', 'jest'].includes(rootIdentifier(node.expression)?.text ?? '') && node.expression.name.text === 'mock') {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) mockedModules.add(argument.text);
    }
    node.forEachChild(visitMocks);
  };
  visitMocks(file);
  const production = new Set(
    [...imports].filter(([, value]) => {
      if (value.typeOnly || frameworkModules.has(value.module) || builtins.has(value.module) || !value.resolved) return false;
      return productionTargets.some((target) => covers(target, value.resolved!));
    }).map(([name]) => name),
  );
  const invoked = new Set<string>();
  const productionVariables = new Set<string>();
  const mutationTargets = new Set<string>();
  const isProductionCall = (node: ts.Node): boolean => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
    const identifier = rootIdentifier(node.expression);
    if (!identifier || !production.has(identifier.text)) return false;
    const imported = imports.get(identifier.text)!;
    if (mockedModules.has(imported.module)) return false;
    invoked.add(identifier.text);
    return true;
  };
  const collectVariables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && contains(node.initializer, isProductionCall))
      productionVariables.add(node.name.text);
    node.forEachChild(collectVariables);
  };
  collectVariables(file);
  let assertions = 0;
  let negativePaths = 0;
  let executableFaultChecks = 0;
  const visit = (node: ts.Node): void => {
    if (isProductionCall(node)) {
      const root = rootIdentifier((node as ts.CallExpression).expression);
      if (root) mutationTargets.add(root.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
      const argument = node.arguments[0];
      const consumes = Boolean(argument && contains(argument, (candidate) => isProductionCall(candidate) || (ts.isIdentifier(candidate) && productionVariables.has(candidate.text))));
      if (consumes) {
        assertions += 1;
        const names = propertyNamesAbove(node);
        if (names.some((name) => ['toThrow', 'toThrowError', 'rejects'].includes(name)) || (argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))))
          negativePaths += 1;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = rootIdentifier(node.expression)?.text;
      if (owner === 'fc' && node.expression.name.text === 'assert' && contains(node, isProductionCall)) executableFaultChecks += 1;
      if (production.has(owner ?? '') && /fault|mutat|seed/i.test(node.expression.name.text)) executableFaultChecks += 1;
    }
    node.forEachChild(visit);
  };
  visit(file);
  return {
    path,
    importedModules: [...importedModules].sort(),
    resolvedModulePaths: [...resolvedModulePaths].sort(),
    importedIdentifiers: [...imports.keys()].sort(),
    productionIdentifiers: [...production].sort(),
    mockedModules: [...mockedModules].sort(),
    invokedProductionIdentifiers: [...invoked].sort(),
    assertionsConsumingProductionOutputs: assertions,
    negativePaths,
    executableFaultChecks,
    mutationTargets: [...mutationTargets].sort(),
  };
};

export const assertConformanceTestQuality = async (
  task: TaskContract,
  cwd = process.cwd(),
  manifestRoot = cwd,
): Promise<void> => {
  const manifest = await readConformanceManifest(task, manifestRoot);
  if (!manifest) return;
  if (manifest.taskOwnedTests.length === 0) throw new Error(`CONFORMANCE_TASK_TESTS_MISSING:${task.id}`);
  const analyses = await Promise.all(manifest.taskOwnedTests.map(async (path) =>
    analyzeTestBehavior(await readFile(join(cwd, path), 'utf8'), path, cwd, manifest.productionTargets),
  ));
  for (const analysis of analyses) {
    if (analysis.invokedProductionIdentifiers.length === 0)
      throw new Error(`CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED:${analysis.path}`);
    if (analysis.assertionsConsumingProductionOutputs === 0)
      throw new Error(`CONFORMANCE_PRODUCTION_OUTPUT_NOT_ASSERTED:${analysis.path}`);
  }
  if (analyses.reduce((sum, item) => sum + item.negativePaths, 0) === 0)
    throw new Error(`CONFORMANCE_NEGATIVE_CASE_MISSING:${task.id}`);
  if (manifest.qualityGate === 'SEEDED_FAULT_OR_PROPERTY' && analyses.reduce((sum, item) => sum + item.executableFaultChecks, 0) === 0)
    throw new Error(`CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING:${task.id}`);
};
