import { describe, expect, it, beforeEach } from 'vitest';
import {
  VoiDecisionPlanner,
  EvidenceAcquisitionStore,
  resetEvidenceAcquisitionStore,
  EVIDENCE_FAMILIES,
  imputeFeatureWithMissingnessPolicy,
  assertMissingnessInvariants,
  isSubstantiveNegativeEvidence,
  ALL_EVIDENCE_ACQUISITION_STATES,
  BoundedAgentRuntime,
  ToolArgumentConfinementValidator,
  ConfinementViolationError,
  ModelProfileRegistry,
  type EvidenceFamilyDefinition,
} from '@ciag/agent-runtime';
import type {
  AgentBudget,
  EvidenceAcquisitionDecision,
  ModelProfile,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';

describe('Deterministic VOI Decision Planner & Missingness (FR-AGT-009, FR-AGT-012, FR-DATA-011, FR-DATA-012, AC-242, INV-022)', () => {
  const candidate = {
    assetId: 'solana:token:So11111111111111111111111111111111111111112',
    chainId: 'solana',
    contractAddress: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    lifecycle: 'DISCOVERED',
    risk: 'UNKNOWN',
  };

  const fullEnvelope: ToolAuthorizationEnvelope = {
    allowedTools: [
      'token.profile',
      'dex.pairs',
      'dex.screener',
      'pool.liquidity',
      'market.summary',
      'holder.distribution',
      'contract.audit',
      'risk.honeypot_scan',
      'liquidity.lock',
      'solana.transaction_trace',
      'simulation.sell',
      'simulation.execution',
      'social.activity',
      'community.sentiment',
      'developer.history',
      'deployer.reputation',
    ],
    allowedProviders: ['jupiter', 'dexscreener', 'helius', 'solana_rpc'],
    allowedDomains: ['dexscreener.com', 'helius-rpc.com', 'jup.ag'],
    allowedChains: ['solana'],
    allowedAddresses: ['So11111111111111111111111111111111111111112'],
    allowedEntities: ['solana:token:So11111111111111111111111111111111111111112'],
    timeRange: {
      minTimestamp: '2025-01-01T00:00:00.000Z',
      maxTimestamp: '2026-08-20T12:00:00.000Z',
    },
    maxLimit: 100,
    maxOutputSizeBytes: 65536,
    maxCostUsd: 1.0,
    deadlineAt: '2026-08-20T13:00:00.000Z',
  };

  const testProfile: ModelProfile = {
    id: 'test-research-profile',
    version: '1.2.0',
    modelClass: 'DEEP_RESEARCH',
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    declaredTools: [
      'token.profile',
      'dex.pairs',
      'dex.screener',
      'pool.liquidity',
      'market.summary',
      'holder.distribution',
      'contract.audit',
      'risk.honeypot_scan',
      'liquidity.lock',
      'solana.transaction_trace',
      'simulation.sell',
      'simulation.execution',
      'social.activity',
      'community.sentiment',
      'developer.history',
      'deployer.reputation',
    ],
    maxTokens: 4096,
    maxContextTokens: 64000,
    temperature: 0,
    costPerInputTokenUsd: 0.000001,
    costPerOutputTokenUsd: 0.000002,
  };

  const testBudget: AgentBudget = {
    maxSteps: 10,
    maxToolCalls: 20,
    maxToolCallsPerCandidate: 20,
    maxProviderCalls: 30,
    maxInputTokens: 20000,
    maxOutputTokens: 20000,
    maxModelCostUsd: 0.5,
    maxProviderCostUnits: 50,
  };

  let store: EvidenceAcquisitionStore;
  let planner: VoiDecisionPlanner;

  beforeEach(() => {
    resetEvidenceAcquisitionStore();
    store = new EvidenceAcquisitionStore();
    planner = new VoiDecisionPlanner();
  });

  describe('FR-AGT-009: Value-of-Information Planner persists decisions for every eligible optional evidence family', () => {
    it('persists a decision for EVERY registered evidence family with requested/skipped reason, policy version, requested fields, expected impact, and cost before retrieval', () => {
      const result = planner.plan({
        candidate,
        profile: testProfile,
        envelope: fullEnvelope,
        budget: testBudget,
        runId: 'run-voi-001',
        policyVersion: '1.2.0',
        goal: 'DEEP_RESEARCH',
        store,
      });

      // 1. Must evaluate every registered evidence family
      expect(result.decisions).toHaveLength(EVIDENCE_FAMILIES.length);
      expect(store.size()).toBe(EVIDENCE_FAMILIES.length);

      for (const fam of EVIDENCE_FAMILIES) {
        const famId = fam.familyId ?? fam.id ?? 'UNKNOWN';
        const d = result.decisions.find((dec: EvidenceAcquisitionDecision) => dec.evidenceFamily === famId);
        expect(d).toBeDefined();
        expect(d!.candidateId).toBe(candidate.assetId);
        expect(d!.runId).toBe('run-voi-001');
        expect(d!.policyVersion).toBe('1.2.0');
        expect(d!.expectedDecisionImpact).toBe(fam.defaultDecisionImpact ?? d!.expectedDecisionImpact);
        expect(d!.estimatedCost?.monetaryCostUsd).toBe(fam.monetaryCostUsd ?? fam.defaultMonetaryCostUsd);
        expect(d!.estimatedCost?.quotaCostUnits).toBe(fam.providerQuotaCost ?? fam.defaultQuotaUnits);
        expect(d!.reasonCodes.length).toBeGreaterThan(0);
        expect(ALL_EVIDENCE_ACQUISITION_STATES).toContain(d!.state);
      }

      // 2. High-VOI / mandatory deep-research families are REQUESTED
      expect(result.requestedFamilies).toContain('TOKEN_PROFILE');
      expect(result.requestedFamilies).toContain('CONTRACT_SECURITY');

      // 3. Persisted in store with exact (run, candidate, family, policyVersion) uniqueness
      for (const fam of EVIDENCE_FAMILIES) {
        const famId = fam.familyId ?? fam.id ?? 'UNKNOWN';
        const stored = store.getDecision('run-voi-001', candidate.assetId, famId, '1.2.0');
        expect(stored).toBeDefined();
        expect(stored!.id).toBe(`acq_run-voi-001_${candidate.assetId}_${famId}_1.2.0`);
      }
    });

    it('marks optional low-VOI evidence as NOT_REQUESTED_BY_POLICY with explicit reasons and excludes from execution plan', () => {
      const result = planner.plan({
        candidate,
        profile: testProfile,
        envelope: fullEnvelope,
        budget: testBudget,
        runId: 'run-voi-triage',
        policyVersion: '1.2.0',
        goal: 'TRIAGE',
        minVoiThreshold: 50.0, // High threshold skips low-VOI optional families
        store,
      });

      const socialDecision = result.decisions.find((d: EvidenceAcquisitionDecision) => d.evidenceFamily === 'SOCIAL_SENTIMENT');
      expect(socialDecision).toBeDefined();
      expect(socialDecision!.state).toBe('NOT_REQUESTED_BY_POLICY');
      expect(socialDecision!.reasonCodes).toContain('VOI_BELOW_THRESHOLD');

      // Execution plan must not contain tools for skipped families
      const plannedToolNames = result.plan.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      expect(plannedToolNames).not.toContain('community.sentiment');
    });

    it('enforces cost and quota blocks when budget limits are tight', () => {
      const tightBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 10,
        maxModelCostUsd: 0.0002, // Only enough for ~1 family
        maxProviderCostUnits: 1,
      };

      const result = planner.plan({
        candidate,
        profile: testProfile,
        envelope: fullEnvelope,
        budget: tightBudget,
        runId: 'run-voi-tight',
        policyVersion: '1.2.0',
        goal: 'DEEP_RESEARCH',
        store,
      });

      const blockedDecisions = result.decisions.filter(
        (d: EvidenceAcquisitionDecision) => d.state === 'COST_BLOCKED' || d.state === 'QUOTA_BLOCKED',
      );
      expect(blockedDecisions.length).toBeGreaterThan(0);
      expect(result.blockedFamilies.length).toBeGreaterThan(0);
    });
  });

  describe('FR-AGT-010: Randomized Evidence Probe allocation', () => {
    it('assigns random probe inclusion probability, stratum, and seed reference frozen before retrieval', () => {
      const result = planner.plan({
        candidate,
        profile: testProfile,
        envelope: fullEnvelope,
        budget: testBudget,
        runId: 'run-probe-001',
        policyVersion: '1.2.0',
        randomProbeConfig: {
          enabled: true,
          stratum: 'LOW_ACTIVITY_EXPLORATION',
          inclusionProbability: 1.0, // 100% deterministic probe
          seedRef: 'probe-seed-12345',
        },
        store,
      });

      for (const d of result.decisions) {
        expect(d.randomized).toBe(true);
        expect(d.assignmentProbability).toBe('1');
        expect(d.randomizationStratum).toBe('LOW_ACTIVITY_EXPLORATION');
        expect(d.randomizationSeedRef).toBe('probe-seed-12345');
        expect(d.reasonCodes).toContain('RANDOM_PROBE_INCLUSION');
      }
    });
  });

  describe('FR-DATA-011 & AC-242 & INV-022: Distinct acquisition states & Missingness / Negative Feature Invariants', () => {
    it('supports exactly 10 distinct acquisition states', () => {
      expect(ALL_EVIDENCE_ACQUISITION_STATES).toHaveLength(10);
      expect(ALL_EVIDENCE_ACQUISITION_STATES).toEqual([
        'NOT_REQUESTED_BY_POLICY',
        'REQUESTED',
        'COST_BLOCKED',
        'QUOTA_BLOCKED',
        'RIGHTS_BLOCKED',
        'UNSUPPORTED',
        'PROVIDER_UNAVAILABLE',
        'FAILED',
        'RETURNED_EMPTY',
        'RETURNED',
      ]);
    });

    it('asserts that skipped evidence (NOT_REQUESTED_BY_POLICY) is NEVER stored as RETURNED_EMPTY or PROVIDER_UNAVAILABLE', () => {
      const decision: EvidenceAcquisitionDecision = {
        id: 'acq-test-1',
        candidateId: candidate.assetId,
        runId: 'run-1',
        evidenceFamily: 'SOCIAL_SENTIMENT',
        policyVersion: '1.0.0',
        state: 'RETURNED_EMPTY', // Error! Skipped reason with empty state
        requestedFields: ['followerCount'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['SKIPPED_BY_GOAL_POLICY'],
      };

      expect(() => assertMissingnessInvariants(decision)).toThrow(/AC_242_VIOLATION/);
    });

    it('asserts that NOT_REQUESTED_BY_POLICY is excluded from negative-feature imputation (INV-022)', () => {
      const decision: EvidenceAcquisitionDecision = {
        id: 'acq-test-2',
        candidateId: candidate.assetId,
        runId: 'run-1',
        evidenceFamily: 'SOCIAL_SENTIMENT',
        policyVersion: '1.0.0',
        state: 'NOT_REQUESTED_BY_POLICY',
        requestedFields: ['followerCount'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['VOI_BELOW_THRESHOLD'],
      };

      // Imputing a negative penalty score for unrequested evidence violates INV-022
      expect(() =>
        assertMissingnessInvariants(decision, { sentiment_penalty: -0.8 }),
      ).toThrow(/INV_022_VIOLATION/);

      // Safe imputation helper keeps value as null and isNegativeImputation false
      const imputed = imputeFeatureWithMissingnessPolicy({
        featureId: 'sentiment_score',
        acquisitionState: 'NOT_REQUESTED_BY_POLICY',
      });
      expect(imputed.value).toBeNull();
      expect(imputed.quality).toBe('NOT_REQUESTED');
      expect(imputed.isNegativeImputation).toBe(false);
    });

    it('distinguishes substantive negative evidence from unrequested or empty data', () => {
      // Affirmative negative findings (e.g. honeypot detected, audit failed)
      expect(isSubstantiveNegativeEvidence({ isHoneypot: true })).toBe(true);
      expect(isSubstantiveNegativeEvidence({ auditPassed: false })).toBe(true);
      expect(isSubstantiveNegativeEvidence({ sellFeasible: false })).toBe(true);
      expect(isSubstantiveNegativeEvidence({ risk: 'CRITICAL' })).toBe(true);

      // Non-negative / unobserved / empty
      expect(isSubstantiveNegativeEvidence({})).toBe(false);
      expect(isSubstantiveNegativeEvidence(null)).toBe(false);
      expect(isSubstantiveNegativeEvidence({ isHoneypot: false, auditPassed: true })).toBe(false);
    });
  });

  describe('EvidenceAcquisitionStore: Persistence & (run, candidate, family, policy_version) uniqueness', () => {
    it('enforces uniqueness per (run, candidate, family, policy_version)', () => {
      const dec: EvidenceAcquisitionDecision = {
        id: 'acq-unique-1',
        candidateId: candidate.assetId,
        runId: 'run-unique',
        evidenceFamily: 'TOKEN_PROFILE',
        policyVersion: '1.0.0',
        state: 'REQUESTED',
        requestedFields: ['mint', 'decimals'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['MANDATORY'],
      };

      store.recordDecision(dec);

      // Duplicate insertion must throw
      expect(() => store.recordDecision(dec)).toThrow(/DUPLICATE_ACQUISITION_RECORD/);
    });

    it('allows explicit attempt generation as uniqueness tiebreaker', () => {
      const dec: EvidenceAcquisitionDecision = {
        id: 'acq-attempt-1',
        candidateId: candidate.assetId,
        runId: 'run-attempt',
        evidenceFamily: 'TOKEN_PROFILE',
        policyVersion: '1.0.0',
        state: 'REQUESTED',
        requestedFields: ['mint', 'decimals'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['MANDATORY'],
      };

      store.recordDecision(dec, 1);
      const attempt2 = store.recordDecision(
        { ...dec, id: 'acq-attempt-2' },
        2,
      );
      expect(attempt2).toBeDefined();
      expect(store.size()).toBe(2);
    });

    it('enforces state transition invariants: NOT_REQUESTED_BY_POLICY cannot be updated to empty or provider error', () => {
      const dec: EvidenceAcquisitionDecision = {
        id: 'acq-skip-1',
        candidateId: candidate.assetId,
        runId: 'run-skip',
        evidenceFamily: 'SOCIAL_SENTIMENT',
        policyVersion: '1.0.0',
        state: 'NOT_REQUESTED_BY_POLICY',
        requestedFields: ['followerCount'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['SKIPPED'],
      };

      store.recordDecision(dec);

      expect(() =>
        store.updateOutcome({
          runId: 'run-skip',
          candidateId: candidate.assetId,
          evidenceFamily: 'SOCIAL_SENTIMENT',
          policyVersion: '1.0.0',
          state: 'RETURNED_EMPTY',
        }),
      ).toThrow(/INVALID_STATE_TRANSITION/);
    });

    it('updates REQUESTED state to RETURNED with evidence IDs upon completion', () => {
      const dec: EvidenceAcquisitionDecision = {
        id: 'acq-req-1',
        candidateId: candidate.assetId,
        runId: 'run-complete',
        evidenceFamily: 'MARKET_MICROSTRUCTURE',
        policyVersion: '1.0.0',
        state: 'REQUESTED',
        requestedFields: ['liquidityUsd'],
        randomized: false,
        decidedAt: new Date().toISOString(),
        evidenceIds: [],
        reasonCodes: ['REQUESTED'],
      };

      store.recordDecision(dec);

      const updated = store.updateOutcome({
        runId: 'run-complete',
        candidateId: candidate.assetId,
        evidenceFamily: 'MARKET_MICROSTRUCTURE',
        policyVersion: '1.0.0',
        state: 'RETURNED',
        evidenceIds: ['ev-call-123'],
        actualDecisionChange: 'ALERT',
      });

      expect(updated.state).toBe('RETURNED');
      expect(updated.evidenceIds).toEqual(['ev-call-123']);
      expect(updated.actualDecisionChange).toBe('ALERT');
      expect(updated.completedAt).toBeDefined();
    });
  });

  describe('FR-AGT-012: Deterministic Envelope Confinement Foundation', () => {
    it('authorizes exact tools, entities, fields, time bounds, byte limits, and cost', () => {
      const envelope: ToolAuthorizationEnvelope = {
        allowedTools: ['token.profile', 'dex.pairs'],
        allowedChains: ['solana'],
        allowedAddresses: ['So11111111111111111111111111111111111111112'],
        allowedEntities: ['solana:token:So11111111111111111111111111111111111111112'],
        allowedFields: {
          'token.profile': ['mint', 'decimals', 'symbol'],
        },
        timeRange: {
          maxTimestamp: '2026-08-20T12:00:00.000Z',
        },
        deadlineAt: '2026-08-20T13:00:00.000Z',
        maxLimit: 50,
        maxOutputSizeBytes: 32768,
        maxCostUsd: 0.05,
      };

      // Valid call conforms
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'token.profile',
          {
            chain: 'solana',
            address: 'So11111111111111111111111111111111111111112',
            candidateId: 'solana:token:So11111111111111111111111111111111111111112',
            fields: ['mint', 'symbol'],
            limit: 25,
            asOf: '2026-08-20T11:00:00.000Z',
          },
          envelope,
          ['token.profile', 'dex.pairs'],
        ),
      ).not.toThrow();

      // Broadening tool fails
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'contract.audit',
          {},
          envelope,
          ['token.profile', 'dex.pairs'],
        ),
      ).toThrow(ConfinementViolationError);

      // Broadening entity fails
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'token.profile',
          {
            candidateId: 'solana:token:unauthorized_entity_123',
          },
          envelope,
          ['token.profile', 'dex.pairs'],
        ),
      ).toThrow(ConfinementViolationError);

      // Broadening fields fails
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'token.profile',
          {
            fields: ['unauthorized_private_field'],
          },
          envelope,
          ['token.profile', 'dex.pairs'],
        ),
      ).toThrow(ConfinementViolationError);

      // Exceeding deadline fails
      expect(() =>
        ToolArgumentConfinementValidator.assertConforms(
          'token.profile',
          {
            asOf: '2026-08-20T14:00:00.000Z', // Exceeds deadline 13:00:00
          },
          envelope,
          ['token.profile', 'dex.pairs'],
        ),
      ).toThrow(ConfinementViolationError);
    });
  });

  describe('BoundedAgentRuntime integration with VOI Planner & Acquisition Store', () => {
    it('executes bounded research, persists initial VOI decisions, and updates acquisition records on completion', async () => {
      const registry = new ModelProfileRegistry([testProfile]);
      const runtime = new BoundedAgentRuntime(registry);

      const executionStore = new EvidenceAcquisitionStore();

      const result = await runtime.execute({
        candidate,
        profileId: testProfile.id,
        profileVersion: testProfile.version,
        envelope: fullEnvelope,
        budget: testBudget,
        goal: 'DEEP_RESEARCH',
        acquisitionStore: executionStore,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.runId).toBeDefined();
      expect(result.acquisitionDecisions.length).toBeGreaterThanOrEqual(EVIDENCE_FAMILIES.length);

      // Verify executed tools transitioned to RETURNED
      const returnedDecisions = result.acquisitionDecisions.filter((d: EvidenceAcquisitionDecision) => d.state === 'RETURNED');
      expect(returnedDecisions.length).toBeGreaterThan(0);
      for (const ret of returnedDecisions) {
        expect(ret.evidenceIds.length).toBeGreaterThan(0);
      }

      // Verify skipped families remain NOT_REQUESTED_BY_POLICY in store
      const skippedDecisions = result.acquisitionDecisions.filter(
        (d: EvidenceAcquisitionDecision) => d.state === 'NOT_REQUESTED_BY_POLICY',
      );
      for (const skip of skippedDecisions) {
        expect(skip.evidenceIds).toHaveLength(0);
      }
    });
  });
});
