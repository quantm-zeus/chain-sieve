import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadAndValidateSpecification, sha256 } from '../prd-compiler/compiler.js';
import { loadTasks, verifyTaskContract } from '../task-verifier/verify.js';
import { registerCurrentEvidence } from './evidence-ledger.js';
import { loadRepairLeaseContracts } from './repair-contract.js';
import { performTaskSelfReview } from './self-review.js';
import {
  acquire,
  assertLease,
  currentLeaseCredential,
  markReady,
  markValidated,
  readState,
  refreshReady,
  releaseLease,
  renewLease,
  transition,
  writeState,
  type EvidenceReference,
} from './state.js';
import { productValidationInput, validateLifecycleContract, type LifecycleValidationInput } from './validator.js';

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const git = (args: string[]): string => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`GIT_FAILED:${args.join(':')}`);
  return result.stdout.trim();
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
    await readFile(`artifacts/context/${repair.id}/attestation-findings.json`, 'utf8'),
  ) as { findings: Array<{ id: string }> };
  const obligations = JSON.parse(
    await readFile(`artifacts/context/${repair.id}/proof-obligations.json`, 'utf8'),
  ) as { requiredScenarios: string[] };
  const requirements = findings.findings.map((finding) => finding.id);
  const acceptanceCriteria = obligations.requiredScenarios.map((scenario) => `SCENARIO-${scenario}`);
  return {
    ...repair,
    contractPath: repair.contractPath,
    contractText,
    sourceHashes: specification.hashes,
    expectedSourceHashes: specification.hashes,
    requirements,
    acceptanceCriteria,
    requirementOwners: Object.fromEntries(requirements.map((id) => [id, repair.id])),
    acceptanceOwners: Object.fromEntries(acceptanceCriteria.map((id) => [id, repair.id])),
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
try {
  const productTasks = await loadTasks();
  const repairTasks = await loadRepairLeaseContracts();
  const tasks = [...productTasks, ...repairTasks];
  const state = await readState(tasks);
  if (command === 'list') console.log(JSON.stringify(Object.values(state.tasks), null, 2));
  else if (command === 'ready')
    console.log(JSON.stringify(Object.values(state.tasks).filter((task) => task.state === 'READY'), null, 2));
  else if (!taskId) throw new Error('TASK_ID_REQUIRED');
  else if (command === 'validate') {
    const product = productTasks.find((task) => task.id === taskId);
    const repair = repairTasks.find((task) => task.id === taskId);
    if (!product && !repair) throw new Error('TASK_NOT_FOUND');
    if (product) await verifyTaskContract(taskId);
    const specification = await loadAndValidateSpecification();
    const input = product
      ? await productValidationInput(product, specification.hashes)
      : await repairValidationInput(repair!);
    const { evidence, artifact } = await validateLifecycleContract(input);
    markValidated(state.tasks[taskId]!, evidence);
    await writeState(state);
    console.log(JSON.stringify({ status: 'VALIDATED', artifact, evidence }, null, 2));
  } else if (command === 'mark-ready') {
    markReady(state, tasks, taskId);
    await writeState(state);
    console.log(JSON.stringify(state.tasks[taskId], null, 2));
  } else if (command === 'acquire') {
    const repair = repairTasks.find((task) => task.id === taskId);
    const expected = repair?.approvedBranch ?? `task/${taskId.toLowerCase()}`;
    const branch = git(['branch', '--show-current']);
    if (branch !== expected) throw new Error(`TASK_BRANCH_REQUIRED:${expected}`);
    const lease = acquire(state, tasks, taskId, holder, new Date(), 900_000, git(['rev-parse', 'HEAD']), branch);
    await writeState(state);
    console.log(JSON.stringify(lease, null, 2));
  } else {
    const version = Number(option('--lease-version'));
    const target = assertLease(state, taskId, version, holder, new Date());
    const credential = currentLeaseCredential(target);
    if (command === 'renew') {
      const lease = renewLease(state, credential, new Date());
      await writeState(state);
      console.log(JSON.stringify(lease, null, 2));
    } else if (command === 'begin') {
      const expected =
        repairTasks.find((task) => task.id === taskId)?.approvedBranch ?? `task/${taskId.toLowerCase()}`;
      const branch = git(['branch', '--show-current']);
      if (branch !== expected || target.branch !== expected) throw new Error(`TASK_BRANCH_MISMATCH:${branch}`);
      if (git(['status', '--porcelain']) !== '') throw new Error('DIRTY_WORKTREE');
      if (git(['rev-parse', 'HEAD']) !== target.baseCommit) throw new Error('TASK_BASE_COMMIT_MISMATCH');
      if (!repairTasks.some((task) => task.id === taskId)) await verifyTaskContract(taskId);
      target.worktree = git(['rev-parse', '--show-toplevel']);
      transition(target, ['LEASED'], 'IMPLEMENTING', {
        command: 'task:begin',
        credential,
        worktreeValid: true,
      });
      await writeState(state);
      console.log(JSON.stringify(target, null, 2));
    } else if (command === 'self-review') {
      const task = productTasks.find((item) => item.id === taskId);
      if (!task) throw new Error('PRODUCT_TASK_SELF_REVIEW_CONTRACT_REQUIRED');
      const commit = git(['rev-parse', 'HEAD']);
      const tree = git(['rev-parse', 'HEAD^{tree}']);
      const implementationEvidence: EvidenceReference = {
        path: `git:${commit}`,
        sha256: sha256(`${commit}:${tree}`),
        status: 'CURRENT',
        commit,
        tree,
      };
      transition(target, ['IMPLEMENTING'], 'SELF_REVIEWING', {
        command: 'task:self-review',
        credential,
        evidence: implementationEvidence,
      });
      await writeState(state);
      const review = await performTaskSelfReview(task, target, holder);
      target.selfReviewEvidence = review.evidence;
      await registerCurrentEvidence(taskId, 'SELF_REVIEW', review.evidence);
      await writeState(state);
      console.log(JSON.stringify({ ...target, selfReview: review }, null, 2));
    } else if (command === 'complete') {
      if (target.state !== 'VERIFIED' || !target.commit) throw new Error('INDEPENDENT_VERIFICATION_REQUIRED');
      console.log(JSON.stringify(target, null, 2));
    } else if (command === 'release') {
      releaseLease(target, credential);
      refreshReady(state, tasks);
      await writeState(state);
      console.log(JSON.stringify(target, null, 2));
    } else throw new Error(`UNKNOWN_COMMAND:${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
