/**
 * @requirement FR-AGT-009 - Value-of-information planner that persists per-family request/skip decisions with explicit reasons.
 * @requirement FR-AGT-010 - Bounded stratified randomized evidence probe allocation.
 * @requirement FR-AGT-012 - Deterministic planner authorization envelope foundation.
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY, not RETURNED_EMPTY, PROVIDER_UNAVAILABLE, or a negative feature value.
 * @requirement AC-243 - Randomized evidence probe stores eligibility stratum, nonzero assignment probability, seed provenance, selection timestamp, requested fields, and final decision impact.
 * @requirement FR-DATA-011 - Acquisition states remain distinct from substantive negative evidence.
 * @requirement FR-DATA-012 - Store policy version, candidate state, requested fields, expected value of information, estimated/actual cost, timestamps, result state, evidence IDs, and whether evidence changed final decision.
 * @requirement INV-022 - Distinct from unavailable or negative evidence.
 */

import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  AgentDecision,
  EvidenceAcquisitionDecision,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import {
  DeterministicPlanner,
  type CandidateTarget,
  type DeterministicPlan,
} from './deterministic-planner.js';
import {
  EvidenceFamilyRegistry,
  type EvidenceFamilyDefinition,
} from './evidence-families.js';
import {
  type EvidenceAcquisitionStore,
  getEvidenceAcquisitionStore,
} from './acquisition-state.js';

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

export interface RandomProbeConfig {
  enabled: boolean;
  stratum: string;
  inclusionProbability: number; // in (0, 1]
  seedRef: string;
}

export interface VoiPlanInput {
  candidate: CandidateTarget & { lifecycle?: string | undefined; risk?: string | undefined };
  goal?: 'TRIAGE' | 'DEEP_RESEARCH' | 'SKEPTIC' | 'ADMIN_CHAT' | 'REPAIR' | undefined;
  runId?: string | undefined;
  envelope: ToolAuthorizationEnvelope;
  budget: AgentBudget;
  profile: ModelProfile;
  policyVersion?: string | undefined;
  currentCandidateScore?: number | undefined;
  currentRiskState?: string | undefined;
  currentLifecycleState?: string | undefined;
  knownEvidence?: Record<string, unknown> | undefined;
  initialEvidence?: Record<string, unknown> | undefined;
  hardRejectionProven?: boolean | undefined;
  alertThresholdUnreachable?: boolean | undefined;
  randomizationStratum?: string | undefined;
  randomProbeConfig?: RandomProbeConfig | undefined;
  policy?: Partial<VoiPolicy> | undefined;
  registry?: EvidenceFamilyRegistry | undefined;
  eligibleEvidenceFamilies?: readonly EvidenceFamilyDefinition[] | readonly string[] | undefined;
  minVoiThreshold?: number | undefined;
  store?: EvidenceAcquisitionStore | undefined;
  deterministicSeedRef?: string | number | undefined;
  asOf?: string | undefined;
}

export type VoiPlannerInput = VoiPlanInput;

export interface VoiPlanResult {
  policyVersion: string;
  candidateId: string;
  runId: string;
  decisions: EvidenceAcquisitionDecision[];
  requestedFamilies: string[];
  skippedFamilies: string[];
  blockedFamilies?: string[] | undefined;
  totalEstimatedMonetaryCostUsd: number;
  totalEstimatedCostUsd?: number | undefined;
  totalEstimatedQuotaUnits: number;
  totalQuotaUnits?: number | undefined;
  plannedAt: string;
  plan?: DeterministicPlan | undefined;
  envelope?: ToolAuthorizationEnvelope | undefined;
}


export type VoiPlannerResult = VoiPlanResult;

export interface ReconcileExecutionOptions {
  decisions: readonly EvidenceAcquisitionDecision[];
  toolRecords?: Array<{ toolName: string; callId: string; output?: unknown; error?: string | undefined }> | undefined;
  previousDecision?: AgentDecision | undefined;
  finalDecision: AgentDecision;
  actualCost?: { monetaryCostUsd?: number; quotaCostUnits?: number } | undefined;
  completedAt?: string | undefined;
}

