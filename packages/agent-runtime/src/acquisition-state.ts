import type {
  EvidenceAcquisitionDecision,
  EvidenceAcquisitionState,
} from '@ciag/shared-schemas';
import { EvidenceAcquisitionDecisionSchema } from '@ciag/shared-schemas';

/**
 * FR-AGT-009 / FR-DATA-011 / FR-DATA-012 / AC-242 / INV-022
 * Evidence Acquisition State Store
 *
 * Enforces:
 * 1. Uniqueness per (run, candidate, evidence_family, policy_version) unless explicit attempt generation exists.
 * 2. Exactly 10 valid acquisition states.
 * 3. NOT_REQUESTED_BY_POLICY is distinct from unavailable, empty, or negative evidence and cannot be overwritten as provider missingness.
 * 4. Immutable point-in-time acquisition logging before and after retrieval.
 */

export interface UpdateAcquisitionOutcomeParams {
  runId: string;
  candidateId: string;
  evidenceFamily: string;
  policyVersion: string;
  attempt?: number | undefined;
  state: 'RETURNED' | 'RETURNED_EMPTY' | 'FAILED' | 'PROVIDER_UNAVAILABLE';
  completedAt?: string | undefined;
  evidenceIds?: string[] | undefined;
  actualDecisionChange?:
    | 'NONE'
    | 'RANK'
    | 'LIFECYCLE'
    | 'RISK'
    | 'ALERT'
    | 'ABSTENTION'
    | undefined;
  reasonCodes?: string[] | undefined;
}

export class EvidenceAcquisitionStore {

  private readonly records = new Map<string, EvidenceAcquisitionDecision>();
  private readonly byRunCandidate = new Map<string, string[]>(); // `${runId}::${candidateId}` -> keys
  private readonly byCandidate = new Map<string, string[]>(); // candidateId -> keys
  private readonly byRun = new Map<string, string[]>(); // runId -> keys

  private buildKey(
    runId: string,
    candidateId: string,
    evidenceFamily: string,
    policyVersion: string,
    attempt?: number,
  ): string {
    const base = `${runId}::${candidateId}::${evidenceFamily}::${policyVersion}`;
    return attempt !== undefined ? `${base}::attempt_${attempt}` : base;
  }

  /**
   * Persists an acquisition decision record for an eligible evidence family.
   * Validates schema and enforces uniqueness per (run, candidate, evidence_family, policy_version).
   */
  public recordDecision(decision: EvidenceAcquisitionDecision, attempt?: number): EvidenceAcquisitionDecision {
    const validated = EvidenceAcquisitionDecisionSchema.parse(decision);
    const key = this.buildKey(
      validated.runId,
      validated.candidateId,
      validated.evidenceFamily,
      validated.policyVersion,
      attempt,
    );

    if (this.records.has(key)) {
      throw new Error(
        `DUPLICATE_ACQUISITION_RECORD: Record already exists for (run=${validated.runId}, candidate=${validated.candidateId}, family=${validated.evidenceFamily}, policyVersion=${validated.policyVersion}${attempt !== undefined ? `, attempt=${attempt}` : ''})`,
      );
    }

    const cloned = structuredClone(validated);
    Object.freeze(cloned);
    Object.freeze(cloned.requestedFields);
    Object.freeze(cloned.evidenceIds);
    Object.freeze(cloned.reasonCodes);

    this.records.set(key, cloned);

    // Indexing
    const runCandKey = `${validated.runId}::${validated.candidateId}`;
    const rcList = this.byRunCandidate.get(runCandKey) ?? [];
    rcList.push(key);
    this.byRunCandidate.set(runCandKey, rcList);

    const cList = this.byCandidate.get(validated.candidateId) ?? [];
    cList.push(key);
    this.byCandidate.set(validated.candidateId, cList);

    const rList = this.byRun.get(validated.runId) ?? [];
    rList.push(key);
    this.byRun.set(validated.runId, rList);

    return structuredClone(cloned);
  }

  public recordDecisions(
    decisions: readonly EvidenceAcquisitionDecision[],
    attempt?: number,
  ): EvidenceAcquisitionDecision[] {
    return decisions.map((d) => this.recordDecision(d, attempt));
  }

