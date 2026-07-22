import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { validateTaskAttestation } from '../../tools/task-verifier/attestation.js';
import { verifyTask } from '../../tools/task-verifier/verify.js';
import { createAttestationFixture, type AttestationFixture } from './attestation-fixture.js';

describe('proof-carrying task verification', () => {
  let fixture: AttestationFixture;
  beforeEach(async () => { fixture = await createAttestationFixture(); });
  afterEach(async () => fixture.cleanup());

  it('accepts complete independently derived evidence', async () => {
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true, state: fixture.state })).resolves.toBeDefined();
  });

  it('rejects a forged PASS with empty evidence', async () => {
    const forged = { ...fixture.result, commandEvidence: [], bindings: { ...fixture.result.bindings, changedFiles: [], requirementToCode: [], acceptanceToTests: [], requiredTestArtifacts: [] } };
    await expect(validateTaskAttestation(fixture.task, forged, { cwd: fixture.root })).rejects.toThrow('TASK_RESULT_SCHEMA_INVALID');
  });

  it('rejects tracked source mutation after result generation', async () => {
    await writeFile(`${fixture.root}/${fixture.codePath}`, 'export const attested = false;\n');
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('DIRTY_TRACKED_SOURCE');
  });

  it('rejects a committed source mutation after result generation', async () => {
    await fixture.commitSourceMutation();
    await expect(validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, currentHeadRequired: true })).rejects.toThrow('HEAD_COMMIT_MISMATCH');
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
    await expect(verifyTask('T-G0-CORE', 'forged', 1)).rejects.toThrow('NO_ACTIVE_LEASE');
  });
});
