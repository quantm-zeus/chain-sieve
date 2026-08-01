import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { sha256 } from '../prd-compiler/compiler.js';

export type ResolutionClassification =
  | 'TRUSTED_RUNTIME'
  | 'TRUSTED_THIRD_PARTY_DEPENDENCY'
  | 'MATERIALIZED_TASK_SOURCE'
  | 'MATERIALIZED_TASK_TEST'
  | 'APPROVED_FIXTURE';

export interface ResolutionManifestEntry {
  importer: string;
  specifier: string;
  resolved: string;
  classification: ResolutionClassification;
}

export interface TrustedCommandEvidence {
  command: string;
  exitCode: number;
  output: string;
  outputSha256: string;
  resolutionManifest?: ResolutionManifestEntry[];
  resolutionManifestSha256?: string;
}

export interface TrustedVerificationRuntime {
  trustedRoot: string;
  trustedDependencyRoot: string;
  node: string;
  tsx: string;
  vitest: string;
  vitestConfig: string;
  environment: NodeJS.ProcessEnv;
}

export interface MaterializedVerificationTarget {
  root: string;
  approvedInputs: string[];
  cleanup: () => void;
}

export interface TrustedVitestOptions {
  approvedInputs?: string[];
  workspaceAliases?: Record<string, string>;
}

const contained = (root: string, target: string): boolean => {
  const suffix = relative(root, target);
  return (
    suffix === '' ||
    (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
};

const trustedFile = (
  root: string,
  candidate: string,
  label: string,
): string => {
  const path = realpathSync(candidate);
  if (!contained(root, path))
    throw new Error(`TRUSTED_EXECUTABLE_OUTSIDE_CONTROL_PLANE:${label}`);
  const info = lstatSync(path);
  if (!info.isFile())
    throw new Error(`TRUSTED_EXECUTABLE_NOT_REGULAR:${label}`);
  return path;
};

export const trustedVerificationEnvironment = (
  trustedRoot: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TERM',
    'CI',
  ])
    if (ambient[name]) environment[name] = ambient[name];
  environment.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  environment.NODE_PATH = '';
  environment.PNPM_HOME = '';
  environment.npm_config_prefix = '';
  environment.npm_config_userconfig = '/dev/null';
  environment.INIT_CWD = trustedRoot;
  environment.PWD = trustedRoot;
  environment.NODE_OPTIONS = '';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  return environment;
};

export const resolveTrustedVerificationRuntime = (
  trustedRoot: string,
  ambient: NodeJS.ProcessEnv = process.env,
): TrustedVerificationRuntime => {
  const canonicalRoot = realpathSync(resolve(trustedRoot));
  const nodeModules = realpathSync(join(canonicalRoot, 'node_modules'));
  return {
    trustedRoot: canonicalRoot,
    trustedDependencyRoot: nodeModules,
    node: realpathSync(process.execPath),
    tsx: trustedFile(
      nodeModules,
      join(canonicalRoot, 'node_modules/tsx/dist/cli.mjs'),
      'tsx',
    ),
    vitest: trustedFile(
      nodeModules,
      join(canonicalRoot, 'node_modules/vitest/vitest.mjs'),
      'vitest',
    ),
    vitestConfig: trustedFile(
      canonicalRoot,
      join(canonicalRoot, 'vitest.config.ts'),
      'vitest-config',
    ),
    environment: trustedVerificationEnvironment(canonicalRoot, ambient),
  };
};

const blockedDirectoryNames = new Set([
  '.git',
  'node_modules',
  '.pnpm',
  '.yarn',
  '.pnp',
  '.npm',
  '.cache',
  '.bin',
]);
const blockedFile = (path: string): boolean => {
  const name = path.split('/').at(-1) ?? '';
  return (
    name === 'package.json' ||
    /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.pnp\.)/.test(name) ||
    /^(?:vitest|vite)\.config\./.test(name) ||
    /^tsconfig(?:\..+)?\.json$/.test(name) ||
    /^(?:custom-)?loader\.(?:c?js|mjs|ts)$/.test(name)
  );
};
const covers = (pattern: string, path: string): boolean =>
  pattern.endsWith('/**')
    ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))
    : pattern === path;

