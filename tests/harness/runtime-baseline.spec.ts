import { describe, expect, it } from 'vitest';
import {
  NODE_RUNTIME_VERSION,
  validateRuntimeBaseline,
  verifyRuntimeBaseline,
} from '../../tools/task-verifier/runtime-baseline.js';

describe('Node.js runtime baseline', () => {
  it('pins every executable environment to exact Node.js 22', async () => {
    await expect(verifyRuntimeBaseline()).resolves.toMatchObject({ node: NODE_RUNTIME_VERSION, dockerfiles: 4 });
  });

  it('fails closed if CI drifts to Node.js 24 without an approved baseline change', () => {
    expect(() =>
      validateRuntimeBaseline({
        packageJson: JSON.stringify({
          engines: { node: NODE_RUNTIME_VERSION, pnpm: '10.13.1' },
          packageManager: 'pnpm@10.13.1',
        }),
        nodeVersion: NODE_RUNTIME_VERSION,
        nvmrc: NODE_RUNTIME_VERSION,
        ciWorkflow: 'node-version: 24.14.0',
        scheduledWorkflow: `node-version: ${NODE_RUNTIME_VERSION}`,
        architecturalBaseline: JSON.stringify({ runtime: 'node-22' }),
        dockerfiles: { Dockerfile: `FROM node:${NODE_RUNTIME_VERSION}-alpine` },
      }),
    ).toThrow('CI_NODE_BASELINE_DRIFT:ci');
  });
});
