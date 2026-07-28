import { spawnSync } from 'node:child_process';
import { sha256 } from '../prd-compiler/compiler.js';

export interface IntegrationVerification {
  command: string;
  exitCode: number;
  outputSha256: string;
  status: 'PASS' | 'FAIL';
}

export type IntegrationRunner = (cwd: string) => IntegrationVerification;

export const verifyPostMergeIntegration: IntegrationRunner = (cwd) => {
  if (process.env.CIAG_INJECT_INTEGRATION_FAILURE === '1') {
    const output = 'deterministic lifecycle integration failure injection\n';
    return {
      command: 'cluster:verify-integration',
      exitCode: 86,
      outputSha256: sha256(output),
      status: 'FAIL',
    };
  }
  const result = spawnSync('pnpm', ['test:integration'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    command: 'pnpm test:integration',
    exitCode: result.status ?? 1,
    outputSha256: sha256(output),
    status: result.status === 0 ? 'PASS' : 'FAIL',
  };
};
