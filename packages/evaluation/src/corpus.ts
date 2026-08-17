/**
 * @requirement FR-EVAL-019 - Backtest, cross-fit, forward shadow, live shadow, and active-production results are separate artifact classes.
 * @requirement AC-040 - Outcome profiles compute separate signal and tradable labels from actionable delivery time, canonical pool, configured notional/delay, modeled impact, all required fees, fill/liquidity constraints, exit policy and maturity state.
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Versioned fixture corpus and reproducible snapshot-to-signal-to-outcome evaluation pipeline runner.
 */

import type {
  MarketSnapshot,
  FeatureSet,
  FunnelAdapterEvidence,
  FunnelInput,
  FunnelOutput,
  FunnelProfile,
  SignalRecord,
} from '@ciag/signal-intelligence';
import {
  computeFeatureSet,
  runFunnel,
  materializeSignals,
  DEFAULT_FUNNEL_PROFILE,
} from '@ciag/signal-intelligence';
import type {
  EvaluationArtifactClass,
  EvaluationReport,
  ForwardObservation,
  FrozenCandidateUniverse,
  OutcomeProfile,
  OutcomeRecord,
  PolicyMetadata,
} from './types.js';
import { createFrozenCandidateUniverse } from './universe.js';
import { evaluateOutcomes } from './outcomes.js';
import { generateEvaluationReport } from './report.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_OUTCOME_PROFILE: OutcomeProfile = {
  profileId: 'HG-EM-1',
  version: '1.0.0',
  signalTargetMultiplier: 2.0,
  signalStopMultiplier: 0.5,
  horizonMs: 86_400_000,
  executionScenario: {
    scenarioId: 'conservative-dex',
    notionalUsd: 1000,
    actionDelayMs: 30_000, // 30s delay
    slippageBps: 50,
    networkFeeUsd: 0.05,
    priorityFeeUsd: 0.05,
    poolFeeBps: 30,
    tokenTransferFeeBps: 0,
    minLiquidityUsd: 10_000,
    maxImpactBps: 500,
  },
  exitPolicy: {
    policyId: 'exit-standard-2x',
    targetMultiplier: 2.0,
    stopLossMultiplier: 0.5,
    maxHorizonMs: 86_400_000, // 24h
  },
};

export const DEFAULT_POLICY_METADATA: PolicyMetadata = {
  policyId: 'policy-signal-baseline',
  policyVersion: '1.0.0',
  description: 'Deterministic baseline candidate selection and evaluation policy',
  minScoreThreshold: 0.0,
};

// ---------------------------------------------------------------------------
// Corpus Types
// ---------------------------------------------------------------------------

export type AssetCorpusArchetype =
  | 'GEM_TRADABLE'
  | 'GEM_UNTRADABLE'
  | 'RUG_PULL'
  | 'STOP_LOSS'
  | 'NEUTRAL'
  | 'PENDING'
  | 'INELIGIBLE_SCORE'
  | 'MISSING_ADAPTER';

export interface EvaluationCorpusAsset {
  assetId: string;
  chainId: string;
  symbol: string;
  archetype: AssetCorpusArchetype;
  historySnapshots: MarketSnapshot[];
  currentSnapshot: MarketSnapshot;
  adapterEvidence: FunnelAdapterEvidence | null;
  forwardObservations: ForwardObservation[];
}

export interface EvaluationFixtureCorpus {
  corpusVersion: string;
  universeId: string;
  dataCutoff: string;
  assets: EvaluationCorpusAsset[];
}

// ---------------------------------------------------------------------------
// Corpus Builder
// ---------------------------------------------------------------------------

