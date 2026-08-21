/**
 * @requirement FR-AGT-005 - Persist auditable skeptic artifacts linked to parent decisions.
 * @requirement FR-AGT-009 - Persist per-family evidence acquisition decisions with explicit reason codes, costs, and probe metadata.
 * @requirement AC-242, AC-243 - Explicit decision states, neutral missingness, randomized probe stratification and provenance.
 * @reference migrations/g3_agt_evidence_and_skeptic.sql (Schema tracking: ISSUE-G3-AGT-PERSISTENCE-01)
 */

import type { EvidenceAcquisitionDecision, SkepticArtifact } from '@ciag/shared-schemas';
import type { DatabaseAdapter } from '@ciag/provider-contracts';
import type { VoiPlanResult } from './voi-planner.js';

export interface AgentRuntimePersistenceRepository {
  saveVoiPlan(plan: VoiPlanResult): Promise<void>;
  saveSkepticArtifact(artifact: SkepticArtifact): Promise<void>;
  getVoiDecisions(runId: string): Promise<EvidenceAcquisitionDecision[]>;
  getVoiPlan(runId: string): Promise<VoiPlanResult | null>;
  getSkepticArtifact(runId: string): Promise<SkepticArtifact | null>;
  getSkepticArtifactsByParentDecision(parentDecisionId: string): Promise<SkepticArtifact[]>;
}

export class InMemoryAgentPersistenceRepository implements AgentRuntimePersistenceRepository {
  private readonly voiPlans = new Map<string, VoiPlanResult>();
  private readonly voiDecisionsByRun = new Map<string, EvidenceAcquisitionDecision[]>();
  private readonly skepticArtifactsByRun = new Map<string, SkepticArtifact>();
  private readonly skepticArtifactsByParent = new Map<string, SkepticArtifact[]>();

  public async saveVoiPlan(plan: VoiPlanResult): Promise<void> {
    this.voiPlans.set(plan.runId, plan);
    this.voiDecisionsByRun.set(plan.runId, [...plan.decisions]);
  }

  public async saveSkepticArtifact(artifact: SkepticArtifact): Promise<void> {
    this.skepticArtifactsByRun.set(artifact.runId, artifact);
    const existing = this.skepticArtifactsByParent.get(artifact.parentDecisionId) ?? [];
    existing.push(artifact);
    this.skepticArtifactsByParent.set(artifact.parentDecisionId, existing);
  }

  public async getVoiDecisions(runId: string): Promise<EvidenceAcquisitionDecision[]> {
    return this.voiDecisionsByRun.get(runId) ?? [];
  }

  public async getVoiPlan(runId: string): Promise<VoiPlanResult | null> {
    return this.voiPlans.get(runId) ?? null;
  }

  public async getSkepticArtifact(runId: string): Promise<SkepticArtifact | null> {
    return this.skepticArtifactsByRun.get(runId) ?? null;
  }

  public async getSkepticArtifactsByParentDecision(parentDecisionId: string): Promise<SkepticArtifact[]> {
    return this.skepticArtifactsByParent.get(parentDecisionId) ?? [];
  }
}

export class DatabaseAgentPersistenceRepository implements AgentRuntimePersistenceRepository {
  constructor(private readonly database: DatabaseAdapter) {}

  public async saveVoiPlan(plan: VoiPlanResult): Promise<void> {
    for (const decision of plan.decisions) {
      await this.database.query(
        `INSERT INTO voi_acquisition_decisions (
          id, candidate_id, run_id, evidence_family, policy_version,
          state, requested_fields_json, expected_decision_impact, expected_information_value,
          estimated_cost_json, actual_cost_json, randomized, assignment_probability,
          randomization_stratum, randomization_seed_ref, decided_at, completed_at,
          evidence_ids_json, reason_codes_json, skip_reason, request_reason, actual_decision_change
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT (id) DO UPDATE SET
          state = EXCLUDED.state,
          expected_decision_impact = EXCLUDED.expected_decision_impact,
          expected_information_value = EXCLUDED.expected_information_value,
          estimated_cost_json = EXCLUDED.estimated_cost_json,
          actual_cost_json = EXCLUDED.actual_cost_json,
          completed_at = EXCLUDED.completed_at,
          evidence_ids_json = EXCLUDED.evidence_ids_json,
          reason_codes_json = EXCLUDED.reason_codes_json,
          skip_reason = EXCLUDED.skip_reason,
          request_reason = EXCLUDED.request_reason,
          actual_decision_change = EXCLUDED.actual_decision_change`,
        [
          decision.id,
          decision.candidateId,
          decision.runId,
          decision.evidenceFamily,
          decision.policyVersion,
          decision.state,
          JSON.stringify(decision.requestedFields),
          decision.expectedDecisionImpact ?? null,
          decision.expectedInformationValue ?? null,
          JSON.stringify(decision.estimatedCost ?? {}),
          JSON.stringify(decision.actualCost ?? {}),
          decision.randomized,
          decision.assignmentProbability ?? null,
          decision.randomizationStratum ?? null,
          decision.randomizationSeedRef ?? null,
          decision.decidedAt,
          decision.completedAt ?? null,
          JSON.stringify(decision.evidenceIds),
          JSON.stringify(decision.reasonCodes),
          decision.skipReason ?? null,
          decision.requestReason ?? null,
          decision.actualDecisionChange ?? 'NONE',
        ],
      );
    }
  }