export const materializeVerificationTarget = (
  runtime: TrustedVerificationRuntime,
  targetRoot: string,
  options: TrustedVitestOptions = {},
): MaterializedVerificationTarget => {
  const canonicalTarget = realpathSync(resolve(targetRoot));
  if (canonicalTarget === runtime.trustedRoot)
    throw new Error('TRUSTED_CONTROL_PLANE_MUST_NOT_BE_MATERIALIZED_AS_TASK');
  const root = mkdtempSync(join(tmpdir(), 'ciag-verification-target-'));
  const approvedInputs = options.approvedInputs ?? ['**'];
  const approved = (path: string): boolean =>
    approvedInputs.includes('**') ||
    approvedInputs.some((pattern) => covers(pattern, path));
  const copy = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && blockedDirectoryNames.has(entry.name))
        continue;
      if (blockedFile(path)) continue;
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`UNTRUSTED_VERIFICATION_SYMLINK:${path}`);
      if (entry.isDirectory()) {
        copy(source, path);
        continue;
      }
      if (!entry.isFile() || !approved(path)) continue;
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  };
  try {
    copy(canonicalTarget);
    symlinkSync(
      runtime.trustedDependencyRoot,
      join(root, 'node_modules'),
      'dir',
    );
    return {
      root,
      approvedInputs: [...approvedInputs],
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

const sourceFiles = (root: string): string[] => {
  const files: string[] = [];
  const walk = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.ciag-trusted')
        continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name))
        files.push(path);
    }
  };
  walk(root);
  return files.sort();
};

const classifyMaterializedPath = (
  root: string,
  resolvedPath: string,
  testFiles: Set<string>,
): ResolutionClassification => {
  const relativePath = relative(root, resolvedPath).replaceAll('\\', '/');
  if (
    testFiles.has(relativePath) ||
    (relativePath.startsWith('tests/') &&
      /\.spec\.[cm]?[jt]sx?$/.test(relativePath))
  )
    return 'MATERIALIZED_TASK_TEST';
  if (relativePath.startsWith('tests/fixtures/')) return 'APPROVED_FIXTURE';
  return 'MATERIALIZED_TASK_SOURCE';
};

