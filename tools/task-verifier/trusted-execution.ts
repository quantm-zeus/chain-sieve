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
  | 'TRUSTED_WORKSPACE_DEPENDENCY'
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
  '.svelte-kit',
  '.next',
  'coverage',
  'dist',
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

interface PackageManifest {
  name?: string;
  exports?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface TrustedWorkspacePackage {
  name: string;
  relativeRoot: string;
  entry: string | undefined;
  manifest: PackageManifest;
}

const workspacePattern = (pattern: string): RegExp => {
  const segments = pattern.replace(/^\.\//, '').split('/');
  const expression = segments
    .map((segment) => {
      if (segment === '**') return '(?:[^/]+/)*[^/]*';
      return segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]');
    })
    .join('/');
  return new RegExp(`^${expression}$`);
};

const readWorkspacePatterns = (trustedRoot: string): string[] => {
  const workspacePath = trustedFile(
    trustedRoot,
    join(trustedRoot, 'pnpm-workspace.yaml'),
    'pnpm-workspace',
  );
  const lines = readFileSync(workspacePath, 'utf8').split(/\r?\n/);
  const patterns: string[] = [];
  let packages = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      packages = line.trim() === 'packages:';
      continue;
    }
    if (!packages) continue;
    const match = /^\s*-\s*(?:'([^']+)'|"([^"]+)"|([^\s]+))\s*$/.exec(line);
    if (!match) throw new Error('TRUSTED_PNPM_WORKSPACE_CONFIG_UNSUPPORTED');
    const pattern = match[1] ?? match[2] ?? match[3];
    if (!pattern || isAbsolute(pattern) || pattern.split('/').includes('..'))
      throw new Error(
        `TRUSTED_PNPM_WORKSPACE_PATTERN_INVALID:${pattern ?? ''}`,
      );
    patterns.push(pattern);
  }
  if (patterns.length === 0)
    throw new Error('TRUSTED_PNPM_WORKSPACE_PACKAGES_MISSING');
  return patterns;
};

const workspaceDirectories = (trustedRoot: string): string[] => {
  const paths: string[] = [];
  const walk = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (blockedDirectoryNames.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        paths.push(path);
        walk(join(directory, entry.name), path);
      } else if (entry.isSymbolicLink()) paths.push(path);
    }
  };
  walk(trustedRoot);
  return paths;
};

const readPackageManifest = (
  trustedRoot: string,
  relativeRoot: string,
): { root: string; manifest: PackageManifest } => {
  const lexicalRoot = join(trustedRoot, relativeRoot);
  const root = realpathSync(lexicalRoot);
  if (!contained(trustedRoot, root))
    throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_ESCAPE:${relativeRoot}`);
  const manifestPath = trustedFile(
    trustedRoot,
    join(root, 'package.json'),
    `workspace-manifest:${relativeRoot || '.'}`,
  );
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as PackageManifest;
  } catch {
    throw new Error(
      `TRUSTED_WORKSPACE_MANIFEST_INVALID:${relativeRoot || '.'}`,
    );
  }
  return { root, manifest };
};

const trustedWorkspacePackages = (
  trustedRoot: string,
): Map<string, TrustedWorkspacePackage[]> => {
  const positives: RegExp[] = [];
  const negatives: RegExp[] = [];
  for (const rawPattern of readWorkspacePatterns(trustedRoot)) {
    const negative = rawPattern.startsWith('!');
    const pattern = negative ? rawPattern.slice(1) : rawPattern;
    (negative ? negatives : positives).push(workspacePattern(pattern));
  }
  const matches = workspaceDirectories(trustedRoot).filter(
    (path) =>
      positives.some((pattern) => pattern.test(path)) &&
      !negatives.some((pattern) => pattern.test(path)),
  );
  const packages = new Map<string, TrustedWorkspacePackage[]>();
  for (const relativeRoot of matches) {
    let loaded: ReturnType<typeof readPackageManifest>;
    try {
      loaded = readPackageManifest(trustedRoot, relativeRoot);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ENOENT:'))
        continue;
      throw error;
    }
    const { root, manifest } = loaded;
    if (!manifest.name) continue;
    let entry: string | undefined;
    if (manifest.exports !== undefined) {
      if (
        !manifest.exports.startsWith('./') ||
        manifest.exports.split('/').includes('..')
      )
        throw new Error(
          `TRUSTED_WORKSPACE_PACKAGE_ENTRY_INVALID:${manifest.name}`,
        );
      const canonicalEntry = realpathSync(join(root, manifest.exports));
      if (!contained(trustedRoot, canonicalEntry))
        throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_ESCAPE:${manifest.name}`);
      entry = relative(trustedRoot, canonicalEntry).replaceAll('\\', '/');
    }
    const item = {
      name: manifest.name,
      relativeRoot,
      entry,
      manifest,
    };
    packages.set(manifest.name, [...(packages.get(manifest.name) ?? []), item]);
  }
  return packages;
};

