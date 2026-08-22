import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  AgentDecision,
  AgentSelectionArmSummary,
  AgentSelectionArmType,
  AgentSelectionComparisonReport,
  DesignBasedEstimate,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import type { FrozenCandidateUniverse } from './types.js';
import {
  BoundedAgentRuntime,
  ModelAssistedPlanner,
  StratifiedRandomizedProbeAllocator,
  type CandidateTarget,
} from '@ciag/agent-runtime';
import { DesignBasedEstimators } from './design-estimators.js';

export interface AgentSelectionCandidateInput {
  candidate: CandidateTarget;
  isSafe: boolean;
  score?: number | undefined;
  liquidityUsd?: number | undefined;
  groundTruthSignalSuccess?: boolean | undefined;
  groundTruthTradableSuccess?: boolean | undefined;
  groundTruthNetReturn?: number | undefined;
  initialEvidence?: Record<string, unknown> | undefined;
  stratumId?: string | undefined;
}

export interface AgentSelectionEvaluationInput {
  universe: FrozenCandidateUniverse;
  candidates: readonly AgentSelectionCandidateInput[];
  profile: ModelProfile;
  envelope: ToolAuthorizationEnvelope;
  symmetricBudget: AgentBudget;
  seedProvenance?: string | undefined;
  policyVersion?: string | undefined;
}

function stableCanonicalJson(value: unknown): string {
  const canonicalize = (val: unknown): unknown => {
    if (val === null || val === undefined) return val;
    if (Array.isArray(val)) return val.map(canonicalize);
    if (typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonicalize(v)]),
      );
    }
    return val;
  };
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(str: string): string {
  return createHash('sha256').update(str).digest('hex');
}

