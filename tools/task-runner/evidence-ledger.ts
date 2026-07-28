import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from '../prd-compiler/compiler.js';
import { invalidateCurrentEvidence, runtimeRoot, type EvidenceReference, type TaskState } from './state.js';

export interface EvidenceStatusRecord extends EvidenceReference {
  taskId: string;
  kind: 'SELF_REVIEW' | 'TASK_RESULT' | 'VERIFICATION';
  invalidatedAt?: string;
  reason?: 'CLUSTER_HEAD_ADVANCED';
}

interface EvidenceLedger {
  schemaVersion: '1.0.0';
  records: EvidenceStatusRecord[];
}

const ledgerPath = (cwd: string): string => join(runtimeRoot(cwd), 'evidence-status.json');

const readLedger = async (cwd: string): Promise<EvidenceLedger> => {
  try {
    const value = JSON.parse(await readFile(ledgerPath(cwd), 'utf8')) as EvidenceLedger;
    if (value.schemaVersion !== '1.0.0' || !Array.isArray(value.records))
      throw new Error('EVIDENCE_LEDGER_INVALID');
    return value;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: '1.0.0', records: [] };
  }
};

const writeLedger = async (cwd: string, ledger: EvidenceLedger): Promise<void> => {
  const path = ledgerPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
};

export const registerCurrentEvidence = async (
  taskId: string,
  kind: EvidenceStatusRecord['kind'],
  evidence: EvidenceReference,
  cwd = process.cwd(),
): Promise<void> => {
  const ledger = await readLedger(cwd);
  ledger.records.push({ taskId, kind, ...evidence });
  await writeLedger(cwd, ledger);
};

export const invalidateRebaseEvidence = async (
  target: TaskState,
  cwd = process.cwd(),
  now = new Date(),
): Promise<{ records: EvidenceStatusRecord[]; auditPath: string; auditSha256: string }> => {
  const ledger = await readLedger(cwd);
  const stale = invalidateCurrentEvidence(target);
  const kinds: EvidenceStatusRecord['kind'][] = ['SELF_REVIEW', 'TASK_RESULT', 'VERIFICATION'];
  const records = stale.map((evidence, index) => ({
    taskId: target.taskId,
    kind: kinds[index]!,
    ...evidence,
    status: 'STALE' as const,
    invalidatedAt: now.toISOString(),
    reason: 'CLUSTER_HEAD_ADVANCED' as const,
  }));
  for (const record of records) {
    const current = ledger.records.find(
      (item) => item.taskId === record.taskId && item.kind === record.kind && item.sha256 === record.sha256,
    );
    if (current) Object.assign(current, record);
    else ledger.records.push(record);
  }
  await writeLedger(cwd, ledger);
  const audit = {
    schemaVersion: '1.0.0',
    taskId: target.taskId,
    invalidatedAt: now.toISOString(),
    reason: 'CLUSTER_HEAD_ADVANCED',
    records,
  };
  const text = `${JSON.stringify(audit, null, 2)}\n`;
  const hash = sha256(text);
  const auditPath = `rebase/${target.taskId}/${hash}.stale-evidence.json`;
  const absolute = join(runtimeRoot(cwd), auditPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, { mode: 0o600 });
  return { records, auditPath, auditSha256: hash };
};

export const assertEvidenceCurrent = async (
  taskId: string,
  kind: EvidenceStatusRecord['kind'],
  evidence: EvidenceReference,
  cwd = process.cwd(),
): Promise<void> => {
  if (evidence.status !== 'CURRENT') throw new Error(`STALE_${kind}_EVIDENCE`);
  const ledger = await readLedger(cwd);
  const record = ledger.records.find(
    (item) => item.taskId === taskId && item.kind === kind && item.sha256 === evidence.sha256,
  );
  if (!record) throw new Error(`${kind}_EVIDENCE_NOT_REGISTERED`);
  if (record.status !== 'CURRENT') throw new Error(`STALE_${kind}_EVIDENCE`);
};
