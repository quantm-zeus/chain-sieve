/**
 * @requirement FR-EVAL-019 - Backtest, cross-fit, forward shadow, live shadow, and active-production results are separate artifact classes; UI and exports cannot blend them into one performance curve.
 * @requirement AC-040 - Outcome profiles compute separate signal and tradable labels from actionable delivery time, canonical pool, configured notional/delay, modeled impact, all required fees, fill/liquidity constraints, exit policy and maturity state.
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Unit and regression tests for evaluation baseline, metrics, artifact class separation, and deterministic reports.
 */

import { describe, it, expect } from 'vitest';
import {
  // Types & Constants
  EVALUATION_ARTIFACT_CLASSES,
  DEFAULT_OUTCOME_PROFILE,
  DEFAULT_POLICY_METADATA,
  // Universe (AC-042)
  createFrozenCandidateUniverse,
  validateFrozenUniverse,
  assertIdenticalUniverses,
  // Outcomes (AC-040)
  evaluateOutcome,
  evaluateOutcomes,
  // Metrics & Reports (FR-EVAL-019)
  computeEvaluationMetrics,
  generateEvaluationReport,
  assertNoArtifactClassBlending,
  comparePolicies,
  // Corpus & Pipeline
  createDefaultEvaluationCorpus,
  executeEvaluationPipeline,
  // Errors & Compatibility
  EvaluationError,
  matureSyntheticOutcome,
  assertOutcomeLabelsDistinct,
} from '@ciag/evaluation';
import type {
  EvaluationArtifactClass,
  ForwardObservation,
  OutcomeProfile,
  OutcomeRecord,
} from '@ciag/evaluation';
import {
  computeFeatureSet,
  runFunnel,
  materializeSignal,
  DEFAULT_FUNNEL_PROFILE,
} from '@ciag/signal-intelligence';
import type { SignalRecord } from '@ciag/signal-intelligence';

