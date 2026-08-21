import { createHash } from 'node:crypto';
import type {
  AgentBudget,
  EvidenceAcquisitionDecision,
  EvidenceAcquisitionState,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import {
  EVIDENCE_FAMILIES,
  EvidenceFamilyDefinition,
  EvidenceFamilyRegistry,
} from './evidence-families.js';
import {
  EvidenceAcquisitionStore,
  getEvidenceAcquisitionStore,
} from './acquisition-state.js';
import {
  DeterministicPlanner,
  type CandidateTarget,
  type DeterministicPlan,
  type PlannedToolCall,
  type PlanStep,
} from './deterministic-planner.js';
import { ToolArgumentConfinementValidator } from './confinement.js';

/**
 * @requirement FR-AGT-009 - Value-of-information planner persists a decision for every eligible optional evidence family
 * @requirement FR-AGT-010 - Bounded stratified randomized evidence probe allocation
 * @requirement FR-AGT-012 - Deterministic planner authorization envelope foundation
 * @requirement FR-DATA-011 - Distinct evidence acquisition states
 * @requirement FR-DATA-012 - Structured evidence acquisition records
 * @requirement AC-242 - Evidence not requested by policy is stored as NOT_REQUESTED_BY_POLICY
 * @requirement INV-022 - Distinct from unavailable or negative evidence
 */

export interface RandomProbeConfig {
  enabled: boolean;
  stratum: string;
  inclusionProbability: number; // in (0, 1]
  seedRef: string;
}

export interface VoiPlannerInput {
  candidate: CandidateTarget & { lifecycle?: string | undefined; risk?: string | undefined };
  goal?: 'TRIAGE' | 'DEEP_RESEARCH' | 'SKEPTIC' | 'ADMIN_CHAT' | 'REPAIR' | undefined;
  profile: ModelProfile;
  envelope: ToolAuthorizationEnvelope;
  budget: AgentBudget;
  runId?: string | undefined;
  policyVersion?: string | undefined;
  eligibleEvidenceFamilies?: readonly EvidenceFamilyDefinition[] | readonly string[] | undefined;
  initialEvidence?: Record<string, unknown> | undefined;
  randomProbeConfig?: RandomProbeConfig | undefined;
  minVoiThreshold?: number | undefined;
  store?: EvidenceAcquisitionStore | undefined;
  deterministicSeedRef?: string | number | undefined;
}

export interface VoiPlannerResult {
  runId: string;
  policyVersion: string;
  plan: DeterministicPlan;
  decisions: EvidenceAcquisitionDecision[];
  requestedFamilies: string[];
  skippedFamilies: string[];
  blockedFamilies: string[];
  totalEstimatedCostUsd: number;
  totalQuotaUnits: number;
  envelope: ToolAuthorizationEnvelope;
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

export class VoiDecisionPlanner {
  private readonly registry: EvidenceFamilyRegistry;

  constructor(registry: EvidenceFamilyRegistry = new EvidenceFamilyRegistry()) {
    this.registry = registry;
  }

  /**
   * Evaluates value-of-information for every eligible optional evidence family,
   * persists all acquisition decisions prior to any retrieval, and constructs
   * the deterministic authorization envelope and plan.
   */
  public plan(input: VoiPlannerInput): VoiPlannerResult {
    const { candidate, profile, envelope, budget } = input;
    const goal = input.goal ?? (profile.modelClass as VoiPlannerInput['goal']) ?? 'TRIAGE';
    const policyVersion = input.policyVersion ?? profile.version;
    const runId =
      input.runId ??
      `run_${candidate.assetId}_${stableHash({ candidate: candidate.assetId, profile: profile.id, seed: input.deterministicSeedRef }).slice(0, 12)}`;
    const store = input.store ?? getEvidenceAcquisitionStore();
    const decidedAt = envelope.timeRange?.maxTimestamp ?? new Date().toISOString();

    // 1. Resolve eligible optional evidence families
    const eligibleFamilies: EvidenceFamilyDefinition[] = this.resolveEligibleFamilies(
      input.eligibleEvidenceFamilies,
    );

    const decisions: EvidenceAcquisitionDecision[] = [];
    const requestedFamilies: string[] = [];
    const skippedFamilies: string[] = [];
    const blockedFamilies: string[] = [];

    let accumulatedCostUsd = 0;
    let accumulatedQuotaUnits = 0;
    let accumulatedToolCalls = 0;

    const maxCalls = budget.maxToolCalls;
    const maxCostUsd = budget.maxModelCostUsd ?? envelope.maxCostUsd;
    const maxQuotaUnits = budget.maxProviderCostUnits;

    // 2. Evaluate every eligible evidence family deterministically
    for (const fam of eligibleFamilies) {
      const decisionId = `acq_${runId}_${candidate.assetId}_${fam.id}_${policyVersion}`;

      // Calculate VOI metric: (impact * probChange * reliability * independence) / cost
      const estimatedCostUsd = fam.defaultMonetaryCostUsd;
      const quotaCostUnits = fam.defaultQuotaUnits;
      const rawVoi =
        (fam.estimatedImpactScore *
          fam.probabilityStateChange *
          fam.reliability *
          fam.independenceValue) /
        Math.max(estimatedCostUsd, 0.0001);

      // Check tool compatibility with profile & envelope
      const supportedTools = fam.associatedTools.filter(
        (t) => envelope.allowedTools.includes(t) && profile.declaredTools.includes(t),
      );

      let state: EvidenceAcquisitionState;
      const reasonCodes: string[] = [];
      let randomized = false;
      let assignmentProbability: string | undefined;
      let randomizationStratum: string | undefined;
      let randomizationSeedRef: string | undefined;

      // Gate A: Tool & Envelope support
      if (supportedTools.length === 0) {
        state = 'UNSUPPORTED';
        reasonCodes.push('TOOL_NOT_IN_ENVELOPE');
        blockedFamilies.push(fam.id);
      }
      // Gate B: Chain constraint
      else if (
        envelope.allowedChains &&
        envelope.allowedChains.length > 0 &&
        !envelope.allowedChains.map((c) => c.toLowerCase()).includes(candidate.chainId.toLowerCase())
      ) {
        state = 'UNSUPPORTED';
        reasonCodes.push('CHAIN_NOT_ALLOWED');
        blockedFamilies.push(fam.id);
      }
      // Gate C: Address constraint
      else if (
        envelope.allowedAddresses &&
        envelope.allowedAddresses.length > 0 &&
        !envelope.allowedAddresses.includes(candidate.contractAddress)
      ) {
        state = 'UNSUPPORTED';
        reasonCodes.push('ADDRESS_NOT_ALLOWED');
        blockedFamilies.push(fam.id);
      }
      // Gate D: Entity constraint
      else if (
        envelope.allowedEntities &&
        envelope.allowedEntities.length > 0 &&
        !envelope.allowedEntities.includes(candidate.assetId)
      ) {
        state = 'UNSUPPORTED';
        reasonCodes.push('ENTITY_NOT_ALLOWED');
        blockedFamilies.push(fam.id);
      }
      // Gate E: Monetary cost limit
      else if (
        maxCostUsd !== undefined &&
        accumulatedCostUsd + estimatedCostUsd > maxCostUsd
      ) {
        state = 'COST_BLOCKED';
        reasonCodes.push('BUDGET_COST_EXCEEDED');
        blockedFamilies.push(fam.id);
      }
      // Gate F: Quota units limit
      else if (
        maxQuotaUnits !== undefined &&
        accumulatedQuotaUnits + quotaCostUnits > maxQuotaUnits
      ) {
        state = 'QUOTA_BLOCKED';
        reasonCodes.push('QUOTA_EXCEEDED');
        blockedFamilies.push(fam.id);
      }
      // Gate G: Max tool calls budget
      else if (accumulatedToolCalls + supportedTools.length > maxCalls) {
        state = 'COST_BLOCKED';
        reasonCodes.push('MAX_TOOL_CALLS_EXCEEDED');
        blockedFamilies.push(fam.id);
      }
      // Gate H: Randomized Evidence Probe (FR-AGT-010)
      else if (input.randomProbeConfig?.enabled) {
        const probe = input.randomProbeConfig;
        randomized = true;
        assignmentProbability = String(probe.inclusionProbability);
        randomizationStratum = probe.stratum;
        randomizationSeedRef = probe.seedRef;

        // Bounded deterministic sample check using hash of seed + candidate + family
        const probeHash = stableHash(`${probe.seedRef}:${candidate.assetId}:${fam.id}`);
        const sampleVal = parseInt(probeHash.slice(0, 8), 16) / 0xffffffff;

        if (sampleVal <= probe.inclusionProbability) {
          state = 'REQUESTED';
          reasonCodes.push('RANDOM_PROBE_INCLUSION');
          requestedFamilies.push(fam.id);
          accumulatedCostUsd += estimatedCostUsd;
          accumulatedQuotaUnits += quotaCostUnits;
          accumulatedToolCalls += supportedTools.length;
        } else {
          state = 'NOT_REQUESTED_BY_POLICY';
          reasonCodes.push('RANDOM_PROBE_NOT_SELECTED');
          skippedFamilies.push(fam.id);
        }
      }
      // Gate I: Standard Policy / Value of Information Evaluation
      else {
        const isMandatory = fam.isMandatoryForGoals?.includes(goal) ?? false;
        const minThreshold = input.minVoiThreshold ?? 10.0;
        const satisfiesVoi = rawVoi >= minThreshold;

        if (isMandatory || satisfiesVoi) {
          state = 'REQUESTED';
          if (isMandatory) reasonCodes.push('GOAL_MANDATED_FAMILY');
          if (satisfiesVoi) reasonCodes.push('HIGH_EXPECTED_IMPACT', 'VOI_THRESHOLD_SATISFIED');
          requestedFamilies.push(fam.id);
          accumulatedCostUsd += estimatedCostUsd;
          accumulatedQuotaUnits += quotaCostUnits;
          accumulatedToolCalls += supportedTools.length;
        } else {
          state = 'NOT_REQUESTED_BY_POLICY';
          reasonCodes.push('VOI_BELOW_THRESHOLD', 'SKIPPED_BY_GOAL_POLICY');
          skippedFamilies.push(fam.id);
        }
      }

      const decision: EvidenceAcquisitionDecision = {
        id: decisionId,
        candidateId: candidate.assetId,
        runId,
        evidenceFamily: fam.id,
        policyVersion,
        state,
        requestedFields: [...fam.standardFields],
        expectedDecisionImpact: fam.defaultDecisionImpact,
        estimatedCost: {
          monetaryCostUsd: estimatedCostUsd,
          quotaCostUnits,
        },
        randomized,
        ...(assignmentProbability ? { assignmentProbability } : {}),
        ...(randomizationStratum ? { randomizationStratum } : {}),
        ...(randomizationSeedRef ? { randomizationSeedRef } : {}),
        decidedAt,
        evidenceIds: [],
        reasonCodes,
      };

      decisions.push(decision);
    }

    // 3. Persist decisions to EvidenceAcquisitionStore before retrieval
    store.recordDecisions(decisions);

    // 4. Construct tool calls and steps only for REQUESTED evidence families
    const activeTools = new Set<string>();
    for (const famId of requestedFamilies) {
      const fam = this.registry.require(famId);
      for (const tool of fam.associatedTools) {
        if (envelope.allowedTools.includes(tool) && profile.declaredTools.includes(tool)) {
          activeTools.add(tool);
        }
      }
    }

    // 5. Generate deterministic plan with bounded active tools
    const boundedEnvelope: ToolAuthorizationEnvelope = {
      ...envelope,
      allowedTools: Array.from(activeTools).sort((a, b) => a.localeCompare(b)),
      allowedEntities: [candidate.assetId],
      allowedAddresses: [candidate.contractAddress],
      allowedChains: [candidate.chainId],
      maxCostUsd: Math.min(accumulatedCostUsd, envelope.maxCostUsd ?? accumulatedCostUsd),
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
      runId,
      policyVersion,
      plan,
      decisions,
      requestedFamilies,
      skippedFamilies,
      blockedFamilies,
      totalEstimatedCostUsd: accumulatedCostUsd,
      totalQuotaUnits: accumulatedQuotaUnits,
      envelope: boundedEnvelope,
    };
  }

  private resolveEligibleFamilies(
    explicit?: readonly EvidenceFamilyDefinition[] | readonly string[],
  ): EvidenceFamilyDefinition[] {
    if (!explicit || explicit.length === 0) {
      return this.registry.list();
    }
    if (typeof explicit[0] === 'string') {
      return (explicit as string[]).map((id) => this.registry.require(id));
    }
    return explicit as EvidenceFamilyDefinition[];
  }
}
