import { describe, expect, it } from 'vitest';
import {
  BoundedAgentRuntime,
  ModelAssistedPlanner,
  StratifiedRandomizedProbeAllocator,
  ToolArgumentConfinementValidator,
  ConfinementViolationError,
  type CandidateTarget,
} from '@ciag/agent-runtime';
import {
  DesignBasedEstimators,
  createFrozenCandidateUniverse,
  AgentSelectionEvaluator,
} from '@ciag/evaluation';
import type {
  AgentBudget,
  ModelProfile,
  StratifiedProbeConfig,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';

describe('T-G3-AGT-02 Negative Facets (FR-AGT-010, FR-AGT-011, FR-AGT-012, AC-242, AC-244)', () => {
  const sampleCandidate: CandidateTarget = {
    assetId: 'solana:token:unsafe-honeypot-1',
    chainId: 'solana',
    contractAddress: 'Unsafe11111111111111111111111111111111111111',
    symbol: 'BAD',
  };

  const sampleProfile: ModelProfile = {
    id: 'research-agent-v1',
    version: '1.0.0',
    modelClass: 'DEEP_RESEARCH',
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    declaredTools: ['dex.pairs', 'contract.audit', 'simulation.sell'],
    maxTokens: 4096,
    maxContextTokens: 64000,
    temperature: 0,
  };

  const sampleEnvelope: ToolAuthorizationEnvelope = {
    allowedTools: ['dex.pairs', 'contract.audit'],
    allowedProviders: ['helius', 'dexscreener'],
    allowedChains: ['solana'],
    allowedAddresses: ['Unsafe11111111111111111111111111111111111111'],
    timeRange: {
      minTimestamp: '2025-01-01T00:00:00Z',
      maxTimestamp: '2026-08-20T12:00:00Z',
    },
    maxLimit: 50,
    maxCostUsd: 0.1,
  };

  const sampleBudget: AgentBudget = {
    maxSteps: 3,
    maxToolCalls: 5,
    maxModelCostUsd: 0.1,
  };

  // ---------------------------------------------------------------------------
  // 1. Unsafe candidates are excluded from randomized probe sampling (FR-AGT-010)
  // ---------------------------------------------------------------------------
  describe('Safety eligibility in probe allocation', () => {
    it('never allocates probes to unsafe candidates (failing security gates)', () => {
      const candidates = [
        {
          candidate: sampleCandidate,
          isSafe: false, // Unsafe honeypot
          score: 0.9,
          stratumId: 'STRATUM_HIGH',
          normalSelectionState: 'SKIPPED' as const,
        },
        {
          candidate: {
            assetId: 'solana:token:safe-1',
            chainId: 'solana',
            contractAddress: 'Safe11111111111111111111111111111111111111111',
          },
          isSafe: true,
          score: 0.5,
          stratumId: 'STRATUM_MID',
          normalSelectionState: 'SKIPPED' as const,
        },
      ];

      const probeConfig: StratifiedProbeConfig = {
        probePolicyId: 'policy_v1',
        policyVersion: '1.0.0',
        seedProvenance: 'seed_neg_1',
        strata: [
          { stratumId: 'STRATUM_HIGH', name: 'High Stratum', targetSampleFraction: 1.0, minInclusionProbability: 0.1 },
          { stratumId: 'STRATUM_MID', name: 'Mid Stratum', targetSampleFraction: 1.0, minInclusionProbability: 0.1 },
        ],
        defaultSampleFraction: 1.0,
        minInclusionProbability: 0.1,
        maxProbeCandidates: 10,
        requestedEvidenceFamilies: ['dex.pairs'],
      };

      const result = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'run_neg_safety',
        config: probeConfig,
        candidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
      });

      // Unsafe candidate must NOT be in eligibility universe or probe list
      expect(result.totalEligibleCandidates).toBe(1);
      const unsafeProbe = result.probes.find((p) => p.candidateId === sampleCandidate.assetId);
      expect(unsafeProbe).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. FR-AGT-012: Model-Assisted Planner Confinement Violations
  // ---------------------------------------------------------------------------
  describe('FR-AGT-012: Model-assisted planner authorization envelope confinement', () => {
    it('rejects or filters model suggestions requesting unallowed tools', () => {
      const plan = ModelAssistedPlanner.plan({
        candidate: sampleCandidate,
        profile: sampleProfile,
        envelope: sampleEnvelope, // allowedTools: ['dex.pairs', 'contract.audit']
        budget: sampleBudget,
        modelSuggestions: [
          { toolName: 'trading.swap', purpose: 'Prohibited execution capability' },
          { toolName: 'dex.screener', purpose: 'Tool not in envelope' },
          { toolName: 'dex.pairs', purpose: 'Allowed tool' },
        ],
      });

      // Prohibited / unallowed tools must be filtered out
      const plannedTools = plan.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      expect(plannedTools).not.toContain('trading.swap');
      expect(plannedTools).not.toContain('dex.screener');
      expect(plannedTools).toContain('dex.pairs');
    });

    it('fails closed when direct tool execution broadens address or chain beyond envelope', () => {
      expect(() => {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          {
            chain: 'ethereum', // Prohibited chain (envelope allows 'solana')
            address: '0x1234567890abcdef',
          },
          sampleEnvelope,
          sampleProfile.declaredTools,
        );
      }).toThrow(ConfinementViolationError);

      expect(() => {
        ToolArgumentConfinementValidator.assertConforms(
          'dex.pairs',
          {
            chain: 'solana',
            address: 'DifferentAddress999999999999999999999999999', // Outside allowedAddresses
          },
          sampleEnvelope,
          sampleProfile.declaredTools,
        );
      }).toThrow(ConfinementViolationError);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. AC-244: Selective Deep Research Cannot Claim Full-Universe Lift
  // ---------------------------------------------------------------------------
  describe('AC-244: Selection bias and restricted population claims', () => {
    it('restricts claim to OBSERVED_SUBSET_ONLY and blocks FULL_UNIVERSE claim when observations are selective without randomized probe', () => {
      const validation = DesignBasedEstimators.validatePopulationClaim({
        intendedClaimScope: 'FULL_UNIVERSE',
        hasRandomizedProbe: false, // Non-randomized selective deep research
        universeCandidateCount: 100,
        observedCandidateCount: 10,
      });

      expect(validation.claimScope).toBe('OBSERVED_SUBSET_ONLY');
      expect(validation.isRandomizedDesignValid).toBe(false);
      expect(validation.unsupportedGeneralizations.length).toBeGreaterThan(0);
      expect(validation.restrictionReason).toContain('AC-244');
    });

    it('detects zero or negative inclusion probability and fails randomized design validity', () => {
      const validation = DesignBasedEstimators.validatePopulationClaim({
        intendedClaimScope: 'FULL_UNIVERSE',
        hasRandomizedProbe: true,
        observations: [
          { candidateId: 'c1', inclusionProbability: 0.5, value: 1 },
          { candidateId: 'c2', inclusionProbability: 0.0, value: 0 }, // Invalid zero inclusion probability
        ],
        universeCandidateCount: 20,
        observedCandidateCount: 2,
      });

      expect(validation.claimScope).toBe('OBSERVED_SUBSET_ONLY');
      expect(validation.isRandomizedDesignValid).toBe(false);
      expect(validation.zeroInclusionProbabilityCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. AC-242: Evidence Not Requested Stored as NOT_REQUESTED_BY_POLICY
  // ---------------------------------------------------------------------------
  describe('AC-242: Evidence acquisition state integrity', () => {
    it('never stores skipped probe evidence as RETURNED_EMPTY or PROVIDER_UNAVAILABLE', () => {
      const candidates = [
        {
          candidate: { assetId: 'tok-1', chainId: 'solana', contractAddress: 'A1' },
          isSafe: true,
          score: 0.5,
          stratumId: 'STRATUM_1',
          normalSelectionState: 'SKIPPED' as const,
        },
        {
          candidate: { assetId: 'tok-2', chainId: 'solana', contractAddress: 'A2' },
          isSafe: true,
          score: 0.5,
          stratumId: 'STRATUM_1',
          normalSelectionState: 'SKIPPED' as const,
        },
      ];

      const config: StratifiedProbeConfig = {
        probePolicyId: 'p1',
        policyVersion: '1.0.0',
        seedProvenance: 'seed1',
        strata: [{ stratumId: 'STRATUM_1', name: 'S1', targetSampleSize: 1, minInclusionProbability: 0.5 }],
        maxProbeCandidates: 1,
        requestedEvidenceFamilies: ['dex.pairs'],
      };

      const result = StratifiedRandomizedProbeAllocator.allocate({
        runId: 'r1',
        config,
        candidates,
        selectedAtIso: '2026-08-20T12:00:00Z',
      });

      const unselectedDecisions = result.acquisitionDecisions.filter(
        (d) => d.reasonCodes.includes('STRATIFIED_RANDOMIZED_PROBE_NOT_SELECTED'),
      );

      expect(unselectedDecisions.length).toBeGreaterThan(0);
      for (const d of unselectedDecisions) {
        expect(d.state).toBe('NOT_REQUESTED_BY_POLICY');
        expect(d.state).not.toBe('RETURNED_EMPTY');
        expect(d.state).not.toBe('PROVIDER_UNAVAILABLE');
        expect(d.state).not.toBe('FAILED');
      }
    });
  });
});