describe('evaluation-baseline', () => {
  // -------------------------------------------------------------------------
  // 1. Versioned Fixture Corpus & Full Snapshot-to-Signal-to-Outcome Pipeline
  // -------------------------------------------------------------------------
  describe('versioned fixture corpus and pipeline execution', () => {
    it('executes full snapshot-to-signal-to-outcome pipeline reproducibly', () => {
      const corpus = createDefaultEvaluationCorpus();
      expect(corpus.corpusVersion).toBe('1.0.0');
      expect(corpus.assets.length).toBe(8);

      const result1 = executeEvaluationPipeline({ corpus, artifactClass: 'BACKTEST' });
      const result2 = executeEvaluationPipeline({ corpus, artifactClass: 'BACKTEST' });

      // 1. Universe
      expect(result1.candidateUniverse.totalAssets).toBe(8);
      expect(result1.candidateUniverse.sha256).toBe(result2.candidateUniverse.sha256);
      expect(result1.candidateUniverse.candidateAssetIds).toEqual(
        [...corpus.assets.map((a) => a.assetId)].sort(),
      );

      // 2. Funnel candidates: 7 eligible, 1 rejected (missing adapter)
      expect(result1.funnelOutput.eligibleCount).toBe(7);
      expect(result1.funnelOutput.rejectedCount).toBe(1);
      expect(result1.funnelOutput.sha256).toBe(result2.funnelOutput.sha256);

      // 3. Materialized signals: exactly 7 signals for the 7 eligible candidates (missing adapter asset excluded)
      expect(result1.signals.length).toBe(7);
      expect(result1.signals.map((s) => s.signalId)).toEqual(result2.signals.map((s) => s.signalId));
      expect(result1.signals.find((s) => s.assetId === 'solana:asset-8-missing-adapter')).toBeUndefined();

      // 4. Outcomes
      expect(result1.outcomes.length).toBe(7);
      expect(result1.outcomes.map((o) => o.outcomeId)).toEqual(result2.outcomes.map((o) => o.outcomeId));

      // 5. Deterministic report
      expect(result1.report.reportId).toBe(result2.report.reportId);
      expect(result1.report.sha256).toBe(result2.report.sha256);
      expect(result1.report.canonicalJson).toBe(result2.report.canonicalJson);
      expect(result1.report.bytes).toBe(result2.report.bytes);
      expect(result1.report.artifactClass).toBe('BACKTEST');

      // 6. Metrics stability
      expect(result1.report.metrics).toEqual(result2.report.metrics);
      expect(result1.report.metrics.totalCandidates).toBe(8);
      expect(result1.report.metrics.eligibleCandidates).toBe(7);
      expect(result1.report.metrics.rejectedCandidates).toBe(1);
      expect(result1.report.metrics.materializedSignals).toBe(7);
      expect(result1.report.metrics.evaluatedOutcomes).toBe(7);
    });

    it('produces frozen immutable structures across all evaluation stages', () => {
      const corpus = createDefaultEvaluationCorpus();
      const result = executeEvaluationPipeline({ corpus });

      expect(Object.isFrozen(result.candidateUniverse)).toBe(true);
      expect(Object.isFrozen(result.report)).toBe(true);
      for (const outcome of result.outcomes) {
        expect(Object.isFrozen(outcome)).toBe(true);
      }
      for (const signal of result.signals) {
        expect(Object.isFrozen(signal)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. FR-EVAL-019: Strict Artifact Class Separation
  // -------------------------------------------------------------------------
  describe('FR-EVAL-019: artifact class separation', () => {
    it('supports all normative artifact classes', () => {
      expect(EVALUATION_ARTIFACT_CLASSES).toEqual([
        'BACKTEST',
        'CROSS_FIT',
        'FORWARD_SHADOW',
        'LIVE_SHADOW',
        'ACTIVE_PRODUCTION',
      ]);
    });

    it('assertNoArtifactClassBlending passes for homogenous reports', () => {
      const corpus = createDefaultEvaluationCorpus();
      const r1 = executeEvaluationPipeline({ corpus, artifactClass: 'FORWARD_SHADOW' }).report;
      const r2 = executeEvaluationPipeline({ corpus, artifactClass: 'FORWARD_SHADOW' }).report;

      expect(() => assertNoArtifactClassBlending([r1, r2])).not.toThrow();
    });

    it('assertNoArtifactClassBlending fails closed when blending distinct classes', () => {
      const corpus = createDefaultEvaluationCorpus();
      const rBacktest = executeEvaluationPipeline({ corpus, artifactClass: 'BACKTEST' }).report;
      const rLive = executeEvaluationPipeline({ corpus, artifactClass: 'LIVE_SHADOW' }).report;

      expect(() => assertNoArtifactClassBlending([rBacktest, rLive])).toThrowError(
        /FR-EVAL-019 violation: Attempted to blend distinct artifact classes/,
      );

      try {
        assertNoArtifactClassBlending([rBacktest, rLive]);
      } catch (err) {
        expect(err).toBeInstanceOf(EvaluationError);
        expect((err as EvaluationError).code).toBe('EVAL_CLASS_BLENDED');
      }
    });

    it('generateEvaluationReport rejects invalid or missing artifactClass', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { candidateUniverse, outcomes } = executeEvaluationPipeline({ corpus });

      expect(() =>
        generateEvaluationReport({
          artifactClass: 'INVALID_CLASS' as EvaluationArtifactClass,
          candidateUniverse,
          profile: DEFAULT_OUTCOME_PROFILE,
          policy: DEFAULT_POLICY_METADATA,
          outcomes,
        }),
      ).toThrowError(/Invalid artifactClass/);
    });

    it('comparePolicies rejects comparing baseline and champion across different artifact classes', () => {
      const corpus = createDefaultEvaluationCorpus();
      const rBacktest = executeEvaluationPipeline({ corpus, artifactClass: 'BACKTEST' }).report;
      const rForward = executeEvaluationPipeline({ corpus, artifactClass: 'FORWARD_SHADOW' }).report;

      expect(() =>
        comparePolicies({
          baselineReport: rBacktest,
          championReport: rForward,
        }),
      ).toThrowError(/FR-EVAL-019 violation/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. AC-040: Separate Signal vs Tradable Labels & Universal Timing
  // -------------------------------------------------------------------------
  describe('AC-040: separate signal and tradable labels', () => {
    it('differentiates UNTRADABLE_SIGNAL_WIN from TRADABLE_SUCCESS and preserves TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { outcomes } = executeEvaluationPipeline({ corpus });

      // Asset 1: Tradable Gem -> SIGNAL_WIN & TRADABLE_SUCCESS
      const gem1 = outcomes.find((o) => o.assetId === 'solana:asset-1-gem-tradable')!;
      expect(gem1).toBeDefined();
      expect(gem1.signalSuccess).toBe(true);
      expect(gem1.tradableSuccess).toBe(true);
      expect(gem1.signalOutcome).toBe('SIGNAL_WIN');
      expect(gem1.tradableOutcome).toBe('TRADABLE_SUCCESS');
      expect(gem1.liquiditySurvives).toBe(true);
      expect(gem1.securitySurvives).toBe(true);
      expect(gem1.netReturn).toBeGreaterThan(0.5);

      // Asset 2: Untradable Gem (Liquidity collapsed) -> SIGNAL_WIN & TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY
      const gem2 = outcomes.find((o) => o.assetId === 'solana:asset-2-gem-untradable')!;
      expect(gem2).toBeDefined();
      expect(gem2.signalSuccess).toBe(true); // Signal target hit
      expect(gem2.tradableSuccess).toBe(false); // Liquidity collapsed
      expect(gem2.signalOutcome).toBe('SIGNAL_WIN');
      expect(gem2.tradableOutcome).toBe('TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY');
      expect(gem2.liquiditySurvives).toBe(false);
      expect(gem2.failureReason).toBe('LIQUIDITY_DROPPED_BELOW_MINIMUM');
    });

    it('resolves UNTRADABLE_SIGNAL_WIN when signal target is hit but tradable execution fails with surviving liquidity/security', () => {
      const corpus = createDefaultEvaluationCorpus();
      const asset = corpus.assets[0]!;
      const fs = computeFeatureSet(asset.historySnapshots, asset.currentSnapshot, [10, 5, 2, 1], corpus.dataCutoff);
      const funnelOut = runFunnel([{
        assetId: asset.assetId,
        chainId: asset.chainId,
        asOf: corpus.dataCutoff,
        featureSet: fs,
        adapterEvidence: asset.adapterEvidence,
      }], DEFAULT_FUNNEL_PROFILE);
      const signal = materializeSignal({
        candidate: funnelOut.candidates[0]!,
        featureSet: fs,
        snapshot: asset.currentSnapshot,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
      });

      // Pure signal target reaches 2.0x raw price, but tradable target is 3.0x and expires at horizon with fee drag
      const frictionProfile: OutcomeProfile = {
        ...DEFAULT_OUTCOME_PROFILE,
        signalTargetMultiplier: 2.0,
        exitPolicy: {
          ...DEFAULT_OUTCOME_PROFILE.exitPolicy,
          targetMultiplier: 3.0,
          maxHorizonMs: 86400_000,
        },
        executionScenario: {
          ...DEFAULT_OUTCOME_PROFILE.executionScenario,
          notionalUsd: 100,
          networkFeeUsd: 150, // $150 fee on $100 notional
        },
      };

      const obs: ForwardObservation[] = [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.0, poolLiquidityUsd: 500000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T04:00:00.000Z', priceUsd: 2.5, poolLiquidityUsd: 500000, securityStatus: 'SAFE' }, // Reaches 2.0x signal target, but not 3.0x tradable target
        { timestamp: '2026-03-02T02:01:00.000Z', priceUsd: 2.5, poolLiquidityUsd: 500000, securityStatus: 'SAFE' }, // Horizon expiration with net loss after fees
      ];

      const outcome = evaluateOutcome({
        signal,
        profile: frictionProfile,
        observations: obs,
      });

      expect(outcome.signalSuccess).toBe(true);
      expect(outcome.tradableSuccess).toBe(false);
      expect(outcome.signalOutcome).toBe('SIGNAL_WIN');
      expect(outcome.tradableOutcome).toBe('UNTRADABLE_SIGNAL_WIN');
      expect(outcome.securitySurvives).toBe(true);
      expect(outcome.liquiditySurvives).toBe(true);
    });

    it('enforces terminal security failures: TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { outcomes } = executeEvaluationPipeline({ corpus });

      const rug = outcomes.find((o) => o.assetId === 'solana:asset-3-rugpull')!;
      expect(rug).toBeDefined();
      expect(rug.signalSuccess).toBe(false);
      expect(rug.tradableSuccess).toBe(false);
      expect(rug.signalOutcome).toBe('SIGNAL_LOSS');
      expect(rug.tradableOutcome).toBe('TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY');
      expect(rug.securitySurvives).toBe(false);
      expect(rug.failureReason).toContain('SECURITY_TERMINAL_EVENT');
    });

    it('enforces stop loss triggers: TRADABLE_FAILURE', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { outcomes } = executeEvaluationPipeline({ corpus });

      const stop = outcomes.find((o) => o.assetId === 'solana:asset-4-stoploss')!;
      expect(stop).toBeDefined();
      expect(stop.signalSuccess).toBe(false);
      expect(stop.tradableSuccess).toBe(false);
      expect(stop.signalOutcome).toBe('SIGNAL_LOSS');
      expect(stop.tradableOutcome).toBe('TRADABLE_FAILURE');
      expect(stop.failureReason).toBe('STOP_LOSS_TRIGGERED');
    });

    it('enforces universal action delay: observations before T_action_reference are ignored for entry', () => {
      const corpus = createDefaultEvaluationCorpus();
      const asset = corpus.assets[0]!;
      const fs = computeFeatureSet(asset.historySnapshots, asset.currentSnapshot, [10, 5, 2, 1], corpus.dataCutoff);
      const funnelOut = runFunnel([{
        assetId: asset.assetId,
        chainId: asset.chainId,
        asOf: corpus.dataCutoff,
        featureSet: fs,
        adapterEvidence: asset.adapterEvidence,
      }], DEFAULT_FUNNEL_PROFILE);
      const signal = materializeSignal({
        candidate: funnelOut.candidates[0]!,
        featureSet: fs,
        snapshot: asset.currentSnapshot,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
      });

      // Signal delivered at T0 (2026-03-01T02:00:00Z) with actionDelayMs = 60_000 (1 minute)
      // T_action_reference = 2026-03-01T02:01:00Z
      const customProfile: OutcomeProfile = {
        ...DEFAULT_OUTCOME_PROFILE,
        executionScenario: {
          ...DEFAULT_OUTCOME_PROFILE.executionScenario,
          actionDelayMs: 60_000, // 60s
        },
      };

      const obs: ForwardObservation[] = [
        // Before action reference (should not be entry)
        { timestamp: '2026-03-01T02:00:30.000Z', priceUsd: 1.25, poolLiquidityUsd: 100000, securityStatus: 'SAFE' },
        // At action reference (should be entry)
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.50, poolLiquidityUsd: 100000, securityStatus: 'SAFE' },
        // Target reached
        { timestamp: '2026-03-01T04:00:00.000Z', priceUsd: 3.50, poolLiquidityUsd: 100000, securityStatus: 'SAFE' },
      ];

      const outcome = evaluateOutcome({
        signal,
        profile: customProfile,
        observations: obs,
      });

      expect(outcome.timing.tActionReference).toBe('2026-03-01T02:01:00.000Z');
      expect(outcome.timing.actionablePriceTime).toBe('2026-03-01T02:01:00.000Z');
      // Entry price should be derived from 1.50 (at action reference), NOT 1.25 (before action reference)
      expect(outcome.entryPrice).toBeGreaterThanOrEqual(1.50);
    });

    it('deducts network, priority, pool, and token transfer fees from net return', () => {
      const corpus = createDefaultEvaluationCorpus();
      const asset = corpus.assets[0]!;
      const fs = computeFeatureSet(asset.historySnapshots, asset.currentSnapshot, [10, 5, 2, 1], corpus.dataCutoff);
      const funnelOut = runFunnel([{
        assetId: asset.assetId,
        chainId: asset.chainId,
        asOf: corpus.dataCutoff,
        featureSet: fs,
        adapterEvidence: asset.adapterEvidence,
      }], DEFAULT_FUNNEL_PROFILE);
      const signal = materializeSignal({
        candidate: funnelOut.candidates[0]!,
        featureSet: fs,
        snapshot: asset.currentSnapshot,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
      });

      const highFeeProfile: OutcomeProfile = {
        ...DEFAULT_OUTCOME_PROFILE,
        executionScenario: {
          ...DEFAULT_OUTCOME_PROFILE.executionScenario,
          notionalUsd: 100,
          networkFeeUsd: 5.0, // $5 network fee
          priorityFeeUsd: 5.0, // $5 priority fee
          poolFeeBps: 100, // 1%
          tokenTransferFeeBps: 200, // 2%
        },
      };

      const obs: ForwardObservation[] = [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.0, poolLiquidityUsd: 500000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T04:00:00.000Z', priceUsd: 2.2, poolLiquidityUsd: 500000, securityStatus: 'SAFE' },
      ];

      const outcome = evaluateOutcome({
        signal,
        profile: highFeeProfile,
        observations: obs,
      });

      // Total fees: (5 + 5 + 100 * 3%) * 2 = (10 + 3) * 2 = 26 USD on 100 USD notional = 26% fee drag
      expect(outcome.totalFeesUsd).toBeGreaterThanOrEqual(20);
      expect(outcome.netReturn).toBeLessThan(outcome.rawReturn!);
    });

    it('correctly reports PENDING when observations have not matured', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { outcomes } = executeEvaluationPipeline({
        corpus,
        evaluationTime: '2026-03-01T02:15:00.000Z',
      });

      const pending = outcomes.find((o) => o.assetId === 'solana:asset-6-pending')!;
      expect(pending).toBeDefined();
      expect(pending.state).toBe('PARTIALLY_MATURED');
      expect(pending.tradableOutcome).toBe('PENDING');
      expect(pending.signalOutcome).toBe('SIGNAL_NEUTRAL');
    });

    it('correctly reports CENSORED when data cutoff passes horizon with no actionable observations', () => {
      const corpus = createDefaultEvaluationCorpus();
      const asset = corpus.assets[0]!;
      const fs = computeFeatureSet(asset.historySnapshots, asset.currentSnapshot, [10, 5, 2, 1], corpus.dataCutoff);
      const funnelOut = runFunnel([{
        assetId: asset.assetId,
        chainId: asset.chainId,
        asOf: corpus.dataCutoff,
        featureSet: fs,
        adapterEvidence: asset.adapterEvidence,
      }], DEFAULT_FUNNEL_PROFILE);
      const signal = materializeSignal({
        candidate: funnelOut.candidates[0]!,
        featureSet: fs,
        snapshot: asset.currentSnapshot,
        funnelProfile: DEFAULT_FUNNEL_PROFILE,
      });

      const outcome = evaluateOutcome({
        signal,
        profile: DEFAULT_OUTCOME_PROFILE,
        observations: [], // No forward observations
        evaluationTime: '2026-03-05T00:00:00.000Z', // Far after horizon
      });

      expect(outcome.state).toBe('CENSORED');
      expect(outcome.tradableOutcome).toBe('CENSORED');
      expect(outcome.signalOutcome).toBe('SIGNAL_CENSORED');
      expect(outcome.failureReason).toBe('NO_ACTIONABLE_OBSERVATIONS_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // 4. AC-042: Candidate Universe Consistency & Policy Comparison
  // -------------------------------------------------------------------------
  describe('AC-042: frozen candidate universe & policy comparison', () => {
    it('creates deterministic, deduplicated, lexicographically sorted universe', () => {
      const u1 = createFrozenCandidateUniverse({
        universeId: 'univ-test-1',
        dataCutoff: '2026-03-01T00:00:00.000Z',
        candidateAssetIds: ['solana:token-z', 'solana:token-a', 'solana:token-m', 'solana:token-a'],
      });

      expect(u1.candidateAssetIds).toEqual(['solana:token-a', 'solana:token-m', 'solana:token-z']);
      expect(u1.totalAssets).toBe(3);
      expect(u1.sha256).toMatch(/^[a-f0-9]{64}$/);

      const u2 = createFrozenCandidateUniverse({
        universeId: 'univ-test-1',
        dataCutoff: '2026-03-01T00:00:00.000Z',
        candidateAssetIds: ['solana:token-m', 'solana:token-z', 'solana:token-a'],
      });

      expect(u1.sha256).toBe(u2.sha256);
      expect(() => validateFrozenUniverse(u1)).not.toThrow();
    });

    it('assertIdenticalUniverses fails closed on universe hash or cutoff mismatch', () => {
      const u1 = createFrozenCandidateUniverse({
        universeId: 'univ-1',
        dataCutoff: '2026-03-01T00:00:00.000Z',
        candidateAssetIds: ['solana:token-a', 'solana:token-b'],
      });

      const uDiffCutoff = createFrozenCandidateUniverse({
        universeId: 'univ-1',
        dataCutoff: '2026-03-02T00:00:00.000Z', // Different cutoff
        candidateAssetIds: ['solana:token-a', 'solana:token-b'],
      });

      const uDiffAssets = createFrozenCandidateUniverse({
        universeId: 'univ-1',
        dataCutoff: '2026-03-01T00:00:00.000Z',
        candidateAssetIds: ['solana:token-a', 'solana:token-c'], // Different assets
      });

      expect(() => assertIdenticalUniverses(u1, uDiffCutoff)).toThrowError(
        /Data cutoff mismatch between policies/,
      );

      expect(() => assertIdenticalUniverses(u1, uDiffAssets)).toThrowError(
        /Candidate universe hash mismatch between policies/,
      );
    });

    it('comparePolicies evaluates baseline vs champion over identical universe', () => {
      const corpus = createDefaultEvaluationCorpus();

      // Baseline policy: minScore = 0.0 (selects all eligible)
      const baselineReport = executeEvaluationPipeline({
        corpus,
        policyMetadata: { policyId: 'policy-baseline', policyVersion: '1.0.0' },
      }).report;

      // Champion policy: higher threshold, improved filtering
      const championReport = executeEvaluationPipeline({
        corpus,
        funnelProfile: {
          ...DEFAULT_FUNNEL_PROFILE,
          minScore: 0.5, // Filter out weak candidates
        },
        policyMetadata: { policyId: 'policy-champion', policyVersion: '2.0.0' },
      }).report;

      const comparison = comparePolicies({
        baselineReport,
        championReport,
      });

      expect(comparison.baselineReportId).toBe(baselineReport.reportId);
      expect(comparison.championReportId).toBe(championReport.reportId);
      expect(comparison.universeHash).toBe(baselineReport.candidateUniverse.sha256);
      expect(comparison.dataCutoff).toBe(baselineReport.candidateUniverse.dataCutoff);
      expect(typeof comparison.precisionLift).toBe('number');
      expect(typeof comparison.utilityLift).toBe('number');
      expect(typeof comparison.lcb95Lift).toBe('number');
      expect(comparison.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Metrics & Opportunity Diagnostics (PRD Section 7 & 38.42)
  // -------------------------------------------------------------------------
  describe('comprehensive metrics computation', () => {
    it('computes financial, ranking, and utility metrics correctly', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { report } = executeEvaluationPipeline({ corpus });
      const m = report.metrics;

      // Counts
      expect(m.totalCandidates).toBe(8);
      expect(m.eligibleCandidates).toBe(7);
      expect(m.materializedSignals).toBe(7);
      expect(m.evaluatedOutcomes).toBe(7);

      // Signal vs Tradable counts
      expect(m.signalSuccessCount).toBeGreaterThan(0);
      expect(m.tradableSuccessCount).toBeGreaterThan(0);
      expect(m.securityOrLiquidityFailureCount).toBeGreaterThanOrEqual(2); // Asset 2 & 3

      // Precision & Recall
      expect(m.signalPrecision).toBeGreaterThanOrEqual(0);
      expect(m.tradablePrecision).toBeGreaterThanOrEqual(0);
      expect(m.falseDiscoveryRate).toBeGreaterThanOrEqual(0);

      // Ranking diagnostics
      expect(m.precisionAt1).toBeGreaterThanOrEqual(0);
      expect(m.ndcgAt5).toBeGreaterThanOrEqual(0);
      expect(m.meanReciprocalRank).toBeGreaterThanOrEqual(0);

      // Financial & Net Portfolio Utility
      expect(typeof m.averageNetReturn).toBe('number');
      expect(typeof m.profitFactor).toBe('number');
      expect(typeof m.maxDrawdown).toBe('number');
      expect(typeof m.cvar95).toBe('number');
      expect(typeof m.netShadowPortfolioUtility).toBe('number');
      expect(typeof m.lcb95Utility).toBe('number');
    });

    it('computes ranking diagnostics (Precision@K, NDCG@K, MRR) ordered by descending signal score per PRD 7.5', () => {
      const outcomes = [
        {
          outcomeId: 'out_c_lowest_score',
          state: 'FULLY_MATURED' as const,
          score: 0.1,
          tradableSuccess: false,
          signalSuccess: false,
          signalOutcome: 'SIGNAL_LOSS' as const,
          tradableOutcome: 'TRADABLE_FAILURE' as const,
          netReturn: -0.5,
        },
        {
          outcomeId: 'out_a_highest_score',
          state: 'FULLY_MATURED' as const,
          score: 0.9,
          tradableSuccess: true,
          signalSuccess: true,
          signalOutcome: 'SIGNAL_WIN' as const,
          tradableOutcome: 'TRADABLE_SUCCESS' as const,
          netReturn: 0.5,
        },
        {
          outcomeId: 'out_b_mid_score',
          state: 'FULLY_MATURED' as const,
          score: 0.5,
          tradableSuccess: false,
          signalSuccess: false,
          signalOutcome: 'SIGNAL_LOSS' as const,
          tradableOutcome: 'TRADABLE_FAILURE' as const,
          netReturn: -0.2,
        },
      ];

      const metrics = computeEvaluationMetrics(outcomes as unknown as OutcomeRecord[]);
      // Top 1 by score is Signal A (score 0.9, tradableSuccess = true) -> Precision@1 should be 1.0
      expect(metrics.precisionAt1).toBe(1.0);
      // Top 3 has 1 win out of 3 -> Precision@3 = 1/3 = 0.333333
      expect(metrics.precisionAt3).toBe(0.333333);
      // MRR: First win is at rank 1 -> MRR = 1.0
      expect(metrics.meanReciprocalRank).toBe(1.0);
      expect(metrics.ndcgAt5).toBeGreaterThan(0);
    });

    it('validateProfile rejects negative or non-finite scenario and policy parameters', () => {
      const baseProfile = DEFAULT_OUTCOME_PROFILE;
      const dummySignal = {
        signalId: 'sig_dummy',
        assetId: 'solana:dummy',
        chainId: 'solana-mainnet',
        asOf: '2026-03-01T00:00:00.000Z',
      } as unknown as SignalRecord;

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            executionScenario: {
              ...baseProfile.executionScenario,
              minLiquidityUsd: -100,
            },
          },
          observations: [],
        }),
      ).toThrowError(/MIN_LIQUIDITY_USD_INVALID/);

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            executionScenario: {
              ...baseProfile.executionScenario,
              maxImpactBps: NaN,
            },
          },
          observations: [],
        }),
      ).toThrowError(/MAX_IMPACT_BPS_INVALID/);

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            executionScenario: {
              ...baseProfile.executionScenario,
              poolFeeBps: -10,
            },
          },
          observations: [],
        }),
      ).toThrowError(/POOL_FEE_BPS_INVALID/);

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            signalTargetMultiplier: 0.9, // <= 1.0 invalid
          },
          observations: [],
        }),
      ).toThrowError(/SIGNAL_TARGET_MULTIPLIER_INVALID/);

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            signalStopMultiplier: 1.5, // >= 1.0 invalid
          },
          observations: [],
        }),
      ).toThrowError(/SIGNAL_STOP_MULTIPLIER_INVALID/);

      expect(() =>
        evaluateOutcome({
          signal: dummySignal,
          profile: {
            ...baseProfile,
            horizonMs: 0, // <= 0 invalid
          },
          observations: [],
        }),
      ).toThrowError(/HORIZON_MS_INVALID/);
    });

    it('enforces universal timing invariant tDelivery >= tDeliveryEligible when materializedAt precedes asOf', () => {
      const dummySignal = {
        signalId: 'sig_timing_test',
        assetId: 'solana:timing_asset',
        chainId: 'solana-mainnet',
        asOf: '2026-03-01T12:00:00.000Z',
        materializedAt: '2026-03-01T11:00:00.000Z', // Stale / prior timestamp
      } as unknown as SignalRecord;

      const outcome = evaluateOutcome({
        signal: dummySignal,
        profile: DEFAULT_OUTCOME_PROFILE,
        observations: [],
      });

      expect(Date.parse(outcome.timing.tDelivery)).toBeGreaterThanOrEqual(
        Date.parse(outcome.timing.tDeliveryEligible),
      );
      expect(Date.parse(outcome.timing.tActionReference)).toBe(
        Date.parse(outcome.timing.tDelivery) + DEFAULT_OUTCOME_PROFILE.executionScenario.actionDelayMs,
      );
    });

    it('filters out immature (PENDING / CENSORED / PARTIALLY_MATURED) outcomes from ranking diagnostics', () => {
      const outcomes = [
        {
          outcomeId: 'out_mature_win',
          state: 'FULLY_MATURED' as const,
          score: 0.95,
          tradableSuccess: true,
          signalSuccess: true,
          signalOutcome: 'SIGNAL_WIN' as const,
          tradableOutcome: 'TRADABLE_SUCCESS' as const,
          netReturn: 0.4,
        },
        {
          outcomeId: 'out_pending_immature',
          state: 'PENDING' as const,
          score: 0.99, // higher score but not fully matured
          tradableSuccess: false,
          signalSuccess: false,
          signalOutcome: 'SIGNAL_PENDING' as const,
          tradableOutcome: 'PENDING' as const,
          netReturn: null,
        },
        {
          outcomeId: 'out_censored_immature',
          state: 'CENSORED' as const,
          score: 0.85,
          tradableSuccess: false,
          signalSuccess: false,
          signalOutcome: 'SIGNAL_CENSORED' as const,
          tradableOutcome: 'CENSORED' as const,
          netReturn: null,
        },
      ];

      const metrics = computeEvaluationMetrics(outcomes as unknown as OutcomeRecord[]);
      // Only out_mature_win should be ranked -> Precision@1 is 1.0 (not depressed by pending/censored)
      expect(metrics.precisionAt1).toBe(1.0);
      expect(metrics.meanReciprocalRank).toBe(1.0);
    });

    it('computeEvaluationMetrics handles empty or custom outcome arrays deterministically', () => {
      const emptyMetrics = computeEvaluationMetrics([]);
      expect(emptyMetrics.evaluatedOutcomes).toBe(0);
      expect(emptyMetrics.signalPrecision).toBe(0);
      expect(emptyMetrics.tradablePrecision).toBe(0);
      expect(emptyMetrics.profitFactor).toBe(0);
      expect(emptyMetrics.netShadowPortfolioUtility).toBe(0);
      expect(emptyMetrics.precisionAt1).toBe(0);
      expect(emptyMetrics.precisionAt3).toBe(0);
      expect(emptyMetrics.precisionAt5).toBe(0);
      expect(emptyMetrics.meanReciprocalRank).toBe(0);
      expect(emptyMetrics.ndcgAt5).toBe(0);
    });

    it('evaluates deterministic PENDING vs CENSORED fallback when no actionable observation is present', () => {
      const dummySignal = {
        signalId: 'sig_no_obs',
        assetId: 'solana:no_obs',
        chainId: 'solana-mainnet',
        asOf: '2026-03-01T00:00:00.000Z',
      } as unknown as SignalRecord;

      // When observations are empty and evaluationTime omitted, defaults deterministically to asOf (PENDING)
      const outcomePending = evaluateOutcome({
        signal: dummySignal,
        profile: DEFAULT_OUTCOME_PROFILE,
        observations: [],
      });
      expect(outcomePending.state).toBe('PENDING');

      // When observation cutoff is beyond horizon + action delay, returns CENSORED deterministically
      const outcomeCensored = evaluateOutcome({
        signal: dummySignal,
        profile: DEFAULT_OUTCOME_PROFILE,
        evaluationTime: '2026-03-05T00:00:00.000Z',
        observations: [
          {
            timestamp: '2026-03-01T00:00:01.000Z', // Before tActionReference (2026-03-01T00:00:05.000Z)
            priceUsd: 1.0,
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
        ],
      });
      expect(outcomeCensored.state).toBe('CENSORED');
      expect(outcomeCensored.failureReason).toBe('NO_ACTIONABLE_OBSERVATIONS_FOUND');
    });

    it('uses last within-horizon observation for horizon expiration and ignores observations beyond maxHorizonMs', () => {
      const dummySignal = {
        signalId: 'sig_horizon_boundary',
        assetId: 'solana:boundary_asset',
        chainId: 'solana-mainnet',
        asOf: '2026-03-01T00:00:00.000Z',
        materializedAt: '2026-03-01T00:00:00.000Z',
      } as unknown as SignalRecord;

      const actionTimeMs = Date.parse(dummySignal.asOf) + DEFAULT_OUTCOME_PROFILE.executionScenario.actionDelayMs;
      const horizonEndMs = actionTimeMs + DEFAULT_OUTCOME_PROFILE.exitPolicy.maxHorizonMs;

      const outcome = evaluateOutcome({
        signal: dummySignal,
        profile: DEFAULT_OUTCOME_PROFILE,
        observations: [
          {
            timestamp: new Date(actionTimeMs).toISOString(),
            priceUsd: 1.0,
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
          {
            timestamp: new Date(horizonEndMs - 1000).toISOString(),
            priceUsd: 1.10, // within horizon price
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
          {
            timestamp: new Date(horizonEndMs + 60_000).toISOString(),
            priceUsd: 5.00, // out of horizon price (should NOT be used for exit)
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
        ],
      });

      expect(outcome.state).toBe('FULLY_MATURED');
      expect(Date.parse(outcome.exitTime!)).toBeLessThanOrEqual(horizonEndMs);
      expect(outcome.exitPrice).toBeCloseTo(1.099945, 4);
      expect(outcome.exitPrice).toBeLessThan(2.0);
    });

    it('does not promote immature signal winner to UNTRADABLE_SIGNAL_WIN before full maturity', () => {
      const dummySignal = {
        signalId: 'sig_immature_winner',
        assetId: 'solana:immature_winner',
        chainId: 'solana-mainnet',
        asOf: '2026-03-01T00:00:00.000Z',
        materializedAt: '2026-03-01T00:00:00.000Z',
      } as unknown as SignalRecord;

      const actionTimeMs = Date.parse(dummySignal.asOf) + DEFAULT_OUTCOME_PROFILE.executionScenario.actionDelayMs;

      const outcome = evaluateOutcome({
        signal: dummySignal,
        profile: DEFAULT_OUTCOME_PROFILE,
        observations: [
          {
            timestamp: new Date(actionTimeMs).toISOString(),
            priceUsd: 1.0,
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
          {
            timestamp: new Date(actionTimeMs + 60_000).toISOString(), // Well before horizon
            priceUsd: 2.50, // Hits pure signal target (2.0x) but tradable target (2.0x on executable) not matured yet
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
        ],
      });

      // Pure signal target was hit early -> signalSuccess = true
      expect(outcome.signalSuccess).toBe(true);
      expect(outcome.signalOutcome).toBe('SIGNAL_WIN');

      // But since horizon has not been reached and early exit didn't finish, state is PARTIALLY_MATURED, NOT UNTRADABLE_SIGNAL_WIN
      // Note: If 2.50 also hit tradable target (2.0x), it would be TRADABLE_SUCCESS and FULLY_MATURED.
      // Let's test when tradable target is higher (e.g. 3.0x target) so tradable has not exited yet:
      const outcomeImmature = evaluateOutcome({
        signal: dummySignal,
        profile: {
          ...DEFAULT_OUTCOME_PROFILE,
          exitPolicy: {
            ...DEFAULT_OUTCOME_PROFILE.exitPolicy,
            targetMultiplier: 3.0, // higher than 2.5x
          },
        },
        observations: [
          {
            timestamp: new Date(actionTimeMs).toISOString(),
            priceUsd: 1.0,
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
          {
            timestamp: new Date(actionTimeMs + 60_000).toISOString(),
            priceUsd: 2.50, // Hits signalTarget (2.0x) but NOT tradable target (3.0x)
            poolLiquidityUsd: 100_000,
            volumeUsd: 50_000,
            securityStatus: 'SAFE',
          },
        ],
      });

      expect(outcomeImmature.state).toBe('PARTIALLY_MATURED');
      expect(outcomeImmature.signalSuccess).toBe(true);
      expect(outcomeImmature.tradableOutcome).toBe('PENDING'); // Gated from UNTRADABLE_SIGNAL_WIN
    });

    it('evaluateOutcomes evaluates batch of signals with deterministic sorting by outcomeId', () => {
      const corpus = createDefaultEvaluationCorpus();
      const { signals } = executeEvaluationPipeline({ corpus });
      const obsMap: Record<string, ForwardObservation[]> = {};
      for (const a of corpus.assets) {
        obsMap[a.assetId] = a.forwardObservations;
      }

      const batchOutcomes = evaluateOutcomes(signals, DEFAULT_OUTCOME_PROFILE, obsMap);
      expect(batchOutcomes.length).toBe(signals.length);
      for (let i = 0; i < batchOutcomes.length - 1; i++) {
        expect(batchOutcomes[i]!.outcomeId.localeCompare(batchOutcomes[i + 1]!.outcomeId)).toBeLessThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Regression Detection for Candidate Selection, Materialization, Outcomes
  // -------------------------------------------------------------------------
  describe('regression detection', () => {
    it('detects changes in candidate selection criteria', () => {
      const corpus = createDefaultEvaluationCorpus();

      const baseResult = executeEvaluationPipeline({ corpus });

      // Change funnel required features
      const changedFunnelResult = executeEvaluationPipeline({
        corpus,
        funnelProfile: {
          ...DEFAULT_FUNNEL_PROFILE,
          minScore: 10.0, // High threshold rejecting all
        },
      });

      expect(changedFunnelResult.funnelOutput.eligibleCount).not.toBe(baseResult.funnelOutput.eligibleCount);
      expect(changedFunnelResult.report.sha256).not.toBe(baseResult.report.sha256);
    });

    it('detects changes in outcome profile parameters', () => {
      const corpus = createDefaultEvaluationCorpus();

      const baseResult = executeEvaluationPipeline({ corpus });

      // Change target multiplier from 2.0x to 5.0x
      const changedOutcomeResult = executeEvaluationPipeline({
        corpus,
        outcomeProfile: {
          ...DEFAULT_OUTCOME_PROFILE,
          signalTargetMultiplier: 5.0,
          exitPolicy: {
            ...DEFAULT_OUTCOME_PROFILE.exitPolicy,
            targetMultiplier: 5.0,
          },
        },
      });

      expect(changedOutcomeResult.report.metrics.tradableSuccessCount).not.toBe(
        baseResult.report.metrics.tradableSuccessCount,
      );
      expect(changedOutcomeResult.report.sha256).not.toBe(baseResult.report.sha256);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Backward Compatibility & Error Handling
  // -------------------------------------------------------------------------
  describe('backward compatibility and typed errors', () => {
    it('maintains matureSyntheticOutcome behavior', () => {
      const pending = matureSyntheticOutcome('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 5000);
      expect(pending.state).toBe('PENDING');

      const mature = matureSyntheticOutcome('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z', 5000);
      expect(mature.state).toBe('MATURE');
      expect(mature.signalSuccess).toBe(true);
      expect(mature.tradableSuccess).toBe(false);
    });

    it('maintains assertOutcomeLabelsDistinct validation', () => {
      expect(() => assertOutcomeLabelsDistinct(true, false)).not.toThrow();
      expect(() => assertOutcomeLabelsDistinct(undefined, true)).toThrowError(/OUTCOME_LABEL_REQUIRED/);
      expect(() => assertOutcomeLabelsDistinct(false, undefined)).toThrowError(/OUTCOME_LABEL_REQUIRED/);
    });
  });
});
