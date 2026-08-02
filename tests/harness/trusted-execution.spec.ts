import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTrustedVerificationRuntime,
  runTrustedTsx,
  runTrustedVitest,
} from '../../tools/task-verifier/trusted-execution.js';

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

interface WorkspaceFixtureOptions {
  rootDependencies?: Record<string, string>;
  rootDependencySection?:
    | 'dependencies'
    | 'devDependencies'
    | 'peerDependencies'
    | 'optionalDependencies';
  importerDependencies?: Record<string, string>;
  duplicateSharedPackage?: boolean;
}

const workspaceFixture = async (
  options: WorkspaceFixtureOptions = {},
): Promise<{
  trusted: string;
  target: string;
  runtime: ReturnType<typeof resolveTrustedVerificationRuntime>;
}> => {
  const trusted = await mkdtemp(
    join(tmpdir(), 'chain-sieve-trusted-workspace-'),
  );
  const target = await mkdtemp(join(tmpdir(), 'chain-sieve-workspace-target-'));
  temporary.push(trusted, target);
  await symlink(
    join(process.cwd(), 'node_modules'),
    join(trusted, 'node_modules'),
    'dir',
  );
  await copyFile(
    join(process.cwd(), 'vitest.config.ts'),
    join(trusted, 'vitest.config.ts'),
  );
  await writeFile(
    join(trusted, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  await writeFile(
    join(trusted, 'package.json'),
    `${JSON.stringify({
      name: 'trusted-fixture-root',
      type: 'module',
      [options.rootDependencySection ?? 'dependencies']:
        options.rootDependencies,
    })}\n`,
  );
  const packages = [
    {
      path: 'packages/shared',
      manifest: {
        name: '@ciag/shared-schemas',
        type: 'module',
        exports: './src/index.ts',
      },
      source: 'export interface WorkspaceMarker { value: number }\n',
    },
    {
      path: 'packages/domain',
      manifest: {
        name: '@ciag/domain',
        type: 'module',
        exports: './src/index.ts',
      },
      source: 'export const workspaceValue = 1;\n',
    },
    {
      path: 'packages/importer',
      manifest: {
        name: '@ciag/importer',
        type: 'module',
        exports: './src/index.ts',
        dependencies: options.importerDependencies,
      },
      source: 'export const importerValue = 1;\n',
    },
  ];
  if (options.duplicateSharedPackage)
    packages.push({
      path: 'packages/shared-copy',
      manifest: {
        name: '@ciag/shared-schemas',
        type: 'module',
        exports: './src/index.ts',
      },
      source: 'export interface WorkspaceMarker { duplicate: true }\n',
    });
  for (const item of packages) {
    await mkdir(join(trusted, item.path, 'src'), { recursive: true });
    await writeFile(
      join(trusted, item.path, 'package.json'),
      `${JSON.stringify(item.manifest)}\n`,
    );
    await writeFile(join(trusted, item.path, 'src/index.ts'), item.source);
  }
  return {
    trusted,
    target,
    runtime: resolveTrustedVerificationRuntime(trusted),
  };
};

const writeWorkspaceTest = async (
  target: string,
  path: string,
  specifier: string,
): Promise<void> => {
  await mkdir(join(target, path, '..'), { recursive: true });
  await writeFile(
    join(target, path),
    `import type { WorkspaceMarker } from ${JSON.stringify(specifier)}; import { expect, it } from 'vitest'; it('audits workspace resolution', () => { const value: WorkspaceMarker = { value: 1 }; expect(value.value).toBe(1); });\n`,
  );
};

describe('trusted verification executable and dependency resolution', () => {
  it.each([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const)(
    'accepts a root workspace import declared in %s',
    async (section) => {
      const fixture = await workspaceFixture({
        rootDependencies: { '@ciag/shared-schemas': 'workspace:*' },
        rootDependencySection: section,
      });
      await writeWorkspaceTest(
        fixture.target,
        'tests/workspace.spec.ts',
        '@ciag/shared-schemas',
      );
      const result = runTrustedVitest(fixture.runtime, fixture.target, [
        'tests/workspace.spec.ts',
      ]);
      expect(result.exitCode, result.output).toBe(0);
      expect(result.resolutionManifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            specifier: '@ciag/shared-schemas',
            classification: 'TRUSTED_WORKSPACE_DEPENDENCY',
          }),
        ]),
      );
    },
  );

  it('accepts a workspace import declared by the owning package', async () => {
    const fixture = await workspaceFixture({
      importerDependencies: { '@ciag/shared-schemas': 'workspace:*' },
    });
    await mkdir(join(fixture.target, 'packages/importer/src'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.target, 'packages/importer/src/consumer.ts'),
      "import type { WorkspaceMarker } from '@ciag/shared-schemas'; export const marker: WorkspaceMarker = { value: 1 };\n",
    );
    await mkdir(join(fixture.target, 'tests'), { recursive: true });
    await writeFile(
      join(fixture.target, 'tests/workspace.spec.ts'),
      "import { expect, it } from 'vitest'; it('audits a package import', () => expect(typeof it).toBe('function'));\n",
    );
    const result = runTrustedVitest(fixture.runtime, fixture.target, [
      'tests/workspace.spec.ts',
    ]);
    expect(result.exitCode, result.output).toBe(0);
  });

  it('rejects an undeclared workspace import from an owning package', async () => {
    const fixture = await workspaceFixture();
    await mkdir(join(fixture.target, 'packages/importer/src'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.target, 'packages/importer/src/consumer.ts'),
      "import type { WorkspaceMarker } from '@ciag/shared-schemas'; export const marker: WorkspaceMarker = { value: 1 };\n",
    );
    await mkdir(join(fixture.target, 'tests'), { recursive: true });
    await writeFile(
      join(fixture.target, 'tests/workspace.spec.ts'),
      "import { expect, it } from 'vitest'; it('audits a package import', () => expect(typeof it).toBe('function'));\n",
    );
    expect(() =>
      runTrustedVitest(fixture.runtime, fixture.target, [
        'tests/workspace.spec.ts',
      ]),
    ).toThrow('UNTRUSTED_WORKSPACE_IMPORT_UNDECLARED');
  });

  it('rejects an unknown @ciag package', async () => {
    const fixture = await workspaceFixture({
      rootDependencies: { '@ciag/unknown': 'workspace:*' },
    });
    await writeWorkspaceTest(
      fixture.target,
      'tests/workspace.spec.ts',
      '@ciag/unknown',
    );
    expect(() =>
      runTrustedVitest(fixture.runtime, fixture.target, [
        'tests/workspace.spec.ts',
      ]),
    ).toThrow('UNTRUSTED_BARE_IMPORT_UNRESOLVED:@ciag/unknown');
  });

  it('rejects an ambiguous duplicate workspace package identity', async () => {
    const fixture = await workspaceFixture({
      rootDependencies: { '@ciag/shared-schemas': 'workspace:*' },
      duplicateSharedPackage: true,
    });
    await writeWorkspaceTest(
      fixture.target,
      'tests/workspace.spec.ts',
      '@ciag/shared-schemas',
    );
    expect(() =>
      runTrustedVitest(fixture.runtime, fixture.target, [
        'tests/workspace.spec.ts',
      ]),
    ).toThrow('UNTRUSTED_WORKSPACE_PACKAGE_AMBIGUOUS');
  });

  it('rejects workspace alias package-name spoofing', async () => {
    const fixture = await workspaceFixture({
      rootDependencies: { '@ciag/shared-schemas': 'workspace:*' },
    });
    await writeWorkspaceTest(
      fixture.target,
      'tests/workspace.spec.ts',
      '@ciag/shared-schemas',
    );
    expect(() =>
      runTrustedVitest(
        fixture.runtime,
        fixture.target,
        ['tests/workspace.spec.ts'],
        {
          workspaceAliases: {
            '@ciag/shared-schemas': 'packages/domain/src/index.ts',
          },
        },
      ),
    ).toThrow('UNTRUSTED_WORKSPACE_ALIAS_IDENTITY_MISMATCH');
  });

  it('rejects a workspace package symlink outside the trusted repository', async () => {
    const fixture = await workspaceFixture({
      rootDependencies: { '@ciag/escaped': 'workspace:*' },
    });
    const outside = await mkdtemp(
      join(tmpdir(), 'chain-sieve-workspace-escape-'),
    );
    temporary.push(outside);
    await mkdir(join(outside, 'src'), { recursive: true });
    await writeFile(
      join(outside, 'package.json'),
      `${JSON.stringify({ name: '@ciag/escaped', exports: './src/index.ts' })}\n`,
    );
    await writeFile(
      join(outside, 'src/index.ts'),
      'export type Escaped = true;\n',
    );
    await symlink(outside, join(fixture.trusted, 'packages/escaped'), 'dir');
    await writeWorkspaceTest(
      fixture.target,
      'tests/workspace.spec.ts',
      '@ciag/escaped',
    );
    expect(() =>
      runTrustedVitest(fixture.runtime, fixture.target, [
        'tests/workspace.spec.ts',
      ]),
    ).toThrow('UNTRUSTED_WORKSPACE_PACKAGE_ESCAPE');
  });

  it('accepts the T-G0-DATA shared fixture imports declared at the root', async () => {
    const fixture = await workspaceFixture({
      rootDependencies: {
        '@ciag/shared-schemas': 'workspace:*',
        '@ciag/domain': 'workspace:*',
      },
    });
    await mkdir(join(fixture.target, 'tests/fixtures/core'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.target, 'tests/fixtures/core/index.ts'),
      "import type { WorkspaceMarker } from '@ciag/shared-schemas'; import { workspaceValue } from '@ciag/domain'; export const sharedFixture: WorkspaceMarker = { value: workspaceValue };\n",
    );
    await mkdir(join(fixture.target, 'tests'), { recursive: true });
    await writeFile(
      join(fixture.target, 'tests/workspace.spec.ts'),
      "import { expect, it } from 'vitest'; import { sharedFixture } from './fixtures/core/index.js'; it('keeps the shared fixture available', () => expect(typeof sharedFixture).toBe('object'));\n",
    );
    const result = runTrustedVitest(fixture.runtime, fixture.target, [
      'tests/workspace.spec.ts',
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(
      result.resolutionManifest?.filter((entry) =>
        entry.importer.startsWith('tests/fixtures/core/'),
      ),
    ).toHaveLength(2);
  });

  it('reproduces execution of a malicious task-local fast-check package', async () => {
    const target = await mkdtemp(
      join(tmpdir(), 'chain-sieve-untrusted-fast-check-'),
    );
    temporary.push(target);
    const marker = join(target, 'MALICIOUS_FAST_CHECK_EXECUTED');
    await mkdir(join(target, 'node_modules/fast-check'), { recursive: true });
    await writeFile(
      join(target, 'node_modules/fast-check/package.json'),
      `${JSON.stringify({
        name: 'fast-check',
        version: '0.0.0-malicious',
        type: 'module',
        exports: './index.js',
      })}\n`,
    );
    await writeFile(
      join(target, 'node_modules/fast-check/index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default { integer: () => ({}), property: (_arbitrary, predicate) => () => predicate(1), assert: property => property() };\n`,
    );
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(
      join(target, 'tests/fast-check.spec.ts'),
      "import { it } from 'vitest'; import fc from 'fast-check'; it('runs a property', () => { fc.assert(fc.property(fc.integer(), value => Number.isInteger(value))); });\n",
    );

    const runtime = resolveTrustedVerificationRuntime(process.cwd());
    const result = runTrustedVitest(runtime, target, [
      'tests/fast-check.spec.ts',
    ]);
    expect(result.exitCode, result.output).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    expect(result.resolutionManifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: 'fast-check',
          classification: 'TRUSTED_THIRD_PARTY_DEPENDENCY',
        }),
      ]),
    );
    expect(result.resolutionManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('excludes every task-local package and configuration resolution surface', async () => {
    const target = await mkdtemp(
      join(tmpdir(), 'chain-sieve-untrusted-package-surface-'),
    );
    temporary.push(target);
    const markers = [
      'fast-check',
      'vitest',
      'tsx',
      'zod',
      'pure-rand',
      'bin-vitest',
      'bin-tsx',
      'script',
      'vitest-config',
      'vite-config',
      'node-path',
      'loader',
    ].map((name) => join(target, `MALICIOUS_${name}`));
    const maliciousModule = (marker: string, exports = '') =>
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); ${exports}\n`;
    const packages: Array<readonly [string, string, string]> = [
      [
        'fast-check',
        markers[0]!,
        'export default { integer: () => ({}), property: (_arbitrary, predicate) => () => predicate(1), assert: property => property() };',
      ],
      [
        'vitest',
        markers[1]!,
        'export const it = () => {}; export const expect = () => ({ toBe: () => {} });',
      ],
      ['tsx', markers[2]!, 'export default {};'],
      [
        'zod',
        markers[3]!,
        'export const z = { number: () => ({ parse: value => value }) };',
      ],
      ['pure-rand', markers[4]!, 'export default {};'],
    ];
    for (const [name, marker, exports] of packages) {
      await mkdir(join(target, 'node_modules', name), { recursive: true });
      await writeFile(
        join(target, 'node_modules', name, 'package.json'),
        `${JSON.stringify({ name, version: '0.0.0-malicious', type: 'module', exports: './index.js' })}\n`,
      );
      await writeFile(
        join(target, 'node_modules', name, 'index.js'),
        maliciousModule(marker, exports),
      );
    }
    await mkdir(join(target, 'node_modules/.bin'), { recursive: true });
    await writeFile(
      join(target, 'node_modules/.bin/vitest'),
      maliciousModule(markers[5]!),
    );
    await writeFile(
      join(target, 'node_modules/.bin/tsx'),
      maliciousModule(markers[6]!),
    );
    await writeFile(
      join(target, 'package.json'),
      `${JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('${markers[7]}','executed')"` } })}\n`,
    );
    await writeFile(
      join(target, 'vitest.config.ts'),
      maliciousModule(markers[8]!, 'export default {};'),
    );
    await writeFile(
      join(target, 'vite.config.ts'),
      maliciousModule(markers[9]!, 'export default {};'),
    );
    await mkdir(join(target, 'node-path/node-path-poison'), {
      recursive: true,
    });
    await writeFile(
      join(target, 'node-path/node-path-poison/index.js'),
      maliciousModule(markers[10]!),
    );
    await writeFile(
      join(target, 'custom-loader.mjs'),
      maliciousModule(markers[11]!),
    );
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(
      join(target, 'tests/dependencies.spec.ts'),
      "import { expect, it } from 'vitest'; import fc from 'fast-check'; import { z } from 'zod'; it('uses only trusted packages', () => { fc.assert(fc.property(fc.integer(), value => Number.isInteger(value))); expect(z.number().parse(2)).toBe(2); });\n",
    );

    const runtime = resolveTrustedVerificationRuntime(process.cwd(), {
      PATH: join(target, 'node_modules/.bin'),
      NODE_PATH: join(target, 'node-path'),
      PNPM_HOME: target,
      npm_config_prefix: target,
      NODE_OPTIONS: `--experimental-loader=${join(target, 'custom-loader.mjs')}`,
    });
    const result = runTrustedVitest(runtime, target, [
      'tests/dependencies.spec.ts',
    ]);
    expect(result.exitCode, result.output).toBe(0);
    for (const marker of markers)
      await expect(access(marker)).rejects.toThrow();
    expect(
      new Set(result.resolutionManifest?.map((entry) => entry.classification)),
    ).toEqual(new Set(['TRUSTED_THIRD_PARTY_DEPENDENCY']));
    expect(result.output).toContain(
      `CIAG_RESOLUTION_MANIFEST_SHA256:${result.resolutionManifestSha256}`,
    );
  });

  it.each([
    [
      'dynamic bare import',
      "import { it } from 'vitest'; it('dynamic', async () => { await import('fast-check'); });",
      'UNSUPPORTED_DYNAMIC_MODULE_RESOLUTION',
    ],
    [
      'CommonJS require',
      "import { it } from 'vitest'; it('require', () => { require('fast-check'); });",
      'UNSUPPORTED_COMMONJS_REQUIRE',
    ],
  ])('rejects %s before task code executes', async (_name, source, error) => {
    const target = await mkdtemp(
      join(tmpdir(), 'chain-sieve-untrusted-dynamic-'),
    );
    temporary.push(target);
    const marker = join(target, 'MALICIOUS_DYNAMIC_EXECUTED');
    await mkdir(join(target, 'node_modules/fast-check'), { recursive: true });
    await writeFile(
      join(target, 'node_modules/fast-check/package.json'),
      `${JSON.stringify({ name: 'fast-check', type: 'module', exports: './index.js' })}\n`,
    );
    await writeFile(
      join(target, 'node_modules/fast-check/index.js'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    );
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(join(target, 'tests/dynamic.spec.ts'), `${source}\n`);
    const runtime = resolveTrustedVerificationRuntime(process.cwd());
    expect(() =>
      runTrustedVitest(runtime, target, ['tests/dynamic.spec.ts']),
    ).toThrow(error);
    await expect(access(marker)).rejects.toThrow();
  });

  it('ignores malicious task-root binaries, packages, scripts, loaders, and verifier modules', async () => {
    const target = await mkdtemp(
      join(tmpdir(), 'chain-sieve-untrusted-resolution-'),
    );
    temporary.push(target);
    const marker = join(target, 'MALICIOUS_EXECUTED');
    const malicious = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('MALICIOUS_RESOLUTION');\n`;
    for (const path of [
      'node_modules/.bin/tsx',
      'node_modules/.bin/vitest',
      'node_modules/tsx/dist/cli.mjs',
      'node_modules/vitest/vitest.mjs',
      'node-path/poison.mjs',
      'custom-loader.mjs',
      'tools/task-verifier/verify.ts',
      'tools/task-verifier/attestation.ts',
    ]) {
      await mkdir(join(target, path, '..'), { recursive: true });
      await writeFile(join(target, path), malicious);
    }
    await writeFile(
      join(target, 'package.json'),
      `${JSON.stringify({
        name: 'malicious-task-root',
        type: 'module',
        scripts: {
          test: `node -e "require('fs').writeFileSync('${marker}','script')"`,
        },
      })}\n`,
    );
    await mkdir(join(target, 'packages/x'), { recursive: true });
    await writeFile(
      join(target, 'packages/x/index.ts'),
      'export const addOne = (value: number): number => value + 1;\n',
    );
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(
      join(target, 'tests/safe.spec.ts'),
      "import { expect, it } from 'vitest'; import { addOne } from '../packages/x/index.js'; it('uses production', () => expect(addOne(1)).toBe(2));\n",
    );

    const runtime = resolveTrustedVerificationRuntime(process.cwd(), {
      PATH: join(target, 'node_modules/.bin'),
      NODE_PATH: join(target, 'node-path'),
      PNPM_HOME: target,
      npm_config_prefix: target,
      INIT_CWD: target,
      PWD: target,
      NODE_OPTIONS: `--experimental-loader=${join(target, 'custom-loader.mjs')}`,
    });
    expect(runtime.tsx).toContain('/node_modules/.pnpm/tsx@');
    expect(runtime.vitest).toContain('/node_modules/.pnpm/vitest@');
    expect(runtime.environment).toMatchObject({
      NODE_PATH: '',
      PNPM_HOME: '',
      npm_config_prefix: '',
      INIT_CWD: runtime.trustedRoot,
      PWD: runtime.trustedRoot,
      NODE_OPTIONS: '',
    });

    const architecture = runTrustedTsx(
      runtime,
      'tools/architecture-verifier/cli.ts',
      ['architecture', '--target-root', target],
    );
    expect(architecture.exitCode, architecture.output).toBe(0);
    expect(architecture.output).toContain('"status":"PASS"');
    const tests = runTrustedVitest(runtime, target, ['tests/safe.spec.ts']);
    expect(tests.exitCode, tests.output).toBe(0);
    expect(tests.output).toContain('1 passed');
    await expect(access(marker)).rejects.toThrow();
  });
});
