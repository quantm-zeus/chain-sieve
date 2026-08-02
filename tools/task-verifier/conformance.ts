import { builtinModules } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import { readTrustedFile } from '../agent/lib/trusted-path.js';
import {
  materializeVerificationTarget,
  resolveTrustedVerificationRuntime,
  runTrustedVitest,
  runTrustedVitestInMaterializedTarget,
} from './trusted-execution.js';

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
  evidenceDeclarationPath?: string;
}

type MutationEvidenceDeclaration =
  | {
      schemaVersion: '1.0.0';
      taskId: string;
      mechanism: 'ACTUAL_MUTATION';
      target: string;
      operator: 'ARITHMETIC_PLUS_TO_MINUS';
      testPath: string;
      expectedFailurePattern: string;
      affectedExport: string;
      originalText: string;
    }
  | {
      schemaVersion: '1.0.0';
      taskId: string;
      mechanism: 'SEEDED_FAULT';
      target: string;
      faultId: string;
      testPath: string;
    };

export interface ExecutableMutationEvidence {
  mechanism: 'ACTUAL_MUTATION' | 'SEEDED_FAULT';
  target: string;
  testPath: string;
  declarationSha256: string;
  mutantIdentity?: string;
  operator?: string;
  command: string;
  exitCode: number;
  outputSha256: string;
  controlCommand?: string;
  controlExitCode?: number;
  controlOutputSha256?: string;
  mutantCommand?: string;
  mutantExitCode?: number;
  mutantOutputSha256?: string;
  originalSourceSha256?: string;
  mutatedSourceSha256?: string;
  originalNodeKind?: string;
  originalText?: string;
  mutatedText?: string;
  targetSourceRange?: { start: number; end: number };
  affectedProductionExport?: string;
  faultId?: string;
  activationEvidenceSha256?: string;
  assertionEvidenceSha256?: string;
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
  mutationTargets: string[];
}

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const frameworkModules = new Set([
  'vitest',
  '@jest/globals',
  'jest',
  'node:test',
]);
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
  const text = (
    await readTrustedFile(
      cwd,
      task.conformanceManifestPath,
      'CONFORMANCE_MANIFEST',
    )
  ).toString('utf8');
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
  manifestRoot = cwd,
): Promise<void> => {
  const manifest = await readConformanceManifest(task, manifestRoot);
  if (!manifest) return;
  for (const path of changedPaths)
    if (manifest.protectedPaths.some((pattern) => covers(pattern, path)))
      throw new Error(`IMMUTABLE_CONFORMANCE_ORACLE_CHANGED:${path}`);
};

const rootIdentifier = (
  expression: ts.Expression,
): ts.Identifier | undefined => {
  if (ts.isIdentifier(expression)) return expression;
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  )
    return rootIdentifier(expression.expression);
  if (ts.isCallExpression(expression))
    return rootIdentifier(expression.expression);
  return undefined;
};
const contains = (
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): boolean => {
  if (predicate(node)) return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found && contains(child, predicate)) found = true;
  });
  return found;
};
const propertyNamesAbove = (node: ts.Node): string[] => {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  for (
    let index = 0;
    current && index < 5;
    index += 1, current = current.parent
  ) {
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
  const file = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
  };
  const imports = new Map<
    string,
    { module: string; resolved?: string; typeOnly: boolean }
  >();
  const importedModules = new Set<string>();
  const resolvedModulePaths = new Set<string>();
  const mockedModules = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const module = statement.moduleSpecifier.text;
    importedModules.add(module);
    const resolvedModule = ts.resolveModuleName(
      module,
      absolute,
      compilerOptions,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    const resolvedPath = resolvedModule
      ? relative(cwd, resolvedModule).replaceAll('\\', '/')
      : undefined;
    if (resolvedPath) resolvedModulePaths.add(resolvedPath);
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name)
      imports.set(clause.name.text, {
        module,
        ...(resolvedPath ? { resolved: resolvedPath } : {}),
        typeOnly: clause.isTypeOnly,
      });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        imports.set(element.name.text, {
          module,
          ...(resolvedPath ? { resolved: resolvedPath } : {}),
          typeOnly: clause.isTypeOnly || element.isTypeOnly,
        });
    if (bindings && ts.isNamespaceImport(bindings))
      imports.set(bindings.name.text, {
        module,
        ...(resolvedPath ? { resolved: resolvedPath } : {}),
        typeOnly: clause.isTypeOnly,
      });
  }
  const visitMocks = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['vi', 'jest'].includes(rootIdentifier(node.expression)?.text ?? '') &&
      node.expression.name.text === 'mock'
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument))
        mockedModules.add(argument.text);
    }
    node.forEachChild(visitMocks);
  };
  visitMocks(file);
  const production = new Set(
    [...imports]
      .filter(([, value]) => {
        if (
          value.typeOnly ||
          frameworkModules.has(value.module) ||
          builtins.has(value.module) ||
          !value.resolved
        )
          return false;
        return productionTargets.some((target) =>
          covers(target, value.resolved!),
        );
      })
      .map(([name]) => name),
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
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      contains(node.initializer, isProductionCall)
    )
      productionVariables.add(node.name.text);
    node.forEachChild(collectVariables);
  };
  collectVariables(file);
  let assertions = 0;
  let negativePaths = 0;
  const visit = (node: ts.Node): void => {
    if (isProductionCall(node)) {
      const root = rootIdentifier((node as ts.CallExpression).expression);
      if (root) mutationTargets.add(root.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'expect'
    ) {
      const argument = node.arguments[0];
      const consumes = Boolean(
        argument &&
        contains(
          argument,
          (candidate) =>
            isProductionCall(candidate) ||
            (ts.isIdentifier(candidate) &&
              productionVariables.has(candidate.text)),
        ),
      );
      if (consumes) {
        assertions += 1;
        const names = propertyNamesAbove(node);
        if (
          names.some((name) =>
            ['toThrow', 'toThrowError', 'rejects'].includes(name),
          ) ||
          (argument &&
            (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)))
        )
          negativePaths += 1;
      }
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
    mutationTargets: [...mutationTargets].sort(),
  };
};

