import { createHash } from 'node:crypto';
import type {
  EvidenceAcquisitionDecision,
  RandomizedEvidenceProbe,
  StratifiedProbeConfig,
  StratumDefinition,
} from '@ciag/shared-schemas';
import type { CandidateTarget } from './deterministic-planner.js';

export interface ProbeCandidateInput {
  candidate: CandidateTarget;
  isSafe: boolean;
  score?: number | undefined;
  liquidityUsd?: number | undefined;
  stratumId?: string | undefined;
  normalSelectionState?: 'SELECTED_FOR_DEEP_RESEARCH' | 'SKIPPED' | 'REJECTED' | 'WATCHLIST' | undefined;
}

export interface ProbeAllocationInput {
  runId: string;
  config: StratifiedProbeConfig;
  candidates: readonly ProbeCandidateInput[];
  selectedAtIso: string;
  currentReserveCostUsd?: number | undefined;
  availableExplorationBudgetUsd?: number | undefined;
}

export interface ProbeAllocationResult {
  eligibilityUniverseId: string;
  policyVersion: string;
  seedProvenance: string;
  selectedAt: string;
  totalEligibleCandidates: number;
  totalProbedCandidates: number;
  probes: RandomizedEvidenceProbe[];
  acquisitionDecisions: EvidenceAcquisitionDecision[];
  strataSummaries: Array<{
    stratumId: string;
    stratumName: string;
    eligibleCount: number;
    probedCount: number;
    inclusionProbability: number;
  }>;
  totalEstimatedCostUsd: number;
  reserveProtected: boolean;
  sha256: string;
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

function deterministicUnitFloat(seedProvenance: string, policyVersion: string, runId: string, candidateId: string, stratumId: string): number {
  const hash = createHash('sha256')
    .update(`${seedProvenance}:${policyVersion}:${runId}:${stratumId}:${candidateId}`)
    .digest('hex');
  // Use first 12 hex chars (48 bits) divided by 2^48
  const intVal = parseInt(hash.slice(0, 12), 16);
  return intVal / 0x1000000000000;
}

export class StratifiedRandomizedProbeAllocator {
  /**
   * Allocates bounded stratified randomized evidence-probes across safe candidates
   * outside normal deep-research selection with positive, auditable inclusion probabilities.
   *
   * @requirement FR-AGT-010
   * @requirement AC-242 (Evidence not requested by policy stored as NOT_REQUESTED_BY_POLICY)
   * @requirement AC-243 (Stores eligibility stratum, nonzero inclusion prob, seed provenance, selection timestamp)
   * @requirement AC-244 (Full universe claims require known positive inclusion probabilities)
   */
  public static allocate(input: ProbeAllocationInput): ProbeAllocationResult {
    const { runId, config, candidates, selectedAtIso } = input;

    // 1. Safety Hard Gate: Filter only safe candidates (unsafe candidates are permanently ineligible)
    // 2. Population filter: Focus on candidates outside normal deep research selection
    //    (or eligible candidates evaluated for probe allocation)
    const eligibleCandidates = candidates.filter((c) => {
      if (!c.isSafe) return false;
      // Normal selection exclusion: Probes specifically target candidates outside standard deep-research selection
      return c.normalSelectionState !== 'SELECTED_FOR_DEEP_RESEARCH';
    });

    const universeDataForHash = {
      policyVersion: config.policyVersion,
      seedProvenance: config.seedProvenance,
      eligibleAssetIds: eligibleCandidates.map((c) => c.candidate.assetId).sort(),
    };
    const eligibilityUniverseId = `univ_probe_${stableHash(universeDataForHash).slice(0, 16)}`;

    // Build stratum lookup
    const stratumMap = new Map<string, StratumDefinition>();
    for (const s of config.strata) {
      stratumMap.set(s.stratumId, s);
    }

    // Default fallback stratum if candidate has no assigned stratum
    const defaultStratum = config.strata[0] ?? {
      stratumId: 'DEFAULT',
      name: 'Default Stratum',
      targetSampleFraction: config.defaultSampleFraction,
      minInclusionProbability: config.minInclusionProbability,
    };

    // Partition eligible candidates into strata
    const partitioned = new Map<string, ProbeCandidateInput[]>();
    for (const s of config.strata) {
      partitioned.set(s.stratumId, []);
    }

    for (const c of eligibleCandidates) {
      let sId = c.stratumId;
      if (!sId || !partitioned.has(sId)) {
        // Auto-assign stratum based on score or liquidity if not explicitly set
        sId = this.resolveStratumForCandidate(c, config.strata) ?? defaultStratum.stratumId;
        if (!partitioned.has(sId)) {
          partitioned.set(sId, []);
        }
      }
      partitioned.get(sId)!.push(c);
    }

    // Check exploration budget and protected reserve limits
    const costPerProbeEst = 0.005; // estimated default USD cost per probe
    let maxAllowedByBudget = config.maxProbeCandidates;

    if (config.maxProbeCostUsd !== undefined && config.maxProbeCostUsd > 0) {
      const budgetCapacity = Math.floor(config.maxProbeCostUsd / costPerProbeEst);
      maxAllowedByBudget = Math.min(maxAllowedByBudget, Math.max(1, budgetCapacity));
    }

    let reserveProtected = false;
    if (input.availableExplorationBudgetUsd !== undefined) {
      const netAvailable = Math.max(0, input.availableExplorationBudgetUsd - (config.reserveProtectionUsd ?? 0));
      if (netAvailable <= 0) {
        reserveProtected = true;
      }
    }

    // Allocate sample sizes per stratum
    const probes: RandomizedEvidenceProbe[] = [];
    const acquisitionDecisions: EvidenceAcquisitionDecision[] = [];
    const strataSummaries: ProbeAllocationResult['strataSummaries'] = [];
    let totalEstimatedCost = 0;
    let totalProbedCount = 0;

    for (const [stratumId, stratumCandidates] of partitioned.entries()) {
      const stratumDef = stratumMap.get(stratumId) ?? defaultStratum;
      const N_h = stratumCandidates.length;

      if (N_h === 0) {
        strataSummaries.push({
          stratumId,
          stratumName: stratumDef.name,
          eligibleCount: 0,
          probedCount: 0,
          inclusionProbability: 1.0,
        });
        continue;
      }

      // Compute target sample size n_h
      let target_n_h = 1;
      if (stratumDef.targetSampleSize !== undefined) {
        target_n_h = Math.min(N_h, Math.max(1, stratumDef.targetSampleSize));
      } else {
        const fraction = stratumDef.targetSampleFraction ?? config.defaultSampleFraction ?? 0.1;
        target_n_h = Math.min(N_h, Math.max(1, Math.round(N_h * fraction)));
      }

      // Cap at remaining global probe candidate budget
      const remainingGlobalBudget = Math.max(0, maxAllowedByBudget - totalProbedCount);
      const effective_n_h = reserveProtected ? 0 : Math.min(target_n_h, remainingGlobalBudget > 0 ? remainingGlobalBudget : 1);

      // Inclusion probability for every candidate in stratum h: strictly positive (pi_h > 0)
      // When reserve is not protected, pi_h = effective_n_h / N_h
      const inclusionProb = Math.max(
        stratumDef.minInclusionProbability ?? config.minInclusionProbability ?? 0.001,
        Math.min(1.0, effective_n_h / N_h),
      );
      const samplingWeight = 1 / inclusionProb;

      // Sort candidates deterministically by pseudo-random stream
      const scoredCandidates = stratumCandidates.map((c) => ({
        candidateInput: c,
        randScore: deterministicUnitFloat(
          config.seedProvenance,
          config.policyVersion,
          runId,
          c.candidate.assetId,
          stratumId,
        ),
      }));

      // Sort by randScore ascending for deterministic sampling
      scoredCandidates.sort((a, b) => a.randScore - b.randScore);

      for (let i = 0; i < scoredCandidates.length; i++) {
        const item = scoredCandidates[i]!;
        const isSelected = !reserveProtected && i < effective_n_h;

        const probeId = `probe_${item.candidateInput.candidate.assetId}_${runId.slice(0, 8)}`;
        const state: RandomizedEvidenceProbe['state'] = isSelected
          ? 'REQUESTED'
          : reserveProtected
            ? 'COST_BLOCKED'
            : 'NOT_REQUESTED_BY_POLICY';

        const probeRecord: RandomizedEvidenceProbe = {
          probeId,
          candidateId: item.candidateInput.candidate.assetId,
          eligibilityUniverseId,
          stratumId,
          stratumName: stratumDef.name,
          policyVersion: config.policyVersion,
          inclusionProbability: inclusionProb,
          inclusionProbabilityFormatted: inclusionProb.toFixed(6),
          samplingWeight,
          seedProvenance: config.seedProvenance,
          selected: isSelected,
          state,
          requestedEvidenceFamilies: [...config.requestedEvidenceFamilies],
          requestedFields: ['dex.pairs', 'holder.distribution', 'contract.audit'],
          selectedAt: selectedAtIso,
          evidenceIds: [],
          estimatedCostUsd: isSelected ? costPerProbeEst : 0,
        };

        probes.push(probeRecord);

        // Generate corresponding EvidenceAcquisitionDecision adhering to AC-242 / AC-243
        for (const family of config.requestedEvidenceFamilies) {
          acquisitionDecisions.push({
            id: `acq_${probeId}_${family}`,
            candidateId: item.candidateInput.candidate.assetId,
            runId,
            evidenceFamily: family,
            policyVersion: config.policyVersion,
            state: state === 'REQUESTED' ? 'REQUESTED' : state === 'COST_BLOCKED' ? 'COST_BLOCKED' : 'NOT_REQUESTED_BY_POLICY',
            requestedFields: ['dex.pairs', 'holder.distribution', 'contract.audit'],
            expectedDecisionImpact: 'PROBE_EXPLORATION_VALUE',
            estimatedCost: {
              monetaryCostUsd: isSelected ? costPerProbeEst : 0,
              quotaCostUnits: isSelected ? 1 : 0,
            },
            randomized: true,
            assignmentProbability: inclusionProb.toFixed(6),
            randomizationStratum: stratumDef.name,
            randomizationSeedRef: config.seedProvenance,
            decidedAt: selectedAtIso,
            reasonCodes: isSelected
              ? ['STRATIFIED_RANDOMIZED_PROBE_SELECTED']
              : reserveProtected
                ? ['PROBE_BLOCKED_RESERVE_PROTECTION']
                : ['STRATIFIED_RANDOMIZED_PROBE_NOT_SELECTED'],
            evidenceIds: [],
          });
        }

        if (isSelected) {
          totalProbedCount++;
          totalEstimatedCost += costPerProbeEst;
        }
      }

      strataSummaries.push({
        stratumId,
        stratumName: stratumDef.name,
        eligibleCount: N_h,
        probedCount: effective_n_h,
        inclusionProbability: inclusionProb,
      });
    }

    const resultPayload = {
      eligibilityUniverseId,
      policyVersion: config.policyVersion,
      seedProvenance: config.seedProvenance,
      selectedAt: selectedAtIso,
      totalEligibleCandidates: eligibleCandidates.length,
      totalProbedCandidates: totalProbedCount,
      probes: probes.map((p) => ({
        probeId: p.probeId,
        candidateId: p.candidateId,
        stratumId: p.stratumId,
        inclusionProbability: p.inclusionProbability,
        selected: p.selected,
        state: p.state,
      })),
      strataSummaries,
    };

    const sha256 = stableHash(resultPayload);

    return {
      eligibilityUniverseId,
      policyVersion: config.policyVersion,
      seedProvenance: config.seedProvenance,
      selectedAt: selectedAtIso,
      totalEligibleCandidates: eligibleCandidates.length,
      totalProbedCandidates: totalProbedCount,
      probes,
      acquisitionDecisions,
      strataSummaries,
      totalEstimatedCostUsd: totalEstimatedCost,
      reserveProtected,
      sha256,
    };
  }