  public async saveSkepticArtifact(artifact: SkepticArtifact): Promise<void> {
    await this.database.query(
      `INSERT INTO skeptic_artifacts (
        id, parent_decision_id, candidate_id, run_id, policy_version,
        triggered, trigger_reasons_json, trigger_metrics_json, profile_id, profile_version,
        status, verdict, confidence, challenge_findings_json, counter_thesis,
        invalidation_conditions_json, suggested_decision, suggested_risk_level,
        decision_changed, evidence_ids_json, executed_tool_records_json, budget_usage_json,
        sha256, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence,
        counter_thesis = EXCLUDED.counter_thesis,
        sha256 = EXCLUDED.sha256`,
      [
        artifact.id,
        artifact.parentDecisionId,
        artifact.candidateId,
        artifact.runId,
        artifact.policyVersion,
        artifact.triggered,
        JSON.stringify(artifact.triggerReasons),
        JSON.stringify(artifact.triggerMetrics ?? {}),
        artifact.profileId,
        artifact.profileVersion ?? null,
        artifact.status,
        artifact.verdict,
        artifact.confidence,
        JSON.stringify(artifact.challengeFindings),
        artifact.counterThesis,
        JSON.stringify(artifact.invalidationConditions),
        artifact.suggestedDecision ?? null,
        artifact.suggestedRiskLevel ?? null,
        artifact.decisionChanged,
        JSON.stringify(artifact.evidenceIds),
        JSON.stringify(artifact.executedToolRecords),
        JSON.stringify(artifact.budgetUsage ?? {}),
        artifact.sha256 ?? null,
        artifact.createdAt,
      ],
    );
  }

  public async getVoiDecisions(runId: string): Promise<EvidenceAcquisitionDecision[]> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM voi_acquisition_decisions WHERE run_id = $1 ORDER BY decided_at ASC`,
      [runId],
    );
    return result.rows.map((row) => this.mapDecisionRow(row));
  }

  public async getVoiPlan(runId: string): Promise<VoiPlanResult | null> {
    const decisions = await this.getVoiDecisions(runId);
    if (decisions.length === 0) return null;
    const first = decisions[0];
    if (!first) return null;
    const requested = decisions.filter((d) => d.state === 'REQUESTED');
    const requestedFamilies = requested.map((d) => d.evidenceFamily);
    const skippedFamilies = decisions.filter((d) => d.state !== 'REQUESTED').map((d) => d.evidenceFamily);
    const totalCost = requested.reduce((acc, d) => acc + (d.estimatedCost?.monetaryCostUsd ?? 0), 0);
    const totalQuota = requested.reduce((acc, d) => acc + (d.estimatedCost?.quotaCostUnits ?? 0), 0);

    return {
      policyVersion: first.policyVersion,
      candidateId: first.candidateId,
      runId,
      decisions,
      requestedFamilies,
      skippedFamilies,
      totalEstimatedMonetaryCostUsd: totalCost,
      totalEstimatedQuotaUnits: totalQuota,
      plannedAt: first.decidedAt,
    };
  }

  public async getSkepticArtifact(runId: string): Promise<SkepticArtifact | null> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM skeptic_artifacts WHERE run_id = $1 LIMIT 1`,
      [runId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (!row) return null;
    return this.mapSkepticRow(row);
  }