const makeSnapshot = (
  assetId: string,
  chainId: string,
  asOf: string,
  priceUsd: string,
  liquidityUsd: string,
  volumeUsd24h: string,
  marketCapUsd: string,
  poolAddress: string,
): MarketSnapshot => ({
  snapshotId: `${assetId}:${asOf}`,
  assetId,
  chainId,
  asOf,
  version: '1.0.0',
  pools: [
    {
      poolId: `${chainId}:raydium:${poolAddress}`,
      chainId,
      dex: 'raydium',
      poolAddress,
      liquidityUsd,
      volumeUsd24h,
      quoteAssetRepresentationId: null,
      updatedAt: asOf,
      quality: 'VALID',
    },
  ],
  market: {
    priceUsd,
    volumeUsd24h,
    marketCapUsd,
    updatedAt: asOf,
  },
  provenance: {
    observationIds: [`obs-${assetId}-1`, `obs-${assetId}-2`],
    evidenceHashes: [
      'a'.repeat(64),
      'b'.repeat(64),
    ],
    collectedAt: asOf,
  },
  quality: 'VALID',
});

/**
 * Creates the standard versioned evaluation fixture corpus (v1.0.0).
 *
 * Contains 8 distinct archetype assets demonstrating all lifecycle and outcome behaviors:
 * 1. asset-gem-tradable: Strong volume & liquidity growth, reaches 2.5x with healthy pool -> SIGNAL_WIN & TRADABLE_SUCCESS
 * 2. asset-gem-untradable: Price surges 3.0x, but liquidity collapses below minimum -> SIGNAL_WIN & UNTRADABLE_SIGNAL_WIN
 * 3. asset-rugpull: Liquidity drained / RUG_PULL event -> SIGNAL_LOSS & TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY
 * 4. asset-stoploss: Price drops to 0.4x -> SIGNAL_LOSS & TRADABLE_FAILURE
 * 5. asset-neutral: Price fluctuates within [0.9x, 1.1x] through 24h -> SIGNAL_NEUTRAL & TRADABLE_NEUTRAL
 * 6. asset-pending: Forward observations only reach 10m into horizon -> SIGNAL_PENDING & PENDING
 * 7. asset-ineligible-score: High liquidity drawdown / poor momentum, score fails threshold -> Rejected by funnel
 * 8. asset-missing-adapter: No verified adapter -> Rejected by funnel
 */
