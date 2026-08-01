import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '../prd-compiler/compiler.js';

export interface TrustedCommandEvidence {
  command: string;
  exitCode: number;
  output: string;
  outputSha256: string;
}

export interface TrustedVerificationRuntime {
  trustedRoot: string;
  node: string;
  tsx: string;
  vitest: string;
  environment: NodeJS.ProcessEnv;
}

const contained = (root: string, target: string): boolean => {
  const suffix = relative(root, target);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
};

const trustedFile = (root: string, candidate: string, label: string): string => {
  const path = realpathSync(candidate);
  if (!contained(root, path)) throw new Error(`TRUSTED_EXECUTABLE_OUTSIDE_CONTROL_PLANE:${label}`);
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error(`TRUSTED_EXECUTABLE_NOT_REGULAR:${label}`);
  return path;
};

export const trustedVerificationEnvironment = (
  trustedRoot: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM', 'CI'])
    if (ambient[name]) environment[name] = ambient[name];
  environment.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  environment.NODE_PATH = '';
  environment.PNPM_HOME = '';
  environment.npm_config_prefix = '';
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
    node: realpathSync(process.execPath),
    tsx: trustedFile(nodeModules, join(canonicalRoot, 'node_modules/tsx/dist/cli.mjs'), 'tsx'),
    vitest: trustedFile(nodeModules, join(canonicalRoot, 'node_modules/vitest/vitest.mjs'), 'vitest'),
    environment: trustedVerificationEnvironment(canonicalRoot, ambient),
  };
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

export const runTrustedVitest = (
  runtime: TrustedVerificationRuntime,
  targetRoot: string,
  testFiles: string[],
): TrustedCommandEvidence => {
  const canonicalTarget = realpathSync(resolve(targetRoot));
  return execute(runtime, [runtime.vitest, 'run', '--root', canonicalTarget, ...testFiles]);
};

export const runTrustedTsx = (
  runtime: TrustedVerificationRuntime,
  source: string,
  args: string[] = [],
): TrustedCommandEvidence => {
  const canonicalSource = trustedFile(runtime.trustedRoot, join(runtime.trustedRoot, source), source);
  return execute(runtime, [runtime.tsx, canonicalSource, ...args]);
};