  private static resolveStratumForCandidate(
    candidate: ProbeCandidateInput,
    strata: readonly StratumDefinition[],
  ): string | undefined {
    if (strata.length === 0) return undefined;

    // If candidate has a score, match by score tiers if strata contain LOW/MID/HIGH
    if (candidate.score !== undefined) {
      if (candidate.score < 0.33) {
        const match = strata.find((s) => s.stratumId.toLowerCase().includes('low') || s.stratumId.toLowerCase().includes('bottom'));
        if (match) return match.stratumId;
      } else if (candidate.score < 0.67) {
        const match = strata.find((s) => s.stratumId.toLowerCase().includes('mid') || s.stratumId.toLowerCase().includes('middle'));
        if (match) return match.stratumId;
      } else {
        const match = strata.find((s) => s.stratumId.toLowerCase().includes('high') || s.stratumId.toLowerCase().includes('top'));
        if (match) return match.stratumId;
      }
    }

    // If candidate has liquidity, match by liquidity tiers
    if (candidate.liquidityUsd !== undefined) {
      if (candidate.liquidityUsd < 10000) {
        const match = strata.find((s) => s.stratumId.toLowerCase().includes('micro') || s.stratumId.toLowerCase().includes('low_liq'));
        if (match) return match.stratumId;
      } else if (candidate.liquidityUsd < 50000) {
        const match = strata.find((s) => s.stratumId.toLowerCase().includes('small') || s.stratumId.toLowerCase().includes('mid_liq'));
        if (match) return match.stratumId;
      }
    }

    return strata[0]?.stratumId;
  }
}
