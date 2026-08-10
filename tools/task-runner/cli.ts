import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadAndValidateSpecification, sha256 } from '../prd-compiler/compiler.js';
import { loadTasks, verifyTaskContract } from '../task-verifier/verify.js';
import { registerCurrentEvidence } from './evidence-ledger.js';
import { loadRepairLeaseContracts } from './repair-contract.js';
import { performTaskSelfReview } from './self-review.js';
import { correctTaskSelfReview } from './self-review-correct.js';
import { refreshTaskSelfReview } from './self-review-refresh.js';
import {
  acquire,
  acquireLifecycleMutationLock,
  AGENT_LEASE_TTL_MINUTES,
  assertAgentLeaseTtlMinutes,
  assertLease,
  currentLeaseCredential,
  markReady,
  markValidated,
  readState,
  refreshReady,
  releaseLease,
  transition,
  writeState,
  type EvidenceReference,
} from './state.js';
import {
  productValidationInput,
  validateLifecycleContract,
  type LifecycleValidationInput,
} from './validator.js';
import { taskBranch } from '../worktree-manager/identity.js';
import {
  persistLifecycleAuthority,
  validateVerificationBaseline,
} from './authority.js';

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const git = (args: string[]): string => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}`);
  return result.stdout.trim();
};
const gitOptional = (args: string[]): string | undefined => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const trustedRoot = (): string => {
  if (
    process.env.CIAG_LIFECYCLE_HARNESS === '1' &&
    process.env.CIAG_TRUSTED_CONTROL_PLANE
  )
    return process.env.CIAG_TRUSTED_CONTROL_PLANE;
  const blocks = git(['worktree', 'list', '--porcelain']).split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.includes('branch refs/heads/main')) {
      const worktree = lines.find((line) => line.startsWith('worktree '));
      if (worktree) return worktree.slice('worktree '.length);
    }
  }
  throw new Error('TRUSTED_MAIN_WORKTREE_NOT_FOUND');
};
const yamlList = (yaml: string, key: string): string[] => {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) throw new Error(`REPAIR_CONTRACT_FIELD_MISSING:${key}`);
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/.test(line)) break;
    const match = /^ {2}- (.+)$/.exec(line);
    if (match) values.push(match[1]!);
  }
  return values;
};

const repairValidationInput = async (
  repair: Awaited<ReturnType<typeof loadRepairLeaseContracts>>[number],
): Promise<LifecycleValidationInput> => {
  const specification = await loadAndValidateSpecification();
  const contractText = await readFile(repair.contractPath, 'utf8');
  const findings = JSON.parse(
    await readFile(
      `artifacts/context/${repair.id}/attestation-findings.json`,
      'utf8',
    ),
  ) as { findings: Array<{ id: string }> };
  const obligations = JSON.parse(
    await readFile(
      `artifacts/context/${repair.id}/proof-obligations.json`,
      'utf8',
    ),
  ) as { requiredScenarios: string[] };
  const requirements = findings.findings.map((finding) => finding.id);
  const acceptanceCriteria = obligations.requiredScenarios.map(
    (scenario) => `SCENARIO-${scenario}`,
  );
  return {
    ...repair,
    contractPath: repair.contractPath,
    contractText,
    sourceHashes: specification.hashes,
    expectedSourceHashes: specification.hashes,
    requirements,
    acceptanceCriteria,
    requirementOwners: Object.fromEntries(
      requirements.map((id) => [id, repair.id]),
    ),
    acceptanceOwners: Object.fromEntries(
      acceptanceCriteria.map((id) => [id, repair.id]),
    ),
    allowedPaths: yamlList(contractText, 'allowed_paths'),
    forbiddenPaths: yamlList(contractText, 'forbidden_paths'),
    requiredCommands: yamlList(contractText, 'required_commands'),
    contextFiles: [
      `artifacts/context/${repair.id}/context-manifest.json`,
      `artifacts/context/${repair.id}/lease-contract.json`,
      `artifacts/context/${repair.id}/attestation-findings.json`,
      `artifacts/context/${repair.id}/proof-obligations.json`,
      `artifacts/context/${repair.id}/source-integrity.json`,
    ],
    graphFiles: [`artifacts/context/${repair.id}/context-manifest.json`],
    clusterReference: repair.id,
  };
};

const command = process.argv[2] ?? 'list';
const taskId = process.argv[3];
const holder = option('--holder') ?? process.env.USER ?? 'local-agent';
const readOnlyCommands = new Set(['list', 'ready']);
let releaseMutationLock: (() => Promise<void>) | undefined;
try {
  if (!readOnlyCommands.has(command))
    releaseMutationLock = await acquireLifecycleMutationLock();

  const productTasks = await loadTasks();
  const repairTasks = await loadRepairLeaseContracts();
  const tasks = [...productTasks, ...repairTasks];
  const state = await readState(tasks);
  if (command === 'list')
    console.log(JSON.stringify(Object.values(state.tasks), null, 2));
  else if (command === 'ready') {
    const runnable = new Set(
      productTasks
        .filter((task) => task.specificationStatus === 'READY')
        .map((task) => task.id),
    );
    console.log(
      JSON.stringify(
        Object.values(state.tasks).filter(
          (task) => task.state === 'READY' && runnable.has(task.taskId),
        ),
        null,
        2,
      ),
    );
  } else if (!taskId) throw new Error('TASK_ID_REQUIRED');
  else if (command === 'self-review-correct') {
    const targetWorktree = option('--target-worktree');
    if (!targetWorktree) throw new Error('TARGET_WORKTREE_REQUIRED');
    const expectedPreviousCommit = option('--expected-previous-commit');
    if (!expectedPreviousCommit)
      throw new Error('EXPECTED_PREVIOUS_COMMIT_REQUIRED');
    const failureCode = option('--failure-code');
    if (!failureCode) throw new Error('CORRECTION_FAILURE_CODE_REQUIRED');
    const result = await correctTaskSelfReview(
      taskId,
      holder,
      Number(option('--lease-version')),
      targetWorktree,
      expectedPreviousCommit,
      failureCode,
      { trustedRoot: process.cwd() },
    );
    console.log(
      JSON.stringify(
        { status: 'TASK_SELF_REVIEW_CORRECTED', result },
        null,
        2,
      ),
    );
  } else if (command === 'self-review-refresh') {
    const targetWorktree = option('--target-worktree');
    if (!targetWorktree) throw new Error('TARGET_WORKTREE_REQUIRED');
    const result = await refreshTaskSelfReview(
      taskId,
      holder,
      Number(option('--lease-version')),
      targetWorktree,
      { trustedRoot: process.cwd() },
    );
    console.log(
      JSON.stringify({ status: 'SELF_REVIEW_REFRESHED', result }, null, 2),
    );
  } else if (command === 'validate') {
    const product = productTasks.find((task) => task.id === taskId);
    const repair = repairTasks.find((task) => task.id === taskId);
    if (!product && !repair) throw new Error('TASK_NOT_FOUND');
    if (product?.specificationStatus === 'SPECIFICATION_GAP') {
      const target = state.tasks[taskId]!;
      const from = target.state;
      target.state = 'BLOCKED';
      target.blockedReason = 'SPECIFICATION_GAP';
      target.history ??= [];
      target.history.push({
        from,
        to: 'BLOCKED',
        at: new Date().toISOString(),
        command: 'task:validate:specification-gap',
      });
      await writeState(state);
      console.log(
        JSON.stringify(
          { status: 'BLOCKED', reason: 'SPECIFICATION_GAP', taskId },
          null,
          2,
        ),
      );
    } else {
      if (product) await verifyTaskContract(taskId);
      const specification = await loadAndValidateSpecification();
      const input = product
        ? await productValidationInput(product, specification.hashes)
        : await repairValidationInput(repair!);
      const { evidence, artifact } = await validateLifecycleContract(input);
      markValidated(state.tasks[taskId]!, evidence);
      await writeState(state);
      console.log(
        JSON.stringify({ status: 'VALIDATED', artifact, evidence }, null, 2),
      );
    }
  } else if (command === 'mark-ready') {
    markReady(state, tasks, taskId);
    await writeState(state);
    console.log(JSON.stringify(state.tasks[taskId], null, 2));
  } else if (command === 'acquire') {
    const repair = repairTasks.find((task) => task.id === taskId);
    const expected = repair?.approvedBranch ?? taskBranch(taskId);
    const branch = git(['branch', '--show-current']);
    if (branch !== expected) throw new Error(`TASK_BRANCH_REQUIRED:${expected}`);
    const ttlMinutes = assertAgentLeaseTtlMinutes(
      Number(option('--ttl-minutes') ?? AGENT_LEASE_TTL_MINUTES.default),
    );
    const lease = acquire(
      state,
      tasks,
      taskId,
      holder,
      new Date(),
      ttlMinutes * 60_000,
      git(['rev-parse', 'HEAD']),
      branch,
    );
    const product = productTasks.find((task) => task.id === taskId);
    if (product) {
      const authorityRoot = trustedRoot();
      const authority = await persistLifecycleAuthority({
        trustedRoot: authorityRoot,
        taskRoot: process.cwd(),
        task: product,
        state: state.tasks[taskId]!,
        contractPath: `tasks/${product.dependencyGroup}/${product.id}.contract.json`,
        contextManifestPath: `artifacts/context/${product.id}/context-manifest.json`,
        contractMode: 'GENERATED',
      });
      state.tasks[taskId]!.lifecycleBinding = authority.binding;
      state.tasks[taskId]!.verificationBaseline = authority.baseline;
      await validateVerificationBaseline(
        authorityRoot,
        state.tasks[taskId]!,
      );
    }
    await writeState(state);
    console.log(JSON.stringify(lease, null, 2));
  } else {
    const version = Number(option('--lease-version'));
    const target = assertLease(state, taskId, version, holder, new Date());
    const credential = currentLeaseCredential(target);
    if (command === 'renew') {
      throw new Error(
        `IMPLICIT_RENEWAL_PROHIBITED:USE_AGENT_RENEW:${taskId}:${credential.leaseId}:${credential.fencingVersion}`,
      );
    } else if (command === 'begin') {
      const expected =
        repairTasks.find((task) => task.id === taskId)?.approvedBranch ??
        taskBranch(taskId);
      const branch = git(['branch', '--show-current']);
      if (branch !== expected || target.branch !== expected)
        throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
      if (git(['status', '--porcelain']) !== '')
        throw new Error('DIRTY_WORKTREE');
      if (git(['rev-parse', 'HEAD']) !== target.baseCommit)
        throw new Error('TASK_BASE_COMMIT_MISMATCH');
      if (!repairTasks.some((task) => task.id === taskId))
        await verifyTaskContract(taskId);
      target.worktree = git(['rev-parse', '--show-toplevel']);
      transition(target, ['LEASED'], 'IMPLEMENTING', {
        command: 'task:begin',
        credential,
        worktreeValid: true,
      });
      await writeState(state);
      console.log(JSON.stringify(target, null, 2));
    } else if (command === 'checkpoint-adopt') {
      const expected =
        repairTasks.find((task) => task.id === taskId)?.approvedBranch ??
        taskBranch(taskId);
      if (target.branch !== expected)
        throw new Error(`TASK_BRANCH_BINDING_MISMATCH:${target.branch ?? 'missing'}:${expected}`);
      if (git(['status', '--porcelain']) !== '')
        throw new Error('DIRTY_WORKTREE');
      if (!target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISSING');
      const head = git(['rev-parse', 'HEAD']);
      if (head === target.baseCommit) throw new Error('TASK_COMMIT_MISSING');
      if (Number(git(['rev-list', '--count', `${target.baseCommit}..${head}`])) !== 1)
        throw new Error('TASK_COMMIT_NOT_ATOMIC');
      const currentBranch = git(['branch', '--show-current']);
      if (currentBranch !== expected) {
        const expectedRef = gitOptional([
          'rev-parse',
          '--verify',
          `refs/heads/${expected}`,
        ]);
        if (
          expectedRef &&
          expectedRef !== target.baseCommit &&
          expectedRef !== head
        )
          throw new Error(
            `TASK_CHECKPOINT_BRANCH_DIVERGED:${taskId}:${expectedRef}:${head}`,
          );
        git(['switch', '-C', expected, head]);
      }
      if (target.state === 'LEASED') {
        target.worktree = git(['rev-parse', '--show-toplevel']);
        transition(target, ['LEASED'], 'IMPLEMENTING', {
          command: 'task:checkpoint-adopt',
          credential,
          worktreeValid: true,
        });
        await writeState(state);
      } else if (target.state !== 'IMPLEMENTING') {
        throw new Error(`TASK_CHECKPOINT_ADOPT_STATE_INVALID:${target.state}`);
      }
      console.log(
        JSON.stringify(
          { status: 'TASK_CHECKPOINT_ADOPTED', taskId, head, state: target },
          null,
          2,
        ),
      );
    } else if (command === 'self-review') {
      const task = productTasks.find((item) => item.id === taskId);
      if (!task) throw new Error('PRODUCT_TASK_SELF_REVIEW_CONTRACT_REQUIRED');
      const recoveringIncompleteReview =
        target.state === 'SELF_REVIEWING' && !target.selfReviewEvidence;
      if (target.state !== 'IMPLEMENTING' && !recoveringIncompleteReview)
        throw new Error(`TASK_SELF_REVIEW_STATE_INVALID:${target.state}`);
      const commit = git(['rev-parse', 'HEAD']);
      const tree = git(['rev-parse', 'HEAD^{tree}']);
      const implementationEvidence: EvidenceReference = {
        path: `git:${commit}`,
        sha256: sha256(`${commit}:${tree}`),
        status: 'CURRENT',
        commit,
        tree,
      };
      const launchReceiptId = option('--launch-receipt-id');
      const review = await performTaskSelfReview(
        task,
        target,
        holder,
        process.cwd(),
        { ...(launchReceiptId ? { launchReceiptId } : {}) },
      );
      if (target.state === 'IMPLEMENTING')
        transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING', {
          command: 'task:self-review',
          credential,
          evidence: implementationEvidence,
        });
      target.selfReviewEvidence = review.evidence;
      await registerCurrentEvidence(taskId, 'SELF_REVIEW', review.evidence);
      await writeState(state);
      console.log(JSON.stringify({ ...target, selfReview: review }, null, 2));
    } else if (command === 'complete') {
      if (target.state !== 'VERIFIED' || !target.commit)
        throw new Error('INDEPENDENT_VERIFICATION_REQUIRED');
      console.log(JSON.stringify(target, null, 2));
    } else if (command === 'release') {
      releaseLease(target, credential);
      refreshReady(state, tasks);
      await writeState(state);
      console.log(JSON.stringify(target, null, 2));
    } else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await releaseMutationLock?.();
}
