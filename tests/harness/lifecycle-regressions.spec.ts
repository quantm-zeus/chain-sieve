import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import {
  assertEvidenceCurrent,
  invalidateRebaseEvidence,
  registerCurrentEvidence,
} from '../../tools/task-runner/evidence-ledger.js';
import {
  transition,
  type EvidenceReference,
  type TaskState,
} from '../../tools/task-runner/state.js';
import { validateTaskAttestation } from '../../tools/task-verifier/attestation.js';
import { runtimeRoot } from '../../tools/task-runner/state.js';
import { deriveLifecycleVerdict } from '../../tools/merge-queue/lifecycle-manifest.js';
import { createAttestationFixture } from './attestation-fixture.js';
import { validLifecycleManifest } from './git-lifecycle.spec.js';
import {
  readArchivedBoundTaskContract,
  readBoundTaskContract,
  type LifecycleBindingDocument,
} from '../../tools/task-runner/authority.js';
import { deriveClusterTaskAttestations } from '../../tools/cluster-verifier/verification.js';
import { TrustedPathError } from '../../tools/agent/lib/trusted-path.js';

const current = (name: string, commit = '1'.repeat(40), tree = '2'.repeat(40)): EvidenceReference => ({
  path: `${name}.json`,
  sha256: sha256(name),
  status: 'CURRENT',
  commit,
  tree,
});

