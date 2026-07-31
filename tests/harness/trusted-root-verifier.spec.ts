import { describe, expect, it } from 'vitest';
import { assertTrustedTargetPaths } from '../../tools/task-verifier/verify.js';

describe('trusted-root verifier preflight', () => {
  it.each([
    'tasks/G0/T-G0-CORE.contract.json',
    'tasks/generated/interface-hashes.json',
    'artifacts/spec/acceptance-partition.json',
    'artifacts/conformance/T-G0-CORE/manifest.json',
    'tools/task-verifier/verify.ts',
    'tools/task-verifier/attestation.ts',
    'tools/architecture-verifier/verify.ts',
    'tools/task-runner/cli.ts',
    'tools/merge-queue/processor.ts',
    'tools/agent/orchestrator.ts',
    '.github/workflows/ci.yml',
  ])('rejects untrusted changes to %s before verification executes', (path) => {
    expect(() => assertTrustedTargetPaths([path])).toThrow(`UNTRUSTED_CONTROL_PLANE_CHANGE:${path}`);
  });

  it('permits a task-owned production target to proceed to later scope checks', () => {
    expect(() => assertTrustedTargetPaths(['packages/domain/src/cache.ts'])).not.toThrow();
  });
});