const importedPackageName = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
};

const declaredDependencies = (manifest: PackageManifest): Set<string> =>
  new Set(
    [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].flatMap((dependencies) => Object.keys(dependencies ?? {})),
  );

export interface TrustedWorkspaceMaterialization {
  approvedInputs: string[];
  aliases: Record<string, string>;
}

export const trustedWorkspaceMaterialization = (
  trustedRoot: string,
  sourceRoot: string,
  sourceRoots: string[],
): TrustedWorkspaceMaterialization => {
  const workspace = trustedWorkspacePackages(trustedRoot);
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const requested = new Set<string>();
  const transitiveInputs = new Set<string>();
  const inspected = new Set<string>();
  const inspect = (absolute: string): void => {
    const canonical = realpathSync(absolute);
    if (!contained(canonicalSourceRoot, canonical))
      throw new Error(`UNTRUSTED_WORKSPACE_SOURCE_ESCAPE:${absolute}`);
    if (inspected.has(canonical)) return;
    inspected.add(canonical);
    const source = ts.createSourceFile(
      canonical,
      readFileSync(canonical, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.')) {
          const lexical = resolve(dirname(canonical), specifier);
          const withoutExtension = lexical.replace(/\.[cm]?[jt]s$/, '');
          const candidates = [
            lexical,
            ...['.ts', '.tsx', '.mts', '.cts'].map(
              (extension) => `${withoutExtension}${extension}`,
            ),
            ...['index.ts', 'index.tsx', 'index.mts', 'index.cts'].map((name) =>
              join(lexical, name),
            ),
          ].filter(
            (candidate, index, values) => values.indexOf(candidate) === index,
          );
          const matches = candidates.filter((candidate) => {
            try {
              return lstatSync(candidate).isFile();
            } catch {
              return false;
            }
          });
          if (matches.length === 1) {
            const resolvedImport = realpathSync(matches[0]!);
            if (!contained(canonicalSourceRoot, resolvedImport))
              throw new Error(`UNTRUSTED_WORKSPACE_SOURCE_ESCAPE:${specifier}`);
            transitiveInputs.add(
              relative(canonicalSourceRoot, resolvedImport).replaceAll(
                '\\',
                '/',
              ),
            );
            inspect(resolvedImport);
          }
        } else if (!specifier.startsWith('/')) {
          const name = importedPackageName(specifier);
          if (workspace.has(name)) requested.add(name);
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  };
  for (const rawRoot of sourceRoots) {
    const relativeRoot = rawRoot.replace(/\/\*\*$/, '').replace(/^\.\//, '');
    let canonical: string;
    try {
      canonical = realpathSync(join(canonicalSourceRoot, relativeRoot));
    } catch {
      continue;
    }
    if (!contained(canonicalSourceRoot, canonical))
      throw new Error(`UNTRUSTED_WORKSPACE_SOURCE_ESCAPE:${rawRoot}`);
    const stat = lstatSync(canonical);
    if (stat.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(canonical))
      inspect(canonical);
    else if (stat.isDirectory())
      for (const path of sourceFiles(canonical)) inspect(join(canonical, path));
  }
  const approvedInputs: string[] = [...transitiveInputs];
  const aliases: Record<string, string> = {};
  const visited = new Set<string>();
  const queue = [...requested];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const candidates = workspace.get(name) ?? [];
    if (candidates.length !== 1)
      throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_AMBIGUOUS:${name}`);
    const workspacePackage = candidates[0]!;
    if (!workspacePackage.entry)
      throw new Error(`TRUSTED_WORKSPACE_PACKAGE_ENTRY_INVALID:${name}`);
    try {
      const sourcePackageRoot = realpathSync(
        join(canonicalSourceRoot, workspacePackage.relativeRoot),
      );
      if (!contained(canonicalSourceRoot, sourcePackageRoot))
        throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_ESCAPE:${name}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ENOENT:'))
        continue;
      throw error;
    }
    approvedInputs.push(`${workspacePackage.relativeRoot}/**`);
    aliases[name] = workspacePackage.entry;
    for (const dependency of declaredDependencies(workspacePackage.manifest))
      if (workspace.has(dependency) && !visited.has(dependency))
        queue.push(dependency);
  }
  return {
    approvedInputs: [
      ...new Set([...approvedInputs, ...transitiveInputs]),
    ].sort(),
    aliases: Object.fromEntries(
      Object.entries(aliases).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
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
  const workspacePackages = trustedWorkspacePackages(runtime.trustedRoot);
  const rootManifest = readPackageManifest(runtime.trustedRoot, '').manifest;
  const uniqueWorkspacePackage = (
    name: string,
  ): TrustedWorkspacePackage | undefined => {
    const candidates = workspacePackages.get(name) ?? [];
    if (candidates.length > 1)
      throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_AMBIGUOUS:${name}`);
    return candidates[0];
  };
  for (const [name, alias] of Object.entries(workspaceAliases)) {
    const workspacePackage = uniqueWorkspacePackage(name);
    if (!workspacePackage)
      throw new Error(`UNTRUSTED_WORKSPACE_ALIAS_UNKNOWN:${name}`);
    if (!workspacePackage.entry)
      throw new Error(`TRUSTED_WORKSPACE_PACKAGE_ENTRY_INVALID:${name}`);
    const normalizedAlias = alias.replace(/^\.\//, '').replaceAll('\\', '/');
    if (normalizedAlias !== workspacePackage.entry)
      throw new Error(`UNTRUSTED_WORKSPACE_ALIAS_IDENTITY_MISMATCH:${name}`);
  }
  const importerManifest = (importer: string): PackageManifest => {
    const owners = [...workspacePackages.values()]
      .flat()
      .filter(
        (workspacePackage) =>
          importer === workspacePackage.relativeRoot ||
          importer.startsWith(`${workspacePackage.relativeRoot}/`),
      )
      .sort(
        (left, right) => right.relativeRoot.length - left.relativeRoot.length,
      );
    if (
      owners.length > 1 &&
      owners[0]!.relativeRoot === owners[1]!.relativeRoot
    )
      throw new Error(`UNTRUSTED_IMPORTER_PACKAGE_AMBIGUOUS:${importer}`);
    return owners[0]?.manifest ?? rootManifest;
  };
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
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      const packageName = importedPackageName(specifier);
      const workspacePackage = uniqueWorkspacePackage(packageName);
      if (workspacePackage) {
        if (specifier !== workspacePackage.name)
          throw new Error(`UNTRUSTED_WORKSPACE_IMPORT_SUBPATH:${specifier}`);
        if (!declaredDependencies(importerManifest(importer)).has(packageName))
          throw new Error(
            `UNTRUSTED_WORKSPACE_IMPORT_UNDECLARED:${importer}:${specifier}`,
          );
        if (!workspacePackage.entry)
          throw new Error(
            `TRUSTED_WORKSPACE_PACKAGE_ENTRY_INVALID:${specifier}`,
          );
        const alias = workspaceAliases[specifier];
        if (alias) {
          const resolvedAlias = realpathSync(join(root, alias));
          if (!contained(root, resolvedAlias))
            throw new Error(`UNTRUSTED_WORKSPACE_ALIAS_ESCAPE:${specifier}`);
          manifest.push({
            importer,
            specifier,
            resolved: relative(root, resolvedAlias).replaceAll('\\', '/'),
            classification: classifyMaterializedPath(
              root,
              resolvedAlias,
              tests,
            ),
          });
          return;
        }
        const resolvedWorkspace = realpathSync(
          join(runtime.trustedRoot, workspacePackage.entry),
        );
        if (!contained(runtime.trustedRoot, resolvedWorkspace))
          throw new Error(`UNTRUSTED_WORKSPACE_PACKAGE_ESCAPE:${specifier}`);
        manifest.push({
          importer,
          specifier,
          resolved: workspacePackage.entry,
          classification: 'TRUSTED_WORKSPACE_DEPENDENCY',
        });
        return;
      }
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
  const requestedOptions: TrustedVitestOptions = options.approvedInputs
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
  const closure = trustedWorkspaceMaterialization(
    runtime.trustedRoot,
    canonicalTarget,
    requestedOptions.approvedInputs!,
  );
  const materializedOptions: TrustedVitestOptions = {
    ...requestedOptions,
    approvedInputs: [
      ...new Set([
        ...requestedOptions.approvedInputs!,
        ...closure.approvedInputs,
      ]),
    ],
    workspaceAliases: {
      ...closure.aliases,
      ...requestedOptions.workspaceAliases,
    },
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
      materializedOptions,
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
