/**
 * @requirement FR-EVAL-019 - Backtest, cross-fit, forward shadow, live shadow, and active-production results are separate artifact classes.
 * @requirement AC-040 - Outcome profiles compute separate signal and tradable labels from actionable delivery time, canonical pool, configured notional/delay, modeled impact, all required fees, fill/liquidity constraints, exit policy and maturity state.
 * @requirement AC-042 - Baseline and champion use the same frozen candidate universe and data cutoff.
 *
 * Public API for @ciag/evaluation package: candidate universes, outcome profiles & evaluation, metrics, reports, and class separation.
 */

export * from './types.js';
export * from './errors.js';
export * from './universe.js';
export * from './outcomes.js';
export * from './metrics.js';
export * from './report.js';
export * from './corpus.js';

// Backward compatibility helpers
import type { Outcome } from './types.js';
import { EvaluationError } from './errors.js';

export const matureSyntheticOutcome = (observedAt: string, now: string, maturityMs: number): Outcome => {
  if (Date.parse(now) - Date.parse(observedAt) < maturityMs) return { state: 'PENDING' };
  return { state: 'MATURE', signalSuccess: true, tradableSuccess: false };
};

export const assertOutcomeLabelsDistinct = (
  signalSuccess: boolean | undefined,
  tradableSuccess: boolean | undefined,
): void => {
  if (signalSuccess === undefined || tradableSuccess === undefined) {
    throw new EvaluationError('OUTCOME_LABEL_REQUIRED', 'OUTCOME_LABEL_REQUIRED');
  }
};