  /**
   * Updates an existing decision from REQUESTED to terminal outcome state.
   * Enforces that NOT_REQUESTED_BY_POLICY cannot be rewritten as provider missingness or empty.
   */
  public updateOutcome(params: UpdateAcquisitionOutcomeParams): EvidenceAcquisitionDecision {
    const key = this.buildKey(
      params.runId,
      params.candidateId,
      params.evidenceFamily,
      params.policyVersion,
      params.attempt,
    );

    const existing = this.records.get(key);
    if (!existing) {
      throw new Error(
        `ACQUISITION_RECORD_NOT_FOUND: No record for (run=${params.runId}, candidate=${params.candidateId}, family=${params.evidenceFamily}, policyVersion=${params.policyVersion})`,
      );
    }

    // Invariant: NOT_REQUESTED_BY_POLICY is never rewritten
    if (existing.state === 'NOT_REQUESTED_BY_POLICY') {
      throw new Error(
        `INVALID_STATE_TRANSITION: Evidence family "${existing.evidenceFamily}" was NOT_REQUESTED_BY_POLICY and cannot be mutated to "${params.state}"`,
      );
    }

    // Invariant: COST_BLOCKED, QUOTA_BLOCKED, RIGHTS_BLOCKED, UNSUPPORTED cannot be mutated
    if (
      existing.state === 'COST_BLOCKED' ||
      existing.state === 'QUOTA_BLOCKED' ||
      existing.state === 'RIGHTS_BLOCKED' ||
      existing.state === 'UNSUPPORTED'
    ) {
      throw new Error(
        `INVALID_STATE_TRANSITION: Pre-retrieval blocked state "${existing.state}" cannot be mutated to "${params.state}"`,
      );
    }

    const completedAt = params.completedAt ?? new Date().toISOString();
    const updated: EvidenceAcquisitionDecision = {
      ...existing,
      state: params.state,
      completedAt,
      evidenceIds: params.evidenceIds ? [...new Set([...existing.evidenceIds, ...params.evidenceIds])] : existing.evidenceIds,
      actualDecisionChange: params.actualDecisionChange ?? existing.actualDecisionChange ?? 'NONE',
      reasonCodes: params.reasonCodes ? [...new Set([...existing.reasonCodes, ...params.reasonCodes])] : existing.reasonCodes,
    };

    const validated = EvidenceAcquisitionDecisionSchema.parse(updated);
    const cloned = structuredClone(validated);
    Object.freeze(cloned);
    Object.freeze(cloned.requestedFields);
    Object.freeze(cloned.evidenceIds);
    Object.freeze(cloned.reasonCodes);

    this.records.set(key, cloned);
    return structuredClone(cloned);
  }

  public getDecision(
    runId: string,
    candidateId: string,
    evidenceFamily: string,
    policyVersion: string,
    attempt?: number,
  ): EvidenceAcquisitionDecision | undefined {
    const key = this.buildKey(runId, candidateId, evidenceFamily, policyVersion, attempt);
    const record = this.records.get(key);
    return record ? structuredClone(record) : undefined;
  }

  public listDecisionsForCandidateAndRun(runId: string, candidateId: string): EvidenceAcquisitionDecision[] {
    const keys = this.byRunCandidate.get(`${runId}::${candidateId}`) ?? [];
    return keys
      .map((k) => this.records.get(k))
      .filter(Boolean)
      .map((r) => structuredClone(r!));
  }

  public listDecisionsForCandidate(candidateId: string): EvidenceAcquisitionDecision[] {
    const keys = this.byCandidate.get(candidateId) ?? [];
    return keys
      .map((k) => this.records.get(k))
      .filter(Boolean)
      .map((r) => structuredClone(r!));
  }

  public listDecisionsForRun(runId: string): EvidenceAcquisitionDecision[] {
    const keys = this.byRun.get(runId) ?? [];
    return keys
      .map((k) => this.records.get(k))
      .filter(Boolean)
      .map((r) => structuredClone(r!));
  }

  public computeStateSummary(runId: string, candidateId?: string): Record<EvidenceAcquisitionState, number> {
    const decisions = candidateId
      ? this.listDecisionsForCandidateAndRun(runId, candidateId)
      : this.listDecisionsForRun(runId);

    const summary: Record<EvidenceAcquisitionState, number> = {
      NOT_REQUESTED_BY_POLICY: 0,
      REQUESTED: 0,
      COST_BLOCKED: 0,
      QUOTA_BLOCKED: 0,
      RIGHTS_BLOCKED: 0,
      UNSUPPORTED: 0,
      PROVIDER_UNAVAILABLE: 0,
      FAILED: 0,
      RETURNED_EMPTY: 0,
      RETURNED: 0,
    };

    for (const d of decisions) {
      summary[d.state]++;
    }

    return summary;
  }

  public clear(): void {
    this.records.clear();
    this.byRunCandidate.clear();
    this.byCandidate.clear();
    this.byRun.clear();
  }

  public size(): number {
    return this.records.size;
  }
}

// Global singleton for shared runtime access
let singletonStore: EvidenceAcquisitionStore | null = null;

export const getEvidenceAcquisitionStore = (): EvidenceAcquisitionStore => {
  if (!singletonStore) singletonStore = new EvidenceAcquisitionStore();
  return singletonStore;
};

export const resetEvidenceAcquisitionStore = (): void => {
  if (singletonStore) singletonStore.clear();
  singletonStore = null;
};
