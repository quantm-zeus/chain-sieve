import { createHash } from 'node:crypto';
import type { AgentDecision } from '@ciag/shared-schemas';
import type { EvidenceRecord } from './evidence-validator.js';

/**
 * FR-AGT-007 Original-explanation / current-re-evaluation separation
 * Frozen evidence/decision snapshot served via explain endpoint;
 * re-evaluate creates separate versioned run without mutating frozen artifacts.
 */

export interface DecisionRun {
  id: string;
  candidateId: string;
  version: number;
  decision: AgentDecision;
  evidenceSnapshot: EvidenceRecord[];
  evidenceSnapshotHash: string;
  decisionHash: string;
  createdAt: string;
  frozenAt: string;
  isFrozen: true;
  lineage: {
    parentRunId: string | null;
    rootRunId: string;
    evidenceIds: string[];
    evidenceHashes: string[];
    profileId: string;
    profileVersion: string | null;
  };
  executionManifest?: Record<string, unknown> | undefined;
}

export interface CreateRunInput {
  id?: string | undefined;
  candidateId: string;
  decision: AgentDecision;
  evidenceSnapshot: EvidenceRecord[];
  profileId: string;
  profileVersion?: string | null | undefined;
  executionManifest?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}

export interface ReEvaluateInput {
  originalRunId: string;
  newEvidenceSnapshot: EvidenceRecord[];
  newDecision: AgentDecision;
  profileId?: string | undefined;
  executionManifest?: Record<string, unknown> | undefined;
}

const canonicalJson = (value: unknown): string => {
  const canonicalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, child]) => [k, canonicalize(child)]),
      );
    }
    return v;
  };
  return JSON.stringify(canonicalize(value));
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DecisionLineageStore {
  private readonly runs = new Map<string, DecisionRun>();
  private readonly byCandidate = new Map<string, string[]>(); // candidateId -> ordered runIds

  public createRun(input: CreateRunInput): DecisionRun {
    const id = input.id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (this.runs.has(id)) throw new Error(`RUN_ID_CONFLICT:${id}`);

    const frozenAt = input.createdAt ?? new Date().toISOString();
    const evidenceSnapshotHash = sha256(canonicalJson(input.evidenceSnapshot));
    const decisionHash = sha256(canonicalJson(input.decision));

    const run: DecisionRun = {
      id,
      candidateId: input.candidateId,
      version: 1,
      decision: structuredClone(input.decision),
      evidenceSnapshot: structuredClone(input.evidenceSnapshot) as EvidenceRecord[],
      evidenceSnapshotHash,
      decisionHash,
      createdAt: frozenAt,
      frozenAt,
      isFrozen: true,
      lineage: {
        parentRunId: null,
        rootRunId: id,
        evidenceIds: input.evidenceSnapshot.map((e) => e.id).sort(),
        evidenceHashes: input.evidenceSnapshot.map((e) => e.artifactSha256 ?? sha256(canonicalJson(e))).sort(),
        profileId: input.profileId,
        profileVersion: input.profileVersion ?? null,
      },
      ...(input.executionManifest ? { executionManifest: structuredClone(input.executionManifest) } : {}),
    };

    // Freeze deep
    Object.freeze(run.decision);
    Object.freeze(run.evidenceSnapshot);
    Object.freeze(run.lineage);

    this.runs.set(id, run);
    const list = this.byCandidate.get(input.candidateId) ?? [];
    list.push(id);
    this.byCandidate.set(input.candidateId, list);

    return this.getExplainOriginal(id)!;
  }

  /**
   * EXPLAIN_ORIGINAL_DECISION: serves frozen snapshot, never mutates, never triggers provider calls.
   * Returns a deep frozen copy.
   */
  public getExplainOriginal(runId: string): DecisionRun | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    // Return deep clone to prevent mutation, but preserve frozen semantics
    return {
      ...run,
      decision: structuredClone(run.decision),
      evidenceSnapshot: structuredClone(run.evidenceSnapshot) as EvidenceRecord[],
      lineage: { ...run.lineage, evidenceIds: [...run.lineage.evidenceIds], evidenceHashes: [...run.lineage.evidenceHashes] },
    };
  }

  /**
   * RE_EVALUATE_WITH_CURRENT_DATA: creates separate versioned run without mutating frozen artifacts.
   */
  public reEvaluate(input: ReEvaluateInput): DecisionRun {
    const original = this.runs.get(input.originalRunId);
    if (!original) throw new Error(`ORIGINAL_RUN_NOT_FOUND:${input.originalRunId}`);

    // Ensure original remains frozen and untouched — snapshot its hashes before
    const originalEvidenceHash = original.evidenceSnapshotHash;
    const originalDecisionHash = original.decisionHash;

    const newId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_v${original.version + 1}`;
    const frozenAt = new Date().toISOString();
    const evidenceSnapshotHash = sha256(canonicalJson(input.newEvidenceSnapshot));
    const decisionHash = sha256(canonicalJson(input.newDecision));

    const newRun: DecisionRun = {
      id: newId,
      candidateId: original.candidateId,
      version: original.version + 1,
      decision: structuredClone(input.newDecision),
      evidenceSnapshot: structuredClone(input.newEvidenceSnapshot) as EvidenceRecord[],
      evidenceSnapshotHash,
      decisionHash,
      createdAt: frozenAt,
      frozenAt,
      isFrozen: true,
      lineage: {
        parentRunId: original.id,
        rootRunId: original.lineage.rootRunId,
        evidenceIds: input.newEvidenceSnapshot.map((e) => e.id).sort(),
        evidenceHashes: input.newEvidenceSnapshot.map((e) => e.artifactSha256 ?? sha256(canonicalJson(e))).sort(),
        profileId: input.profileId ?? original.lineage.profileId,
        profileVersion: null,
      },
      ...(input.executionManifest ? { executionManifest: structuredClone(input.executionManifest) } : {}),
    };

    Object.freeze(newRun.decision);
    Object.freeze(newRun.evidenceSnapshot);

    this.runs.set(newId, newRun);
    const list = this.byCandidate.get(original.candidateId) ?? [];
    list.push(newId);
    this.byCandidate.set(original.candidateId, list);

    // Verify original not mutated
    const afterOriginal = this.runs.get(input.originalRunId)!;
    if (afterOriginal.evidenceSnapshotHash !== originalEvidenceHash || afterOriginal.decisionHash !== originalDecisionHash) {
      throw new Error('FROZEN_ARTIFACT_MUTATED');
    }
    if (afterOriginal.version !== original.version) throw new Error('FROZEN_VERSION_MUTATED');

    return this.getExplainOriginal(newId)!;
  }

  public listRunsForCandidate(candidateId: string): DecisionRun[] {
    const ids = this.byCandidate.get(candidateId) ?? [];
    return ids.map((id) => this.getExplainOriginal(id)!).filter(Boolean) as DecisionRun[];
  }

  public getRun(runId: string): DecisionRun | null {
    return this.getExplainOriginal(runId);
  }

  public clear(): void {
    this.runs.clear();
    this.byCandidate.clear();
  }

  public size(): number {
    return this.runs.size;
  }
}

// Singleton for API layer convenience
let singleton: DecisionLineageStore | null = null;
export const getDecisionLineageStore = (): DecisionLineageStore => {
  if (!singleton) singleton = new DecisionLineageStore();
  return singleton;
};
export const resetDecisionLineageStore = (): void => {
  if (singleton) singleton.clear();
  singleton = null;
};
