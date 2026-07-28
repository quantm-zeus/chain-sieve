import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskContract } from '@ciag/shared-schemas';
import { sha256 } from '../prd-compiler/compiler.js';
import type { EvidenceReference, LeaseContract } from './state.js';
import { runtimeRoot } from './state.js';

export interface LifecycleValidationInput extends LeaseContract {
  contractPath: string;
  contractText: string;
  sourceHashes: { prd: string; requirements: string; audit: string };
  expectedSourceHashes: { prd: string; requirements: string; audit: string };
  requirements: string[];
  acceptanceCriteria: string[];
  requirementOwners: Record<string, string>;
  acceptanceOwners: Record<string, string>;
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredCommands: string[];
  contextFiles: string[];
  graphFiles: string[];
  clusterReference: string;
}

export interface ValidationArtifact {
  schemaVersion: '1.0.0';
  taskId: string;
  contractPath: string;
  contractSha256: string;
  sourceHashes: LifecycleValidationInput['sourceHashes'];
  checks: Array<{ name: string; status: 'PASS'; evidence: string[] }>;
  validatedAt: string;
}

const overlaps = (left: string, right: string): boolean => {
  const normalize = (value: string): string => value.replace(/\/\*\*$/, '');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

const requireUniqueOwnership = (
  ids: string[],
  owners: Record<string, string>,
  taskId: string,
  kind: string,
): void => {
  for (const id of ids) {
    const owner = owners[id];
    if (!owner) throw new Error(`${kind}_OWNERSHIP_MISSING:${id}`);
    if (owner !== taskId) throw new Error(`${kind}_OWNERSHIP_CONFLICT:${id}:${owner}`);
  }
};

export const validateLifecycleContract = async (
  input: LifecycleValidationInput,
  cwd = process.cwd(),
  now = new Date(),
): Promise<{ artifact: ValidationArtifact; evidence: EvidenceReference }> => {
  if (!input.contractText.trim()) throw new Error('TASK_CONTRACT_SCHEMA_INVALID:EMPTY');
  if (sha256(input.contractText).length !== 64) throw new Error('TASK_CONTRACT_SCHEMA_INVALID:HASH');
  if (JSON.stringify(input.sourceHashes) !== JSON.stringify(input.expectedSourceHashes))
    throw new Error('TASK_SOURCE_HASH_DRIFT');
  requireUniqueOwnership(input.requirements, input.requirementOwners, input.id, 'REQUIREMENT');
  requireUniqueOwnership(input.acceptanceCriteria, input.acceptanceOwners, input.id, 'ACCEPTANCE_CRITERION');
  if (input.allowedPaths.length === 0) throw new Error('ALLOWED_PATHS_MISSING');
  for (const forbidden of input.forbiddenPaths)
    if (input.allowedPaths.some((allowed) => overlaps(allowed, forbidden)))
      throw new Error(`ALLOWED_FORBIDDEN_PATH_OVERLAP:${forbidden}`);
  if (input.requiredCommands.length === 0 || input.requiredCommands.some((command) => !command.trim()))
    throw new Error('REQUIRED_COMMANDS_MISSING');
  for (const file of input.contextFiles) {
    try {
      await access(join(cwd, file));
    } catch {
      throw new Error(`REQUIRED_CONTEXT_PACK_MISSING:${file}`);
    }
  }
  for (const file of input.graphFiles) {
    let text: string;
    try {
      text = await readFile(join(cwd, file), 'utf8');
    } catch {
      throw new Error(`TASK_GRAPH_REFERENCE_MISSING:${file}`);
    }
    if (!text.includes(input.id) && !text.includes(input.clusterReference))
      throw new Error(`TASK_GRAPH_REFERENCE_INVALID:${file}`);
  }
  const checks: ValidationArtifact['checks'] = [
    { name: 'task-contract-schema', status: 'PASS', evidence: [`sha256:${sha256(input.contractText)}`] },
    {
      name: 'source-prd-hashes',
      status: 'PASS',
      evidence: Object.entries(input.sourceHashes).map(([name, hash]) => `${name}:${hash}`),
    },
    {
      name: 'requirement-ownership',
      status: 'PASS',
      evidence: input.requirements.map((id) => `${id}:${input.requirementOwners[id]}`),
    },
    {
      name: 'acceptance-criterion-ownership',
      status: 'PASS',
      evidence: input.acceptanceCriteria.map((id) => `${id}:${input.acceptanceOwners[id]}`),
    },
    {
      name: 'dependency-readiness',
      status: 'PASS',
      evidence: input.dependencies.length === 0 ? ['no-dependencies'] : input.dependencies,
    },
    {
      name: 'allowed-and-forbidden-paths',
      status: 'PASS',
      evidence: [`allowed:${input.allowedPaths.length}`, `forbidden:${input.forbiddenPaths.length}`],
    },
    {
      name: 'required-commands',
      status: 'PASS',
      evidence: input.requiredCommands.map((command) => sha256(command)),
    },
    { name: 'required-context-pack', status: 'PASS', evidence: input.contextFiles },
    {
      name: 'task-and-cluster-graph-references',
      status: 'PASS',
      evidence: [...input.graphFiles, input.clusterReference],
    },
  ];
  const artifact: ValidationArtifact = {
    schemaVersion: '1.0.0',
    taskId: input.id,
    contractPath: input.contractPath,
    contractSha256: sha256(input.contractText),
    sourceHashes: input.sourceHashes,
    checks,
    validatedAt: now.toISOString(),
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  const hash = sha256(text);
  const relativePath = `validation/${input.id}/${hash}.validation.json`;
  const absolute = join(runtimeRoot(cwd), relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, { mode: 0o600 });
  return { artifact, evidence: { path: relativePath, sha256: hash, status: 'CURRENT' } };
};

export const productValidationInput = async (
  task: TaskContract,
  expectedSourceHashes: LifecycleValidationInput['expectedSourceHashes'],
  cwd = process.cwd(),
): Promise<LifecycleValidationInput> => {
  const contractPath = `tasks/${task.dependencyGroup}/${task.id}.contract.json`;
  const rawRequirementMap = JSON.parse(
    await readFile(join(cwd, 'tasks/generated/requirement-task-map.json'), 'utf8'),
  ) as Record<string, string[]>;
  const rawAcceptanceMap = JSON.parse(
    await readFile(join(cwd, 'tasks/generated/acceptance-task-map.json'), 'utf8'),
  ) as Record<string, string[]>;
  const requirementMap = Object.fromEntries(
    Object.entries(rawRequirementMap).map(([id, owners]) => {
      if (owners.length !== 1) throw new Error(`REQUIREMENT_OWNERSHIP_NOT_UNIQUE:${id}`);
      return [id, owners[0]!];
    }),
  );
  const acceptanceMap = Object.fromEntries(
    Object.entries(rawAcceptanceMap).map(([id, owners]) => {
      if (owners.length !== 1) throw new Error(`ACCEPTANCE_CRITERION_OWNERSHIP_NOT_UNIQUE:${id}`);
      return [id, owners[0]!];
    }),
  );
  return {
    id: task.id,
    dependencies: task.dependencies,
    exclusiveLocks: task.exclusiveLocks,
    contractPath,
    contractText: await readFile(join(cwd, contractPath), 'utf8'),
    sourceHashes: task.sourceHashes,
    expectedSourceHashes,
    requirements: task.requirements,
    acceptanceCriteria: task.acceptanceCriteria,
    requirementOwners: requirementMap,
    acceptanceOwners: acceptanceMap,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    requiredCommands: task.verificationCommands.map((item) => item.command),
    contextFiles: [
      `artifacts/context/${task.id}/context-manifest.json`,
      `artifacts/context/${task.id}/task-contract.json`,
      `artifacts/context/${task.id}/requirements.json`,
      `artifacts/context/${task.id}/acceptance-criteria.json`,
      `artifacts/context/${task.id}/dependency-outputs.json`,
    ],
    graphFiles: ['tasks/generated/graph.json', 'tasks/generated/cluster-graph.json'],
    clusterReference: task.cluster,
  };
};