function stableHash(value: unknown): string {
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
  const json = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(json).digest('hex');
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
  public plan(input: VoiPlanInput): VoiPlanResult {
    const policy = { ...this.policy, ...(input.policy ?? {}) };
    const registry = input.registry ?? this.registry;
    const { candidate, envelope, budget, profile } = input;
    const goal = input.goal ?? (profile.modelClass as VoiPlanInput['goal']) ?? 'TRIAGE';
    const policyVersion = input.policyVersion ?? policy.policyVersion ?? profile.version;
    const runId =
      input.runId ??
      `run_${candidate.assetId}_${stableHash({ candidate: candidate.assetId, profile: profile.id, seed: input.deterministicSeedRef }).slice(0, 12)}`;
    const store = input.store ?? getEvidenceAcquisitionStore();
    const asOf = input.asOf ?? envelope.timeRange?.maxTimestamp ?? new Date().toISOString();

    const candidateScore = input.currentCandidateScore ?? 0.5;
    const isNearAlert = candidateScore >= policy.candidateNearAlertThreshold;
    const isHardRejected = input.hardRejectionProven === true;
    const isUnreachable = input.alertThresholdUnreachable === true;

    // Resolve eligible families
    const eligibleFamilies: EvidenceFamilyDefinition[] = this.resolveEligibleFamilies(
      input.eligibleEvidenceFamilies,
      registry,
    );

    // Prioritize mandatory core families first, then optional families by defaultPriority
    const families = [...eligibleFamilies].sort((a, b) => {
      if (!a.isOptional && b.isOptional) return -1;
      if (a.isOptional && !b.isOptional) return 1;
      return (b.defaultPriority ?? 5) - (a.defaultPriority ?? 5);
    });

    const decisions: EvidenceAcquisitionDecision[] = [];
    const requestedFamilies: string[] = [];
    const skippedFamilies: string[] = [];
    const blockedFamilies: string[] = [];

    let accumulatedEstimatedCostUsd = 0;
    let accumulatedQuotaUnits = 0;
    let accumulatedToolCalls = 0;

    const maxCalls = budget.maxToolCalls;
    const maxCostUsd = budget.maxModelCostUsd ?? envelope.maxCostUsd;
    const maxQuotaUnits = budget.maxProviderCostUnits;

    for (const family of families) {
      const familyId = family.familyId ?? family.id ?? 'UNKNOWN';
      const decisionId = `acq_${runId}_${candidate.assetId}_${familyId}_${policyVersion}`;
      const estimatedCostUsd = family.monetaryCostUsd ?? family.defaultMonetaryCostUsd ?? 0.0001;
      const quotaCostUnits = family.providerQuotaCost ?? family.defaultQuotaUnits ?? 1;
      const estimatedCost = {
        monetaryCostUsd: estimatedCostUsd,
        quotaCostUnits,
      };

      // 1. Check tool authorization and profile declared tools
      const tools = family.tools ?? family.associatedTools ?? [];
      const toolsInEnvelope = tools.filter((t) => envelope.allowedTools.includes(t));
      const toolsInProfile = tools.filter((t) => profile.declaredTools.includes(t));
      const isProfileSupported = toolsInProfile.length > 0;
      const isRightsAuthorized = toolsInEnvelope.length > 0;

      // 2. Check if evidence is already known
      const fields = family.fieldsProduced ?? family.standardFields ?? [];
      const hasKnownEvidence = fields.some(
        (field) => (input.knownEvidence && input.knownEvidence[field] !== undefined) ||
                   (input.initialEvidence && input.initialEvidence[field] !== undefined),
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

      // 4. Randomized probe check using explicit eligibility stratum (AC-243 / FR-AGT-010)
      const stratum =
        input.randomProbeConfig?.stratum ??
        input.randomizationStratum ??
        (isNearAlert
          ? 'NEAR_ALERT'
          : input.currentRiskState
            ? `RISK_${input.currentRiskState}`
            : input.currentLifecycleState
              ? `LIFECYCLE_${input.currentLifecycleState}`
              : 'GENERAL_ELIGIBLE');

      const probeCheck = input.randomProbeConfig?.enabled
        ? {
            selected: this.sampleProbe(input.randomProbeConfig.seedRef, candidate.assetId, familyId, input.randomProbeConfig.inclusionProbability),
            probability: String(input.randomProbeConfig.inclusionProbability),
            stratum: input.randomProbeConfig.stratum,
            seedRef: input.randomProbeConfig.seedRef,
          }
        : this.evaluateRandomizedProbe(candidate.assetId, familyId, policy, stratum);

      // 5. Decision state & reason resolution
      let state: EvidenceAcquisitionDecision['state'];
      let skipReason: string | undefined;
      let requestReason: string | undefined;
      const reasonCodes: string[] = [];
      let expectedDecisionImpact = `Information value: ${evoi.toFixed(3)}`;

      // Envelope checks
      const isChainAllowed =
        !envelope.allowedChains ||
        envelope.allowedChains.length === 0 ||
        envelope.allowedChains.map((c) => c.toLowerCase()).includes(candidate.chainId.toLowerCase());

      const isAddressAllowed =
        !envelope.allowedAddresses ||
        envelope.allowedAddresses.length === 0 ||
        envelope.allowedAddresses.includes(candidate.contractAddress);

      const isEntityAllowed =
        !envelope.allowedEntities ||
        envelope.allowedEntities.length === 0 ||
        envelope.allowedEntities.includes(candidate.assetId);

      if (isHardRejected && family.isOptional) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Hard rejection already proven; additional optional evidence skipped by policy';
        reasonCodes.push('HARD_REJECTION_PROVEN', 'POLICY_STOP_CONDITION');
        skippedFamilies.push(familyId);
      } else if (isUnreachable && family.isOptional) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Alert threshold unreachable under current state; additional optional evidence skipped by policy';
        reasonCodes.push('ALERT_THRESHOLD_UNREACHABLE', 'POLICY_STOP_CONDITION');
        skippedFamilies.push(familyId);
      } else if (!isProfileSupported) {
        state = 'UNSUPPORTED';
        skipReason = `Tools for family ${familyId} (${tools.join(', ')}) are not declared in model profile ${profile.id}`;
        reasonCodes.push('TOOL_NOT_SUPPORTED_IN_PROFILE', 'TOOL_NOT_IN_ENVELOPE');
        blockedFamilies.push(familyId);
      } else if (!isRightsAuthorized || !isChainAllowed || !isAddressAllowed || !isEntityAllowed) {
        state = 'RIGHTS_BLOCKED';
        skipReason = `Tools for family ${familyId} (${tools.join(', ')}) are not permitted by authorization envelope`;
        reasonCodes.push('TOOL_NOT_AUTHORIZED_IN_ENVELOPE', 'RIGHTS_BLOCKED_BY_POLICY');
        blockedFamilies.push(familyId);
      } else if (hasKnownEvidence) {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = 'Sufficient evidence for family already collected in run context';
        reasonCodes.push('EVIDENCE_ALREADY_KNOWN', 'DIMINISHING_MARGINAL_UTILITY');
        skippedFamilies.push(familyId);
      } else if (
        maxCostUsd !== undefined &&
        accumulatedEstimatedCostUsd + estimatedCostUsd > maxCostUsd
      ) {
        state = 'COST_BLOCKED';
        skipReason = `Estimated cost ($${estimatedCostUsd}) exceeds remaining model cost budget`;
        reasonCodes.push('BUDGET_COST_EXCEEDED');
        blockedFamilies.push(familyId);
      } else if (
        maxQuotaUnits !== undefined &&
        accumulatedQuotaUnits + quotaCostUnits > maxQuotaUnits
      ) {
        state = 'QUOTA_BLOCKED';
        skipReason = `Provider quota cost (${quotaCostUnits} units) exceeds remaining provider quota budget`;
        reasonCodes.push('BUDGET_QUOTA_EXCEEDED');
        blockedFamilies.push(familyId);
      } else if (accumulatedToolCalls + tools.length > maxCalls) {
        state = 'COST_BLOCKED';
        skipReason = `Tool call limit exceeded`;
        reasonCodes.push('MAX_TOOL_CALLS_EXCEEDED');
        blockedFamilies.push(familyId);
      } else if (probeCheck.selected) {
        state = 'REQUESTED';
        requestReason = 'Selected under stratified randomized evidence probe policy';
        reasonCodes.push('RANDOM_PROBE_INCLUSION', 'RANDOMIZED_EVIDENCE_PROBE');
        expectedDecisionImpact = 'Exploratory randomized probe measurement for selection-bias adjustment';
        requestedFamilies.push(familyId);
        accumulatedEstimatedCostUsd += estimatedCostUsd;
        accumulatedQuotaUnits += quotaCostUnits;
        accumulatedToolCalls += tools.length;
      } else if (evoi >= (input.minVoiThreshold ?? policy.minExpectedInformationValue) || !family.isOptional || (family.isMandatoryForGoals && family.isMandatoryForGoals.includes(goal))) {
        state = 'REQUESTED';
        requestReason = !family.isOptional
          ? 'Mandatory core evidence family for initial candidate characterization'
          : isNearAlert
            ? `High expected information value (${evoi.toFixed(3)}) near alert threshold`
            : `Expected information value (${evoi.toFixed(3)}) satisfies policy threshold (${policy.minExpectedInformationValue})`;
        if (!family.isOptional) {
          reasonCodes.push('MANDATORY_CORE_EVIDENCE');
        } else {
          reasonCodes.push('HIGH_EXPECTED_IMPACT', 'VOI_THRESHOLD_SATISFIED');
        }
        requestedFamilies.push(familyId);
        accumulatedEstimatedCostUsd += estimatedCostUsd;
        accumulatedQuotaUnits += quotaCostUnits;
        accumulatedToolCalls += tools.length;
      } else {
        state = 'NOT_REQUESTED_BY_POLICY';
        skipReason = `Expected information value (${evoi.toFixed(3)}) below policy acquisition threshold (${policy.minExpectedInformationValue})`;
        reasonCodes.push('VOI_BELOW_THRESHOLD', 'SKIPPED_BY_GOAL_POLICY', 'LOW_EXPECTED_VOI');
        skippedFamilies.push(familyId);
      }

      const decision: EvidenceAcquisitionDecision = {
        id: decisionId,
        candidateId: candidate.assetId,
        runId,
        evidenceFamily: familyId,
        policyVersion,
        state,
        requestedFields: [...fields],
        expectedDecisionImpact: family.defaultDecisionImpact ?? expectedDecisionImpact,
        expectedInformationValue: evoi,
        estimatedCost,
        randomized: probeCheck.selected ?? false,
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

    // Persist decisions to EvidenceAcquisitionStore before retrieval
    try {
      store.recordDecisions(decisions);
    } catch {
      // Ignore conflict if re-planning same run
    }

    // Construct tool calls and steps only for REQUESTED evidence families
    const activeTools = new Set<string>();
    for (const famId of requestedFamilies) {
      const fam = registry.require(famId);
      const tools = fam.tools ?? fam.associatedTools ?? [];
      for (const tool of tools) {
        if (envelope.allowedTools.includes(tool) && profile.declaredTools.includes(tool)) {
          activeTools.add(tool);
        }
      }
    }

    // Generate deterministic plan with bounded active tools
    const boundedEnvelope: ToolAuthorizationEnvelope = {
      ...envelope,
      allowedTools: Array.from(activeTools).sort((a, b) => a.localeCompare(b)),
      allowedEntities: [candidate.assetId],
      allowedAddresses: [candidate.contractAddress],
      allowedChains: [candidate.chainId],
      maxCostUsd: Math.min(accumulatedEstimatedCostUsd, envelope.maxCostUsd ?? accumulatedEstimatedCostUsd),
    };

    const plan = DeterministicPlanner.plan({
      candidate,
      profile,
      envelope: boundedEnvelope,
      budget,
      goal,
      initialEvidence: input.initialEvidence,
      requestedEvidenceFamilies: requestedFamilies,
      deterministicSeedRef: input.deterministicSeedRef,
    });

    return {
      policyVersion,
      candidateId: candidate.assetId,
      runId,
      decisions,
      requestedFamilies,
      skippedFamilies,
      blockedFamilies,
      totalEstimatedMonetaryCostUsd: accumulatedEstimatedCostUsd,
      totalEstimatedCostUsd: accumulatedEstimatedCostUsd,
      totalEstimatedQuotaUnits: accumulatedQuotaUnits,
      totalQuotaUnits: accumulatedQuotaUnits,
      plannedAt: asOf,
      plan,
      envelope: boundedEnvelope,
    };
  }

  public planAcquisitions(input: VoiPlanInput): VoiPlanResult {
    return this.plan(input);
  }

  private resolveEligibleFamilies(
    explicit?: readonly EvidenceFamilyDefinition[] | readonly string[],
    registry: EvidenceFamilyRegistry = this.registry,
  ): EvidenceFamilyDefinition[] {
    if (!explicit || explicit.length === 0) {
      return registry.list();
    }
    if (typeof explicit[0] === 'string') {
      return (explicit as string[]).map((id) => registry.require(id));
    }
    return explicit as EvidenceFamilyDefinition[];
  }

  private sampleProbe(seedRef: string, candidateId: string, familyId: string, probability: number): boolean {
    const probeHash = stableHash(`${seedRef}:${candidateId}:${familyId}`);
    const sampleVal = parseInt(probeHash.slice(0, 8), 16) / 0xffffffff;
    return sampleVal <= probability;
  }

  /**
   * Reconciles acquisition records post-execution with actual retrieval states, evidence IDs, and decision impact.
   */
  public reconcileExecution(options: ReconcileExecutionOptions): EvidenceAcquisitionDecision[] {
    return this.reconcileDecisions(options);
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
      const relevantTools = family ? (family.tools ?? family.associatedTools ?? []) : [];

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
      } else if (!previousDecision && decision.state === 'REQUESTED' && evidenceIds.length > 0) {
        if (finalDecision.decision === 'ALERT') actualDecisionChange = 'ALERT';
        else if (finalDecision.decision === 'INSUFFICIENT_DATA') actualDecisionChange = 'ABSTENTION';
        else if (finalDecision.decision === 'REJECT') actualDecisionChange = 'LIFECYCLE';
      }

      // Update state if requested but execution failed
      let finalState = decision.state;
      if (decision.state === 'REQUESTED') {
        const anyFailed = matchingToolRecords.some((r) => r.error !== undefined);
        const allEmpty = matchingToolRecords.length > 0 && matchingToolRecords.every((r) => r.output === null || r.output === undefined);
        if (anyFailed) {
          const firstError = matchingToolRecords.find((r) => r.error !== undefined)?.error ?? '';
          if (
            firstError.includes('503') ||
            firstError.includes('UNAVAILABLE') ||
            firstError.includes('TIMEOUT') ||
            firstError.includes('ETIMEDOUT')
          ) {
            finalState = 'PROVIDER_UNAVAILABLE';
          } else {
            finalState = 'FAILED';
          }
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
          monetaryCostUsd: Number((matchingToolRecords.length * (family.monetaryCostUsd ?? family.defaultMonetaryCostUsd ?? 0.0001)).toFixed(6)),
          quotaCostUnits: matchingToolRecords.length * (family.providerQuotaCost ?? family.defaultQuotaUnits ?? 1),
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
        this.registry.findByTool(featureKey)?.familyId;
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

  private calculateExpectedInformationValue(params: {
    family: EvidenceFamilyDefinition;
    candidateScore: number;
    currentRisk?: string | undefined;
    isNearAlert: boolean;
    hasKnownEvidence: boolean;
    isHardRejected: boolean;
    isUnreachable: boolean;
    costWeight: number;
  }): number {
    const { family, isNearAlert, hasKnownEvidence, isHardRejected, isUnreachable, costWeight } = params;

    if (isHardRejected || isUnreachable || hasKnownEvidence) return 0.0;

    let baseUtility = (family.defaultPriority ?? 5) / 10.0;

    if (isNearAlert) {
      baseUtility *= 1.5;
    }

    const impactScore = family.estimatedImpactScore ?? 0.8;
    const probChange = family.probabilityStateChange ?? 0.6;
    const reliability = family.reliability ?? 0.95;
    const independence = family.independenceValue ?? 0.85;

    const normalizedCost = (family.monetaryCostUsd ?? family.defaultMonetaryCostUsd ?? 0.0005) * 1000 +
                           (family.providerQuotaCost ?? family.defaultQuotaUnits ?? 1) * 0.05;
    const costPenalty = normalizedCost * costWeight;

    const evoi = Math.max(0.0, (baseUtility * impactScore * probChange * reliability * independence) - costPenalty);
    return Math.round(evoi * 1000) / 1000;
  }

  private evaluateRandomizedProbe(
    candidateId: string,
    familyId: string,
    policy: VoiPolicy,
    stratum: string,
  ): { selected: boolean; probability?: string | undefined; stratum?: string | undefined; seedRef?: string | undefined } {
    if (!policy.enableRandomizedProbes || !policy.randomizedProbeRate || policy.randomizedProbeRate <= 0) {
      return { selected: false };
    }

    const seedRef = policy.randomizationSeedRef ?? 'voi-probe-seed-default';
    const hashInput = `${seedRef}:${stratum}:${candidateId}:${familyId}`;
    const hash = createHash('sha256').update(hashInput).digest('hex');
    const pseudoRandom = parseInt(hash.slice(0, 8), 16) / 0xffffffff;

    const selected = pseudoRandom < policy.randomizedProbeRate;
    if (!selected) {
      return { selected: false };
    }
    return {
      selected: true,
      probability: String(policy.randomizedProbeRate),
      stratum,
      seedRef,
    };
  }
}

export class VoiDecisionPlanner extends VoiPlanner {}

