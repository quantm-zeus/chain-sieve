import { describe, expect, it } from 'vitest';
import {
  StratifiedRandomizedProbeAllocator,
  type CandidateTarget,
} from '@ciag/agent-runtime';
import {
  AgentSelectionEvaluator,
  DesignBasedEstimators,
  createFrozenCandidateUniverse,
} from '@ciag/evaluation';
import type {
  AgentBudget,
  ModelProfile,
  StratifiedProbeConfig,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import {
  AgentSelectionComparisonReportSchema,
  DesignBasedEstimateSchema,
  EvidenceAcquisitionDecisionSchema,
  PopulationClaimValidationSchema,
  RandomizedEvidenceProbeSchema,
} from '@ciag/shared-schemas';

describe('T-G3-AGT-02 Positive Facets (FR-AGT-010, FR-AGT-011, AC-242, AC-243, AC-244)', () => {
  const sampleCandidates: Array<{
    candidate: CandidateTarget;
    isSafe: boolean;
    score: number;
    liquidityUsd: number;
    stratumId: string;
    normalSelectionState: 'SELECTED_FOR_DEEP_RESEARCH' | 'SKIPPED' | 'REJECTED' | 'WATCHLIST';
    groundTruthSignalSuccess: boolean;
    groundTruthTradableSuccess: boolean;
    groundTruthNetReturn: number;
  }> = [
    {
      candidate: { assetId: 'solana:token:asset-1', chainId: 'solana', contractAddress: 'Addr1111111111111111111111111111111111111111', symbol: 'TOK1' },
      isSafe: true,
      score: 0.95,
      liquidityUsd: 150000,
      stratumId: 'STRATUM_HIGH',
      normalSelectionState: 'SELECTED_FOR_DEEP_RESEARCH', // Normal selection
      groundTruthSignalSuccess: true,
      groundTruthTradableSuccess: true,
      groundTruthNetReturn: 1.2,
    },
    {
      candidate: { assetId: 'solana:token:asset-2', chainId: 'solana', contractAddress: 'Addr2222222222222222222222222222222222222222', symbol: 'TOK2' },
      isSafe: true,
      score: 0.85,
      liquidityUsd: 80000,
      stratumId: 'STRATUM_HIGH',
      normalSelectionState: 'WATCHLIST', // Outside normal deep research selection
      groundTruthSignalSuccess: true,
      groundTruthTradableSuccess: true,
      groundTruthNetReturn: 0.8,
    },
    {
      candidate: { assetId: 'solana:token:asset-3', chainId: 'solana', contractAddress: 'Addr3333333333333333333333333333333333333333', symbol: 'TOK3' },
      isSafe: true,
      score: 0.55,
      liquidityUsd: 45000,
      stratumId: 'STRATUM_MID',
      normalSelectionState: 'SKIPPED', // Outside normal deep research selection
      groundTruthSignalSuccess: true,
      groundTruthTradableSuccess: false,
      groundTruthNetReturn: -0.1,
    },
    {
      candidate: { assetId: 'solana:token:asset-4', chainId: 'solana', contractAddress: 'Addr4444444444444444444444444444444444444444', symbol: 'TOK4' },
      isSafe: true,
      score: 0.45,
      liquidityUsd: 30000,
      stratumId: 'STRATUM_MID',
      normalSelectionState: 'SKIPPED',
      groundTruthSignalSuccess: false,
      groundTruthTradableSuccess: false,
      groundTruthNetReturn: -0.5,
    },
    {
      candidate: { assetId: 'solana:token:asset-5', chainId: 'solana', contractAddress: 'Addr5555555555555555555555555555555555555555', symbol: 'TOK5' },
      isSafe: true,
      score: 0.25,
      liquidityUsd: 15000,
      stratumId: 'STRATUM_LOW',
      normalSelectionState: 'REJECTED', // Outside normal deep research selection
      groundTruthSignalSuccess: false,
      groundTruthTradableSuccess: false,
      groundTruthNetReturn: -0.7,
    },
    {
      candidate: { assetId: 'solana:token:asset-6', chainId: 'solana', contractAddress: 'Addr6666666666666666666666666666666666666666', symbol: 'TOK6' },
      isSafe: true,
      score: 0.15,
      liquidityUsd: 8000,
      stratumId: 'STRATUM_LOW',
      normalSelectionState: 'REJECTED',
      groundTruthSignalSuccess: true, // Missed opportunity!
      groundTruthTradableSuccess: true,
      groundTruthNetReturn: 1.5,
    },
  ];

  const sampleProfile: ModelProfile = {
    id: 'research-agent-v1',
    version: '1.0.0',
    modelClass: 'DEEP_RESEARCH',
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    declaredTools: [
      'dex.pairs',
      'dex.screener',
      'token.profile',
      'holder.distribution',
      'contract.audit',
      'pool.liquidity',
      'simulation.execution',
      'signal.score',
    ],
    maxTokens: 4096,
    maxContextTokens: 64000,
    temperature: 0,
    costPerInputTokenUsd: 0.000001,
    costPerOutputTokenUsd: 0.000002,
  };

  const sampleEnvelope: ToolAuthorizationEnvelope = {
    allowedTools: [
      'dex.pairs',
      'dex.screener',
      'token.profile',
      'holder.distribution',
      'contract.audit',
      'pool.liquidity',
      'simulation.execution',
      'signal.score',
    ],
    allowedProviders: ['jupiter', 'dexscreener', 'helius'],
    allowedDomains: ['dexscreener.com', 'helius-rpc.com', 'jup.ag'],
    allowedChains: ['solana'],
    timeRange: {
      minTimestamp: '2025-01-01T00:00:00Z',
      maxTimestamp: '2026-08-20T12:00:00Z',
    },
    maxLimit: 100,
    maxOutputSizeBytes: 65536,
    maxCostUsd: 0.5,
  };

  const sampleBudget: AgentBudget = {
    maxSteps: 4,
    maxToolCalls: 8,
    maxToolCallsPerCandidate: 8,
    maxProviderCalls: 16,
    maxInputTokens: 8000,
    maxOutputTokens: 8000,
    maxModelCostUsd: 0.5,
    maxProviderCostUnits: 30,
  };

  // ---------------------------------------------------------------------------
  // 1. FR-AGT-010: Stratified Randomized Probe Allocation & Nonzero Inclusion Probabilities
  // ---------------------------------------------------------------------------
  describe('FR-AGT-010: Stratified randomized evidence-probe allocation', () => {
    const probeConfig: StratifiedProbeConfig = {
      probePolicyId: 'policy_stratified_v1',
      policyVersion: '1.0.0',
      seedProvenance: 'seed_provenance_test_123',
      strata: [
        { stratumId: 'STRATUM_HIGH', name: 'High Stratum', targetSampleFraction: 1.0, minInclusionProbability: 0.1 },
        { stratumId: 'STRATUM_MID', name: 'Mid Stratum', targetSampleFraction: 0.5, minInclusionProbability: 0.1 },
        { stratumId: 'STRATUM_LOW', name: 'Low Stratum', targetSampleFraction: 0.5, minInclusionProbability: 0.1 },
      ],
      defaultSampleFraction: 0.5,
      minInclusionProbability: 0.1,
      maxProbeCandidates: 10,
      maxProbeCostUsd: 0.2,
      reserveProtectionUsd: 0.05,
      requestedEvidenceFamilies: ['dex.pairs', 'holder.distribution', 'contract.audit'],
    };

    it('samples safe candidates outside normal deep-research selection with nonzero inclusion probabilities', () => {
      const allocation = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'run_test_probe_001',
        config: probeConfig,
        candidates: sampleCandidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
        availableExplorationBudgetUsd: 1.0,
      });

      expect(allocation.totalEligibleCandidates).toBe(5); // 6 minus asset-1 which is normally selected for deep research
      expect(allocation.totalProbedCandidates).toBeGreaterThanOrEqual(1);
      expect(allocation.seedProvenance).toBe('seed_provenance_test_123');
      expect(allocation.policyVersion).toBe('1.0.0');
      expect(allocation.selectedAt).toBe('2026-08-20T12:00:00Z');

      // Check all probes adhere to schema and have strictly positive inclusion probability
      for (const probe of allocation.probes) {
        expect(() => RandomizedEvidenceProbeSchema.parse(probe)).not.toThrow();
        expect(probe.inclusionProbability).toBeGreaterThan(0);
        expect(probe.inclusionProbability).toBeLessThanOrEqual(1.0);
        expect(probe.samplingWeight).toBeCloseTo(1 / probe.inclusionProbability, 4);
        expect(probe.candidateId).not.toBe('solana:token:asset-1'); // Normal deep research candidate excluded
      }

      // Check AC-242: unselected candidates get NOT_REQUESTED_BY_POLICY
      const unselected = allocation.probes.filter((p) => !p.selected);
      for (const u of unselected) {
        expect(u.state).toBe('NOT_REQUESTED_BY_POLICY');
      }

      // Check AC-243: acquisition decisions store probability, stratum, seed, requested fields before outcome observation
      expect(allocation.acquisitionDecisions.length).toBeGreaterThan(0);
      for (const acq of allocation.acquisitionDecisions) {
        expect(() => EvidenceAcquisitionDecisionSchema.parse(acq)).not.toThrow();
        expect(acq.randomized).toBe(true);
        expect(acq.assignmentProbability).toBeDefined();
        expect(Number(acq.assignmentProbability)).toBeGreaterThan(0);
        expect(acq.randomizationSeedRef).toBe('seed_provenance_test_123');
        expect(acq.randomizationStratum).toBeDefined();
        expect(acq.decidedAt).toBe('2026-08-20T12:00:00Z');
      }
    });

    it('is cryptographically reproducible for identical seed, policy version, and runId', () => {
      const alloc1 = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'run_repro_1',
        config: probeConfig,
        candidates: sampleCandidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
      });
      const alloc2 = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'run_repro_1',
        config: probeConfig,
        candidates: sampleCandidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
      });

      expect(alloc1.sha256).toBe(alloc2.sha256);
      expect(alloc1.eligibilityUniverseId).toBe(alloc2.eligibilityUniverseId);
      expect(alloc1.probes.map((p) => p.probeId)).toEqual(alloc2.probes.map((p) => p.probeId));
      expect(alloc1.probes.map((p) => p.selected)).toEqual(alloc2.probes.map((p) => p.selected));
    });

    it('respects separate budget and protected reserves', () => {
      // When available exploration budget is 0 or below reserve protection threshold
      const protectedAlloc = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'run_reserve_test',
        config: probeConfig,
        candidates: sampleCandidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
        availableExplorationBudgetUsd: 0.02, // Less than reserveProtectionUsd (0.05)
      });

      expect(protectedAlloc.reserveProtected).toBe(true);
      expect(protectedAlloc.totalProbedCandidates).toBe(0);
      for (const p of protectedAlloc.probes) {
        expect(p.selected).toBe(false);
        expect(p.state).toBe('COST_BLOCKED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. FR-AGT-010 & AC-244: Inverse-Probability / Design-Based Estimators & Selection Bias
  // ---------------------------------------------------------------------------
  describe('FR-AGT-010 & AC-244: Design-based Horvitz-Thompson & Hájek estimators', () => {
    it('computes unbiased Horvitz-Thompson estimates and effective sample size', () => {
      const sampleObs = [
        { candidateId: 'c1', stratumId: 'STRATUM_HIGH', inclusionProbability: 0.8, value: 1.0 },
        { candidateId: 'c2', stratumId: 'STRATUM_MID', inclusionProbability: 0.4, value: 0.0 },
        { candidateId: 'c3', stratumId: 'STRATUM_MID', inclusionProbability: 0.4, value: 1.0 },
        { candidateId: 'c4', stratumId: 'STRATUM_LOW', inclusionProbability: 0.2, value: 0.0 },
      ];

      const ht = DesignBasedEstimators.computeHorvitzThompson({
        targetQuantity: 'tradable_precision',
        observations: sampleObs,
        populationSize: 10,
        selectiveSampleValues: [1.0, 1.0, 0.8], // selective deep research average = 0.933
      });

      expect(() => DesignBasedEstimateSchema.parse(ht)).not.toThrow();
      expect(ht.estimator).toBe('HORVITZ_THOMPSON');
      expect(ht.sampleSize).toBe(4);
      expect(ht.populationSize).toBe(10);
      expect(ht.pointEstimate).toBeGreaterThan(0);
      expect(ht.standardError).toBeGreaterThanOrEqual(0);
      expect(ht.confidenceInterval95[0]).toBeLessThanOrEqual(ht.pointEstimate);
      expect(ht.confidenceInterval95[1]).toBeGreaterThanOrEqual(ht.pointEstimate);
      expect(ht.effectiveSampleSize).toBeGreaterThan(0);

      // Selection bias should be calculated comparing selective mean vs design unbiased
      expect(ht.selectionBias).toBeDefined();
      expect(ht.selectionBias!.selectiveSampleMean).toBeCloseTo(0.933, 2);
      expect(ht.selectionBias!.estimatedBias).toBe(
        ht.selectionBias!.selectiveSampleMean - ht.pointEstimate,
      );
    });

    it('computes stabilized Hájek ratio estimator', () => {
      const sampleObs = [
        { candidateId: 'c1', stratumId: 'STRATUM_HIGH', inclusionProbability: 0.5, value: 1.0 },
        { candidateId: 'c2', stratumId: 'STRATUM_LOW', inclusionProbability: 0.25, value: 0.0 },
      ];

      const hajek = DesignBasedEstimators.computeHajek({
        targetQuantity: 'win_rate',
        observations: sampleObs,
        populationSize: 6,
      });

      expect(() => DesignBasedEstimateSchema.parse(hajek)).not.toThrow();
      expect(hajek.estimator).toBe('HAJEK');
      expect(hajek.pointEstimate).toBeGreaterThanOrEqual(0);
      expect(hajek.pointEstimate).toBeLessThanOrEqual(1.0);
    });

    it('validates population claims and rejects full-universe claim when not randomized (AC-244)', () => {
      // Case 1: Valid randomized probe -> FULL_UNIVERSE valid
      const validClaim = DesignBasedEstimators.validatePopulationClaim({
        intendedClaimScope: 'FULL_UNIVERSE',
        hasRandomizedProbe: true,
        observations: [
          { candidateId: 'c1', inclusionProbability: 0.5, value: 1 },
          { candidateId: 'c2', inclusionProbability: 0.25, value: 0 },
        ],
        universeCandidateCount: 10,
        observedCandidateCount: 2,
      });

      expect(() => PopulationClaimValidationSchema.parse(validClaim)).not.toThrow();
      expect(validClaim.claimScope).toBe('FULL_UNIVERSE');
      expect(validClaim.isRandomizedDesignValid).toBe(true);

      // Case 2: Selective observations only without randomized probe -> OBSERVED_SUBSET_ONLY (AC-244)
      const restrictedClaim = DesignBasedEstimators.validatePopulationClaim({
        intendedClaimScope: 'FULL_UNIVERSE',
        hasRandomizedProbe: false,
        universeCandidateCount: 10,
        observedCandidateCount: 2,
      });

      expect(restrictedClaim.claimScope).toBe('OBSERVED_SUBSET_ONLY');
      expect(restrictedClaim.isRandomizedDesignValid).toBe(false);
      expect(restrictedClaim.unsupportedGeneralizations.length).toBeGreaterThan(0);
      expect(restrictedClaim.restrictionReason).toContain('AC-244');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. FR-AGT-011: Symmetric 4-Arm Agent/Tool-Selection Evaluation
  // ---------------------------------------------------------------------------
  describe('FR-AGT-011: Agent/tool-selection evaluation across 4 symmetric arms', () => {
    it('compares deterministic planner, model-assisted planner, randomized probe, and no-additional-evidence controls under symmetric budgets', async () => {
      const universe = createFrozenCandidateUniverse({
        dataCutoff: '2026-08-20T12:00:00Z',
        candidateAssetIds: sampleCandidates.map((c) => c.candidate.assetId),
        corpusVersion: '1.0.0',
      });

      const report = await AgentSelectionEvaluator.evaluate({
        universe,
        candidates: sampleCandidates,
        profile: sampleProfile,
        envelope: sampleEnvelope,
        symmetricBudget: sampleBudget,
        seedProvenance: 'seed_eval_symmetric_001',
        policyVersion: '1.0.0',
      });

      // Verify schema conformance
      expect(() => AgentSelectionComparisonReportSchema.parse(report)).not.toThrow();

      // Check all 4 symmetric arms are present
      expect(report.arms).toHaveLength(4);
      const armTypes = report.arms.map((a) => a.arm).sort();
      expect(armTypes).toEqual([
        'DETERMINISTIC_PLANNER',
        'MODEL_ASSISTED_PLANNER',
        'NO_ADDITIONAL_EVIDENCE',
        'RANDOMIZED_PROBE',
      ]);

      // Check symmetric candidate universes and counts
      for (const arm of report.arms) {
        expect(arm.candidateCount).toBe(sampleCandidates.length);
        expect(arm.decisions).toHaveProperty('alertCount');
        expect(arm.metrics).toHaveProperty('tradablePrecision');
        expect(arm.metrics).toHaveProperty('netPortfolioUtility');
      }

      // Control arm (NO_ADDITIONAL_EVIDENCE) should execute 0 tool calls
      const controlArm = report.arms.find((a) => a.arm === 'NO_ADDITIONAL_EVIDENCE');
      expect(controlArm).toBeDefined();
      expect(controlArm!.executedToolCallsTotal).toBe(0);
      expect(controlArm!.decisionChangeRateVsControl).toBe(0);

      // Deterministic and Model-assisted arms should execute bounded tool calls
      const detArm = report.arms.find((a) => a.arm === 'DETERMINISTIC_PLANNER');
      expect(detArm).toBeDefined();
      expect(detArm!.executedToolCallsTotal).toBeGreaterThan(0);

      const modelArm = report.arms.find((a) => a.arm === 'MODEL_ASSISTED_PLANNER');
      expect(modelArm).toBeDefined();
      expect(modelArm!.executedToolCallsTotal).toBeGreaterThan(0);

      // Randomized probe arm should contain design-based estimates
      const probeArm = report.arms.find((a) => a.arm === 'RANDOMIZED_PROBE');
      expect(probeArm).toBeDefined();
      expect(probeArm!.designBasedEstimates).toBeDefined();
      expect(probeArm!.designBasedEstimates!.horvitzThompson).toBeDefined();

      // Check pairwise contrasts
      expect(report.contrasts.length).toBeGreaterThanOrEqual(4);
      const detVsControl = report.contrasts.find(
        (c) => c.treatmentArm === 'DETERMINISTIC_PLANNER' && c.controlArm === 'NO_ADDITIONAL_EVIDENCE',
      );
      expect(detVsControl).toBeDefined();
      expect(detVsControl!.costDeltaUsd).toBeGreaterThanOrEqual(0);

      // Deterministic report serialization & SHA256 integrity
      expect(report.reportId).toMatch(/^rep_agent_sel_[a-f0-9]{16}$/);
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.canonicalJson.length).toBeGreaterThan(0);
    });
  });
});
