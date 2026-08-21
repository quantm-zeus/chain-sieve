import type { AgentDecision } from '@ciag/shared-schemas';
import { EvidenceValidator, type EvidenceRecord, type ValidatorOptions } from './evidence-validator.js';

/**
 * FR-AGT-003 Structured decision with abstention
 * Emits typed verdict with INSUFFICIENT_DATA abstention path and never forces ranking when evidence gates fail.
 */

export interface DecisionGateConfig {
  minObservedFacts?: number | undefined;
  minEvidenceCount?: number | undefined;
  minIndependenceGroups?: number | undefined;
  maxFreshnessMs?: number | undefined;
  requireValidatorPass?: boolean | undefined;
  criticalRiskBlocksAlert?: boolean | undefined;
}

export interface StructuredDecisionInput {
  candidate: AgentDecision['candidate'];
  profileId: string;
  proposedDecision: Partial<AgentDecision> & Pick<AgentDecision, 'thesis' | 'counterThesis' | 'lifecycleRecommendation' | 'riskRecommendation' | 'reasoningAssessment'>;
  evidenceById: Map<string, EvidenceRecord> | Record<string, EvidenceRecord>;
  validatorOptions: ValidatorOptions;
  gateConfig?: DecisionGateConfig | undefined;
  // deterministic signals
  providerConflicts?: string[] | undefined;
  hasCriticalRisk?: boolean | undefined;
  executionTradabilityPass?: boolean | undefined;
}

export interface StructuredDecisionResult {
  decision: AgentDecision;
  abstained: boolean;
  abstentionReasons: string[];
  validatorResult: ReturnType<typeof EvidenceValidator.validate>;
  gates: {
    evidenceCoveragePass: boolean;
    freshnessPass: boolean;
    independencePass: boolean;
    validatorPass: boolean;
    criticalRiskPass: boolean;
    tradabilityPass: boolean;
  };
}

const DEFAULT_GATE_CONFIG: Required<DecisionGateConfig> = {
  minObservedFacts: 1,
  minEvidenceCount: 1,
  minIndependenceGroups: 1,
  maxFreshnessMs: 1000 * 60 * 60 * 24 * 7, // 7 days default
  requireValidatorPass: true,
  criticalRiskBlocksAlert: true,
};