export const createDefaultEvaluationCorpus = (): EvaluationFixtureCorpus => {
  const cutoff = '2026-03-01T02:00:00.000Z';
  const tMinus2 = '2026-03-01T00:00:00.000Z';
  const tMinus1 = '2026-03-01T01:00:00.000Z';
  const chainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

  const assets: EvaluationCorpusAsset[] = [
    // 1. GEM_TRADABLE
    {
      assetId: 'solana:asset-1-gem-tradable',
      chainId,
      symbol: 'GEM1',
      archetype: 'GEM_TRADABLE',
      historySnapshots: [
        makeSnapshot('solana:asset-1-gem-tradable', chainId, tMinus2, '1.00', '100000.00', '50000.00', '1000000.00', 'PoolGem1'),
        makeSnapshot('solana:asset-1-gem-tradable', chainId, tMinus1, '1.10', '120000.00', '75000.00', '1100000.00', 'PoolGem1'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-1-gem-tradable', chainId, cutoff, '1.25', '150000.00', '120000.00', '1250000.00', 'PoolGem1'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolGem1`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.28, poolLiquidityUsd: 155000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T02:30:00.000Z', priceUsd: 1.80, poolLiquidityUsd: 200000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T04:00:00.000Z', priceUsd: 2.60, poolLiquidityUsd: 250000, securityStatus: 'SAFE' }, // Reaches 2.0x target
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 2.80, poolLiquidityUsd: 260000, securityStatus: 'SAFE' },
      ],
    },

    // 2. GEM_UNTRADABLE (Price jumps but liquidity drops below 10k threshold)
    {
      assetId: 'solana:asset-2-gem-untradable',
      chainId,
      symbol: 'GEM2',
      archetype: 'GEM_UNTRADABLE',
      historySnapshots: [
        makeSnapshot('solana:asset-2-gem-untradable', chainId, tMinus2, '0.50', '50000.00', '20000.00', '500000.00', 'PoolGem2'),
        makeSnapshot('solana:asset-2-gem-untradable', chainId, tMinus1, '0.55', '60000.00', '35000.00', '550000.00', 'PoolGem2'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-2-gem-untradable', chainId, cutoff, '0.65', '70000.00', '60000.00', '650000.00', 'PoolGem2'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolGem2`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 0.70, poolLiquidityUsd: 50000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T02:15:00.000Z', priceUsd: 1.40, poolLiquidityUsd: 5000, securityStatus: 'SAFE' }, // Liquidity dropped below 10k!
        { timestamp: '2026-03-01T03:00:00.000Z', priceUsd: 2.00, poolLiquidityUsd: 2000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 2.10, poolLiquidityUsd: 1000, securityStatus: 'SAFE' },
      ],
    },

    // 3. RUG_PULL
    {
      assetId: 'solana:asset-3-rugpull',
      chainId,
      symbol: 'RUG',
      archetype: 'RUG_PULL',
      historySnapshots: [
        makeSnapshot('solana:asset-3-rugpull', chainId, tMinus2, '2.00', '80000.00', '40000.00', '2000000.00', 'PoolRug'),
        makeSnapshot('solana:asset-3-rugpull', chainId, tMinus1, '2.10', '90000.00', '60000.00', '2100000.00', 'PoolRug'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-3-rugpull', chainId, cutoff, '2.30', '100000.00', '90000.00', '2300000.00', 'PoolRug'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolRug`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 2.35, poolLiquidityUsd: 100000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T02:10:00.000Z', priceUsd: 0.01, poolLiquidityUsd: 50, securityStatus: 'RUG_PULL' }, // Rug event
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 0.00, poolLiquidityUsd: 0, securityStatus: 'RUG_PULL' },
      ],
    },

    // 4. STOP_LOSS
    {
      assetId: 'solana:asset-4-stoploss',
      chainId,
      symbol: 'STOP',
      archetype: 'STOP_LOSS',
      historySnapshots: [
        makeSnapshot('solana:asset-4-stoploss', chainId, tMinus2, '5.00', '150000.00', '50000.00', '5000000.00', 'PoolStop'),
        makeSnapshot('solana:asset-4-stoploss', chainId, tMinus1, '5.10', '160000.00', '60000.00', '5100000.00', 'PoolStop'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-4-stoploss', chainId, cutoff, '5.20', '170000.00', '80000.00', '5200000.00', 'PoolStop'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolStop`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 5.15, poolLiquidityUsd: 165000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T03:00:00.000Z', priceUsd: 3.50, poolLiquidityUsd: 140000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T05:00:00.000Z', priceUsd: 2.20, poolLiquidityUsd: 120000, securityStatus: 'SAFE' }, // Hits 50% stop loss
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 1.80, poolLiquidityUsd: 100000, securityStatus: 'SAFE' },
      ],
    },

    // 5. NEUTRAL
    {
      assetId: 'solana:asset-5-neutral',
      chainId,
      symbol: 'NEUT',
      archetype: 'NEUTRAL',
      historySnapshots: [
        makeSnapshot('solana:asset-5-neutral', chainId, tMinus2, '10.00', '300000.00', '100000.00', '10000000.00', 'PoolNeut'),
        makeSnapshot('solana:asset-5-neutral', chainId, tMinus1, '10.10', '305000.00', '105000.00', '10100000.00', 'PoolNeut'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-5-neutral', chainId, cutoff, '10.20', '310000.00', '110000.00', '10200000.00', 'PoolNeut'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolNeut`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 10.25, poolLiquidityUsd: 310000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T08:00:00.000Z', priceUsd: 10.40, poolLiquidityUsd: 315000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T16:00:00.000Z', priceUsd: 10.10, poolLiquidityUsd: 305000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 10.30, poolLiquidityUsd: 310000, securityStatus: 'SAFE' }, // Expires at horizon within neutral band
      ],
    },

    // 6. PENDING
    {
      assetId: 'solana:asset-6-pending',
      chainId,
      symbol: 'PEND',
      archetype: 'PENDING',
      historySnapshots: [
        makeSnapshot('solana:asset-6-pending', chainId, tMinus2, '4.00', '200000.00', '80000.00', '4000000.00', 'PoolPend'),
        makeSnapshot('solana:asset-6-pending', chainId, tMinus1, '4.10', '210000.00', '90000.00', '4100000.00', 'PoolPend'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-6-pending', chainId, cutoff, '4.20', '220000.00', '100000.00', '4200000.00', 'PoolPend'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolPend`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 4.25, poolLiquidityUsd: 220000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-01T02:10:00.000Z', priceUsd: 4.30, poolLiquidityUsd: 222000, securityStatus: 'SAFE' },
      ],
    },

    // 7. INELIGIBLE_SCORE (Volume deceleration and liquidity collapse before cutoff)
    {
      assetId: 'solana:asset-7-ineligible',
      chainId,
      symbol: 'INEL',
      archetype: 'INELIGIBLE_SCORE',
      historySnapshots: [
        makeSnapshot('solana:asset-7-ineligible', chainId, tMinus2, '8.00', '500000.00', '200000.00', '8000000.00', 'PoolInel'),
        makeSnapshot('solana:asset-7-ineligible', chainId, tMinus1, '4.00', '200000.00', '50000.00', '4000000.00', 'PoolInel'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-7-ineligible', chainId, cutoff, '2.00', '50000.00', '10000.00', '2000000.00', 'PoolInel'),
      adapterEvidence: {
        poolId: `${chainId}:raydium:PoolInel`,
        adapterVersion: '1.0.0',
        available: true,
        verified: true,
      },
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.80, poolLiquidityUsd: 40000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 1.00, poolLiquidityUsd: 20000, securityStatus: 'SAFE' },
      ],
    },

    // 8. MISSING_ADAPTER
    {
      assetId: 'solana:asset-8-missing-adapter',
      chainId,
      symbol: 'NOAD',
      archetype: 'MISSING_ADAPTER',
      historySnapshots: [
        makeSnapshot('solana:asset-8-missing-adapter', chainId, tMinus2, '1.00', '100000.00', '50000.00', '1000000.00', 'PoolNoAd'),
        makeSnapshot('solana:asset-8-missing-adapter', chainId, tMinus1, '1.10', '110000.00', '60000.00', '1100000.00', 'PoolNoAd'),
      ],
      currentSnapshot: makeSnapshot('solana:asset-8-missing-adapter', chainId, cutoff, '1.20', '120000.00', '70000.00', '1200000.00', 'PoolNoAd'),
      adapterEvidence: null, // No adapter evidence!
      forwardObservations: [
        { timestamp: '2026-03-01T02:01:00.000Z', priceUsd: 1.25, poolLiquidityUsd: 120000, securityStatus: 'SAFE' },
        { timestamp: '2026-03-02T02:00:00.000Z', priceUsd: 2.50, poolLiquidityUsd: 200000, securityStatus: 'SAFE' },
      ],
    },
  ];

  return {
    corpusVersion: '1.0.0',
    universeId: 'univ-solana-golden-corpus-v1',
    dataCutoff: cutoff,
    assets,
  };
};

