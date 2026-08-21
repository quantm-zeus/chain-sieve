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
  blockedFamilies: string[];
  totalEstimatedMonetaryCostUsd: number;
  totalEstimatedCostUsd: number;
  totalEstimatedQuotaUnits: number;
  totalQuotaUnits: number;
  plannedAt: string;
  plan: DeterministicPlan;
  envelope: ToolAuthorizationEnvelope;
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
      const familyId = family.familyId ?? family.id;
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
    const { decisions, toolRecords = [], previousDecision, finalDecision, completedAt = new Date().toISOString() } = options;

    const actualDecisionChange = this.detectDecisionChange(previousDecision, finalDecision);

    const reconciled: EvidenceAcquisitionDecision[] = [];

    for (const d of decisions) {
      if (d.state !== 'REQUESTED') {
        reconciled.push({
          ...d,
          completedAt,
          actualDecisionChange: 'NONE',
          actualCost: {
            monetaryCostUsd: 0,
            quotaCostUnits: 0,
          },
        });
        continue;
      }

      const familyDef = this.registry.get(d.evidenceFamily);
      const tools = familyDef ? (familyDef.tools ?? familyDef.associatedTools ?? []) : [];

      const relevantToolRecords = toolRecords.filter((r) => tools.includes(r.toolName));

      let resolvedState: EvidenceAcquisitionDecision['state'] = 'RETURNED';
      const evidenceIds: string[] = [];

      if (relevantToolRecords.length === 0) {
        resolvedState = 'RETURNED_EMPTY';
      } else {
        const hasErrors = relevantToolRecords.some((r) => r.error !== undefined);
        const hasOutputs = relevantToolRecords.some((r) => r.output !== undefined && r.output !== null);

        for (const r of relevantToolRecords) {
          if (r.callId) evidenceIds.push(r.callId);
        }

        if (hasErrors && !hasOutputs) {
          const firstError = relevantToolRecords.find((r) => r.error !== undefined)?.error ?? '';
          if (
            firstError.includes('503') ||
            firstError.includes('UNAVAILABLE') ||
            firstError.includes('TIMEOUT') ||
            firstError.includes('ETIMEDOUT')
          ) {
            resolvedState = 'PROVIDER_UNAVAILABLE';
          } else {
            resolvedState = 'FAILED';
          }
        } else if (!hasOutputs) {
          resolvedState = 'RETURNED_EMPTY';
        } else {
          resolvedState = 'RETURNED';
        }
      }

      const perFamilyActualCost = options.actualCost ?? {
        monetaryCostUsd: d.estimatedCost?.monetaryCostUsd ?? 0.0001,
        quotaCostUnits: d.estimatedCost?.quotaCostUnits ?? 1,
      };

      reconciled.push({
        ...d,
        state: resolvedState,
        completedAt,
        evidenceIds: [...new Set(evidenceIds)],
        actualDecisionChange,
        actualCost: resolvedState === 'RETURNED' ? perFamilyActualCost : { monetaryCostUsd: 0, quotaCostUnits: 0 },
      });
    }

    return reconciled;
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
  ): { selected: boolean; probability?: string; stratum?: string; seedRef?: string } {
    if (!policy.enableRandomizedProbes || !policy.randomizedProbeRate || policy.randomizedProbeRate <= 0) {
      return { selected: false };
    }

    const seedRef = policy.randomizationSeedRef ?? 'voi-probe-seed-default';
    const hashInput = `${seedRef}:${stratum}:${candidateId}:${familyId}`;
    const hash = createHash('sha256').update(hashInput).digest('hex');
    const pseudoRandom = parseInt(hash.slice(0, 8), 16) / 0xffffffff;

    const selected = pseudoRandom < policy.randomizedProbeRate;
    return {
      selected,
      probability: selected ? String(policy.randomizedProbeRate) : undefined,
      stratum: selected ? stratum : undefined,
      seedRef: selected ? seedRef : undefined,
    };
  }

  private detectDecisionChange(
    prev: AgentDecision | undefined,
    curr: AgentDecision,
  ): EvidenceAcquisitionDecision['actualDecisionChange'] {
    if (!prev) {
      if (curr.decision === 'ALERT') return 'ALERT';
      if (curr.decision === 'INSUFFICIENT_DATA') return 'ABSTENTION';
      if (curr.decision === 'REJECT') return 'LIFECYCLE';
      return 'NONE';
    }

    if (prev.decision !== curr.decision) {
      if (curr.decision === 'ALERT') return 'ALERT';
      if (curr.decision === 'INSUFFICIENT_DATA') return 'ABSTENTION';
      return 'RANK';
    }

    if (prev.lifecycleRecommendation !== curr.lifecycleRecommendation) return 'LIFECYCLE';
    if (prev.riskRecommendation !== curr.riskRecommendation) return 'RISK';

    return 'NONE';
  }
}

export const VoiDecisionPlanner = VoiPlanner;