export class StructuredDecisionEngine {
  public static decide(input: StructuredDecisionInput): StructuredDecisionResult {
    const gateConfig: Required<DecisionGateConfig> = {
      minObservedFacts: input.gateConfig?.minObservedFacts ?? DEFAULT_GATE_CONFIG.minObservedFacts,
      minEvidenceCount: input.gateConfig?.minEvidenceCount ?? DEFAULT_GATE_CONFIG.minEvidenceCount,
      minIndependenceGroups: input.gateConfig?.minIndependenceGroups ?? DEFAULT_GATE_CONFIG.minIndependenceGroups,
      maxFreshnessMs: input.gateConfig?.maxFreshnessMs ?? DEFAULT_GATE_CONFIG.maxFreshnessMs,
      requireValidatorPass: input.gateConfig?.requireValidatorPass ?? DEFAULT_GATE_CONFIG.requireValidatorPass,
      criticalRiskBlocksAlert: input.gateConfig?.criticalRiskBlocksAlert ?? DEFAULT_GATE_CONFIG.criticalRiskBlocksAlert,
    };
    const proposed = input.proposedDecision;

    // Run deterministic validator first
    const validatorResult = EvidenceValidator.validate(
      {
        candidate: input.candidate,
        profileId: input.profileId,
        decision: (proposed.decision as AgentDecision['decision']) ?? 'WATCH',
        costPolicyResult: proposed.costPolicyResult ?? 'PASS',
        lifecycleRecommendation: proposed.lifecycleRecommendation,
        riskRecommendation: proposed.riskRecommendation,
        thesis: proposed.thesis,
        counterThesis: proposed.counterThesis,
        observedFacts: proposed.observedFacts ?? [],
        derivedFacts: proposed.derivedFacts ?? [],
        inferences: proposed.inferences ?? [],
        hypotheses: proposed.hypotheses ?? [],
        positiveSignals: proposed.positiveSignals ?? [],
        riskSignals: proposed.riskSignals ?? [],
        missingData: proposed.missingData ?? [],
        providerConflicts: proposed.providerConflicts ?? input.providerConflicts ?? [],
        thesisInvalidationConditions: proposed.thesisInvalidationConditions ?? [],
        reasoningAssessment: proposed.reasoningAssessment,
        ...(proposed.alertClassRecommendation ? { alertClassRecommendation: proposed.alertClassRecommendation } : {}),
        ...(proposed.executionScenarioId ? { executionScenarioId: proposed.executionScenarioId } : {}),
        ...(proposed.validUntil ? { validUntil: proposed.validUntil } : {}),
      } as AgentDecision,
      input.evidenceById,
      {
        ...input.validatorOptions,
        requireIndependenceGroups: gateConfig.minIndependenceGroups,
        maxFreshnessMs: gateConfig.maxFreshnessMs,
      },
    );

    const abstentionReasons: string[] = [];

    // Gate 1: evidence coverage
    const observedFactsCount = proposed.observedFacts?.length ?? 0;
    const evidenceCoveragePass = observedFactsCount >= gateConfig.minObservedFacts && validatorResult.lineage.rawEvidenceCount >= gateConfig.minEvidenceCount;
    if (!evidenceCoveragePass) {
      if (observedFactsCount < gateConfig.minObservedFacts) abstentionReasons.push(`INSUFFICIENT_OBSERVED_FACTS:${observedFactsCount}<${gateConfig.minObservedFacts}`);
      if (validatorResult.lineage.rawEvidenceCount < gateConfig.minEvidenceCount) abstentionReasons.push(`INSUFFICIENT_EVIDENCE_COUNT:${validatorResult.lineage.rawEvidenceCount}<${gateConfig.minEvidenceCount}`);
    }

    // Gate 2: freshness — validator already checks, but also check lineage age
    const freshnessPass = !validatorResult.failures.some((f) => f.code === 'EVIDENCE_STALE');
    if (!freshnessPass) abstentionReasons.push('STALE_EVIDENCE');

    // Gate 3: independence
    const independencePass = validatorResult.lineage.effectiveIndependenceGroups >= gateConfig.minIndependenceGroups;
    if (!independencePass) abstentionReasons.push(`INSUFFICIENT_INDEPENDENCE:${validatorResult.lineage.effectiveIndependenceGroups}<${gateConfig.minIndependenceGroups}`);

    // Gate 4: validator must pass if required
    const validatorPass = validatorResult.valid;
    if (gateConfig.requireValidatorPass && !validatorPass) {
      const codes = [...new Set(validatorResult.failures.map((f) => f.code))].join(',');
      abstentionReasons.push(`VALIDATOR_FAILED:${codes}`);
    }

    // Gate 5: critical risk blocks alert (not necessarily all decisions, but alert requires pass)
    const criticalRiskPass = !(gateConfig.criticalRiskBlocksAlert && input.hasCriticalRisk);
    if (!criticalRiskPass) abstentionReasons.push('CRITICAL_RISK_BLOCKS_ALERT');

    // Gate 6: tradability (if expected to alert)
    const tradabilityPass = input.executionTradabilityPass !== false; // undefined means not checked, pass
    if (!tradabilityPass) abstentionReasons.push('TRADABILITY_FAILED');

    const mustAbstain = abstentionReasons.length > 0;

    // Never force ranking when gates fail — abstention path
    let finalDecision: AgentDecision['decision'];
    let finalAlertClass: AgentDecision['alertClassRecommendation'];
    let lifecycle: AgentDecision['lifecycleRecommendation'];
    let risk: AgentDecision['riskRecommendation'];

    if (mustAbstain) {
      finalDecision = 'INSUFFICIENT_DATA';
      finalAlertClass = undefined;
      // Abstention preserves lifecycle/risk as-is but forces no ranking
      lifecycle = proposed.lifecycleRecommendation;
      risk = proposed.riskRecommendation;
    } else {
      finalDecision = (proposed.decision as AgentDecision['decision']) ?? 'WATCH';
      finalAlertClass = proposed.alertClassRecommendation;
      lifecycle = proposed.lifecycleRecommendation;
      risk = proposed.riskRecommendation;
    }

    const decision: AgentDecision = {
      candidate: input.candidate,
      profileId: input.profileId,
      decision: finalDecision,
      ...(finalAlertClass ? { alertClassRecommendation: finalAlertClass } : {}),
      ...(proposed.executionScenarioId ? { executionScenarioId: proposed.executionScenarioId } : {}),
      ...(proposed.tradabilityAssessmentId ? { tradabilityAssessmentId: proposed.tradabilityAssessmentId } : {}),
      ...(proposed.validUntil && !mustAbstain ? { validUntil: proposed.validUntil } : {}),
      costPolicyResult: proposed.costPolicyResult ?? 'PASS',
      ...(proposed.socialCapabilityState ? { socialCapabilityState: proposed.socialCapabilityState } : {}),
      ...(proposed.alphaEvidencePackId ? { alphaEvidencePackId: proposed.alphaEvidencePackId } : {}),
      ...(proposed.multiViewState ? { multiViewState: proposed.multiViewState } : {}),
      ...(proposed.failureHazardState ? { failureHazardState: proposed.failureHazardState } : {}),
      ...(proposed.noveltyState ? { noveltyState: proposed.noveltyState } : {}),
      ...(proposed.patternMatchIds ? { patternMatchIds: proposed.patternMatchIds } : {}),
      ...(proposed.alphaArtifactVersionIds ? { alphaArtifactVersionIds: proposed.alphaArtifactVersionIds } : {}),
      lifecycleRecommendation: lifecycle,
      riskRecommendation: risk,
      thesis: proposed.thesis,
      counterThesis: proposed.counterThesis,
      observedFacts: proposed.observedFacts ?? [],
      derivedFacts: proposed.derivedFacts ?? [],
      inferences: proposed.inferences ?? [],
      hypotheses: proposed.hypotheses ?? [],
      positiveSignals: mustAbstain ? [] : (proposed.positiveSignals ?? []),
      riskSignals: proposed.riskSignals ?? [],
      missingData: mustAbstain
        ? [
            ...(proposed.missingData ?? []),
            ...abstentionReasons.map((r) => ({ field: 'abstention_gate', reason: r, severity: 'HIGH' as const })),
          ]
        : (proposed.missingData ?? []),
      providerConflicts: proposed.providerConflicts ?? input.providerConflicts ?? [],
      thesisInvalidationConditions: proposed.thesisInvalidationConditions ?? [],
      ...(proposed.recommendedNextCheckMinutes ? { recommendedNextCheckMinutes: proposed.recommendedNextCheckMinutes } : {}),
      reasoningAssessment: proposed.reasoningAssessment,
      ...(mustAbstain ? { abstentionReason: abstentionReasons.join('; ') } : {}),
    };

    return {
      decision,
      abstained: mustAbstain,
      abstentionReasons,
      validatorResult,
      gates: {
        evidenceCoveragePass,
        freshnessPass,
        independencePass,
        validatorPass,
        criticalRiskPass,
        tradabilityPass,
      },
    };
  }