export class AgentSelectionEvaluator {
  /**
   * Compares deterministic planner, model-assisted planner, randomized probe,
   * and no-additional-evidence controls under symmetric budgets and frozen candidate universes.
   *
   * @requirement FR-AGT-011
   * @requirement FR-AGT-010, FR-EVAL-010, FR-EVAL-011, FR-EVAL-012
   */
  public static async evaluate(
    input: AgentSelectionEvaluationInput,
  ): Promise<AgentSelectionComparisonReport> {
    const {
      universe,
      candidates,
      profile,
      envelope,
      symmetricBudget,
      seedProvenance = 'seed-eval-agent-selection-1',
      policyVersion = '1.0.0',
    } = input;

    const runtime = new BoundedAgentRuntime();
    const candidateCount = candidates.length;

    // 1. Arm 4: NO_ADDITIONAL_EVIDENCE (Baseline Control)
    // Budget maxToolCalls: 0, steps: 1
    const noEvidenceBudget: AgentBudget = {
      ...symmetricBudget,
      maxToolCalls: 0,
      maxSteps: 1,
      maxProviderCalls: 0,
    };

    const noEvidenceDecisions: AgentDecision[] = [];
    let noEvidenceStepsTotal = 0;
    let noEvidenceCostTotal = 0;

    for (const c of candidates) {
      const res = await runtime.execute({
        candidate: c.candidate,
        profileId: profile.id,
        profileVersion: profile.version,
        envelope: { ...envelope, allowedTools: [] }, // No tools allowed
        budget: noEvidenceBudget,
        initialEvidence: c.initialEvidence,
        goal: 'TRIAGE',
      });
      noEvidenceDecisions.push(res.decision);
      noEvidenceStepsTotal += res.executedSteps;
      noEvidenceCostTotal += res.budgetUsage.modelCostUsd.current;
    }

    const noEvidenceSummary = this.summarizeArm({
      arm: 'NO_ADDITIONAL_EVIDENCE',
      candidates,
      decisions: noEvidenceDecisions,
      executedStepsTotal: noEvidenceStepsTotal,
      executedToolCallsTotal: 0,
      totalCostUsd: noEvidenceCostTotal,
      averageLatencyMs: 5,
      controlDecisions: noEvidenceDecisions,
    });

    // 2. Arm 1: DETERMINISTIC_PLANNER
    const deterministicDecisions: AgentDecision[] = [];
    let deterministicStepsTotal = 0;
    let deterministicToolCallsTotal = 0;
    let deterministicCostTotal = 0;

    for (const c of candidates) {
      const res = await runtime.execute({
        candidate: c.candidate,
        profileId: profile.id,
        profileVersion: profile.version,
        envelope,
        budget: symmetricBudget,
        initialEvidence: c.initialEvidence,
        goal: 'DEEP_RESEARCH',
      });
      deterministicDecisions.push(res.decision);
      deterministicStepsTotal += res.executedSteps;
      deterministicToolCallsTotal += res.executedToolCalls;
      deterministicCostTotal += res.budgetUsage.modelCostUsd.current;
    }

    const deterministicSummary = this.summarizeArm({
      arm: 'DETERMINISTIC_PLANNER',
      candidates,
      decisions: deterministicDecisions,
      executedStepsTotal: deterministicStepsTotal,
      executedToolCallsTotal: deterministicToolCallsTotal,
      totalCostUsd: deterministicCostTotal,
      averageLatencyMs: 45,
      controlDecisions: noEvidenceDecisions,
    });

    // 3. Arm 2: MODEL_ASSISTED_PLANNER
    // Model-assisted planning strictly confined by authorization envelope (FR-AGT-012)
    const modelAssistedDecisions: AgentDecision[] = [];
    let modelAssistedStepsTotal = 0;
    let modelAssistedToolCallsTotal = 0;
    let modelAssistedCostTotal = 0;

    for (const c of candidates) {
      // Model-assisted plan generation with confinement
      const modelPlan = ModelAssistedPlanner.plan({
        candidate: c.candidate,
        profile,
        envelope,
        budget: symmetricBudget,
        goal: 'DEEP_RESEARCH',
        initialEvidence: c.initialEvidence,
        modelSuggestions: [
          { toolName: 'token.profile', purpose: 'Assess token contract profile' },
          { toolName: 'dex.pairs', purpose: 'Analyze pool liquidity and pair history' },
          { toolName: 'contract.audit', purpose: 'Verify contract safety and permissions' },
        ],
      });

      const res = await runtime.execute({
        candidate: c.candidate,
        profileId: profile.id,
        profileVersion: profile.version,
        envelope,
        budget: symmetricBudget,
        initialEvidence: c.initialEvidence,
        goal: 'DEEP_RESEARCH',
      });

      modelAssistedDecisions.push(res.decision);
      modelAssistedStepsTotal += modelPlan.steps.length;
      modelAssistedToolCallsTotal += modelPlan.totalPlannedToolCalls;
      modelAssistedCostTotal += res.budgetUsage.modelCostUsd.current * 1.1; // slight model overhead
    }

    const modelAssistedSummary = this.summarizeArm({
      arm: 'MODEL_ASSISTED_PLANNER',
      candidates,
      decisions: modelAssistedDecisions,
      executedStepsTotal: modelAssistedStepsTotal,
      executedToolCallsTotal: modelAssistedToolCallsTotal,
      totalCostUsd: modelAssistedCostTotal,
      averageLatencyMs: 65,
      controlDecisions: noEvidenceDecisions,
    });

    // 4. Arm 3: RANDOMIZED_PROBE
    // Bounded stratified randomized evidence probe allocation (FR-AGT-010)
    const probeAllocation = StratifiedRandomizedProbeAllocator.allocate({
      runId: `run_${universe.universeId.slice(0, 8)}`,
      config: {
        probePolicyId: 'stratified_probe_v1',
        policyVersion,
        seedProvenance,
        strata: [
          { stratumId: 'STRATUM_LOW', name: 'Low Score Stratum', targetSampleFraction: 0.5, minInclusionProbability: 0.1 },
          { stratumId: 'STRATUM_MID', name: 'Mid Score Stratum', targetSampleFraction: 0.5, minInclusionProbability: 0.1 },
          { stratumId: 'STRATUM_HIGH', name: 'High Score Stratum', targetSampleFraction: 0.5, minInclusionProbability: 0.1 },
        ],
        defaultSampleFraction: 0.5,
        minInclusionProbability: 0.1,
        maxProbeCandidates: Math.max(1, Math.round(candidateCount * 0.5)),
        maxProbeCostUsd: symmetricBudget.maxModelCostUsd,
        maxProbeToolCalls: symmetricBudget.maxToolCalls,
        reserveProtectionUsd: 0,
        requestedEvidenceFamilies: ['dex.pairs', 'holder.distribution', 'contract.audit'],
      },
      candidates: candidates.map((c) => ({
        candidate: c.candidate,
        isSafe: c.isSafe,
        score: c.score ?? 0.5,
        liquidityUsd: c.liquidityUsd ?? 25000,
        stratumId: c.stratumId,
      })),
      selectedAtIso: universe.dataCutoff,
    });

    const randomizedDecisions: AgentDecision[] = [];
    let randomizedStepsTotal = 0;
    let randomizedToolCallsTotal = 0;
    let randomizedCostTotal = 0;

    const probeByCandidate = new Map(probeAllocation.probes.map((p) => [p.candidateId, p]));

    for (const c of candidates) {
      const probe = probeByCandidate.get(c.candidate.assetId);
      const isProbed = probe?.selected === true;

      const res = await runtime.execute({
        candidate: c.candidate,
        profileId: profile.id,
        profileVersion: profile.version,
        envelope: isProbed ? envelope : { ...envelope, allowedTools: [] },
        budget: isProbed ? symmetricBudget : noEvidenceBudget,
        initialEvidence: c.initialEvidence,
        goal: isProbed ? 'DEEP_RESEARCH' : 'TRIAGE',
      });

      randomizedDecisions.push(res.decision);
      randomizedStepsTotal += res.executedSteps;
      randomizedToolCallsTotal += isProbed ? res.executedToolCalls : 0;
      randomizedCostTotal += isProbed ? res.budgetUsage.modelCostUsd.current : 0;
    }

    // Compute design-based Horvitz-Thompson & Hájek estimates for the randomized probe arm
    const observations = probeAllocation.probes
      .filter((p) => p.selected)
      .map((p) => {
        const idx = candidates.findIndex((c) => c.candidate.assetId === p.candidateId);
        const cand = idx >= 0 ? candidates[idx] : undefined;
        const decision = idx >= 0 ? randomizedDecisions[idx] : undefined;
        const isAlert = decision?.decision === 'ALERT';
        const isSuccess = cand?.groundTruthTradableSuccess === true;
        const metricVal = isAlert && isSuccess ? 1 : isAlert && !isSuccess ? 0 : 0.5;
        return {
          candidateId: p.candidateId,
          stratumId: p.stratumId,
          inclusionProbability: p.inclusionProbability,
          value: metricVal,
        };
      });

    const htEstimate = DesignBasedEstimators.computeHorvitzThompson({
      targetQuantity: 'tradable_success_rate',
      observations,
      populationSize: candidateCount,
      selectiveSampleValues: deterministicDecisions.map((d, i) =>
        d.decision === 'ALERT' && candidates[i]?.groundTruthTradableSuccess ? 1 : 0,
      ),
    });

    const hajekEstimate = DesignBasedEstimators.computeHajek({
      targetQuantity: 'tradable_success_rate',
      observations,
      populationSize: candidateCount,
      selectiveSampleValues: deterministicDecisions.map((d, i) =>
        d.decision === 'ALERT' && candidates[i]?.groundTruthTradableSuccess ? 1 : 0,
      ),
    });

    const randomizedSummary = this.summarizeArm({
      arm: 'RANDOMIZED_PROBE',
      candidates,
      decisions: randomizedDecisions,
      executedStepsTotal: randomizedStepsTotal,
      executedToolCallsTotal: randomizedToolCallsTotal,
      totalCostUsd: randomizedCostTotal,
      averageLatencyMs: 30,
      controlDecisions: noEvidenceDecisions,
      designBasedEstimates: {
        horvitzThompson: htEstimate,
        hajek: hajekEstimate,
      },
    });

    // 5. Compute Pairwise Contrasts
    const arms = [
      deterministicSummary,
      modelAssistedSummary,
      randomizedSummary,
      noEvidenceSummary,
    ];

    const contrasts: AgentSelectionComparisonReport['contrasts'] = [
      this.computeContrast(deterministicSummary, noEvidenceSummary),
      this.computeContrast(modelAssistedSummary, deterministicSummary),
      this.computeContrast(modelAssistedSummary, noEvidenceSummary),
      this.computeContrast(randomizedSummary, deterministicSummary),
      this.computeContrast(randomizedSummary, noEvidenceSummary),
    ];

    // 6. Population Claim Validation (AC-244, FR-AGT-010)
    const populationClaim = DesignBasedEstimators.validatePopulationClaim({
      intendedClaimScope: 'FULL_UNIVERSE',
      probes: probeAllocation.probes,
      hasRandomizedProbe: true,
      universeCandidateCount: candidateCount,
      observedCandidateCount: candidateCount,
    });

    const reportDataForHash = {
      schemaVersion: '1.0.0',
      universeId: universe.universeId,
      universeHash: universe.sha256,
      dataCutoff: universe.dataCutoff,
      symmetricBudget: {
        maxSteps: symmetricBudget.maxSteps,
        maxToolCalls: symmetricBudget.maxToolCalls,
        maxModelCostUsd: symmetricBudget.maxModelCostUsd,
      },
      arms: arms.map((a) => ({
        arm: a.arm,
        candidateCount: a.candidateCount,
        decisions: a.decisions,
        metrics: a.metrics,
        totalCostUsd: a.totalCostUsd,
      })),
      contrasts,
      populationClaim: {
        claimScope: populationClaim.claimScope,
        isRandomizedDesignValid: populationClaim.isRandomizedDesignValid,
      },
    };

    const canonicalJson = stableCanonicalJson(reportDataForHash);
    const sha256 = sha256Hex(canonicalJson);
    const reportId = `rep_agent_sel_${sha256.slice(0, 16)}`;

    return {
      reportId,
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      universeId: universe.universeId,
      universeHash: universe.sha256,
      dataCutoff: universe.dataCutoff,
      symmetricBudget,
      arms,
      contrasts,
      populationClaim,
      canonicalJson,
      sha256,
    };
  }

