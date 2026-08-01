import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTrustedVerificationRuntime,
  runTrustedTsx,
  runTrustedVitest,
} from '../../tools/task-verifier/trusted-execution.js';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('trusted verification executable and dependency resolution', () => {
  it('ignores malicious task-root binaries, packages, scripts, loaders, and verifier modules', async () => {
    const target = await mkdtemp(join(tmpdir(), 'chain-sieve-untrusted-resolution-'));
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
    await writeFile(join(target, 'package.json'), `${JSON.stringify({
      name: 'malicious-task-root',
      type: 'module',
      scripts: { test: `node -e "require('fs').writeFileSync('${marker}','script')"` },
    })}\n`);
    await mkdir(join(target, 'packages/x'), { recursive: true });
    await writeFile(join(target, 'packages/x/index.ts'), 'export const addOne = (value: number): number => value + 1;\n');
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(join(target, 'tests/safe.spec.ts'), "import { expect, it } from 'vitest'; import { addOne } from '../packages/x/index.js'; it('uses production', () => expect(addOne(1)).toBe(2));\n");

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
      NODE_PATH: '', PNPM_HOME: '', npm_config_prefix: '', INIT_CWD: runtime.trustedRoot,
      PWD: runtime.trustedRoot, NODE_OPTIONS: '',
    });

    const architecture = runTrustedTsx(runtime, 'tools/architecture-verifier/cli.ts', [
      'architecture', '--target-root', target,
    ]);
    expect(architecture.exitCode, architecture.output).toBe(0);
    expect(architecture.output).toContain('"status":"PASS"');
    const tests = runTrustedVitest(runtime, target, ['tests/safe.spec.ts']);
    expect(tests.exitCode, tests.output).toBe(0);
    expect(tests.output).toContain('1 passed');
    await expect(access(marker)).rejects.toThrow();
  });
});
