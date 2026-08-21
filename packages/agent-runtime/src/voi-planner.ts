/**
 * @requirement FR-AGT-009 - Value-of-information planner that persists per-family request/skip decisions with explicit reasons.
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY, not RETURNED_EMPTY, PROVIDER_UNAVAILABLE, or a negative feature value.
 * @requirement AC-243 - Randomized evidence probe stores eligibility stratum, nonzero assignment probability, seed provenance, selection timestamp, requested fields, and final decision impact.
 * @requirement FR-DATA-011 - Acquisition states remain distinct from substantive negative evidence.
 * @requirement FR-DATA-012 - Store policy version, candidate state, requested fields, expected value of information, estimated/actual cost, timestamps, result state, evidence IDs, and whether evidence changed final decision.
 */

import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  AgentDecision,
  EvidenceAcquisitionDecision,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import type { CandidateTarget } from './deterministic-planner.js';
import {
  EvidenceFamilyRegistry,
  type EvidenceFamilyDefinition,
} from './evidence-families.js';

export interface VoiPolicy {
  policyVersion: string;
  minExpectedInformationValue: number;
  candidateNearAlertThreshold: number;
  costWeight: number;
  enableRandomizedProbes?: boolean | undefined;
  randomizedProbeRate?: number | undefined;
  randomizationSeedRef?: string | undefined;
}

export const DEFAULT_VOI_POLICY: VoiPolicy = {
  policyVersion: '1.0.0',
  minExpectedInformationValue: 0.25,
  candidateNearAlertThreshold: 0.70,
  costWeight: 5.0,
  enableRandomizedProbes: false,
  randomizedProbeRate: 0.05,
  randomizationSeedRef: 'voi-probe-seed-v1',
};

export interface VoiPlanInput {
  candidate: CandidateTarget;
  runId: string;
  envelope: ToolAuthorizationEnvelope;
  budget: AgentBudget;
  profile: ModelProfile;
  currentCandidateScore?: number | undefined;
  currentRiskState?: string | undefined;
  currentLifecycleState?: string | undefined;
  knownEvidence?: Record<string, unknown> | undefined;
  hardRejectionProven?: boolean | undefined;
  alertThresholdUnreachable?: boolean | undefined;
  randomizationStratum?: string | undefined;
  policy?: Partial<VoiPolicy> | undefined;
  registry?: EvidenceFamilyRegistry | undefined;
  asOf?: string | undefined;
}

export interface VoiPlanResult {
  policyVersion: string;
  candidateId: string;
  runId: string;
  decisions: EvidenceAcquisitionDecision[];
  requestedFamilies: string[];
  skippedFamilies: string[];
  totalEstimatedMonetaryCostUsd: number;
  totalEstimatedQuotaUnits: number;
  plannedAt: string;
}

export interface ReconcileExecutionOptions {
  decisions: readonly EvidenceAcquisitionDecision[];
  toolRecords?: Array<{ toolName: string; callId: string; output?: unknown; error?: string | undefined }> | undefined;
  previousDecision?: AgentDecision | undefined;
  finalDecision: AgentDecision;
  actualCost?: { monetaryCostUsd?: number; quotaCostUnits?: number } | undefined;
  completedAt?: string | undefined;
}

export class VoiPlanner {
  public readonly policy: VoiPolicy;
  public readonly registry: EvidenceFamilyRegistry;

  constructor(
    policy: Partial<VoiPolicy> = {},
    registry: EvidenceFamilyRegistry = new EvidenceFamilyRegistry(),
  ) {
    this.policy = { ...DEFAULT_VOI_POLICY, ...policy };
    this.registry = registry;
  }

