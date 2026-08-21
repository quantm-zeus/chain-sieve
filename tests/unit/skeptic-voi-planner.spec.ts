import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  ConditionalSkepticAgent,
  DEFAULT_EVIDENCE_FAMILIES,
  DEFAULT_SKEPTIC_TRIGGER_POLICY,
  DEFAULT_VOI_POLICY,
  DatabaseAgentPersistenceRepository,
  InMemoryAgentPersistenceRepository,
  ModelProfileRegistry,
  SkepticTriggerPolicy,
  VoiPlanner,
} from '@ciag/agent-runtime';
import type {
  AgentBudget,
  AgentDecision,
  SkepticArtifact,
  ToolAuthorizationEnvelope,
} from '@ciag/shared-schemas';
import {
  EvidenceAcquisitionDecisionSchema,
  SkepticArtifactSchema,
} from '@ciag/shared-schemas';
import type { DatabaseAdapter } from '@ciag/provider-contracts';

describe('Conditional Skeptic and Value-of-Information Planner (FR-AGT-005, FR-AGT-009)', () => {
  const sampleCandidate = {
    assetId: 'solana:token:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    chainId: 'solana',
    contractAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
  };

  const sampleEnvelope: ToolAuthorizationEnvelope = {
    allowedTools: [
      'token.profile',
      'dex.pairs',
      'dex.screener',
      'pool.liquidity',
      'contract.audit',
      'risk.honeypot_scan',
      'liquidity.lock',
      'simulation.sell',
      'simulation.execution',
      'holder.distribution',
      'solana.transaction_trace',
      'signal.score',
      'market.summary',
    ],
    allowedProviders: ['jupiter', 'dexscreener', 'helius'],
    allowedDomains: ['dexscreener.com', 'helius-rpc.com', 'jup.ag'],
    allowedChains: ['solana'],
    allowedAddresses: ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
    timeRange: {
      minTimestamp: '2025-01-01T00:00:00Z',
      maxTimestamp: '2026-08-20T12:00:00Z',
    },
    maxLimit: 100,
    maxOutputSizeBytes: 65536,
    maxCostUsd: 0.5,
  };

  const sampleBudget: AgentBudget = {
    maxSteps: 10,
    maxToolCalls: 20,
    maxToolCallsPerCandidate: 20,
    maxProviderCalls: 30,
    maxInputTokens: 20000,
    maxOutputTokens: 20000,
    maxModelCostUsd: 0.20,
    maxProviderCostUnits: 50,
  };

  const sampleParentDecision: AgentDecision = {
    candidate: sampleCandidate,
    profileId: 'deep-research-v1',
    decision: 'ALERT',
    alertClassRecommendation: 'CONFIRMED_OPPORTUNITY',
    costPolicyResult: 'PASS',
    lifecycleRecommendation: 'CONFIRMED',
    riskRecommendation: 'LOW',
    thesis: 'High volume breakout with verified liquidity and low holder concentration',
    counterThesis: 'Potential hidden fee or unlock schedule risk',
    observedFacts: [
      {
        claim: 'Liquidity pairs verified on Raydium',
        evidenceIds: ['call_dex_pairs_1'],
        confidence: 'HIGH',
      },
    ],
    derivedFacts: [],
    inferences: [],
    hypotheses: [],
    positiveSignals: ['VERIFIED_LIQUIDITY', 'HIGH_VOLUME_MOMENTUM'],
    riskSignals: [],
    missingData: [],
    providerConflicts: [],
    thesisInvalidationConditions: ['Liquidity falls below 0k', 'Deployer dumps balance'],
    reasoningAssessment: 'HIGH',
  };

  describe('FR-AGT-005: Conditional Skeptic Agent and Versioned Trigger Policy', () => {
    it('evaluates versioned trigger policy and identifies all trigger reasons', () => {
      const policy = new SkepticTriggerPolicy({
        policyVersion: '1.0.0',
        nearAlertScoreThreshold: 0.70,
        maxAcceptableProviderConflicts: 0,
        minDataCoverageRatio: 0.75,
      });

      expect(policy.config.policyVersion).toBe('1.0.0');

      const nearAlertEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        candidateScore: 0.75,
      });
      expect(nearAlertEval.triggered).toBe(true);
      expect(nearAlertEval.triggerReasons).toContain('CANDIDATE_NEAR_ALERT');
      expect(nearAlertEval.policyVersion).toBe('1.0.0');

      const conflictDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'WATCH',
        alertClassRecommendation: undefined,
        providerConflicts: ['DEXScreener vs Birdeye price divergence 12%'],
      };
      const conflictEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: conflictDecision,
        candidateScore: 0.50,
      });
      expect(conflictEval.triggered).toBe(true);
      expect(conflictEval.triggerReasons).toContain('PROVIDER_CONFLICT_EXCEEDS_THRESHOLD');

      const disagreementDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'WATCH',
        alertClassRecommendation: undefined,
        positiveSignals: ['LIQUIDITY_SURGE', 'VIRAL_ENGAGEMENT'],
        riskSignals: ['UNRENOUNCED_OWNERSHIP'],
        riskRecommendation: 'HIGH',
      };
      const disagreeEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: disagreementDecision,
        candidateScore: 0.55,
      });
      expect(disagreeEval.triggered).toBe(true);
      expect(disagreeEval.triggerReasons).toContain('OPPORTUNITY_RISK_VECTOR_DISAGREEMENT');

      const coverageEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: { ...sampleParentDecision, decision: 'WATCH', alertClassRecommendation: undefined },
        candidateScore: 0.50,
        dataCoverageRatio: 0.60,
      });
      expect(coverageEval.triggered).toBe(true);
      expect(coverageEval.triggerReasons).toContain('DATA_COVERAGE_MARGINAL');

      const extendedEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: { ...sampleParentDecision, decision: 'WATCH', alertClassRecommendation: undefined },
        candidateScore: 0.50,
        unusuallyExtended: true,
      });
      expect(extendedEval.triggered).toBe(true);
      expect(extendedEval.triggerReasons).toContain('CANDIDATE_UNUSUALLY_EXTENDED');

      const weakFactsDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'WATCH',
        alertClassRecommendation: undefined,
        observedFacts: [{ claim: 'Unverified rumor', evidenceIds: [], confidence: 'LOW' }],
      };
      const weakEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: weakFactsDecision,
        candidateScore: 0.50,
      });
      expect(weakEval.triggered).toBe(true);
      expect(weakEval.triggerReasons).toContain('RESEARCHER_CLAIMS_WEAKLY_SUPPORTED');

      const fragileEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: { ...sampleParentDecision, decision: 'WATCH', alertClassRecommendation: undefined },
        candidateScore: 0.50,
        fragilityDetected: true,
      });
      expect(fragileEval.triggered).toBe(true);
      expect(fragileEval.triggerReasons).toContain('THRESHOLD_SENSITIVITY_FRAGILITY');

      const dominantEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: { ...sampleParentDecision, decision: 'WATCH', alertClassRecommendation: undefined },
        candidateScore: 0.50,
        dominantProviderRatio: 0.90,
      });
      expect(dominantEval.triggered).toBe(true);
      expect(dominantEval.triggerReasons).toContain('DOMINANT_SINGLE_PROVIDER_DEPENDENCE');
    });

    it('skips execution and returns NOT_TRIGGERED when no trigger condition holds', async () => {
      const skepticAgent = new ConditionalSkepticAgent();
      const quietDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'IGNORE',
        alertClassRecommendation: undefined,
        positiveSignals: [],
        riskSignals: [],
        riskRecommendation: 'LOW',
        lifecycleRecommendation: 'DISCOVERED',
        observedFacts: [{ claim: 'Token exists', evidenceIds: ['ev_1'], confidence: 'HIGH' }],
      };

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: quietDecision,
        runId: 'run-test-not-triggered',
        envelope: sampleEnvelope,
        triggerContext: {
          candidateScore: 0.30,
          dataCoverageRatio: 1.0,
          providerConflictsCount: 0,
        },
      });

      expect(result.status).toBe('NOT_TRIGGERED');
      expect(result.artifact.triggered).toBe(false);
      expect(result.artifact.status).toBe('NOT_TRIGGERED');
      expect(result.artifact.verdict).toBe('CONFIRM');
      expect(result.artifact.decisionChanged).toBe(false);
      expect(result.toolRecords.length).toBe(0);
      expect(result.artifact.sha256).toBeDefined();

      const parsed = SkepticArtifactSchema.parse(result.artifact);
      expect(parsed.id).toContain('skeptic_');
      expect(parsed.parentDecisionId).toBeDefined();
    });

    it('executes with independent budget and produces auditable artifact linked to parent decision', async () => {
      const skepticAgent = new ConditionalSkepticAgent();
      const independentBudget: AgentBudget = {
        maxSteps: 6,
        maxToolCalls: 6,
        maxModelCostUsd: 0.05,
        maxProviderCostUnits: 10,
        maxInputTokens: 3000,
        maxOutputTokens: 3000,
      };

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        parentDecisionId: 'parent-dec-12345',
        runId: 'run-skeptic-001',
        envelope: sampleEnvelope,
        skepticBudget: independentBudget,
        triggerContext: {
          candidateScore: 0.85,
        },
      });

      expect(result.status).toBe('EXECUTED');
      expect(result.artifact.triggered).toBe(true);
      expect(result.artifact.parentDecisionId).toBe('parent-dec-12345');
      expect(result.artifact.candidateId).toBe(sampleCandidate.assetId);
      expect(result.artifact.runId).toBe('run-skeptic-001');
      expect(result.artifact.policyVersion).toBe(DEFAULT_SKEPTIC_TRIGGER_POLICY.policyVersion);
      expect(result.artifact.triggerReasons).toContain('CANDIDATE_NEAR_ALERT');
      expect(result.artifact.profileId).toBe('skeptic-v1');
      expect(result.artifact.sha256).toBeDefined();
      expect(result.artifact.sha256?.length).toBe(64);
      expect(result.toolRecords.length).toBeGreaterThan(0);

      const validated = SkepticArtifactSchema.parse(result.artifact);
      expect(validated.verdict).toBe('CONFIRM');
      expect(validated.decisionChanged).toBe(false);
    });

    it('vetoes candidate and changes parent decision when honeypot or sell failure is detected', async () => {
      const skepticAgent = new ConditionalSkepticAgent();

      skepticAgent.registerTool('risk.honeypot_scan', async () => ({
        isHoneypot: true,
        sellTax: 0.99,
        reason: 'Transfer fee 99% configured in bytecode',
      }));

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        parentDecisionId: 'parent-dec-honeypot',
        runId: 'run-skeptic-honeypot',
        envelope: sampleEnvelope,
        triggerContext: {
          candidateScore: 0.80,
        },
      });

      expect(result.status).toBe('EXECUTED');
      expect(result.artifact.verdict).toBe('VETO');
      expect(result.artifact.suggestedDecision).toBe('REJECT');
      expect(result.artifact.suggestedRiskLevel).toBe('CRITICAL');
      expect(result.artifact.decisionChanged).toBe(true);
      expect(result.artifact.challengeFindings).toContain('CRITICAL_SECURITY_HONEYPOT_CONFIRMED');
      expect(result.artifact.counterThesis).toContain('Critical failure hazards');
    });

    it('challenges candidate when unlocked liquidity or unrenounced mint is detected', async () => {
      const skepticAgent = new ConditionalSkepticAgent();

      skepticAgent.registerTool('liquidity.lock', async () => ({
        lockedPercentage: 10,
        isBurned: false,
      }));

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        parentDecisionId: 'parent-dec-unlock',
        runId: 'run-skeptic-unlock',
        envelope: sampleEnvelope,
        triggerContext: {
          candidateScore: 0.78,
        },
      });

      expect(result.status).toBe('EXECUTED');
      expect(result.artifact.verdict).toBe('CHALLENGE');
      expect(result.artifact.suggestedDecision).toBe('WATCH');
      expect(result.artifact.suggestedRiskLevel).toBe('HIGH');
      expect(result.artifact.decisionChanged).toBe(true);
      expect(result.artifact.challengeFindings).toContain('UNLOCKED_LIQUIDITY_HAZARD_10_PERCENT_LOCKED');
    });

    it('triggers skeptic on HIGH risk when forceSkepticOnHighRisk is enabled even without strong positive', () => {
      const policy = new SkepticTriggerPolicy({ forceSkepticOnHighRisk: true, nearAlertScoreThreshold: 0.90 });
      const highRiskEval = policy.evaluate({
        candidate: sampleCandidate,
        parentDecision: {
          ...sampleParentDecision,
          decision: 'IGNORE',
          alertClassRecommendation: undefined,
          positiveSignals: [],
          riskRecommendation: 'HIGH',
        },
        candidateScore: 0.40,
      });
      expect(highRiskEval.triggered).toBe(true);
      expect(highRiskEval.triggerReasons).toContain('OPPORTUNITY_RISK_VECTOR_DISAGREEMENT');
    });

    it('handles skeptic budget exhaustion fail-closed without corrupting parent run', async () => {
      const skepticAgent = new ConditionalSkepticAgent();
      const exhaustedBudget: AgentBudget = {
        maxSteps: 0,
        maxToolCalls: 0,
        maxModelCostUsd: 0,
        maxProviderCostUnits: 0,
      };

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        runId: 'run-budget-exhaust',
        envelope: sampleEnvelope,
        skepticBudget: exhaustedBudget,
        triggerContext: {
          candidateScore: 0.82,
        },
      });

      expect(result.status).toBe('BUDGET_EXCEEDED');
      expect(result.artifact.status).toBe('BUDGET_EXCEEDED');
      expect(result.artifact.triggered).toBe(true);
      expect(result.artifact.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.artifact.confidence).toBe('LOW');
      expect(result.toolRecords.length).toBe(0);
    });

    it('gracefully handles BudgetExceededError thrown inside tool handler without escaping skeptic execution', async () => {
      const skepticAgent = new ConditionalSkepticAgent();
      skepticAgent.registerTool('contract.audit', async () => {
        throw new BudgetExceededError('TOOL_CALLS', 1, 0, 1);
      });

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        runId: 'run-handler-budget-exhaust',
        envelope: sampleEnvelope,
        triggerContext: {
          candidateScore: 0.85,
        },
      });

      expect(result.status).toBe('BUDGET_EXCEEDED');
      expect(result.artifact.status).toBe('BUDGET_EXCEEDED');
      expect(result.artifact.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.artifact.confidence).toBe('LOW');
      expect(result.toolRecords.length).toBe(1);
      expect(result.toolRecords[0]?.error).toContain('Skeptic tool budget exceeded');
    });
  });

  describe('FR-AGT-009: Value-of-Information Planner', () => {
    const profile = new ModelProfileRegistry().require('deep-research-v1');

    it('applies costWeight to penalize expensive optional evidence families', () => {
      const lowCostWeightPlanner = new VoiPlanner({ costWeight: 0.0 });
      const highCostWeightPlanner = new VoiPlanner({ costWeight: 20.0 });

      const lowResult = lowCostWeightPlanner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-cost-low',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.50,
      });

      const highResult = highCostWeightPlanner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-cost-high',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.50,
      });

      const lowDec = lowResult.decisions.find((d) => d.evidenceFamily === 'CONTRACT_SECURITY');
      const highDec = highResult.decisions.find((d) => d.evidenceFamily === 'CONTRACT_SECURITY');
      expect(lowDec?.expectedInformationValue).toBeGreaterThan(highDec?.expectedInformationValue ?? 0);
    });

    it('persists a decision record for every eligible optional evidence family', () => {
      const planner = new VoiPlanner();
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-001',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.80,
      });

      expect(planResult.policyVersion).toBe(DEFAULT_VOI_POLICY.policyVersion);
      expect(planResult.decisions.length).toBe(DEFAULT_EVIDENCE_FAMILIES.length);

      for (const decision of planResult.decisions) {
        const validated = EvidenceAcquisitionDecisionSchema.parse(decision);
        expect(validated.policyVersion).toBe(DEFAULT_VOI_POLICY.policyVersion);
        expect(validated.candidateId).toBe(sampleCandidate.assetId);
        expect(validated.runId).toBe('run-voi-001');
        expect(validated.expectedInformationValue).toBeDefined();
        expect(validated.estimatedCost).toBeDefined();
        expect(validated.decidedAt).toBeDefined();

        if (validated.state === 'NOT_REQUESTED_BY_POLICY') {
          expect(validated.skipReason).toBeDefined();
          expect(validated.reasonCodes.length).toBeGreaterThan(0);
        } else if (validated.state === 'REQUESTED') {
          expect(validated.requestReason).toBeDefined();
          expect(validated.requestedFields.length).toBeGreaterThan(0);
        }
      }

      expect(planResult.requestedFamilies).toContain('TOKEN_PROFILE');
      expect(planResult.requestedFamilies).toContain('CONTRACT_SECURITY');
      expect(planResult.requestedFamilies).toContain('MARKET_MICROSTRUCTURE');
      expect(planResult.requestedFamilies).toContain('HOLDER_DISTRIBUTION');
      expect(planResult.requestedFamilies).toContain('TRANSACTION_TRACE');
      expect(planResult.requestedFamilies.length + planResult.skippedFamilies.length).toBe(planResult.decisions.length);
      expect(planResult.totalEstimatedMonetaryCostUsd).toBeGreaterThan(0);
      expect(planResult.totalEstimatedQuotaUnits).toBeGreaterThan(0);
    });

    it('renders skipped families as NOT_REQUESTED_BY_POLICY and distinct from provider failure', () => {
      const planner = new VoiPlanner({ minExpectedInformationValue: 0.60 });
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-skipped',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.35,
      });

      const skipped = planResult.decisions.filter((d) => d.state === 'NOT_REQUESTED_BY_POLICY');
      expect(skipped.length).toBeGreaterThan(0);

      for (const d of skipped) {
        expect(d.state).toBe('NOT_REQUESTED_BY_POLICY');
        expect(d.skipReason).toBeDefined();
        expect(d.reasonCodes).toContain('DIMINISHING_MARGINAL_UTILITY');
        expect(d.state).not.toBe('RETURNED_EMPTY');
        expect(d.state).not.toBe('FAILED');
        expect(d.state).not.toBe('PROVIDER_UNAVAILABLE');
      }

      const rendered = planner.renderEvidenceAcquisitions(planResult.decisions);
      expect(rendered).toContain('[NOT_REQUESTED_BY_POLICY]');
      expect(rendered).toContain('Missingness is neutral; not unfavorable');
    });

    it('skips all optional evidence as NOT_REQUESTED_BY_POLICY when hard rejection is proven while retaining mandatory core family', () => {
      const planner = new VoiPlanner();
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-hard-reject',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        hardRejectionProven: true,
      });

      const tokenProfileDecision = planResult.decisions.find((d) => d.evidenceFamily === 'TOKEN_PROFILE');
      expect(tokenProfileDecision).toBeDefined();
      expect(tokenProfileDecision?.state).toBe('REQUESTED');
      expect(tokenProfileDecision?.reasonCodes).toContain('MANDATORY_CORE_EVIDENCE');

      const optionalDecisions = planResult.decisions.filter((d) => d.evidenceFamily !== 'TOKEN_PROFILE');
      expect(optionalDecisions.length).toBeGreaterThan(0);
      for (const d of optionalDecisions) {
        expect(d.state).toBe('NOT_REQUESTED_BY_POLICY');
        expect(d.skipReason).toContain('Hard rejection already proven');
        expect(d.reasonCodes).toContain('HARD_REJECTION_PROVEN');
      }
    });

    it('skips all optional evidence as NOT_REQUESTED_BY_POLICY when alert threshold is unreachable while retaining mandatory core family', () => {
      const planner = new VoiPlanner();
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-unreachable',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        alertThresholdUnreachable: true,
      });

      const tokenProfileDecision = planResult.decisions.find((d) => d.evidenceFamily === 'TOKEN_PROFILE');
      expect(tokenProfileDecision).toBeDefined();
      expect(tokenProfileDecision?.state).toBe('REQUESTED');
      expect(tokenProfileDecision?.reasonCodes).toContain('MANDATORY_CORE_EVIDENCE');

      const optionalDecisions = planResult.decisions.filter((d) => d.evidenceFamily !== 'TOKEN_PROFILE');
      expect(optionalDecisions.length).toBeGreaterThan(0);
      for (const d of optionalDecisions) {
        expect(d.state).toBe('NOT_REQUESTED_BY_POLICY');
        expect(d.skipReason).toContain('Alert threshold unreachable');
        expect(d.reasonCodes).toContain('ALERT_THRESHOLD_UNREACHABLE');
      }
    });

    it('marks families as COST_BLOCKED or QUOTA_BLOCKED when budget is constrained', () => {
      const planner = new VoiPlanner();
      const tightBudget: AgentBudget = {
        maxSteps: 5,
        maxToolCalls: 10,
        maxModelCostUsd: 0.0002,
        maxProviderCostUnits: 1,
      };

      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-cost-blocked',
        envelope: sampleEnvelope,
        budget: tightBudget,
        profile,
        currentCandidateScore: 0.85,
      });

      const blocked = planResult.decisions.filter(
        (d) => d.state === 'COST_BLOCKED' || d.state === 'QUOTA_BLOCKED',
      );
      expect(blocked.length).toBeGreaterThan(0);
      for (const b of blocked) {
        expect(b.skipReason).toBeDefined();
        expect(
          b.reasonCodes.includes('BUDGET_COST_EXCEEDED') ||
            b.reasonCodes.includes('BUDGET_QUOTA_EXCEEDED'),
        ).toBe(true);
      }
    });

    it('supports stratified randomized evidence probe allocation with provenance metadata', () => {
      const planner = new VoiPlanner({
        enableRandomizedProbes: true,
        randomizedProbeRate: 1.0,
        randomizationSeedRef: 'test-seed-xyz',
      });

      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-voi-randomized',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
      });

      const randomizedDecisions = planResult.decisions.filter((d) => d.randomized);
      expect(randomizedDecisions.length).toBeGreaterThan(0);
      for (const d of randomizedDecisions) {
        expect(d.assignmentProbability).toBe('1');
        expect(d.randomizationStratum).toBe('GENERAL_ELIGIBLE');
        expect(d.randomizationSeedRef).toBe('test-seed-xyz');
        expect(d.reasonCodes).toContain('RANDOMIZED_EVIDENCE_PROBE');
      }
    });

    it('reconciles decisions after execution, updating actual cost and decision change status', () => {
      const planner = new VoiPlanner({ minExpectedInformationValue: 0.60 });
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-reconcile-001',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.75,
      });

      const initialDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'WATCH',
        lifecycleRecommendation: 'QUALIFIED',
      };

      const finalDecision: AgentDecision = {
        ...sampleParentDecision,
        decision: 'ALERT',
        lifecycleRecommendation: 'CONFIRMED',
      };

      const reconciled = planner.reconcileDecisions({
        decisions: planResult.decisions,
        toolRecords: [
          { toolName: 'token.profile', callId: 'call_tok_1', output: { name: 'BONK' } },
          { toolName: 'contract.audit', callId: 'call_aud_1', output: { isHoneypot: false } },
        ],
        previousDecision: initialDecision,
        finalDecision,
        actualCost: { monetaryCostUsd: 0.0012, quotaCostUnits: 4 },
      });

      const contractSecurityDecision = reconciled.find((d) => d.evidenceFamily === 'CONTRACT_SECURITY');
      expect(contractSecurityDecision).toBeDefined();
      expect(contractSecurityDecision?.state).toBe('RETURNED');
      expect(contractSecurityDecision?.evidenceIds).toContain('call_aud_1');
      expect(contractSecurityDecision?.actualDecisionChange).toBe('ALERT');
      expect(contractSecurityDecision?.completedAt).toBeDefined();
      expect(contractSecurityDecision?.actualCost?.monetaryCostUsd).toBe(0.0008);
      expect(contractSecurityDecision?.actualCost?.quotaCostUnits).toBe(3);

      const tokenProfileDecision = reconciled.find((d) => d.evidenceFamily === 'TOKEN_PROFILE');
      expect(tokenProfileDecision).toBeDefined();
      expect(tokenProfileDecision?.state).toBe('RETURNED');
      expect(tokenProfileDecision?.actualCost?.monetaryCostUsd).toBe(0.0001);
      expect(tokenProfileDecision?.actualCost?.quotaCostUnits).toBe(1);

      // Skipped families must have actualCost of 0
      const skippedDecisions = reconciled.filter((d) => d.state === 'NOT_REQUESTED_BY_POLICY');
      expect(skippedDecisions.length).toBeGreaterThan(0);
      for (const skipped of skippedDecisions) {
        expect(skipped.actualCost?.monetaryCostUsd).toBe(0);
        expect(skipped.actualCost?.quotaCostUnits).toBe(0);
      }
    });

    it('treats NOT_REQUESTED_BY_POLICY as neutral missingness in downstream scoring without negative inference', () => {
      const planner = new VoiPlanner({ minExpectedInformationValue: 0.60 });
      const planResult = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-scoring-test',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile,
        currentCandidateScore: 0.40,
      });

      const featureValues: Record<string, number | null> = {
        'token.profile': 0.90,
        'contract.audit': null,
        'simulation.sell': null,
        'social.sentiment': 0.80,
      };

      const featureWeights: Record<string, number> = {
        'token.profile': 1.0,
        'contract.audit': 1.0,
        'simulation.sell': 1.0,
        'social.sentiment': 1.0,
      };

      const baselineCohortScores: Record<string, number> = {
        'contract.audit': 0.60,
        'simulation.sell': 0.60,
      };

      const scored = planner.scoreWithMissingnessAwareness({
        featureValues,
        acquisitionDecisions: planResult.decisions,
        featureWeights,
        baselineCohortScores,
      });

      expect(scored.compositeScore).toBeGreaterThan(0.60);
      expect(scored.evaluatedFeatures['contract.audit']?.isMissing).toBe(true);
      expect(scored.evaluatedFeatures['contract.audit']?.isNegativeInferred).toBe(false);
      expect(scored.evaluatedFeatures['contract.audit']?.imputedValue).toBe(0.60);
    });

    it('defaults unmapped features to NOT_REQUESTED_BY_POLICY with cohort neutral prior', () => {
      const planner = new VoiPlanner();
      const scored = planner.scoreWithMissingnessAwareness({
        featureValues: {
          'custom.unmapped.metric': null,
        },
        acquisitionDecisions: [],
        featureWeights: {
          'custom.unmapped.metric': 1.0,
        },
        baselineCohortScores: {
          'custom.unmapped.metric': 0.75,
        },
      });

      expect(scored.evaluatedFeatures['custom.unmapped.metric']?.acquisitionState).toBe('NOT_REQUESTED_BY_POLICY');
      expect(scored.evaluatedFeatures['custom.unmapped.metric']?.isMissing).toBe(true);
      expect(scored.evaluatedFeatures['custom.unmapped.metric']?.isNegativeInferred).toBe(false);
      expect(scored.evaluatedFeatures['custom.unmapped.metric']?.imputedValue).toBe(0.75);
    });
  });

  // =========================================================================
  // Pipeline Integration: Bounded Runtime with VOI and Conditional Skeptic
  // =========================================================================
  describe('BoundedAgentRuntime Pipeline Integration with VOI and Skeptic', () => {
    it('executes research pipeline with VOI planning and conditional skeptic seamlessly', async () => {
      const { BoundedAgentRuntime } = await import('@ciag/agent-runtime');
      const runtime = new BoundedAgentRuntime();

      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'deep-research-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        enableVoi: true,
        enableSkeptic: true,
        candidateScore: 0.82,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.decision).toBeDefined();

      // Check VOI plan result
      expect(result.voiPlanResult).toBeDefined();
      expect(result.voiPlanResult?.decisions.length).toBe(DEFAULT_EVIDENCE_FAMILIES.length);
      expect(result.voiPlanResult?.requestedFamilies).toContain('CONTRACT_SECURITY');
      expect(
        (result.voiPlanResult?.requestedFamilies.length ?? 0) +
          (result.voiPlanResult?.skippedFamilies.length ?? 0),
      ).toBe(DEFAULT_EVIDENCE_FAMILIES.length);
      const contractSecDecision = result.voiPlanResult?.decisions.find((d) => d.evidenceFamily === 'CONTRACT_SECURITY');
      expect(contractSecDecision?.completedAt).toBeDefined();
      expect(contractSecDecision?.actualCost).toBeDefined();
      expect(contractSecDecision?.actualDecisionChange).toBeDefined();

      // Check Skeptic execution result
      expect(result.skepticResult).toBeDefined();
      expect(result.skepticResult?.status).toBe('EXECUTED');
      expect(result.skepticResult?.artifact.triggered).toBe(true);
      expect(result.skepticResult?.artifact.triggerReasons).toContain('CANDIDATE_NEAR_ALERT');
      expect(result.skepticResult?.artifact.sha256).toBeDefined();
    });

    it('plumbs full skepticTriggerContext through BoundedAgentRuntime to trigger skeptic', async () => {
      const { BoundedAgentRuntime } = await import('@ciag/agent-runtime');
      const runtime = new BoundedAgentRuntime();

      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'deep-research-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        enableSkeptic: true,
        candidateScore: 0.40, // not near alert
        skepticTriggerContext: {
          unusuallyExtended: true,
          fragilityDetected: true,
          dominantProviderRatio: 0.90,
          dataCoverageRatio: 0.50,
        },
      });

      expect(result.skepticResult).toBeDefined();
      expect(result.skepticResult?.status).toBe('EXECUTED');
      expect(result.skepticResult?.artifact.triggered).toBe(true);
      expect(result.skepticResult?.artifact.triggerReasons).toContain('CANDIDATE_UNUSUALLY_EXTENDED');
      expect(result.skepticResult?.artifact.triggerReasons).toContain('THRESHOLD_SENSITIVITY_FRAGILITY');
      expect(result.skepticResult?.artifact.triggerReasons).toContain('DOMINANT_SINGLE_PROVIDER_DEPENDENCE');
      expect(result.skepticResult?.artifact.triggerReasons).toContain('DATA_COVERAGE_MARGINAL');
    });

    it('persists VOI decisions and skeptic artifacts via persistence repository write-through', async () => {
      const { BoundedAgentRuntime } = await import('@ciag/agent-runtime');
      const runtime = new BoundedAgentRuntime();
      const repository = new InMemoryAgentPersistenceRepository();

      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'deep-research-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        enableVoi: true,
        enableSkeptic: true,
        candidateScore: 0.85,
        persistenceRepository: repository,
      });

      expect(result.status).toBe('SUCCESS');

      // Verify persistence write-through
      const savedVoiPlan = await repository.getVoiPlan(result.plan.planId);
      expect(savedVoiPlan).toBeDefined();
      expect(savedVoiPlan?.decisions.length).toBe(DEFAULT_EVIDENCE_FAMILIES.length);

      const savedVoiDecisions = await repository.getVoiDecisions(result.plan.planId);
      expect(savedVoiDecisions.length).toBe(DEFAULT_EVIDENCE_FAMILIES.length);

      const savedSkepticArtifact = await repository.getSkepticArtifact(result.plan.planId);
      expect(savedSkepticArtifact).toBeDefined();
      expect(savedSkepticArtifact?.id).toBe(result.skepticResult?.artifact.id);
      expect(savedSkepticArtifact?.sha256).toBe(result.skepticResult?.artifact.sha256);

      const parentDecisionId = `dec_${sampleCandidate.assetId}_${result.plan.planId}`;
      const artifactsByParent = await repository.getSkepticArtifactsByParentDecision(parentDecisionId);
      expect(artifactsByParent.length).toBe(1);
      expect(artifactsByParent[0]?.id).toBe(result.skepticResult?.artifact.id);
    });

    it('handles AC-243 randomized probe stratum matching eligibility stratum and metadata', () => {
      const planner = new VoiPlanner({
        enableRandomizedProbes: true,
        randomizedProbeRate: 1.0,
        randomizationSeedRef: 'test-stratum-seed-1',
      });

      const plan = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'plan_stratum_test_1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile: new ModelProfileRegistry().get('deep-research-v1')!,
        currentCandidateScore: 0.75, // isNearAlert
        currentRiskState: 'HIGH',
        randomizationStratum: 'NEAR_ALERT_HIGH_RISK_STRATUM',
      });

      const requestedProbes = plan.decisions.filter((d) => d.randomized);
      expect(requestedProbes.length).toBeGreaterThan(0);
      for (const probe of requestedProbes) {
        expect(probe.randomizationStratum).toBe('NEAR_ALERT_HIGH_RISK_STRATUM');
        expect(probe.assignmentProbability).toBe('1');
        expect(probe.randomizationSeedRef).toBe('test-stratum-seed-1');
        expect(probe.reasonCodes).toContain('RANDOMIZED_EVIDENCE_PROBE');
      }
    });

    it('returns SKIPPED_POLICY when no skeptic tools are authorized in envelope', async () => {
      const skepticAgent = new ConditionalSkepticAgent(
        new SkepticTriggerPolicy(),
        new ModelProfileRegistry(),
      );

      // Restrict envelope to exclude all skeptic tools
      const emptyEnvelope: ToolAuthorizationEnvelope = {
        ...sampleEnvelope,
        allowedTools: ['dex.screener'], // none of skeptic tools (contract.audit, risk.honeypot_scan, etc.)
      };

      const result = await skepticAgent.execute({
        candidate: sampleCandidate,
        parentDecision: sampleParentDecision,
        parentDecisionId: 'dec_test_skipped_policy',
        runId: 'run_skipped_policy',
        envelope: emptyEnvelope,
      });

      expect(result.status).toBe('SKIPPED_POLICY');
      expect(result.artifact.status).toBe('SKIPPED_POLICY');
      expect(result.artifact.verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.artifact.confidence).toBe('LOW');
      expect(result.artifact.counterThesis).toContain('skipped by policy');
      expect(result.artifact.sha256).toBeDefined();
    });

    it('DatabaseAgentPersistenceRepository preserves round-trip fidelity for VoiPlan totals over requested families only', async () => {
      const rows: Record<string, unknown>[] = [];
      const mockDatabase: DatabaseAdapter = {
        query: async <T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) => {
          const p = params ?? [];
          if (sql.startsWith('INSERT INTO voi_acquisition_decisions')) {
            rows.push({
              id: p[0],
              candidate_id: p[1],
              run_id: p[2],
              evidence_family: p[3],
              policy_version: p[4],
              state: p[5],
              requested_fields_json: p[6],
              expected_decision_impact: p[7],
              expected_information_value: p[8],
              estimated_cost_json: p[9],
              actual_cost_json: p[10],
              randomized: p[11],
              assignment_probability: p[12],
              randomization_stratum: p[13],
              randomization_seed_ref: p[14],
              decided_at: p[15],
              completed_at: p[16],
              evidence_ids_json: p[17],
              reason_codes_json: p[18],
              skip_reason: p[19],
              request_reason: p[20],
              actual_decision_change: p[21],
            });
            return { rows: [] as T[], rowCount: 0 };
          }
          if (sql.startsWith('SELECT * FROM voi_acquisition_decisions')) {
            return { rows: rows as unknown as T[], rowCount: rows.length };
          }
          return { rows: [] as T[], rowCount: 0 };
        },
        transaction: async <T>(work: (db: DatabaseAdapter) => Promise<T>) => work(mockDatabase),
        ready: async () => true,
        close: async () => {},
      };

      const dbRepo = new DatabaseAgentPersistenceRepository(mockDatabase);
      const planner = new VoiPlanner({ minExpectedInformationValue: 0.60 });
      const plan = planner.planAcquisitions({
        candidate: sampleCandidate,
        runId: 'run-db-fidelity-test',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        profile: new ModelProfileRegistry().get('deep-research-v1')!,
        currentCandidateScore: 0.40, // some requested, some skipped
      });

      // Verify that the plan has both requested and skipped families
      expect(plan.requestedFamilies.length).toBeGreaterThan(0);
      expect(plan.skippedFamilies.length).toBeGreaterThan(0);

      await dbRepo.saveVoiPlan(plan);
      const reconstructed = await dbRepo.getVoiPlan('run-db-fidelity-test');

      expect(reconstructed).not.toBeNull();
      expect(reconstructed?.totalEstimatedMonetaryCostUsd).toBe(plan.totalEstimatedMonetaryCostUsd);
      expect(reconstructed?.totalEstimatedQuotaUnits).toBe(plan.totalEstimatedQuotaUnits);
      expect(reconstructed?.requestedFamilies).toEqual(plan.requestedFamilies);
      expect(reconstructed?.skippedFamilies).toEqual(plan.skippedFamilies);
    });

    it('InMemoryAgentPersistenceRepository maintains idempotency when saving duplicate skeptic artifact id', async () => {
      const inMemory = new InMemoryAgentPersistenceRepository();
      const artifact1: SkepticArtifact = {
        id: 'skeptic-idempotency-1',
        parentDecisionId: 'parent-decision-1',
        candidateId: 'cand-1',
        runId: 'run-1',
        policyVersion: 'v1.0.0',
        triggered: true,
        triggerReasons: ['CANDIDATE_NEAR_ALERT'],
        profileId: 'skeptic-v1',
        status: 'EXECUTED',
        verdict: 'CHALLENGE',
        confidence: 'HIGH',
        challengeFindings: ['Finding 1'],
        counterThesis: 'Thesis 1',
        invalidationConditions: ['Condition 1'],
        decisionChanged: true,
        evidenceIds: ['ev-1'],
        executedToolRecords: [],
        createdAt: '2026-08-21T12:00:00.000Z',
      };

      await inMemory.saveSkepticArtifact(artifact1);
      const afterFirst = await inMemory.getSkepticArtifactsByParentDecision('parent-decision-1');
      expect(afterFirst.length).toBe(1);

      // Re-save with updated fields and same ID
      const artifact2: SkepticArtifact = {
        ...artifact1,
        verdict: 'VETO',
        counterThesis: 'Updated thesis',
      };
      await inMemory.saveSkepticArtifact(artifact2);
      const afterSecond = await inMemory.getSkepticArtifactsByParentDecision('parent-decision-1');
      expect(afterSecond.length).toBe(1);
      expect(afterSecond[0]?.verdict).toBe('VETO');
      expect(afterSecond[0]?.counterThesis).toBe('Updated thesis');
    });

    it('DatabaseAgentPersistenceRepository.saveSkepticArtifact upserts all mutable columns on conflict', async () => {
      let executedSql = '';
      const mockDatabase: DatabaseAdapter = {
        query: async <T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
        ) => {
          executedSql = sql;
          return { rows: [] as T[], rowCount: 1 };
        },
        transaction: async <T>(work: (db: DatabaseAdapter) => Promise<T>) => work(mockDatabase),
        ready: async () => true,
        close: async () => {},
      };

      const dbRepo = new DatabaseAgentPersistenceRepository(mockDatabase);
      const artifact: SkepticArtifact = {
        id: 'skeptic-db-upsert-1',
        parentDecisionId: 'parent-1',
        candidateId: 'cand-1',
        runId: 'run-1',
        policyVersion: 'v1.0.0',
        triggered: true,
        triggerReasons: ['CANDIDATE_NEAR_ALERT'],
        profileId: 'skeptic-v1',
        status: 'EXECUTED',
        verdict: 'CHALLENGE',
        confidence: 'HIGH',
        challengeFindings: ['Finding 1'],
        counterThesis: 'Thesis 1',
        invalidationConditions: ['Condition 1'],
        decisionChanged: true,
        evidenceIds: ['ev-1'],
        executedToolRecords: [],
        createdAt: '2026-08-21T12:00:00.000Z',
      };

      await dbRepo.saveSkepticArtifact(artifact);
      expect(executedSql).toContain('ON CONFLICT (id) DO UPDATE SET');
      expect(executedSql).toContain('trigger_reasons_json = EXCLUDED.trigger_reasons_json');
      expect(executedSql).toContain('evidence_ids_json = EXCLUDED.evidence_ids_json');
      expect(executedSql).toContain('executed_tool_records_json = EXCLUDED.executed_tool_records_json');
      expect(executedSql).toContain('budget_usage_json = EXCLUDED.budget_usage_json');
      expect(executedSql).toContain('decision_changed = EXCLUDED.decision_changed');
    });

    it('DatabaseAgentPersistenceRepository.getVoiPlan correctly computes totals for reconciled decision states', async () => {
      const storedRows: Array<Record<string, unknown>> = [
        {
          id: 'dec-1',
          candidate_id: 'cand-1',
          run_id: 'run-reconciled-1',
          evidence_family: 'core.token_overview',
          policy_version: 'v1.0.0',
          state: 'RETURNED',
          requested_fields_json: JSON.stringify(['symbol']),
          estimated_cost_json: JSON.stringify({ monetaryCostUsd: 0.005, quotaCostUnits: 1 }),
          actual_cost_json: JSON.stringify({ monetaryCostUsd: 0.004, quotaCostUnits: 1 }),
          randomized: false,
          decided_at: '2026-08-21T10:00:00.000Z',
          completed_at: '2026-08-21T10:00:01.000Z',
          evidence_ids_json: JSON.stringify(['ev-1']),
          reason_codes_json: JSON.stringify(['CORE_MANDATORY']),
          actual_decision_change: 'NONE',
        },
        {
          id: 'dec-2',
          candidate_id: 'cand-1',
          run_id: 'run-reconciled-1',
          evidence_family: 'holder.distribution',
          policy_version: 'v1.0.0',
          state: 'RETURNED_EMPTY',
          requested_fields_json: JSON.stringify(['top10Holders']),
          estimated_cost_json: JSON.stringify({ monetaryCostUsd: 0.010, quotaCostUnits: 2 }),
          actual_cost_json: JSON.stringify({ monetaryCostUsd: 0.008, quotaCostUnits: 2 }),
          randomized: false,
          decided_at: '2026-08-21T10:00:00.000Z',
          completed_at: '2026-08-21T10:00:01.000Z',
          evidence_ids_json: JSON.stringify([]),
          reason_codes_json: JSON.stringify(['HIGH_EVOI']),
          actual_decision_change: 'NONE',
        },
        {
          id: 'dec-3',
          candidate_id: 'cand-1',
          run_id: 'run-reconciled-1',
          evidence_family: 'social.sentiment',
          policy_version: 'v1.0.0',
          state: 'NOT_REQUESTED_BY_POLICY',
          requested_fields_json: JSON.stringify([]),
          estimated_cost_json: JSON.stringify({ monetaryCostUsd: 0.050, quotaCostUnits: 5 }),
          randomized: false,
          decided_at: '2026-08-21T10:00:00.000Z',
          evidence_ids_json: JSON.stringify([]),
          reason_codes_json: JSON.stringify(['EXCEEDS_BUDGET']),
          actual_decision_change: 'NONE',
        },
      ];

      const mockDatabase: DatabaseAdapter = {
        query: async <T extends Record<string, unknown> = Record<string, unknown>>() => {
          return { rows: storedRows as unknown as T[], rowCount: storedRows.length };
        },
        transaction: async <T>(work: (db: DatabaseAdapter) => Promise<T>) => work(mockDatabase),
        ready: async () => true,
        close: async () => {},
      };

      const dbRepo = new DatabaseAgentPersistenceRepository(mockDatabase);
      const plan = await dbRepo.getVoiPlan('run-reconciled-1');

      expect(plan).not.toBeNull();
      expect(plan?.requestedFamilies).toEqual(['core.token_overview', 'holder.distribution']);
      expect(plan?.skippedFamilies).toEqual(['social.sentiment']);
      expect(plan?.totalEstimatedMonetaryCostUsd).toBeCloseTo(0.015, 6);
      expect(plan?.totalEstimatedQuotaUnits).toBe(3);
    });

    it('BoundedAgentRuntime fails closed when skeptic throws unexpected error without failing parent run', async () => {
      const { BoundedAgentRuntime } = await import('@ciag/agent-runtime');
      const runtime = new BoundedAgentRuntime();

      runtime.registerTool('risk.honeypot_scan', async () => {
        throw new Error('Unexpected remote provider fatal socket error');
      });

      const inMemory = new InMemoryAgentPersistenceRepository();
      const result = await runtime.execute({
        candidate: sampleCandidate,
        profileId: 'deep-research-v1',
        envelope: sampleEnvelope,
        budget: sampleBudget,
        enableVoi: true,
        enableSkeptic: true,
        candidateScore: 0.85,
        persistenceRepository: inMemory,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.decision).toBeDefined();
      expect(result.skepticResult).toBeDefined();
      expect(['CHALLENGE', 'INSUFFICIENT_EVIDENCE']).toContain(result.skepticResult?.artifact.verdict);
      expect(result.skepticResult?.artifact.status).toBeDefined();
      expect(result.skepticResult?.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);

      const persistedArtifact = await inMemory.getSkepticArtifact(result.plan.planId);
      expect(persistedArtifact).not.toBeNull();
      expect(persistedArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('asserts NOT_REQUESTED_BY_POLICY never penalizes score compared to negative inferred missingness', () => {
      const planner = new VoiPlanner();

      const notRequestedScored = planner.scoreWithMissingnessAwareness({
        featureValues: { 'liquidity.lock': null },
        acquisitionDecisions: [
          {
            id: 'd-1',
            candidateId: 'c-1',
            runId: 'r-1',
            evidenceFamily: 'liquidity.lock',
            policyVersion: 'v1.0.0',
            state: 'NOT_REQUESTED_BY_POLICY',
            requestedFields: [],
            randomized: false,
            decidedAt: '2026-08-21T10:00:00.000Z',
            evidenceIds: [],
            reasonCodes: [],
          },
        ],
        featureWeights: { 'liquidity.lock': 1.0 },
        baselineCohortScores: { 'liquidity.lock': 0.70 },
      });

      const failedPenalizedScored = planner.scoreWithMissingnessAwareness({
        featureValues: { 'liquidity.lock': null },
        acquisitionDecisions: [
          {
            id: 'd-2',
            candidateId: 'c-1',
            runId: 'r-1',
            evidenceFamily: 'liquidity.lock',
            policyVersion: 'v1.0.0',
            state: 'FAILED',
            requestedFields: [],
            randomized: false,
            decidedAt: '2026-08-21T10:00:00.000Z',
            evidenceIds: [],
            reasonCodes: [],
          },
        ],
        featureWeights: { 'liquidity.lock': 1.0 },
        baselineCohortScores: { 'liquidity.lock': 0.70 },
      });

      expect(notRequestedScored.evaluatedFeatures['liquidity.lock']?.isNegativeInferred).toBe(false);
      expect(notRequestedScored.evaluatedFeatures['liquidity.lock']?.imputedValue).toBe(0.70);
      expect(failedPenalizedScored.evaluatedFeatures['liquidity.lock']?.isNegativeInferred).toBe(false);
      expect(failedPenalizedScored.evaluatedFeatures['liquidity.lock']?.imputedValue).toBe(0.50);
      expect(notRequestedScored.compositeScore).toBeGreaterThan(failedPenalizedScored.compositeScore);
    });
  });
});

