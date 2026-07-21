import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadAndValidateSpecification, sha256 } from '../prd-compiler/compiler.js';
import type { LeaseContract } from './state.js';

const RepairLeaseContractSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  id: z.string().regex(/^HARNESS-V\d+\.\d+\.\d+-REPAIR$/),
  contractPath: z.string().regex(/^tasks\/repairs\/HARNESS-V\d+\.\d+\.\d+-REPAIR\.yaml$/),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBranch: z.string().regex(/^fix\/harness-v\d+\.\d+\.\d+-attestation$/),
  sourceHashes: z.object({
    prd: z.string().regex(/^[a-f0-9]{64}$/),
    requirements: z.string().regex(/^[a-f0-9]{64}$/),
    audit: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  dependencies: z.array(z.string()),
  exclusiveLocks: z.array(z.string().min(1)).min(1),
});

export interface RepairLeaseContract extends LeaseContract {
  approvedBranch: string;
  contractPath: string;
  contractSha256: string;
}

const assertContractBinding = (yaml: string, contract: z.infer<typeof RepairLeaseContractSchema>): void => {
  const requiredLines = [
    `id: ${contract.id}`,
    `  approved_branch: ${contract.approvedBranch}`,
    `  prd: ${contract.sourceHashes.prd}`,
    `  requirement_manifest: ${contract.sourceHashes.requirements}`,
    `  audit: ${contract.sourceHashes.audit}`,
    ...contract.exclusiveLocks.map((lock) => `  - ${lock}`),
  ];
  for (const line of requiredLines) if (!yaml.split('\n').includes(line)) throw new Error(`REPAIR_CONTRACT_METADATA_DRIFT:${line.trim()}`);
};

export const loadRepairLeaseContract = async (taskId: string, cwd = process.cwd()): Promise<RepairLeaseContract> => {
  if (!/^HARNESS-V\d+\.\d+\.\d+-REPAIR$/.test(taskId)) throw new Error('REPAIR_TASK_ID_INVALID');
  const metadataPath = join(cwd, 'artifacts/context', taskId, 'lease-contract.json');
  const contract = RepairLeaseContractSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
  if (contract.id !== taskId) throw new Error('REPAIR_CONTRACT_ID_MISMATCH');
  const yaml = await readFile(join(cwd, contract.contractPath), 'utf8');
  if (sha256(yaml) !== contract.contractSha256) throw new Error('REPAIR_CONTRACT_HASH_DRIFT');
  const checksum = await readFile(join(cwd, `tasks/repairs/${taskId}.sha256`), 'utf8');
  if (checksum.trim() !== `${contract.contractSha256}  ${contract.contractPath}`) throw new Error('REPAIR_CONTRACT_CHECKSUM_DRIFT');
  const specification = await loadAndValidateSpecification();
  if (JSON.stringify(specification.hashes) !== JSON.stringify(contract.sourceHashes)) throw new Error('REPAIR_SOURCE_HASH_DRIFT');
  assertContractBinding(yaml, contract);
  return contract;
};

export const loadRepairLeaseContracts = async (cwd = process.cwd()): Promise<RepairLeaseContract[]> => {
  let files: string[];
  try { files = await readdir(join(cwd, 'tasks/repairs')); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = files.filter((file) => file.endsWith('.yaml')).map((file) => file.slice(0, -5)).sort();
  return Promise.all(ids.map((id) => loadRepairLeaseContract(id, cwd)));
};