// ---------------------------------------------------------------------------
// Pipeline Runner
// ---------------------------------------------------------------------------

export const DEFAULT_FEATURE_WINDOWS: readonly number[] = Object.freeze([10, 5, 2, 1]);

export interface ExecutePipelineInput {
  corpus: EvaluationFixtureCorpus;
  funnelProfile?: FunnelProfile | undefined;
  outcomeProfile?: OutcomeProfile | undefined;
  policyMetadata?: PolicyMetadata | undefined;
  artifactClass?: EvaluationArtifactClass | undefined;
  evaluationTime?: string | undefined;
  featureWindows?: number[] | undefined;
}

export interface PipelineExecutionResult {
  candidateUniverse: FrozenCandidateUniverse;
  featureSets: Map<string, FeatureSet>;
  funnelOutput: FunnelOutput;
  signals: SignalRecord[];
  outcomes: OutcomeRecord[];
  report: EvaluationReport;
}

/**
 * Execute the complete snapshot-to-signal-to-outcome evaluation pipeline deterministically.
 */
export const executeEvaluationPipeline = (input: ExecutePipelineInput): PipelineExecutionResult => {
  const {
    corpus,
    funnelProfile = DEFAULT_FUNNEL_PROFILE,
    outcomeProfile = DEFAULT_OUTCOME_PROFILE,
    policyMetadata = DEFAULT_POLICY_METADATA,
    artifactClass = 'BACKTEST',
    evaluationTime,
    featureWindows = DEFAULT_FEATURE_WINDOWS,
  } = input;

  // 1. Create Frozen Candidate Universe (AC-042)
  const candidateAssetIds = corpus.assets.map((a) => a.assetId);
  const candidateUniverse = createFrozenCandidateUniverse({
    universeId: corpus.universeId,
    dataCutoff: corpus.dataCutoff,
    candidateAssetIds,
    corpusVersion: corpus.corpusVersion,
  });

  // 2. Compute canonical feature sets from historical & current snapshots
  const featureSets = new Map<string, FeatureSet>();
  const snapshotsMap = new Map<string, MarketSnapshot>();
  const observationsMap = new Map<string, ForwardObservation[]>();
  const funnelInputs: FunnelInput[] = [];

  for (const asset of corpus.assets) {
    const fs = computeFeatureSet(
      asset.historySnapshots,
      asset.currentSnapshot,
      featureWindows as number[],
      corpus.dataCutoff,
    );
    featureSets.set(asset.assetId, fs);
    snapshotsMap.set(asset.assetId, asset.currentSnapshot);
    observationsMap.set(asset.assetId, asset.forwardObservations);

    funnelInputs.push({
      assetId: asset.assetId,
      chainId: asset.chainId,
      asOf: corpus.dataCutoff,
      featureSet: fs,
      adapterEvidence: asset.adapterEvidence,
    });
  }

  // 3. Run candidate funnel
  const funnelOutput = runFunnel(funnelInputs, funnelProfile);

  // 4. Materialize eligible candidates into immutable signals
  const { signals } = materializeSignals(
    funnelOutput,
    featureSets,
    snapshotsMap,
    funnelProfile,
  );

  // 5. Evaluate forward outcomes
  const outcomes = evaluateOutcomes(
    signals,
    outcomeProfile,
    observationsMap,
    evaluationTime,
  );

  // Evaluate all candidates with valid adapter evidence to determine universe-level ground-truth winners (AC-041 recall / missed-gems)
  const executableCandidates = funnelOutput.candidates.filter((c) => c.adapterEvidence !== null);
  const allCandidatesOutput: FunnelOutput = {
    ...funnelOutput,
    eligibleCount: executableCandidates.length,
    rejectedCount: 0,
    candidates: executableCandidates.map((c, i) => ({
      ...c,
      eligible: true,
      score: c.score ?? 0.5,
      rank: i + 1,
      rejectionReasons: [],
    })),
  };
  const { signals: allUniverseSignals } = materializeSignals(
    allCandidatesOutput,
    featureSets,
    snapshotsMap,
    funnelProfile,
  );
  const universeOutcomes = evaluateOutcomes(
    allUniverseSignals,
    outcomeProfile,
    observationsMap,
    evaluationTime,
  );
  const universeSignalWinnersCount = universeOutcomes.filter((o) => o.signalSuccess).length;
  const universeTradableWinnersCount = universeOutcomes.filter((o) => o.tradableSuccess).length;

  // 6. Generate canonical evaluation report (FR-EVAL-019, AC-040, AC-042)
  const report = generateEvaluationReport({
    artifactClass,
    candidateUniverse,
    profile: outcomeProfile,
    policy: policyMetadata,
    outcomes,
    metricsOptions: {
      totalCandidates: candidateUniverse.totalAssets,
      eligibleCandidates: funnelOutput.eligibleCount,
      rejectedCandidates: funnelOutput.rejectedCount,
      universeSignalWinnersCount,
      universeTradableWinnersCount,
    },
    generatedAt: corpus.dataCutoff,
  });

  return {
    candidateUniverse,
    featureSets,
    funnelOutput,
    signals,
    outcomes,
    report,
  };
};