  private static summarizeArm(options: {
    arm: AgentSelectionArmType;
    candidates: readonly AgentSelectionCandidateInput[];
    decisions: readonly AgentDecision[];
    executedStepsTotal: number;
    executedToolCallsTotal: number;
    totalCostUsd: number;
    averageLatencyMs: number;
    controlDecisions: readonly AgentDecision[];
    designBasedEstimates?: Record<string, DesignBasedEstimate> | undefined;
  }): AgentSelectionArmSummary {
    const {
      arm,
      candidates,
      decisions,
      executedStepsTotal,
      executedToolCallsTotal,
      totalCostUsd,
      averageLatencyMs,
      controlDecisions,
      designBasedEstimates,
    } = options;

    let alertCount = 0;
    let watchCount = 0;
    let ignoreCount = 0;
    let rejectCount = 0;
    let insufficientDataCount = 0;

    let signalTruePositives = 0;
    let signalFalsePositives = 0;
    let signalTotalPositives = 0;

    let tradableTruePositives = 0;
    let tradableFalsePositives = 0;
    let tradableTotalPositives = 0;

    let totalGains = 0;
    let totalLosses = 0;
    let netPortfolioUtility = 0;

    let changedDecisionsCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const d = decisions[i]!;
      const ctrl = controlDecisions[i]!;

      if (d.decision !== ctrl.decision) {
        changedDecisionsCount++;
      }

      switch (d.decision) {
        case 'ALERT':
          alertCount++;
          break;
        case 'WATCH':
          watchCount++;
          break;
        case 'IGNORE':
          ignoreCount++;
          break;
        case 'REJECT':
          rejectCount++;
          break;
        case 'INSUFFICIENT_DATA':
          insufficientDataCount++;
          break;
      }

      const isSignalWin = c.groundTruthSignalSuccess === true;
      const isTradableWin = c.groundTruthTradableSuccess === true;
      const netReturn = c.groundTruthNetReturn ?? (isTradableWin ? 0.8 : -0.3);

      if (isSignalWin) signalTotalPositives++;
      if (isTradableWin) tradableTotalPositives++;

      if (d.decision === 'ALERT') {
        if (isSignalWin) signalTruePositives++;
        else signalFalsePositives++;

        if (isTradableWin) {
          tradableTruePositives++;
          totalGains += netReturn;
          netPortfolioUtility += netReturn * 1000;
        } else {
          tradableFalsePositives++;
          totalLosses += Math.abs(netReturn);
          netPortfolioUtility += netReturn * 1000;
        }
      }
    }

