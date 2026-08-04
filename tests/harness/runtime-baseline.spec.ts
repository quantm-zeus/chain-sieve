import { describe, expect, it } from 'vitest';
import {
  NODE_ENGINE_RANGE,
  NODE_RUNTIME_MAJOR,
  validateRuntimeBaseline,
  verifyRuntimeBaseline,
} from '../../tools/task-verifier/runtime-baseline.js';

describe('Node.js runtime baseline', () => {
  it('keeps every executable environment on Node.js 22 without patch pinning', async () => {
    await expect(verifyRuntimeBaseline()).resolves.toMatchObject({
      node: NODE_RUNTIME_MAJOR,
      dockerfiles: 4,
    });
  });

  it('fails closed if CI drifts to Node.js 24 without an approved baseline change', () => {
    expect(() =>
      validateRuntimeBaseline({
        packageJson: JSON.stringify({
          engines: { node: NODE_ENGINE_RANGE, pnpm: '10.13.1' },
          packageManager: 'pnpm@10.13.1',
        }),
        nodeVersion: NODE_RUNTIME_MAJOR,
        nvmrc: NODE_RUNTIME_MAJOR,
        ciWorkflow: 'node-version: 24',
        scheduledWorkflow: `node-version: ${NODE_RUNTIME_MAJOR}`,
        architecturalBaseline: JSON.stringify({ runtime: 'node-22' }),
        dockerfiles: { Dockerfile: `FROM node:${NODE_RUNTIME_MAJOR}-alpine` },
      }),
    ).toThrow('CI_NODE_BASELINE_DRIFT:ci');
  });
});