const readEvidenceDeclaration = async (
  task: TaskContract,
  cwd: string,
  manifest: ConformanceManifest,
): Promise<{ value: MutationEvidenceDeclaration; sha256: string }> => {
  const path =
    manifest.evidenceDeclarationPath ??
    `tests/task-facets/${task.id}.conformance-evidence.json`;
  let text: string;
  try {
    text = (
      await readTrustedFile(cwd, path, 'CONFORMANCE_EVIDENCE_DECLARATION')
    ).toString('utf8');
  } catch (error) {
    throw new Error(
      `CONFORMANCE_HIGH_RISK_EXECUTABLE_FAULT_GATE_MISSING:${task.id}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = JSON.parse(text) as MutationEvidenceDeclaration;
  if (value.schemaVersion !== '1.0.0' || value.taskId !== task.id)
    throw new Error(`CONFORMANCE_EVIDENCE_DECLARATION_INVALID:${task.id}`);
  if (!manifest.taskOwnedTests.includes(value.testPath))
    throw new Error(`CONFORMANCE_EVIDENCE_TEST_NOT_OWNED:${value.testPath}`);
  if (
    !manifest.productionTargets.some((target) => covers(target, value.target))
  )
    throw new Error(
      `CONFORMANCE_EVIDENCE_TARGET_NOT_PRODUCTION:${value.target}`,
    );
  return { value, sha256: sha256(text) };
};

const runActualMutation = async (
  declaration: Extract<
    MutationEvidenceDeclaration,
    { mechanism: 'ACTUAL_MUTATION' }
  >,
  declarationSha256: string,
  cwd: string,
  trustedControlPlaneRoot: string,
  productionTargets: string[],
): Promise<ExecutableMutationEvidence> => {
  if (!declaration.expectedFailurePattern)
    throw new Error('CONFORMANCE_MUTATION_EXPECTED_FAILURE_MISSING');
  if (!declaration.affectedExport || !declaration.originalText)
    throw new Error('CONFORMANCE_MUTATION_TARGET_BINDING_MISSING');
  const runtime = resolveTrustedVerificationRuntime(trustedControlPlaneRoot);
  const workspaceAliases = Object.fromEntries(
    (
      await Promise.all(
        [
          ...new Set(
            productionTargets
              .filter((path) => path.startsWith('packages/'))
              .map((path) => path.split('/').slice(0, 2).join('/')),
          ),
        ].map(async (packagePath) => {
          let manifest: { name?: string; exports?: string };
          try {
            manifest = JSON.parse(
              await readFile(
                join(trustedControlPlaneRoot, packagePath, 'package.json'),
                'utf8',
              ),
            ) as { name?: string; exports?: string };
          } catch {
            return undefined;
          }
          if (
            !manifest.name ||
            !manifest.exports ||
            !manifest.exports.startsWith('./') ||
            manifest.exports.includes('..')
          )
            throw new Error(`TRUSTED_WORKSPACE_ALIAS_INVALID:${packagePath}`);
          return [manifest.name, join(packagePath, manifest.exports)] as const;
        }),
      )
    ).filter((item): item is readonly [string, string] => Boolean(item)),
  );
  const materialized = materializeVerificationTarget(runtime, cwd, {
    approvedInputs: [...productionTargets, declaration.testPath],
  });
  const isolated = materialized.root;
  try {
    const target = join(isolated, declaration.target);
    const original = await readFile(target, 'utf8');
    const originalSha256 = sha256(original);
    const sourceFile = ts.createSourceFile(
      target,
      original,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const exportedAncestor = (node: ts.Node): string | undefined => {
      let current: ts.Node | undefined = node;
      while (current) {
        if (
          ts.isFunctionDeclaration(current) &&
          current.name &&
          current.modifiers?.some(
            (item) => item.kind === ts.SyntaxKind.ExportKeyword,
          )
        )
          return current.name.text;
        if (
          ts.isVariableDeclaration(current) &&
          ts.isIdentifier(current.name)
        ) {
          const statement = current.parent.parent;
          if (
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some(
              (item) => item.kind === ts.SyntaxKind.ExportKeyword,
            )
          )
            return current.name.text;
        }
        current = current.parent;
      }
      return undefined;
    };
    const candidates: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        node.getText(sourceFile) === declaration.originalText &&
        exportedAncestor(node) === declaration.affectedExport
      )
        candidates.push(node);
      node.forEachChild(visit);
    };
    visit(sourceFile);
    if (candidates.length === 0)
      throw new Error(
        `CONFORMANCE_MUTATION_TARGET_UNREACHABLE:${declaration.target}:${declaration.affectedExport}`,
      );
    if (candidates.length !== 1)
      throw new Error(
        `CONFORMANCE_MUTATION_TARGET_AMBIGUOUS:${declaration.target}:${declaration.affectedExport}`,
      );
    const mutationNode = candidates[0]!;
    const operatorStart = mutationNode.operatorToken.getStart(sourceFile);
    const operatorEnd = mutationNode.operatorToken.getEnd();
    const mutated = `${original.slice(0, operatorStart)}-${original.slice(operatorEnd)}`;
    const mutatedText = `${mutationNode.left.getText(sourceFile)} - ${mutationNode.right.getText(sourceFile)}`;
    if (mutated === original)
      throw new Error(
        `CONFORMANCE_MUTATION_OPERATOR_NOT_APPLICABLE:${declaration.target}`,
      );

    const testSource = await readFile(
      join(isolated, declaration.testPath),
      'utf8',
    );
    const testFile = ts.createSourceFile(
      declaration.testPath,
      testSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const importedNames = new Set<string>();
    for (const statement of testFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const resolved = ts.resolveModuleName(
        statement.moduleSpecifier.text,
        join(isolated, declaration.testPath),
        {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          module: ts.ModuleKind.ESNext,
          allowImportingTsExtensions: true,
        },
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (
        !resolved ||
        relative(isolated, resolved).replaceAll('\\', '/') !==
          declaration.target
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === declaration.affectedExport)
            importedNames.add(element.name.text);
        }
      if (
        statement.importClause?.name &&
        declaration.affectedExport === 'default'
      )
        importedNames.add(statement.importClause.name.text);
    }
    let outputAssertionObserved = false;
    const productionVariables = new Set<string>();
    const isAffectedCall = (node: ts.Node): boolean =>
      ts.isCallExpression(node) &&
      Boolean(
        rootIdentifier(node.expression) &&
        importedNames.has(rootIdentifier(node.expression)!.text),
      );
    const collectProductionVariables = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        contains(node.initializer, isAffectedCall)
      )
        productionVariables.add(node.name.text);
      node.forEachChild(collectProductionVariables);
    };
    collectProductionVariables(testFile);
    const findOutputAssertion = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'expect'
      ) {
        const argument = node.arguments[0];
        if (
          argument &&
          contains(
            argument,
            (candidate) =>
              isAffectedCall(candidate) ||
              (ts.isIdentifier(candidate) &&
                productionVariables.has(candidate.text)),
          )
        )
          outputAssertionObserved = true;
      }
      node.forEachChild(findOutputAssertion);
    };
    findOutputAssertion(testFile);
    if (!outputAssertionObserved)
      throw new Error(
        `CONFORMANCE_MUTATION_NOT_BEHAVIORALLY_OBSERVED:${declaration.affectedExport}`,
      );

    const control = runTrustedVitestInMaterializedTarget(
      runtime,
      isolated,
      [declaration.testPath],
      { workspaceAliases },
    );
    if (control.exitCode !== 0)
      throw new Error(
        `CONFORMANCE_MUTATION_CONTROL_FAILED:${declaration.testPath}`,
      );
    await writeFile(target, mutated);
    if (sha256(await readFile(target)) !== sha256(mutated))
      throw new Error(
        `CONFORMANCE_MUTATION_MATERIALIZATION_MISMATCH:${declaration.target}`,
      );
    const mutant = runTrustedVitestInMaterializedTarget(
      runtime,
      isolated,
      [declaration.testPath],
      { workspaceAliases },
    );
    await writeFile(target, original);
    if (sha256(await readFile(target)) !== originalSha256)
      throw new Error(
        `CONFORMANCE_MUTATION_CONTROL_NOT_RESTORED:${declaration.target}`,
      );
    if (control.command !== mutant.command)
      throw new Error('MUTATION_CONTROL_ENVIRONMENT_MISMATCH');
    if (mutant.exitCode === 0)
      throw new Error(
        `CONFORMANCE_MUTATION_NOT_BEHAVIORALLY_OBSERVED:${declaration.target}`,
      );
    if (!mutant.output.includes(declaration.expectedFailurePattern))
      throw new Error(
        `CONFORMANCE_MUTANT_FAILED_FOR_WRONG_REASON:${declaration.target}`,
      );
    return {
      mechanism: 'ACTUAL_MUTATION',
      target: declaration.target,
      testPath: declaration.testPath,
      declarationSha256,
      mutantIdentity: sha256(mutated),
      operator: declaration.operator,
      command: mutant.command,
      exitCode: mutant.exitCode,
      outputSha256: mutant.outputSha256,
      controlCommand: control.command,
      controlExitCode: control.exitCode,
      controlOutputSha256: control.outputSha256,
      mutantCommand: mutant.command,
      mutantExitCode: mutant.exitCode,
      mutantOutputSha256: mutant.outputSha256,
      originalSourceSha256: originalSha256,
      mutatedSourceSha256: sha256(mutated),
      originalNodeKind: ts.SyntaxKind[mutationNode.kind],
      originalText: mutationNode.getText(sourceFile),
      mutatedText,
      targetSourceRange: {
        start: mutationNode.getStart(sourceFile),
        end: mutationNode.getEnd(),
      },
      affectedProductionExport: declaration.affectedExport,
    };
  } finally {
    materialized.cleanup();
  }
};

const runSeededFault = async (
  declaration: Extract<
    MutationEvidenceDeclaration,
    { mechanism: 'SEEDED_FAULT' }
  >,
  declarationSha256: string,
  cwd: string,
  trustedControlPlaneRoot: string,
): Promise<ExecutableMutationEvidence> => {
  if (!declaration.faultId)
    throw new Error('CONFORMANCE_SEEDED_FAULT_ID_MISSING');
  const source = (
    await readTrustedFile(
      cwd,
      declaration.testPath,
      'CONFORMANCE_SEEDED_FAULT_TEST',
    )
  ).toString('utf8');
  const file = ts.createSourceFile(
    declaration.testPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const absoluteTest = join(cwd, declaration.testPath);
  const targetIdentifiers = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const resolved = ts.resolveModuleName(
      statement.moduleSpecifier.text,
      absoluteTest,
      {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        allowImportingTsExtensions: true,
      },
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (
      !resolved ||
      relative(cwd, resolved).replaceAll('\\', '/') !== declaration.target
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        targetIdentifiers.add(element.name.text);
    if (bindings && ts.isNamespaceImport(bindings))
      targetIdentifiers.add(bindings.name.text);
    if (statement.importClause?.name)
      targetIdentifiers.add(statement.importClause.name.text);
  }
  const calls = new Map<
    string,
    { activated: boolean; node: ts.CallExpression }
  >();
  const collectCalls = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const owner = rootIdentifier(node.initializer.expression)?.text;
      if (owner && targetIdentifiers.has(owner))
        calls.set(node.name.text, {
          activated: node.initializer.arguments.some(
            (argument) =>
              ts.isStringLiteral(argument) &&
              argument.text === declaration.faultId,
          ),
          node: node.initializer,
        });
    }
    node.forEachChild(collectCalls);
  };
  collectCalls(file);
  let activation: ts.CallExpression | undefined;
  let assertion: ts.CallExpression | undefined;
  for (const call of calls.values()) if (call.activated) activation = call.node;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toBe' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'not'
    ) {
      const expectCall = (() => {
        let expression: ts.Expression = node.expression.expression;
        while (ts.isPropertyAccessExpression(expression))
          expression = expression.expression;
        return ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'expect'
          ? expression
          : undefined;
      })();
      const left = expectCall?.arguments[0];
      const right = node.arguments[0];
      if (left && right && ts.isIdentifier(left) && ts.isIdentifier(right)) {
        const leftCall = calls.get(left.text);
        const rightCall = calls.get(right.text);
        if (leftCall && rightCall && leftCall.activated !== rightCall.activated)
          assertion = node;
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  if (!activation)
    throw new Error(
      `CONFORMANCE_SEEDED_FAULT_NOT_ACTIVATED:${declaration.faultId}`,
    );
  if (!assertion)
    throw new Error(
      `CONFORMANCE_SEEDED_FAULT_DIFFERENCE_NOT_ASSERTED:${declaration.faultId}`,
    );
  const runtime = resolveTrustedVerificationRuntime(trustedControlPlaneRoot);
  const result = runTrustedVitest(runtime, cwd, [declaration.testPath]);
  if (result.exitCode !== 0)
    throw new Error(
      `CONFORMANCE_SEEDED_FAULT_TEST_FAILED:${declaration.faultId}`,
    );
  return {
    mechanism: 'SEEDED_FAULT',
    target: declaration.target,
    testPath: declaration.testPath,
    declarationSha256,
    command: result.command,
    exitCode: result.exitCode,
    outputSha256: result.outputSha256,
    faultId: declaration.faultId,
    activationEvidenceSha256: sha256(activation.getText(file)),
    assertionEvidenceSha256: sha256(assertion.getText(file)),
  };
};

export const assertConformanceTestQuality = async (
  task: TaskContract,
  cwd = process.cwd(),
  manifestRoot = cwd,
  trustedControlPlaneRoot = process.cwd(),
): Promise<ExecutableMutationEvidence[]> => {
  const manifest = await readConformanceManifest(task, manifestRoot);
  if (!manifest) return [];
  if (manifest.taskOwnedTests.length === 0)
    throw new Error(`CONFORMANCE_TASK_TESTS_MISSING:${task.id}`);
  const analyses = await Promise.all(
    manifest.taskOwnedTests.map(async (path) =>
      analyzeTestBehavior(
        await readFile(join(cwd, path), 'utf8'),
        path,
        cwd,
        manifest.productionTargets,
      ),
    ),
  );
  for (const analysis of analyses) {
    if (analysis.invokedProductionIdentifiers.length === 0)
      throw new Error(
        `CONFORMANCE_PRODUCTION_BEHAVIOR_NOT_INVOKED:${analysis.path}`,
      );
    if (analysis.assertionsConsumingProductionOutputs === 0)
      throw new Error(
        `CONFORMANCE_PRODUCTION_OUTPUT_NOT_ASSERTED:${analysis.path}`,
      );
  }
  if (analyses.reduce((sum, item) => sum + item.negativePaths, 0) === 0)
    throw new Error(`CONFORMANCE_NEGATIVE_CASE_MISSING:${task.id}`);
  if (manifest.qualityGate !== 'SEEDED_FAULT_OR_PROPERTY') return [];
  const declaration = await readEvidenceDeclaration(task, cwd, manifest);
  return declaration.value.mechanism === 'ACTUAL_MUTATION'
    ? [
        await runActualMutation(
          declaration.value,
          declaration.sha256,
          cwd,
          trustedControlPlaneRoot,
          manifest.productionTargets,
        ),
      ]
    : [
        await runSeededFault(
          declaration.value,
          declaration.sha256,
          cwd,
          trustedControlPlaneRoot,
        ),
      ];
};