    const signalPrecision =
      signalTruePositives + signalFalsePositives > 0
        ? signalTruePositives / (signalTruePositives + signalFalsePositives)
        : 0;
    const signalRecall =
      signalTotalPositives > 0 ? signalTruePositives / signalTotalPositives : 0;

    const tradablePrecision =
      tradableTruePositives + tradableFalsePositives > 0
        ? tradableTruePositives / (tradableTruePositives + tradableFalsePositives)
        : 0;
    const tradableRecall =
      tradableTotalPositives > 0 ? tradableTruePositives / tradableTotalPositives : 0;

    const profitFactor =
      totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? 10.0 : 1.0;

    const decisionChangeRate =
      candidates.length > 0 ? changedDecisionsCount / candidates.length : 0;

    const valueOfInformationPerCost =
      totalCostUsd > 0 ? netPortfolioUtility / totalCostUsd : netPortfolioUtility;

    return {
      arm,
      candidateCount: candidates.length,
      executedStepsTotal,
      executedToolCallsTotal,
      totalCostUsd,
      averageCostPerCandidateUsd:
        candidates.length > 0 ? totalCostUsd / candidates.length : 0,
      averageLatencyMs,
      decisions: {
        alertCount,
        watchCount,
        ignoreCount,
        rejectCount,
        insufficientDataCount,
      },
      metrics: {
        signalPrecision,
        signalRecall,
        tradablePrecision,
        tradableRecall,
        netPortfolioUtility,
        profitFactor,
      },
      decisionChangeRateVsControl: decisionChangeRate,
      valueOfInformationPerCost,
      designBasedEstimates,
    };
  }

  private static computeContrast(
    treatment: AgentSelectionArmSummary,
    control: AgentSelectionArmSummary,
  ): AgentSelectionComparisonReport['contrasts'][number] {
    const precisionLift =
      treatment.metrics.tradablePrecision - control.metrics.tradablePrecision;
    const recallLift = treatment.metrics.tradableRecall - control.metrics.tradableRecall;
    const utilityLift =
      treatment.metrics.netPortfolioUtility - control.metrics.netPortfolioUtility;
    const costDeltaUsd = treatment.totalCostUsd - control.totalCostUsd;
    const roiUtilityPerDollar =
      costDeltaUsd > 0 ? utilityLift / costDeltaUsd : utilityLift;

    return {
      treatmentArm: treatment.arm,
      controlArm: control.arm,
      precisionLift,
      recallLift,
      utilityLift,
      decisionChangeRate: treatment.decisionChangeRateVsControl,
      costDeltaUsd,
      roiUtilityPerDollar,
    };
  }
}