const cleanedLegacyFixture = async () => {
  const fixture = await createAttestationFixture();
  const bindingPath = join(runtimeRoot(fixture.root), 'lifecycle-binding.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as LifecycleBindingDocument;
  const missingRoot = join(fixture.root, 'cleaned-task-worktree');
  binding.bindingRoot = missingRoot;
  binding.contractMode = 'LEGACY';
  const persist = async (): Promise<void> => {
    const text = `${JSON.stringify(binding, null, 2)}\n`;
    await writeFile(bindingPath, text);
    fixture.state.completedLifecycleBinding = {
      path: 'lifecycle-binding.json', sha256: sha256(text), status: 'CURRENT',
    };
  };
  await persist();
  fixture.state.completedVerificationBaseline = fixture.state.verificationBaseline!;
  delete fixture.state.lifecycleBinding;
  delete fixture.state.verificationBaseline;
  fixture.state.state = 'MERGED';
  fixture.state.leaseState = 'COMPLETED';
  fixture.state.commit = fixture.head;
  return { fixture, binding, missingRoot, persist };
};

describe('lifecycle attestation regressions', () => {
  it('preserves the archived legacy contract through merge, cleanup, and cluster verification', async () => {
    const fixture = await createAttestationFixture();
    try {
      const bindingPath = join(runtimeRoot(fixture.root), 'lifecycle-binding.json');
      const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
      const originalWorktree = join(fixture.root, 'original-task-worktree');
      const contractPath = String(binding.contractPath);
      await mkdir(join(originalWorktree, dirname(contractPath)), { recursive: true });
      const contractText = await readFile(join(fixture.root, contractPath), 'utf8');
      await writeFile(join(originalWorktree, contractPath), contractText);
      binding.bindingRoot = originalWorktree;
      binding.contractMode = 'LEGACY';
      const bindingText = `${JSON.stringify(binding, null, 2)}\n`;
      await writeFile(bindingPath, bindingText);
      const bindingEvidence = {
        path: 'lifecycle-binding.json', sha256: sha256(bindingText), status: 'CURRENT' as const,
      };
      fixture.state.lifecycleBinding = bindingEvidence;
      fixture.result.bindings.lifecycleBindingSha256 = bindingEvidence.sha256;
      const reviewPath = join(runtimeRoot(fixture.root), fixture.result.bindings.selfReviewPath);
      const review = JSON.parse(await readFile(reviewPath, 'utf8')) as Record<string, unknown>;
      review.lifecycleBindingSha256 = bindingEvidence.sha256;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText);
      fixture.result.bindings.selfReviewSha256 = sha256(reviewText);

      const credential = {
        taskId: fixture.task.id,
        holder: fixture.state.holder!,
        leaseId: fixture.state.leaseId!,
        fencingVersion: fixture.state.leaseVersion,
      };
      const reviewEvidence: EvidenceReference = {
        path: fixture.result.bindings.selfReviewPath,
        sha256: fixture.result.bindings.selfReviewSha256,
        status: 'CURRENT', commit: fixture.head, tree: fixture.result.bindings.headTreeSha,
      };
      await registerCurrentEvidence(fixture.task.id, 'SELF_REVIEW', reviewEvidence, fixture.root);
      transition(fixture.state, ['SELF_REVIEWING'], 'VERIFYING', {
        command: 'task:verify', credential, evidence: reviewEvidence,
        currentCommit: fixture.head, currentTree: fixture.result.bindings.headTreeSha,
      });
      await expect(validateTaskAttestation(fixture.task, fixture.result, {
        cwd: fixture.root, state: fixture.state,
      })).resolves.toBeDefined();
      const resultPath = `results/${fixture.task.id}.result.json`;
      const resultText = `${JSON.stringify(fixture.result, null, 2)}\n`;
      await mkdir(dirname(join(runtimeRoot(fixture.root), resultPath)), { recursive: true });
      await writeFile(join(runtimeRoot(fixture.root), resultPath), resultText);
      const resultEvidence: EvidenceReference = {
        path: resultPath, sha256: sha256(resultText), status: 'CURRENT',
        commit: fixture.head, tree: fixture.result.bindings.headTreeSha,
      };
      const verificationEvidence: EvidenceReference = {
        path: 'verification.json', sha256: sha256('verification'), status: 'CURRENT',
        commit: fixture.head, tree: fixture.result.bindings.headTreeSha,
      };
      await registerCurrentEvidence(fixture.task.id, 'TASK_RESULT', resultEvidence, fixture.root);
      await registerCurrentEvidence(fixture.task.id, 'VERIFICATION', verificationEvidence, fixture.root);
      fixture.state.taskResultEvidence = resultEvidence;
      transition(fixture.state, ['VERIFYING'], 'VERIFIED', {
        command: 'task:verify:proof-carrying', credential, evidence: verificationEvidence,
      });
      fixture.state.commit = fixture.head;
      fixture.state.tree = fixture.result.bindings.headTreeSha;
      transition(fixture.state, ['VERIFIED'], 'MERGE_QUEUED', {
        command: 'merge-queue:add', credential,
        currentCommit: fixture.head, currentTree: fixture.result.bindings.headTreeSha,
      });
      transition(fixture.state, ['MERGE_QUEUED'], 'MERGED', {
        command: 'merge-queue:process', credential, mergeQueueProcessed: true,
      });
      fixture.state.leaseState = 'COMPLETED';
      fixture.state.completedLifecycleBinding = fixture.state.lifecycleBinding;
      fixture.state.completedVerificationBaseline = fixture.state.verificationBaseline!;
      delete fixture.state.lifecycleBinding;
      delete fixture.state.verificationBaseline;
      await rm(originalWorktree, { recursive: true });

      const bound = await readBoundTaskContract(fixture.root, fixture.state, true);
      expect(bound?.id).toBe(fixture.task.id);
      expect(sha256(contractText)).toBe(String(binding.contractSha256));
      await expect(validateTaskAttestation(fixture.task, fixture.result, {
        cwd: fixture.root, state: fixture.state,
      })).resolves.toBeDefined();
      const lifecycle = { schemaVersion: '2.0.0', tasks: { [fixture.task.id]: fixture.state } } as const;
      const attestations = await deriveClusterTaskAttestations(
        { tasks: [fixture.task.id] } as Parameters<typeof deriveClusterTaskAttestations>[0],
        [fixture.task],
        lifecycle,
        fixture.head,
        fixture.root,
      );
      expect(attestations).toEqual([expect.objectContaining({
        taskId: fixture.task.id,
        taskCommitSha: fixture.head,
      })]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not treat a missing contract inside an existing worktree as cleanup', async () => {
    const prepared = await cleanedLegacyFixture();
    try {
      await mkdir(join(prepared.missingRoot, dirname(prepared.binding.contractPath)), { recursive: true });
      await expect(readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true)).rejects.toMatchObject({
        code: 'TRUSTED_PATH_CONTAINMENT', operation: 'LSTAT_FILE', filesystemCauseCode: 'ENOENT',
      });
    } finally { await prepared.fixture.cleanup(); }
  });

  it.each([
    ['contract path escape', async (prepared: Awaited<ReturnType<typeof cleanedLegacyFixture>>) => { prepared.binding.contractPath = '../replacement.json'; await prepared.persist(); }, 'ARCHIVED_CONTRACT_PATH_INVALID'],
    ['missing bound commit', async (prepared: Awaited<ReturnType<typeof cleanedLegacyFixture>>) => { prepared.fixture.state.commit = 'f'.repeat(40); }, 'ARCHIVED_CONTRACT_BOUND_COMMIT_MISSING'],
    ['missing contract blob', async (prepared: Awaited<ReturnType<typeof cleanedLegacyFixture>>) => { prepared.binding.contractPath = 'tasks/G0/missing.contract.json'; await prepared.persist(); }, 'ARCHIVED_CONTRACT_BOUND_BLOB_MISSING'],
    ['wrong contract hash', async (prepared: Awaited<ReturnType<typeof cleanedLegacyFixture>>) => { prepared.binding.contractSha256 = 'f'.repeat(64); await prepared.persist(); }, 'ARCHIVED_CONTRACT_HASH_MISMATCH'],
  ])('rejects archived fallback with %s', async (_name, mutate, error) => {
    const prepared = await cleanedLegacyFixture();
    try {
      await mutate(prepared);
      await expect(readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true)).rejects.toThrow(error);
    } finally { await prepared.fixture.cleanup(); }
  });

  it.each([
    ['wrong task ID', (value: Record<string, unknown>) => { value.id = 'T-G0-WRONG'; }, 'ARCHIVED_CONTRACT_TASK_ID_MISMATCH'],
    ['wrong cluster', (value: Record<string, unknown>) => { value.cluster = 'C-G0-WRONG'; }, 'ARCHIVED_CONTRACT_CLUSTER_ID_MISMATCH'],
    ['wrong source hashes', (value: Record<string, unknown>) => { value.sourceHashes = { prd: 'f'.repeat(64), requirements: 'e'.repeat(64), audit: 'd'.repeat(64) }; }, 'ARCHIVED_CONTRACT_SOURCE_HASH_MISMATCH'],
  ])('rejects an archived blob with %s', async (_name, mutate, error) => {
    const prepared = await cleanedLegacyFixture();
    try {
      const contract = JSON.parse(await readFile(join(prepared.fixture.root, prepared.binding.contractPath), 'utf8')) as Record<string, unknown>;
      mutate(contract);
      const text = `${JSON.stringify(contract, null, 2)}\n`;
      await writeFile(join(prepared.fixture.root, prepared.binding.contractPath), text);
      execFileSync('git', ['add', prepared.binding.contractPath], { cwd: prepared.fixture.root });
      execFileSync('git', ['commit', '-m', `test: ${_name}`], { cwd: prepared.fixture.root });
      prepared.fixture.state.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: prepared.fixture.root, encoding: 'utf8' }).trim();
      prepared.binding.contractSha256 = sha256(text);
      await prepared.persist();
      await expect(readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true)).rejects.toThrow(error);
    } finally { await prepared.fixture.cleanup(); }
  });

  it.each(['EACCES', 'ELOOP'])('never treats structured %s as a cleanup fallback', async (causeCode) => {
    const prepared = await cleanedLegacyFixture();
    try {
      const failure = new TrustedPathError({
        operation: 'LSTAT_DIRECTORY', logicalBindingName: 'BOUND_TASK_CONTRACT:ROOT',
        requestedPath: prepared.missingRoot, trustedRoot: prepared.missingRoot,
        detail: causeCode, filesystemCauseCode: causeCode,
      });
      await expect(readArchivedBoundTaskContract(
        prepared.fixture.root, prepared.fixture.state, prepared.binding, failure,
      )).rejects.toBe(failure);
    } finally { await prepared.fixture.cleanup(); }
  });

  it('rejects symlink and containment substitutions without using the archive', async () => {
    const prepared = await cleanedLegacyFixture();
    try {
      const outside = join(prepared.fixture.root, 'outside');
      await mkdir(outside);
      await symlink(outside, prepared.missingRoot);
      await expect(readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true)).rejects.toThrow('SYMLINK_DIRECTORY');
      await rm(prepared.missingRoot);
      await mkdir(prepared.missingRoot);
      prepared.binding.contractPath = join(prepared.fixture.root, 'tasks/G0/T-G0-CORE.contract.json');
      await prepared.persist();
      await expect(readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true)).rejects.toThrow('CANONICAL_ROOT_ESCAPE');
    } finally { await prepared.fixture.cleanup(); }
  });

  it('never substitutes a current generated replacement for the commit-bound legacy blob', async () => {
    const prepared = await cleanedLegacyFixture();
    try {
      const replacement = JSON.parse(await readFile(join(prepared.fixture.root, prepared.binding.contractPath), 'utf8')) as Record<string, unknown>;
      replacement.title = 'current generated replacement';
      await writeFile(join(prepared.fixture.root, prepared.binding.contractPath), `${JSON.stringify(replacement, null, 2)}\n`);
      const bound = await readBoundTaskContract(prepared.fixture.root, prepared.fixture.state, true);
      expect(bound?.title).not.toBe('current generated replacement');
      expect(bound?.id).toBe(prepared.fixture.task.id);
    } finally { await prepared.fixture.cleanup(); }
  });

  it.each([
    ['DRAFT', 'LIFECYCLE_REQUIRED_STATE_MISSING:DRAFT'],
    ['VALIDATED', 'LIFECYCLE_REQUIRED_STATE_MISSING:VALIDATED'],
  ])('rejects a lifecycle missing %s', (state, reason) => {
    const manifest = validLifecycleManifest();
    manifest.scenarios[0]!.stateTransitionsObserved = manifest.scenarios[0]!.stateTransitionsObserved.filter(
      (item) => item !== state,
    );
    expect(() => deriveLifecycleVerdict(manifest)).toThrow(reason);
  });

  it('rejects a lifecycle that omits lease renewal', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'B')!.leaseVersions = [1];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LEASE_RENEWAL_NOT_OBSERVED');
  });

  it('rejects a lifecycle that accepts the old lease after renewal', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'B')!.commandsExecuted = [];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('OLD_LEASE_REJECTION_NOT_OBSERVED');
  });

  it('rejects a simulation that bypasses the real merge queue', () => {
    const manifest = validLifecycleManifest();
    manifest.harness = 'production-lifecycle';
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'D')!.queueOperations = [];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('REAL_POST_REBASE_TASK_VERIFY_MISSING');
  });

  it('marks and rejects pre-rebase self-review, task-result and verification evidence', async () => {
    const fixture = await createAttestationFixture();
    try {
      const state: TaskState = {
        ...fixture.state,
        state: 'MERGE_QUEUED',
        selfReviewEvidence: current('review', fixture.head, fixture.result.bindings.headTreeSha),
        taskResultEvidence: current('result', fixture.head, fixture.result.bindings.headTreeSha),
        verificationEvidence: current('verification', fixture.head, fixture.result.bindings.headTreeSha),
      };
      await registerCurrentEvidence(fixture.task.id, 'SELF_REVIEW', state.selfReviewEvidence!, fixture.root);
      await registerCurrentEvidence(fixture.task.id, 'TASK_RESULT', state.taskResultEvidence!, fixture.root);
      await registerCurrentEvidence(fixture.task.id, 'VERIFICATION', state.verificationEvidence!, fixture.root);
      const old = structuredClone(state);
      await invalidateRebaseEvidence(state, fixture.root, new Date('2026-07-28T00:00:00Z'));
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'SELF_REVIEW', old.selfReviewEvidence!, fixture.root),
      ).rejects.toThrow('STALE_SELF_REVIEW_EVIDENCE');
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'TASK_RESULT', old.taskResultEvidence!, fixture.root),
      ).rejects.toThrow('STALE_TASK_RESULT_EVIDENCE');
      await expect(
        assertEvidenceCurrent(fixture.task.id, 'VERIFICATION', old.verificationEvidence!, fixture.root),
      ).rejects.toThrow('STALE_VERIFICATION_EVIDENCE');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a post-rebase review bound to the wrong commit', () => {
    const target: TaskState = {
      taskId: 'T',
      state: 'SELF_REVIEWING',
      leaseVersion: 1,
      holder: 'worker',
      leaseId: 'T:1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    expect(() =>
      transition(target, ['SELF_REVIEWING'], 'VERIFYING', {
        command: 'task:verify',
        credential: { taskId: 'T', holder: 'worker', leaseId: 'T:1', fencingVersion: 1 },
        evidence: current('review', '1'.repeat(40), '2'.repeat(40)),
        currentCommit: '3'.repeat(40),
        currentTree: '2'.repeat(40),
      }),
    ).toThrow('SELF_REVIEW_BINDING_MISMATCH');
  });

  it('rejects a post-rebase result bound to the wrong tree', () => {
    const target: TaskState = {
      taskId: 'T',
      state: 'VERIFIED',
      leaseVersion: 1,
      holder: 'worker',
      leaseId: 'T:1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      taskResultEvidence: current('result'),
      verificationEvidence: current('verification'),
    };
    expect(() =>
      transition(target, ['VERIFIED'], 'MERGE_QUEUED', {
        command: 'merge-queue:add',
        credential: { taskId: 'T', holder: 'worker', leaseId: 'T:1', fencingVersion: 1 },
        currentCommit: '1'.repeat(40),
        currentTree: '3'.repeat(40),
      }),
    ).toThrow('MERGE_QUEUE_BINDING_MISMATCH');
  });

  it('rejects a merge queue that skips post-rebase task:verify', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'D')!.queueOperations = [
      'generated-post-rebase-self-review',
    ];
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('REAL_POST_REBASE_TASK_VERIFY_MISSING');
  });

  it('rejects a task result generated before its fresh self-review', async () => {
    const fixture = await createAttestationFixture();
    try {
      const reviewPath = join(runtimeRoot(fixture.root), fixture.result.bindings.selfReviewPath);
      const review = JSON.parse(await readFile(reviewPath, 'utf8')) as { reviewedAt: string };
      review.reviewedAt = '2026-07-22T00:00:00.000Z';
      const text = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, text);
      fixture.result.bindings.selfReviewSha256 = sha256(text);
      await expect(
        validateTaskAttestation(fixture.task, fixture.result, { cwd: fixture.root, state: fixture.state }),
      ).rejects.toThrow('TASK_RESULT_PREDATES_FRESH_SELF_REVIEW');
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts observed cluster advance only with fresh evidence and real verification', () => {
    expect(deriveLifecycleVerdict(validLifecycleManifest()).status).toBe('PASS');
  });

  it('rejects integration failure without an automatic revert', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios.find((scenario) => scenario.scenarioId === 'G')!.revertResult = 'MISSING';
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('AUTOMATIC_REVERT_MISSING');
  });

  it('rejects a lifecycle manifest that omits a required command', () => {
    const manifest = validLifecycleManifest();
    for (const scenario of manifest.scenarios)
      scenario.commandsExecuted = scenario.commandsExecuted.filter((item) => item.command !== 'task:self-review');
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LIFECYCLE_REQUIRED_COMMAND_MISSING:task:self-review');
  });

  it('rejects a manually claimed PASS with a missing phase', () => {
    const manifest = validLifecycleManifest();
    manifest.scenarios = manifest.scenarios.filter((scenario) => scenario.scenarioId !== 'H');
    expect(() => deriveLifecycleVerdict(manifest)).toThrow('LIFECYCLE_SCENARIO_MISSING:H');
  });
});
