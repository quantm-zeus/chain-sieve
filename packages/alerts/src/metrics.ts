/**
 * @requirement FR-ALERT-005 - Separated alert metrics and denominators by alert class.
 * @requirement AC-140 - EARLY_WATCH excluded from confirmed opportunity precision.
 */

import type {
  AlertClassSeparatedMetrics,
  AlertEvaluationMetricRecord,
} from './types.js';

export interface ComputeAlertMetricsOptions {
  asOf?: string;
  universeTradableSuccessCount?: number;
}

const round6 = (val: number): number => {
  if (!Number.isFinite(val)) return 0;
  return Math.round(val * 1_000_000) / 1_000_000;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return round6((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return round6(sorted[mid]!);
};

/**
 * Computes deterministic alert evaluation metrics strictly separated by alert class.
 * EARLY_WATCH is excluded from CONFIRMED_OPPORTUNITY precision/recall denominators.
 */
export const computeAlertClassMetrics = (
  records: AlertEvaluationMetricRecord[],
  options: ComputeAlertMetricsOptions = {},
): AlertClassSeparatedMetrics => {
  const asOf = options.asOf ?? new Date().toISOString();

  // 1. Group records by alert class
  const confirmedRecords = records.filter((r) => r.alertClass === 'CONFIRMED_OPPORTUNITY');
  const earlyWatchRecords = records.filter((r) => r.alertClass === 'EARLY_WATCH');
  const riskRecords = records.filter((r) => r.alertClass === 'RISK_ALERT');
  const strengtheningRecords = records.filter((r) => r.alertClass === 'THESIS_STRENGTHENING');
  const weakeningRecords = records.filter((r) => r.alertClass === 'THESIS_WEAKENING');
  const expiredRecords = records.filter((r) => r.alertClass === 'OPPORTUNITY_EXPIRED');

  // 2. Confirmed Opportunity Metrics
  const totalConfirmed = confirmedRecords.length;
  let confirmedTradableWins = 0;
  let confirmedTradableLosses = 0;

  for (const rec of confirmedRecords) {
    if (rec.tradableSuccess === true) {
      confirmedTradableWins++;
    } else if (rec.tradableSuccess === false) {
      confirmedTradableLosses++;
    }
  }

  const confirmedPrecision = totalConfirmed > 0 ? round6(confirmedTradableWins / totalConfirmed) : 0;
  const falseDiscoveryRate = totalConfirmed > 0 ? round6(1 - confirmedPrecision) : 0;
  const confirmedRecall =
    options.universeTradableSuccessCount !== undefined && options.universeTradableSuccessCount > 0
      ? round6(confirmedTradableWins / options.universeTradableSuccessCount)
      : 0;

  // 3. Early Watch Metrics (Explicitly separated from confirmed opportunity precision)
  const totalWatches = earlyWatchRecords.length;
  let convertedCount = 0;
  let watchWins = 0;
  const leadTimes: number[] = [];

  for (const rec of earlyWatchRecords) {
    if (rec.convertedToConfirmed === true) {
      convertedCount++;
      if (rec.tradableSuccess === true) {
        watchWins++;
      }
    }
    if (rec.leadTimeMinutes !== undefined && rec.leadTimeMinutes > 0) {
      leadTimes.push(rec.leadTimeMinutes);
    }
  }

  const watchConversionRate = totalWatches > 0 ? round6(convertedCount / totalWatches) : 0;
  const watchPrecision = convertedCount > 0 ? round6(watchWins / convertedCount) : 0;
  const medianLeadTimeMinutes = median(leadTimes);

  // 4. Risk Alert Metrics
  const totalRiskAlerts = riskRecords.length;
  let trueRiskCount = 0;
  const warningLeadTimes: number[] = [];

  for (const rec of riskRecords) {
    if (rec.trueRiskDetected === true) {
      trueRiskCount++;
    }
    if (rec.warningLeadTimeMinutes !== undefined && rec.warningLeadTimeMinutes > 0) {
      warningLeadTimes.push(rec.warningLeadTimeMinutes);
    }
  }

  const riskPrecision = totalRiskAlerts > 0 ? round6(trueRiskCount / totalRiskAlerts) : 0;
  const medianWarningLeadTime = median(warningLeadTimes);

  // 5. Thesis Updates Metrics
  const strengtheningCount = strengtheningRecords.length;
  const weakeningCount = weakeningRecords.length;
  const expiredCount = expiredRecords.length;
  const cancellationCount = records.filter((r) => r.actionabilityState === 'CANCELLED').length;

  return {
    asOf,
    confirmedOpportunity: {
      totalAlerts: totalConfirmed,
      tradableSuccessCount: confirmedTradableWins,
      tradableFailureCount: confirmedTradableLosses,
      precision: confirmedPrecision,
      recall: confirmedRecall,
      falseDiscoveryRate,
    },
    earlyWatch: {
      totalWatches,
      convertedToConfirmedCount: convertedCount,
      conversionRate: watchConversionRate,
      watchPrecision,
      medianLeadTimeMinutes,
      excludedFromConfirmedPrecision: true,
    },
    riskAlert: {
      totalRiskAlerts,
      trueRiskCount,
      precision: riskPrecision,
      medianWarningLeadTimeMinutes: medianWarningLeadTime,
    },
    thesisUpdates: {
      strengtheningCount,
      weakeningCount,
      expiredCount,
      cancellationCount,
    },
  };
};