const resolveMaterializedRelativeImport = (
  root: string,
  importerAbsolute: string,
  specifier: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined => {
  const compilerResolution = ts.resolveModuleName(
    specifier,
    importerAbsolute,
    compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (compilerResolution) return compilerResolution;
  if (!specifier.startsWith('.')) return undefined;
  const lexical = resolve(dirname(importerAbsolute), specifier);
  if (
    !contained(root, lexical) ||
    contained(join(root, 'node_modules'), lexical)
  )
    return undefined;
  const withoutJavaScriptExtension = lexical.replace(
    /\.(?:mjs|cjs|js|jsx)$/,
    '',
  );
  const candidates = [
    lexical,
    ...['.ts', '.tsx', '.mts', '.cts'].map(
      (extension) => `${withoutJavaScriptExtension}${extension}`,
    ),
    ...['index.ts', 'index.tsx', 'index.mts', 'index.cts'].map((name) =>
      join(lexical, name),
    ),
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
  const matches = candidates.filter((candidate) => {
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (matches.length > 1)
    throw new Error(
      `UNTRUSTED_RELATIVE_IMPORT_AMBIGUOUS:${relative(root, importerAbsolute)}:${specifier}`,
    );
  return matches[0];
};

const auditMaterializedResolution = (
  runtime: TrustedVerificationRuntime,
  root: string,
  testFiles: string[],
  workspaceAliases: Record<string, string> = {},
): ResolutionManifestEntry[] => {
  const manifest: ResolutionManifestEntry[] = [];
  const tests = new Set(testFiles);
  const trustedRequire = createRequire(
    join(runtime.trustedRoot, 'package.json'),
  );
  const compilerOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowImportingTsExtensions: true,
  };
  const record = (importer: string, specifier: string): void => {
    if (
      specifier.startsWith('node:') ||
      ['fs', 'path', 'url', 'util', 'crypto', 'os', 'assert'].includes(
        specifier,
      )
    ) {
      manifest.push({
        importer,
        specifier,
        resolved: specifier,
        classification: 'TRUSTED_RUNTIME',
      });
      return;
    }
    const alias = workspaceAliases[specifier];
    if (alias) {
      const resolvedAlias = realpathSync(join(root, alias));
      if (!contained(root, resolvedAlias))
        throw new Error(`UNTRUSTED_WORKSPACE_ALIAS_ESCAPE:${specifier}`);
      manifest.push({
        importer,
        specifier,
        resolved: relative(root, resolvedAlias).replaceAll('\\', '/'),
        classification: classifyMaterializedPath(root, resolvedAlias, tests),
      });
      return;
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      let resolvedDependency: string;
      try {
        resolvedDependency = realpathSync(trustedRequire.resolve(specifier));
      } catch {
        throw new Error(`UNTRUSTED_BARE_IMPORT_UNRESOLVED:${specifier}`);
      }
      if (!contained(runtime.trustedDependencyRoot, resolvedDependency))
        throw new Error(
          `UNTRUSTED_BARE_IMPORT_OUTSIDE_DEPENDENCY_ROOT:${specifier}`,
        );
      manifest.push({
        importer,
        specifier,
        resolved: resolvedDependency,
        classification: 'TRUSTED_THIRD_PARTY_DEPENDENCY',
      });
      return;
    }
    const importerAbsolute = join(root, importer);
    const resolved = resolveMaterializedRelativeImport(
      root,
      importerAbsolute,
      specifier,
      compilerOptions,
    );
    if (!resolved)
      throw new Error(
        `UNTRUSTED_RELATIVE_IMPORT_UNRESOLVED:${importer}:${specifier}`,
      );
    const canonical = realpathSync(resolved);
    if (!contained(root, canonical))
      throw new Error(
        `UNTRUSTED_RELATIVE_IMPORT_ESCAPE:${importer}:${specifier}`,
      );
    manifest.push({
      importer,
      specifier,
      resolved: relative(root, canonical).replaceAll('\\', '/'),
      classification: classifyMaterializedPath(root, canonical, tests),
    });
  };
  for (const path of sourceFiles(root)) {
    const absolute = join(root, path);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        record(path, node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          throw new Error(`UNSUPPORTED_DYNAMIC_MODULE_RESOLUTION:${path}`);
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'
        )
          throw new Error(`UNSUPPORTED_COMMONJS_REQUIRE:${path}`);
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return manifest.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
};

const execute = (
  runtime: TrustedVerificationRuntime,
  args: string[],
): TrustedCommandEvidence => {
  const result = spawnSync(runtime.node, args, {
    cwd: runtime.trustedRoot,
    env: runtime.environment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`;
  return {
    command: [runtime.node, ...args].join(' '),
    exitCode: result.status ?? 1,
    output,
    outputSha256: sha256(output),
  };
};

export const runTrustedVitestInMaterializedTarget = (
  runtime: TrustedVerificationRuntime,
  materializedRoot: string,
  testFiles: string[],
  options: TrustedVitestOptions = {},
): TrustedCommandEvidence => {
  const canonicalTarget = realpathSync(resolve(materializedRoot));
  const manifest = auditMaterializedResolution(
    runtime,
    canonicalTarget,
    testFiles,
    options.workspaceAliases,
  );
  const manifestText = `${JSON.stringify({ schemaVersion: '1.0.0', entries: manifest }, null, 2)}\n`;
  const manifestSha256 = sha256(manifestText);
  let config = runtime.vitestConfig;
  if (
    options.workspaceAliases &&
    Object.keys(options.workspaceAliases).length > 0
  ) {
    const configDirectory = join(canonicalTarget, '.ciag-trusted');
    mkdirSync(configDirectory, { recursive: true });
    config = join(configDirectory, 'vitest.config.ts');
    const aliases = Object.fromEntries(
      Object.entries(options.workspaceAliases).map(([specifier, path]) => [
        specifier,
        join(canonicalTarget, path),
      ]),
    );
    writeFileSync(
      config,
      [
        "import { defineConfig, mergeConfig } from 'vitest/config';",
        `import baseConfig from ${JSON.stringify(runtime.vitestConfig)};`,
        `export default mergeConfig(baseConfig, defineConfig({ resolve: { alias: ${JSON.stringify(aliases)} } }));`,
        '',
      ].join('\n'),
    );
  }
  const result = execute(runtime, [
    runtime.vitest,
    'run',
    '--config',
    config,
    '--root',
    canonicalTarget,
    '--sequence.seed=424242',
    ...testFiles,
  ]);
  const output = `${result.output}\nCIAG_RESOLUTION_MANIFEST_SHA256:${manifestSha256}\n${manifestText}`;
  return {
    ...result,
    output,
    outputSha256: sha256(output),
    resolutionManifest: manifest,
    resolutionManifestSha256: manifestSha256,
  };
};

export const runTrustedVitest = (
  runtime: TrustedVerificationRuntime,
  targetRoot: string,
  testFiles: string[],
  options: TrustedVitestOptions = {},
): TrustedCommandEvidence => {
  const canonicalTarget = realpathSync(resolve(targetRoot));
  if (canonicalTarget === runtime.trustedRoot)
    return execute(runtime, [
      runtime.vitest,
      'run',
      '--config',
      runtime.vitestConfig,
      '--root',
      runtime.trustedRoot,
      '--sequence.seed=424242',
      ...testFiles,
    ]);
  const materializedOptions: TrustedVitestOptions = options.approvedInputs
    ? options
    : {
        ...options,
        approvedInputs: [
          ...testFiles,
          'packages/**',
          'apps/**',
          'tests/fixtures/**',
        ],
      };
  const materialized = materializeVerificationTarget(
    runtime,
    canonicalTarget,
    materializedOptions,
  );
  try {
    return runTrustedVitestInMaterializedTarget(
      runtime,
      materialized.root,
      testFiles,
      options,
    );
  } finally {
    materialized.cleanup();
  }
};

export const runTrustedTsx = (
  runtime: TrustedVerificationRuntime,
  source: string,
  args: string[] = [],
): TrustedCommandEvidence => {
  const canonicalSource = trustedFile(
    runtime.trustedRoot,
    join(runtime.trustedRoot, source),
    source,
  );
  return execute(runtime, [runtime.tsx, canonicalSource, ...args]);
};
