import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTaskAttestation } from '../../tools/task-verifier/attestation.js';
import { verifyTask } from '../../tools/task-verifier/verify.js';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import { runtimeRoot } from '../../tools/task-runner/state.js';
import { createAttestationFixture, type AttestationFixture } from './attestation-fixture.js';

describe('proof-carrying task verification', () => {
  let fixture: AttestationFixture;
  beforeEach(async () => { fixture = await createAttestationFixture(); });
  afterEach(async () => fixture.cleanup());

  it('accepts complete independently derived evidence', async () => {
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true, state: fixture.state })).resolves.toBeDefined();
  });

  it('accepts unchanged self-review evidence through an exact recovered-lease and baseline bridge', async () => {
    const previousBaseline = fixture.state.verificationBaseline!;
    const baselineText = `${JSON.stringify({
      schemaVersion: '1.1.0',
      taskId: fixture.task.id,
      verifierVersion: fixture.result.bindings.verifierVersion,
      verificationPolicyVersion: fixture.result.bindings.verificationPolicyVersion,
      recoveryBaseline: true,
    }, null, 2)}\n`;
    const baselinePath = 'verification-baseline-recovered.json';
    const baseline = { path: baselinePath, sha256: sha256(baselineText), status: 'CURRENT' as const };
    await writeFile(join(runtimeRoot(fixture.root), baselinePath), baselineText);
    const recoveredLeaseId = `${fixture.task.id}:2:recovery:fixture`;
    const recoveredState = {
      ...fixture.state,
      leaseVersion: 2,
      leaseId: recoveredLeaseId,
      verificationBaseline: baseline,
      recovery: {
        requestSha256: '9'.repeat(64),
        receipt: { path: 'recovery.json', sha256: '8'.repeat(64), status: 'CURRENT' as const },
        ttlMinutes: 120,
        previousLeaseId: fixture.result.bindings.leaseId,
        previousFencingVersion: fixture.result.bindings.leaseFencingVersion,
        previousExpiresAt: '2026-07-21T01:00:00.000Z',
        resultingLeaseId: recoveredLeaseId,
        resultingFencingVersion: 2,
        resultingExpiresAt: '2026-07-21T03:00:00.000Z',
        previousVerificationBaseline: previousBaseline,
        resultingVerificationBaseline: baseline,
      },
    };
    const recoveredResult = {
      ...fixture.result,
      bindings: {
        ...fixture.result.bindings,
        leaseId: recoveredLeaseId,
        leaseFencingVersion: 2,
        verificationBaselineSha256: baseline.sha256,
      },
    };
    await expect(validateTaskAttestation(fixture.task, recoveredResult, {
      cwd: fixture.root,
      currentHeadRequired: true,
      state: recoveredState,
    })).resolves.toBeDefined();
  });

  it('rejects a forged PASS with empty evidence', async () => {
    const forged = { ...fixture.result, commandEvidence: [], bindings: { ...fixture.result.bindings, changedFiles: [], requirementToCode: [], acceptanceToTests: [], requiredTestArtifacts: [] } };
    await expect(validateTaskAttestation(fixture.task, forged, { cwd: fixture.root })).rejects.toThrow('TASK_RESULT_SCHEMA_INVALID');
  });

  it('rejects tracked source mutation after result generation', async () => {
    await writeFile(`${fixture.root}/${fixture.codePath}`, 'export const attested = false;\n');
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('DIRTY_WORKTREE');
  });

  it('rejects an untracked source file after result generation', async () => {
    await writeFile(`${fixture.root}/packages/domain/src/untracked.ts`, 'export const untracked = true;\n');
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('DIRTY_WORKTREE');
  });

  it('rejects a committed source mutation after result generation', async () => {
    const mutatedHead = await fixture.commitSourceMutation();
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('HEAD_COMMIT_MISMATCH');
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, clusterHead: mutatedHead })).rejects.toThrow('SOURCE_CHANGED_AFTER_RESULT_GENERATION');
  });

  it('rejects a result copied from another task', async () => {
    await expect(validateTaskAttestation(fixture.task, { ...fixture.result, taskId: 'T-G0-MCP' }, { cwd: fixture.root })).rejects.toThrow('TASK_RESULT_COPIED_FROM_ANOTHER_TASK');
  });

  it('rejects a result copied from another commit', async () => {
    await fixture.commitSourceMutation();
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('HEAD_COMMIT_MISMATCH');
  });

  it('rejects the wrong Git tree hash', async () => {
    const forged = { ...fixture.result, bindings: { ...fixture.result.bindings, headTreeSha: '0'.repeat(40) } };
    await expect(validateTaskAttestation(fixture.task, forged, { cwd: fixture.root })).rejects.toThrow('WRONG_TREE_HASH');
  });

  it('rejects a missing acceptance mapping', async () => {
    const forged = { ...fixture.result, bindings: { ...fixture.result.bindings, acceptanceToTests: fixture.result.bindings.acceptanceToTests.slice(1) } };
    await expect(validateTaskAttestation(fixture.task, forged, { cwd: fixture.root })).rejects.toThrow('ACCEPTANCE_TO_TEST_MAPPING_MISMATCH');
  });

  it('rejects a missing required test artifact', async () => {
    await fixture.removeFirstArtifact();
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root })).rejects.toThrow('MISSING_REQUIRED_TEST_ARTIFACT');
  });

  it('rejects a stale lease fencing version', async () => {
    const stale = { ...fixture.state, leaseVersion: 2 };
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, state: stale })).rejects.toThrow('STALE_LEASE');
  });

  it('rejects a task commit not reachable from the cluster head', async () => {
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, clusterHead: fixture.base })).rejects.toThrow('TASK_COMMIT_NOT_REACHABLE_FROM_CLUSTER_HEAD');
  });
});

describe('live task verification', () => {
  it('rejects task completion without a live lease, task branch and atomic commit', async () => {
    await expect(verifyTask('T-G0-CORE', 'forged', 1)).rejects.toThrow(
      /NO_ACTIVE_LEASE|WRONG_LEASE_OWNER|LEASE_EXPIRED|STALE_LEASE_VERSION/,
    );
  });
});