  public async getSkepticArtifactsByParentDecision(parentDecisionId: string): Promise<SkepticArtifact[]> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM skeptic_artifacts WHERE parent_decision_id = $1 ORDER BY created_at ASC`,
      [parentDecisionId],
    );
    return result.rows.map((row) => this.mapSkepticRow(row));
  }

  private mapDecisionRow(row: Record<string, unknown>): EvidenceAcquisitionDecision {
    return {
      id: String(row.id),
      candidateId: String(row.candidate_id),
      runId: String(row.run_id),
      evidenceFamily: String(row.evidence_family),
      policyVersion: String(row.policy_version),
      state: row.state as EvidenceAcquisitionDecision['state'],
      requestedFields: typeof row.requested_fields_json === 'string' ? JSON.parse(row.requested_fields_json) : (row.requested_fields_json as string[]),
      expectedDecisionImpact: row.expected_decision_impact ? String(row.expected_decision_impact) : undefined,
      expectedInformationValue: row.expected_information_value !== null ? Number(row.expected_information_value) : undefined,
      estimatedCost: typeof row.estimated_cost_json === 'string' ? JSON.parse(row.estimated_cost_json) : (row.estimated_cost_json as EvidenceAcquisitionDecision['estimatedCost']),
      actualCost: typeof row.actual_cost_json === 'string' ? JSON.parse(row.actual_cost_json) : (row.actual_cost_json as EvidenceAcquisitionDecision['actualCost']),
      randomized: Boolean(row.randomized),
      assignmentProbability: row.assignment_probability ? String(row.assignment_probability) : undefined,
      randomizationStratum: row.randomization_stratum ? String(row.randomization_stratum) : undefined,
      randomizationSeedRef: row.randomization_seed_ref ? String(row.randomization_seed_ref) : undefined,
      decidedAt: String(row.decided_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      evidenceIds: typeof row.evidence_ids_json === 'string' ? JSON.parse(row.evidence_ids_json) : ((row.evidence_ids_json as string[]) ?? []),
      reasonCodes: typeof row.reason_codes_json === 'string' ? JSON.parse(row.reason_codes_json) : ((row.reason_codes_json as string[]) ?? []),
      skipReason: row.skip_reason ? String(row.skip_reason) : undefined,
      requestReason: row.request_reason ? String(row.request_reason) : undefined,
      actualDecisionChange: row.actual_decision_change as EvidenceAcquisitionDecision['actualDecisionChange'],
    };
  }

  private mapSkepticRow(row: Record<string, unknown>): SkepticArtifact {
    return {
      id: String(row.id),
      parentDecisionId: String(row.parent_decision_id),
      candidateId: String(row.candidate_id),
      runId: String(row.run_id),
      policyVersion: String(row.policy_version),
      triggered: Boolean(row.triggered),
      triggerReasons: typeof row.trigger_reasons_json === 'string' ? JSON.parse(row.trigger_reasons_json) : (row.trigger_reasons_json as SkepticArtifact['triggerReasons']),
      triggerMetrics: typeof row.trigger_metrics_json === 'string' ? JSON.parse(row.trigger_metrics_json) : (row.trigger_metrics_json as SkepticArtifact['triggerMetrics']),
      profileId: String(row.profile_id),
      profileVersion: row.profile_version ? String(row.profile_version) : undefined,
      status: row.status as SkepticArtifact['status'],
      verdict: row.verdict as SkepticArtifact['verdict'],
      confidence: row.confidence as SkepticArtifact['confidence'],
      challengeFindings: typeof row.challenge_findings_json === 'string' ? JSON.parse(row.challenge_findings_json) : ((row.challenge_findings_json as string[]) ?? []),
      counterThesis: String(row.counter_thesis),
      invalidationConditions: typeof row.invalidation_conditions_json === 'string' ? JSON.parse(row.invalidation_conditions_json) : ((row.invalidation_conditions_json as string[]) ?? []),
      suggestedDecision: row.suggested_decision ? (row.suggested_decision as SkepticArtifact['suggestedDecision']) : undefined,
      suggestedRiskLevel: row.suggested_risk_level ? (row.suggested_risk_level as SkepticArtifact['suggestedRiskLevel']) : undefined,
      decisionChanged: Boolean(row.decision_changed),
      evidenceIds: typeof row.evidence_ids_json === 'string' ? JSON.parse(row.evidence_ids_json) : ((row.evidence_ids_json as string[]) ?? []),
      executedToolRecords: typeof row.executed_tool_records_json === 'string' ? JSON.parse(row.executed_tool_records_json) : ((row.executed_tool_records_json as Record<string, unknown>[]) ?? []),
      budgetUsage: typeof row.budget_usage_json === 'string' ? JSON.parse(row.budget_usage_json) : (row.budget_usage_json as Record<string, unknown>),
      sha256: row.sha256 ? String(row.sha256) : undefined,
      createdAt: String(row.created_at),
    };
  }
}
