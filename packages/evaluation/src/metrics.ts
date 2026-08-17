/**
 * @requirement AC-040 - Baseline metrics computation with separate signal and tradable profiles.
 * @requirement AC-041 - Precision, recall, and missed-gem diagnostics.
 * @requirement FR-EVAL-019 - Stable baseline metrics calculation.
 *
 * Deterministic metrics computation implementing PRD Section 7 and 38.42.
 */

import type { EvaluationMetrics, OutcomeRecord } from './types.js';

export interface ComputeMetricsOptions {
  totalCandidates?: number | undefined;
  eligibleCandidates?: number | undefined;
  rejectedCandidates?: number | undefined;
  universeSignalWinnersCount?: number | undefined;
  universeTradableWinnersCount?: number | undefined;
}

const round6 = (num: number): number => {
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 1_000_000) / 1_000_000;
};

/**
 * Compute comprehensive, deterministic evaluation metrics from evaluated outcome records.
 */
export const computeEvaluationMetrics = (
  outcomes: OutcomeRecord[],
  options: ComputeMetricsOptions = {},
): EvaluationMetrics => {
  const evaluatedOutcomes = outcomes.length;

  let fullyMaturedCount = 0;
  let partiallyMaturedCount = 0;
  let pendingCount = 0;
  let censoredCount = 0;
  let invalidCount = 0;

  let signalSuccessCount = 0;
  let signalFailureCount = 0;

  let tradableSuccessCount = 0;
  let tradableFailureCount = 0;
  let securityOrLiquidityFailureCount = 0;
  let tradableNeutralCount = 0;
  let untradableSignalWinCount = 0;

  const matureReturns: number[] = [];

  for (const outcome of outcomes) {
    switch (outcome.state) {
      case 'FULLY_MATURED':
        fullyMaturedCount++;
        break;
      case 'PARTIALLY_MATURED':
        partiallyMaturedCount++;
        break;
      case 'PENDING':
        pendingCount++;
        break;
      case 'CENSORED':
        censoredCount++;
        break;
      case 'INVALID_DATA':
        invalidCount++;
        break;
    }

    if (outcome.state === 'FULLY_MATURED') {
      if (outcome.signalSuccess) {
        signalSuccessCount++;
      }
      if (outcome.signalOutcome === 'SIGNAL_LOSS') {
        signalFailureCount++;
      }

      switch (outcome.tradableOutcome) {
        case 'TRADABLE_SUCCESS':
          tradableSuccessCount++;
          break;
        case 'TRADABLE_FAILURE':
          tradableFailureCount++;
          break;
        case 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY':
          securityOrLiquidityFailureCount++;
          break;
        case 'TRADABLE_NEUTRAL':
          tradableNeutralCount++;
          break;
        case 'UNTRADABLE_SIGNAL_WIN':
          untradableSignalWinCount++;
          break;
      }

      if (outcome.netReturn !== null) {
        matureReturns.push(outcome.netReturn);
      }
    }
  }

  const matureEvaluated = fullyMaturedCount;

  // Signal precision & recall
  const signalPrecision = matureEvaluated > 0 ? round6(signalSuccessCount / matureEvaluated) : 0;
  const univSignalWins = options.universeSignalWinnersCount ?? signalSuccessCount;
  const signalRecall = univSignalWins > 0 ? round6(signalSuccessCount / univSignalWins) : 1.0;

  // Tradable precision & recall (AC-040, AC-041)
  const tradablePrecision = matureEvaluated > 0 ? round6(tradableSuccessCount / matureEvaluated) : 0;
  const univTradableWins = options.universeTradableWinnersCount ?? tradableSuccessCount;
  const tradableRecall = univTradableWins > 0 ? round6(tradableSuccessCount / univTradableWins) : 1.0;
  const missedGemsCount = Math.max(0, univTradableWins - tradableSuccessCount);
  const falseDiscoveryRate = matureEvaluated > 0 ? round6(1 - tradablePrecision) : 0;

  // Ranking diagnostics: sort copy by descending signal score (with outcomeId tie-breaker for deterministic stability) per PRD 7.5
  const rankedOutcomes = [...outcomes].sort(
    (a, b) => (b.signal.score - a.signal.score) || a.outcomeId.localeCompare(b.outcomeId),
  );

  const p1Slice = rankedOutcomes.slice(0, 1);
  const p3Slice = rankedOutcomes.slice(0, 3);
  const p5Slice = rankedOutcomes.slice(0, 5);

  const precisionAt1 = p1Slice.length > 0 ? round6(p1Slice.filter((o) => o.tradableSuccess).length / p1Slice.length) : 0;
  const precisionAt3 = p3Slice.length > 0 ? round6(p3Slice.filter((o) => o.tradableSuccess).length / p3Slice.length) : 0;
  const precisionAt5 = p5Slice.length > 0 ? round6(p5Slice.filter((o) => o.tradableSuccess).length / p5Slice.length) : 0;

  // Mean Reciprocal Rank (MRR)
  let firstWinRank = 0;
  for (let i = 0; i < rankedOutcomes.length; i++) {
    if (rankedOutcomes[i]!.tradableSuccess) {
      firstWinRank = i + 1;
      break;
    }
  }
  const meanReciprocalRank = firstWinRank > 0 ? round6(1 / firstWinRank) : 0;

  // NDCG@5 and NDCG@10
  const computeNdcg = (k: number): number => {
    const slice = rankedOutcomes.slice(0, k);
    if (slice.length === 0) return 0;

    let dcg = 0;
    for (let i = 0; i < slice.length; i++) {
      const rel = slice[i]!.tradableSuccess ? Math.max(1.0, 1.0 + (slice[i]!.netReturn ?? 0)) : 0;
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }

    const idealRelSorted = slice
      .map((o) => (o.tradableSuccess ? Math.max(1.0, 1.0 + (o.netReturn ?? 0)) : 0))
      .sort((a, b) => b - a);

    let idcg = 0;
    for (let i = 0; i < idealRelSorted.length; i++) {
      idcg += (Math.pow(2, idealRelSorted[i]!) - 1) / Math.log2(i + 2);
    }

    return idcg > 0 ? round6(dcg / idcg) : dcg === 0 ? (slice.every((o) => !o.tradableSuccess) ? 0 : 1.0) : 0;
  };

  const ndcgAt5 = computeNdcg(5);
  const ndcgAt10 = computeNdcg(10);

  // Financial & Net Shadow-Portfolio Utility Metrics (PRD Section 7.1, 7.2)
  let averageNetReturn = 0;
  let winLossRatio = 0;
  let profitFactor = 0;
  let netExpectancy = 0;
  let maxDrawdown = 0;
  let cvar95 = 0;
  let netShadowPortfolioUtility = 0;
  let lcb95Utility = 0;

  if (matureReturns.length > 0) {
    const totalReturn = matureReturns.reduce((acc, r) => acc + r, 0);
    averageNetReturn = round6(totalReturn / matureReturns.length);

    const wins = matureReturns.filter((r) => r > 0);
    const losses = matureReturns.filter((r) => r < 0);

    const sumWins = wins.reduce((acc, r) => acc + r, 0);
    const sumLosses = Math.abs(losses.reduce((acc, r) => acc + r, 0));

    profitFactor = sumLosses > 0 ? round6(sumWins / sumLosses) : sumWins > 0 ? 100.0 : 0;

    const avgWin = wins.length > 0 ? sumWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? sumLosses / losses.length : 0;

    winLossRatio = avgLoss > 0 ? round6(avgWin / avgLoss) : avgWin > 0 ? 100.0 : 0;

    const winRate = matureReturns.length > 0 ? wins.length / matureReturns.length : 0;
    const lossRate = matureReturns.length > 0 ? losses.length / matureReturns.length : 0;

    netExpectancy = round6(winRate * avgWin - lossRate * avgLoss);

    // Max Drawdown calculation
    let peak = 1.0;
    let equity = 1.0;
    let maxDd = 0;
    for (const r of matureReturns) {
      equity *= 1 + r;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }
    maxDrawdown = round6(maxDd);

    // CVaR (95% tail loss): worst 5% outcomes
    const sortedReturns = [...matureReturns].sort((a, b) => a - b);
    const tailCount = Math.max(1, Math.ceil(sortedReturns.length * 0.05));
    const tailReturns = sortedReturns.slice(0, tailCount);
    const tailMean = tailReturns.reduce((acc, r) => acc + r, 0) / tailCount;
    cvar95 = round6(Math.abs(Math.min(0, tailMean)));

    // Net Shadow Portfolio Utility (PRD 7.2): realized PnL - DD penalty - CVaR penalty - security failure penalty
    const secFailureRate = matureEvaluated > 0 ? securityOrLiquidityFailureCount / matureEvaluated : 0;
    const rawUtility = averageNetReturn - 0.5 * maxDrawdown - 1.0 * cvar95 - 2.0 * secFailureRate;
    netShadowPortfolioUtility = round6(rawUtility);

    // LCB95 (PRD 7.1, 7.4): One-sided 95% lower confidence bound
    const variance =
      matureReturns.length > 1
        ? matureReturns.reduce((acc, r) => acc + Math.pow(r - averageNetReturn, 2), 0) / (matureReturns.length - 1)
        : 0;
    const stdErr = matureReturns.length > 0 ? Math.sqrt(variance) / Math.sqrt(matureReturns.length) : 0;
    lcb95Utility = round6(netShadowPortfolioUtility - 1.645 * stdErr);
  }

  return {
    totalCandidates: options.totalCandidates ?? evaluatedOutcomes,
    eligibleCandidates: options.eligibleCandidates ?? evaluatedOutcomes,
    rejectedCandidates: options.rejectedCandidates ?? 0,
    materializedSignals: evaluatedOutcomes,
    evaluatedOutcomes,
    fullyMaturedCount,
    partiallyMaturedCount,
    pendingCount,
    censoredCount,
    invalidCount,
    signalSuccessCount,
    signalFailureCount,
    signalPrecision,
    signalRecall,
    tradableSuccessCount,
    tradableFailureCount,
    securityOrLiquidityFailureCount,
    tradableNeutralCount,
    untradableSignalWinCount,
    tradablePrecision,
    tradableRecall,
    missedGemsCount,
    falseDiscoveryRate,
    precisionAt1,
    precisionAt3,
    precisionAt5,
    recallAtGems: tradableRecall,
    ndcgAt5,
    ndcgAt10,
    meanReciprocalRank,
    averageNetReturn,
    profitFactor,
    winLossRatio,
    netExpectancy,
    maxDrawdown,
    cvar95,
    netShadowPortfolioUtility,
    lcb95Utility,
  };
};