  /**
   * Plans evidence acquisition decisions for every eligible evidence family.
   * Persists an explicit decision record (requested or skipped with reason) for every optional family.
   */
  public planAcquisitions(input: VoiPlanInput): VoiPlanResult {
    const policy = { ...this.policy, ...(input.policy ?? {}) };
    const registry = input.registry ?? this.registry;
    const { candidate, runId, envelope, budget, profile } = input;
    const asOf = input.asOf ?? envelope.timeRange?.maxTimestamp ?? new Date().toISOString();

    const candidateScore = input.currentCandidateScore ?? 0.5;
    const isNearAlert = candidateScore >= policy.candidateNearAlertThreshold;
    const isHardRejected = input.hardRejectionProven === true;
    const isUnreachable = input.alertThresholdUnreachable === true;

    // Prioritize mandatory core families first, then optional families by defaultPriority
    const families = [...registry.list()].sort((a, b) => {
      if (!a.isOptional && b.isOptional) return -1;
      if (a.isOptional && !b.isOptional) return 1;
      return b.defaultPriority - a.defaultPriority;
    });
    const decisions: EvidenceAcquisitionDecision[] = [];

    let accumulatedEstimatedCostUsd = 0;
    let accumulatedQuotaUnits = 0;

    for (const family of families) {
      const decisionId = `voi_${candidate.assetId}_${family.familyId}_${runId}`;
      const estimatedCost = {
        monetaryCostUsd: family.monetaryCostUsd,
        quotaCostUnits: family.providerQuotaCost,
      };

      // 1. Check tool authorization and profile declared tools
      const toolsInEnvelope = family.tools.filter((t) => envelope.allowedTools.includes(t));
      const toolsInProfile = family.tools.filter((t) => profile.declaredTools.includes(t));
      const isProfileSupported = toolsInProfile.length > 0;
      const isRightsAuthorized = toolsInEnvelope.length > 0;

      // 2. Check if evidence is already known
      const hasKnownEvidence = family.fieldsProduced.some(
        (field) => input.knownEvidence && input.knownEvidence[field] !== undefined,
      );

      // 3. Compute Expected Value of Information (EVOI)
      const evoi = this.calculateExpectedInformationValue({
        family,
        candidateScore,
        currentRisk: input.currentRiskState,
        isNearAlert,
        hasKnownEvidence,
        isHardRejected,
        isUnreachable,
        costWeight: policy.costWeight,
      });

      // 4. Randomized probe check using explicit eligibility stratum (AC-243)
      const stratum =
        input.randomizationStratum ??
        (isNearAlert
          ? 'NEAR_ALERT'
          : input.currentRiskState
            ? `RISK_${input.currentRiskState}`
            : input.currentLifecycleState
              ? `LIFECYCLE_${input.currentLifecycleState}`
              : 'GENERAL_ELIGIBLE');

      const probeCheck = this.evaluateRandomizedProbe(
        candidate.assetId,
        family.familyId,
        policy,
        stratum,
      );

      // 5. Decision state & reason resolution
      let state: EvidenceAcquisitionDecision['state'];
      let skipReason: string | undefined;
      let requestReason: string | undefined;
      const reasonCodes: string[] = [];
      let expectedDecisionImpact = `Information value: ${evoi.toFixed(3)}`;

      if (isHardRejected && family.isOptional) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Hard rejection already proven; additional optional evidence skipped by policy';
        reasonCodes.push('HARD_REJECTION_PROVEN', 'POLICY_STOP_CONDITION');
      } else if (isUnreachable && family.isOptional) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Alert threshold unreachable under current state; additional optional evidence skipped by policy';
        reasonCodes.push('ALERT_THRESHOLD_UNREACHABLE', 'POLICY_STOP_CONDITION');
      } else if (!isProfileSupported) {
        state = 'UNSUPPORTED';
        skipReason = `Tools for family ${family.familyId} (${family.tools.join(', ')}) are not declared in model profile ${profile.id}`;
        reasonCodes.push('TOOL_NOT_SUPPORTED_IN_PROFILE');
      } else if (!isRightsAuthorized) {
        state = 'RIGHTS_BLOCKED';
        skipReason = `Tools for family ${family.familyId} (${family.tools.join(', ')}) are not permitted by authorization envelope`;
        reasonCodes.push('TOOL_NOT_AUTHORIZED_IN_ENVELOPE', 'RIGHTS_BLOCKED_BY_POLICY');
      } else if (hasKnownEvidence) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Sufficient evidence for family already collected in run context';
        reasonCodes.push('EVIDENCE_ALREADY_KNOWN', 'DIMINISHING_MARGINAL_UTILITY');
      } else if (
        budget.maxModelCostUsd !== undefined &&
        accumulatedEstimatedCostUsd + family.monetaryCostUsd > budget.maxModelCostUsd
      ) {
        state = 'COST_BLOCKED';
        skipReason = `Estimated cost ($${family.monetaryCostUsd}) exceeds remaining model cost budget`;
        reasonCodes.push('BUDGET_COST_EXCEEDED');
      } else if (
        budget.maxProviderCostUnits !== undefined &&
        accumulatedQuotaUnits + family.providerQuotaCost > budget.maxProviderCostUnits
      ) {
        state = 'QUOTA_BLOCKED';
        skipReason = `Provider quota cost (${family.providerQuotaCost} units) exceeds remaining provider quota budget`;
        reasonCodes.push('BUDGET_QUOTA_EXCEEDED');
      } else if (probeCheck.selected) {
        state = 'REQUESTED';
        requestReason = 'Selected under stratified randomized evidence probe policy';
        reasonCodes.push('RANDOMIZED_EVIDENCE_PROBE');
        expectedDecisionImpact = 'Exploratory randomized probe measurement for selection-bias adjustment';
        accumulatedEstimatedCostUsd += family.monetaryCostUsd;
        accumulatedQuotaUnits += family.providerQuotaCost;
      } else if (evoi >= policy.minExpectedInformationValue || !family.isOptional) {
        state = 'REQUESTED';
        requestReason = !family.isOptional
          ? 'Mandatory core evidence family for initial candidate characterization'
          : isNearAlert
            ? `High expected information value (${evoi.toFixed(3)}) near alert threshold`
            : `Expected information value (${evoi.toFixed(3)}) satisfies policy threshold (${policy.minExpectedInformationValue})`;
        if (!family.isOptional) {
          reasonCodes.push('MANDATORY_CORE_EVIDENCE');
        } else {
          reasonCodes.push('VOI_THRESHOLD_SATISFIED');
        }
        accumulatedEstimatedCostUsd += family.monetaryCostUsd;
        accumulatedQuotaUnits += family.providerQuotaCost;
      } else {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = `Expected information value (${evoi.toFixed(3)}) below policy acquisition threshold (${policy.minExpectedInformationValue})`;
        reasonCodes.push('DIMINISHING_MARGINAL_UTILITY', 'LOW_EXPECTED_VOI');
      }

      if (probeCheck.selected && !reasonCodes.includes('RANDOMIZED_EVIDENCE_PROBE')) {
        reasonCodes.push('RANDOMIZED_EVIDENCE_PROBE');
      }

      const decision: EvidenceAcquisitionDecision = {
        id: decisionId,
        candidateId: candidate.assetId,
        runId,
        evidenceFamily: family.familyId,
        policyVersion: policy.policyVersion,
        state,
        requestedFields: state === 'REQUESTED' ? [...family.fieldsProduced] : [],
        expectedDecisionImpact,
        expectedInformationValue: evoi,
        estimatedCost,
        randomized: probeCheck.selected,
        assignmentProbability: probeCheck.probability,
        randomizationStratum: probeCheck.stratum,
        randomizationSeedRef: probeCheck.seedRef,
        decidedAt: asOf,
        evidenceIds: [],
        reasonCodes,
        skipReason,
        requestReason,
      };

      decisions.push(decision);
    }

    const requestedFamilies = decisions
      .filter((d) => d.state === 'REQUESTED')
      .map((d) => d.evidenceFamily);
    const skippedFamilies = decisions
      .filter((d) => d.state !== 'REQUESTED')
      .map((d) => d.evidenceFamily);

    return {
      policyVersion: policy.policyVersion,
      candidateId: candidate.assetId,
      runId,
      decisions,
      requestedFamilies,
      skippedFamilies,
      totalEstimatedMonetaryCostUsd: accumulatedEstimatedCostUsd,
      totalEstimatedQuotaUnits: accumulatedQuotaUnits,
      plannedAt: asOf,
    };
  }

  /**
   * Calculates Expected Value of Information for an evidence family.
   */
  private calculateExpectedInformationValue(params: {
    family: EvidenceFamilyDefinition;
    candidateScore: number;
    currentRisk?: string | undefined;
    isNearAlert: boolean;
    hasKnownEvidence: boolean;
    isHardRejected: boolean;
    isUnreachable: boolean;
    costWeight?: number | undefined;
  }): number {
    const { family, candidateScore, isNearAlert, hasKnownEvidence, isHardRejected, isUnreachable } = params;

    if (hasKnownEvidence || (family.isOptional && (isHardRejected || isUnreachable))) {
      return 0.0;
    }

    // Core families have baseline high value
    let baseValue = family.isOptional ? 0.40 : 0.90;

    // Uncertainty proximity: highest near 0.50 - 0.75 boundary
    const uncertaintyFactor = 1.0 - Math.abs(candidateScore - 0.70) * 0.8;
    baseValue *= Math.max(0.2, uncertaintyFactor);

    // If near alert, high-priority families (security, liquidity lock, sell sim) receive substantial boost
    if (isNearAlert) {
      if (
        family.familyId === 'CONTRACT_SECURITY' ||
        family.familyId === 'LIQUIDITY_LOCK' ||
        family.familyId === 'SELL_SIMULATION'
      ) {
        baseValue += 0.35;
      } else if (family.familyId === 'HOLDER_DISTRIBUTION') {
        baseValue += 0.20;
      }
    }

    // High risk elevates need for verification
    if (params.currentRisk === 'HIGH' || params.currentRisk === 'UNKNOWN') {
      if (family.familyId === 'CONTRACT_SECURITY' || family.familyId === 'SELL_SIMULATION') {
        baseValue += 0.25;
      }
    }

    // Cost penalty: penalize higher monetary cost and provider quota cost scaled by costWeight
    const costWeight = params.costWeight ?? 5.0;
    if (family.isOptional && costWeight > 0) {
      const normalizedCost = (family.monetaryCostUsd * 2) + (family.providerQuotaCost * 0.001);
      baseValue -= Math.min(0.20, costWeight * normalizedCost);
    }

    // Reliability weighting
    baseValue *= family.reliability;

    // Normalize between 0.0 and 1.0
    return Math.max(0.0, Math.min(1.0, Number(baseValue.toFixed(4))));
  }

  /**
   * Stratified randomized probe assignment calculation.
   */
  private evaluateRandomizedProbe(
    candidateId: string,
    familyId: string,
    policy: VoiPolicy,
    stratum?: string,
  ): {
    selected: boolean;
    probability?: string | undefined;
    stratum?: string | undefined;
    seedRef?: string | undefined;
  } {
    if (!policy.enableRandomizedProbes || !policy.randomizedProbeRate || policy.randomizedProbeRate <= 0) {
      return { selected: false };
    }

    const seed = policy.randomizationSeedRef ?? 'voi-default-seed';
    const hash = createHash('sha256')
      .update(`${seed}:${candidateId}:${familyId}:${stratum ?? 'all'}`)
      .digest('hex');

    const sample = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
    const selected = sample < policy.randomizedProbeRate;

    return {
      selected,
      probability: String(policy.randomizedProbeRate),
      stratum: stratum ?? 'GENERAL_ELIGIBLE',
      seedRef: seed,
    };
  }

  /**
   * Reconciles VOI decision records after execution, updating actual costs, evidence IDs,
   * completedAt, and tracking whether gathered evidence changed the final decision.
   */
  public reconcileDecisions(options: ReconcileExecutionOptions): EvidenceAcquisitionDecision[] {
    const { decisions, toolRecords = [], previousDecision, finalDecision, actualCost, completedAt } = options;
    const now = completedAt ?? new Date().toISOString();

    return decisions.map((decision) => {
      const family = this.registry.get(decision.evidenceFamily);
      const relevantTools = family ? family.tools : [];

      // Collect evidence IDs generated by tools in this family
      const matchingToolRecords = toolRecords.filter((tr) =>
        relevantTools.includes(tr.toolName),
      );
      const evidenceIds = matchingToolRecords.map((tr) => tr.callId);

      // Determine if decision changed
      let actualDecisionChange: EvidenceAcquisitionDecision['actualDecisionChange'] = 'NONE';
      if (previousDecision && decision.state === 'REQUESTED' && evidenceIds.length > 0) {
        if (previousDecision.decision !== finalDecision.decision) {
          actualDecisionChange =
            finalDecision.decision === 'INSUFFICIENT_DATA'
              ? 'ABSTENTION'
              : finalDecision.decision === 'ALERT'
                ? 'ALERT'
                : 'LIFECYCLE';
        } else if (previousDecision.riskRecommendation !== finalDecision.riskRecommendation) {
          actualDecisionChange = 'RISK';
        } else if (previousDecision.lifecycleRecommendation !== finalDecision.lifecycleRecommendation) {
          actualDecisionChange = 'LIFECYCLE';
        }
      }

      // Update state if requested but execution failed
      let finalState = decision.state;
      if (decision.state === 'REQUESTED') {
        const anyFailed = matchingToolRecords.some((r) => r.error !== undefined);
        const allEmpty = matchingToolRecords.length > 0 && matchingToolRecords.every((r) => r.output === null || r.output === undefined);
        if (anyFailed) {
          finalState = 'FAILED';
        } else if (allEmpty) {
          finalState = 'RETURNED_EMPTY';
        } else if (matchingToolRecords.length > 0) {
          finalState = 'RETURNED';
        }
      }

      // Update actual cost per family based on executed tool records
      let decisionActualCost: typeof decision.estimatedCost;
      if (decision.state !== 'REQUESTED' || matchingToolRecords.length === 0) {
        decisionActualCost = {
          monetaryCostUsd: 0,
          quotaCostUnits: 0,
        };
      } else if (family) {
        decisionActualCost = {
          monetaryCostUsd: Number((matchingToolRecords.length * family.monetaryCostUsd).toFixed(6)),
          quotaCostUnits: matchingToolRecords.length * family.providerQuotaCost,
        };
      } else if (actualCost) {
        decisionActualCost = actualCost;
      } else {
        decisionActualCost = {
          monetaryCostUsd: 0,
          quotaCostUnits: 0,
        };
      }

      return {
        ...decision,
        state: finalState,
        completedAt: now,
        actualCost: decisionActualCost,
        actualDecisionChange,
        evidenceIds: evidenceIds.length > 0 ? evidenceIds : decision.evidenceIds,
      };
    });
  }

  /**
   * Renders evidence acquisition decisions clearly.
   * Explicitly renders skipped families with NOT_REQUESTED_BY_POLICY rather than missing/unfavorable.
   */
  public renderEvidenceAcquisitions(decisions: readonly EvidenceAcquisitionDecision[]): string {
    const lines: string[] = ['### Evidence Acquisition Decisions (Value-of-Information Planner)', ''];

    for (const d of decisions) {
      if (d.state === 'NOT_REQUESTED_BY_POLICY') {
        lines.push(`- **[NOT_REQUESTED_BY_POLICY]** Family \`${d.evidenceFamily}\`: Skipped by policy (${d.skipReason ?? 'Diminishing expected information value'}). Note: Missingness is neutral; not unfavorable.`);
      } else if (d.state === 'REQUESTED' || d.state === 'RETURNED') {
        lines.push(`- **[${d.state}]** Family \`${d.evidenceFamily}\`: ${d.requestReason ?? 'Requested by policy'} | EVOI: ${d.expectedInformationValue?.toFixed(3) ?? 'N/A'} | Est Cost: $${d.estimatedCost?.monetaryCostUsd ?? 0}`);
      } else {
        lines.push(`- **[${d.state}]** Family \`${d.evidenceFamily}\`: ${d.skipReason ?? d.reasonCodes.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Downstream scoring helper that handles missingness safely.
   * Treats NOT_REQUESTED_BY_POLICY as neutral missingness (cohort prior), NEVER inferring a negative signal.
   */
  public scoreWithMissingnessAwareness(params: {
    featureValues: Record<string, number | null | undefined>;
    acquisitionDecisions: readonly EvidenceAcquisitionDecision[];
    featureWeights: Record<string, number>;
    baselineCohortScores?: Record<string, number> | undefined;
  }): {
    compositeScore: number;
    evaluatedFeatures: Record<
      string,
      {
        value: number | null;
        imputedValue: number;
        weight: number;
        acquisitionState: string;
        isMissing: boolean;
        isNegativeInferred: boolean;
      }
    >;
  } {
    const { featureValues, acquisitionDecisions, featureWeights, baselineCohortScores = {} } = params;

    const decisionByFamily = new Map(acquisitionDecisions.map((d) => [d.evidenceFamily, d]));
    const fieldToFamilyMap = this.registry.getFieldToFamilyMap();
    const evaluatedFeatures: Record<
      string,
      {
        value: number | null;
        imputedValue: number;
        weight: number;
        acquisitionState: string;
        isMissing: boolean;
        isNegativeInferred: boolean;
      }
    > = {};

    let weightedSum = 0;
    let totalWeight = 0;

    for (const [featureKey, rawValue] of Object.entries(featureValues)) {
      const weight = featureWeights[featureKey] ?? 1.0;
      totalWeight += weight;

      // Find matching decision via explicit field/tool to family index
      const familyId = fieldToFamilyMap.get(featureKey) ??
        this.registry.findByField(featureKey)?.familyId ??
        this.registry.findByTool(featureKey)[0]?.familyId;
      const decision = familyId ? decisionByFamily.get(familyId) : undefined;
      const acquisitionState = decision ? decision.state : 'NOT_REQUESTED_BY_POLICY';

      const isMissing = rawValue === null || rawValue === undefined;
      let imputedValue = 0.5; // neutral baseline default

      if (isMissing) {
        if (
          acquisitionState === 'NOT_REQUESTED_BY_POLICY' ||
          acquisitionState === 'COST_BLOCKED' ||
          acquisitionState === 'QUOTA_BLOCKED' ||
          acquisitionState === 'RIGHTS_BLOCKED' ||
          acquisitionState === 'UNSUPPORTED'
        ) {
          // Unobserved due to policy, budget bounds, or authorization constraints - neutral cohort baseline prior (NO negative penalty)
          imputedValue = baselineCohortScores[featureKey] ?? 0.5;
        } else {
          // Truly missing provider data
          imputedValue = 0.5;
        }
      } else {
        imputedValue = rawValue;
      }

      weightedSum += imputedValue * weight;

      evaluatedFeatures[featureKey] = {
        value: rawValue ?? null,
        imputedValue,
        weight,
        acquisitionState,
        isMissing,
        isNegativeInferred: false, // Invariant: missingness never inferred as negative
      };
    }

    const compositeScore = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

    return {
      compositeScore: Number(compositeScore.toFixed(4)),
      evaluatedFeatures,
    };
  }
}
