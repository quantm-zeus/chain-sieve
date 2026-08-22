import type { AgentDecision } from '@ciag/shared-schemas';
import { EvidenceValidator, type EvidenceRecord, type ValidatorOptions } from './evidence-validator.js';
import { SingleAttemptOutputRepairer, type StructuredOutputRepairHandler } from './output-repair.js';

/**
 * FR-AGT-003 Structured decision with abstention
 * Emits typed verdict with INSUFFICIENT_DATA abstention path and never forces ranking when evidence gates fail.
 * AC-030: Invalid structured output receives at most one repair attempt and never causes an unsupported alert.
 * AC-031: Critical security risk blocks opportunity alert deterministically.
 */

export interface DecisionGateConfig {
  minObservedFacts?: number;
  minEvidenceCount?: number;
  minIndependenceGroups?: number;
  maxFreshnessMs?: number;
  requireValidatorPass?: boolean;
  criticalRiskBlocksAlert?: boolean;
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

    // Gate 5: critical risk blocks alert (AC-031)
    const isCriticalRisk =
      input.hasCriticalRisk === true ||
      proposed.riskRecommendation === 'CRITICAL' ||
      proposed.failureHazardState === 'CRITICAL' ||
      proposed.multiViewState === 'CRITICAL_CONTRADICTION' ||
      (proposed.riskSignals ?? []).some((s) => /HONEYPOT|CRITICAL|MALICIOUS|BLACKLIST/i.test(s));

    const proposedIsOpportunityAlert =
      proposed.decision === 'ALERT' ||
      proposed.alertClassRecommendation === 'CONFIRMED_OPPORTUNITY' ||
      proposed.alertClassRecommendation === 'EARLY_WATCH' ||
      proposed.alertClassRecommendation === 'THESIS_STRENGTHENING';

    const criticalRiskPass = !(gateConfig.criticalRiskBlocksAlert && isCriticalRisk && proposedIsOpportunityAlert);
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
      risk = isCriticalRisk ? 'CRITICAL' : proposed.riskRecommendation;
    } else {
      finalDecision = (proposed.decision as AgentDecision['decision']) ?? 'WATCH';
      finalAlertClass = proposed.alertClassRecommendation;
      lifecycle = proposed.lifecycleRecommendation;
      risk = isCriticalRisk ? 'CRITICAL' : proposed.riskRecommendation;
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

  /**
   * AC-030: Evaluates decision and executes at most one structured-output repair attempt if initial output is invalid.
   * Never causes an unsupported alert.
   */
  public static async decideWithRepair(
    input: StructuredDecisionInput,
    options?: {
      repairHandler?: StructuredOutputRepairHandler | undefined;
      repairProfileId?: string | undefined;
      enableRepair?: boolean | undefined;
    },
  ): Promise<StructuredDecisionResult> {
    const initialResult = StructuredDecisionEngine.decide(input);
    if (!initialResult.abstained || options?.enableRepair === false) {
      return initialResult;
    }

    const repairResult = await SingleAttemptOutputRepairer.repair({
      candidate: {
        assetId: input.candidate.assetId,
        chainId: input.candidate.chainId,
        contractAddress: input.candidate.contractAddress,
        symbol: input.candidate.symbol,
      },
      originalOutput: input.proposedDecision,
      profileId: input.profileId,
      repairProfileId: options?.repairProfileId,
      validationFailures: initialResult.validatorResult.failures,
      schemaErrors: initialResult.abstentionReasons,
      evidenceById: input.evidenceById,
      validatorOptions: input.validatorOptions,
      attemptCount: 0,
      repairHandler: options?.repairHandler,
      hasCriticalRisk: input.hasCriticalRisk,
    });

    if (repairResult.status === 'REPAIRED') {
      return StructuredDecisionEngine.decide({
        ...input,
        proposedDecision: repairResult.decision,
      });
    }

    return {
      ...initialResult,
      decision: repairResult.decision,
      abstained: true,
      abstentionReasons: [...initialResult.abstentionReasons, repairResult.reason ?? 'REPAIR_FAILED'],
    };
  }
}