  /**
   * Ranking helper: returns null ranking when abstained — never forces ranking
   */
  public static rankOrAbstain(
    candidates: Array<{ candidateId: string; score: number; decisionInput: StructuredDecisionInput }>,
  ): Array<{ candidateId: string; rank: number | null; abstained: boolean; reasons: string[] }> | null {
    const evaluated = candidates.map((c) => ({
      candidateId: c.candidateId,
      result: StructuredDecisionEngine.decide(c.decisionInput),
    }));

    // If every candidate abstained, return abstention with no ranking
    if (evaluated.every((e) => e.result.abstained)) {
      return evaluated.map((e) => ({
        candidateId: e.candidateId,
        rank: null,
        abstained: true,
        reasons: e.result.abstentionReasons,
      }));
    }

    // Otherwise rank only non-abstained candidates, abstained get null rank (never forced)
    const rankable = evaluated
      .filter((e) => !e.result.abstained)
      .sort((a, b) => {
        // Deterministic sort by candidateId as tiebreaker to avoid non-determinism
        return a.candidateId.localeCompare(b.candidateId);
      });

    // For now, preserve input order for rankable if no score delta; use score if available
    // We sort rankable by score descending when available via original input lookup
    const scoreMap = new Map(candidates.map((c) => [c.candidateId, c.score]));
    rankable.sort((a, b) => {
      const sa = scoreMap.get(a.candidateId) ?? 0;
      const sb = scoreMap.get(b.candidateId) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.candidateId.localeCompare(b.candidateId);
    });

    const rankByCandidate = new Map<string, number>();
    rankable.forEach((e, idx) => rankByCandidate.set(e.candidateId, idx + 1));

    return evaluated.map((e) => ({
      candidateId: e.candidateId,
      rank: e.result.abstained ? null : (rankByCandidate.get(e.candidateId) ?? null),
      abstained: e.result.abstained,
      reasons: e.result.abstentionReasons,
    }));
  }
}
