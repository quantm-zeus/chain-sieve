/**
 * @requirement AC-040 - Outcome profiles compute separate signal and tradable labels from actionable delivery time, canonical pool, configured notional/delay, modeled impact, all required fees, fill/liquidity constraints, exit policy and maturity state.
 * @requirement FR-EVAL-019 - Deterministic outcome records with full attribution.
 *
 * Deterministic outcome evaluation implementing PRD Section 8.1 timing, Section 8.2 label precedence,
 * and separate signal vs tradable outcome resolution.
 */

import { createHash } from 'node:crypto';
import type { SignalRecord } from '@ciag/signal-intelligence';
import { EvaluationError } from './errors.js';
import type {
  ForwardObservation,
  OutcomeProfile,
  OutcomeRecord,
  OutcomeState,
  SignalOutcomeLabel,
  TradableOutcomeLabel,
  UniversalTiming,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers & Canonicalization
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isValidIso = (s: string): boolean => {
  if (!ISO_DATETIME_RE.test(s)) return false;
  const ms = Date.parse(s);
  return !Number.isNaN(ms);
};

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const val = obj[k];
    if (val !== undefined) {
      result[k] = canonicalize(val);
    }
  }
  return result;
};

/**
 * Validate input profile and observations for outcome evaluation.
 */
const validateProfile = (profile: OutcomeProfile): void => {
  if (!profile || typeof profile !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'OUTCOME_PROFILE_REQUIRED');
  }
  if (!profile.profileId || typeof profile.profileId !== 'string') {
    throw new EvaluationError('EVAL_MALFORMED', 'PROFILE_ID_MALFORMED');
  }
  if (!profile.version || typeof profile.version !== 'string') {
    throw new EvaluationError('EVAL_MALFORMED', 'PROFILE_VERSION_MALFORMED');
  }
  const s = profile.executionScenario;
  if (!s || typeof s !== 'object') {
    throw new EvaluationError('EVAL_INCOMPLETE', 'EXECUTION_SCENARIO_MISSING');
  }
  if (typeof s.notionalUsd !== 'number' || s.notionalUsd <= 0) {
    throw new EvaluationError('EVAL_MALFORMED', 'NOTIONAL_USD_INVALID');
  }
  if (typeof s.actionDelayMs !== 'number' || s.actionDelayMs < 0) {
    throw new EvaluationError('EVAL_MALFORMED', 'ACTION_DELAY_MS_INVALID');
  }
  const p = profile.exitPolicy;
  if (!p || typeof p !== 'object') {
    throw new EvaluationError('EVAL_INCOMPLETE', 'EXIT_POLICY_MISSING');
  }
  if (typeof p.targetMultiplier !== 'number' || p.targetMultiplier <= 1.0) {
    throw new EvaluationError('EVAL_MALFORMED', 'TARGET_MULTIPLIER_INVALID');
  }
  if (typeof p.stopLossMultiplier !== 'number' || p.stopLossMultiplier <= 0 || p.stopLossMultiplier >= 1.0) {
    throw new EvaluationError('EVAL_MALFORMED', 'STOP_LOSS_MULTIPLIER_INVALID');
  }
  if (typeof p.maxHorizonMs !== 'number' || p.maxHorizonMs <= 0) {
    throw new EvaluationError('EVAL_MALFORMED', 'MAX_HORIZON_MS_INVALID');
  }
};

// ---------------------------------------------------------------------------
// Core Outcome Evaluator
// ---------------------------------------------------------------------------

export interface EvaluateOutcomeInput {
  signal: SignalRecord;
  profile: OutcomeProfile;
  observations: ForwardObservation[];
  evaluationTime?: string | undefined; // current simulated time; defaults to latest observation timestamp
}

/**
 * Evaluate a single materialized signal against forward observations according to an OutcomeProfile.
 *
 * Implements AC-040:
 * - Computes separate signal and tradable labels.
 * - Enforces actionable delivery time (T_action_reference = T_delivery + D_action).
 * - Applies canonical pool fee, network fee, priority fee, token transfer fee, and modeled price impact.
 * - Enforces liquidity survival and security survival.
 * - Follows PRD Section 8.2 outcome label precedence.
 */
export const evaluateOutcome = (input: EvaluateOutcomeInput): OutcomeRecord => {
  if (!input || typeof input !== 'object') {
    throw new EvaluationError('EVAL_MALFORMED', 'EVALUATION_INPUT_REQUIRED');
  }

  const { signal, profile, observations, evaluationTime } = input;

  if (!signal || typeof signal !== 'object') {
    throw new EvaluationError('EVAL_INCOMPLETE', 'SIGNAL_RECORD_REQUIRED');
  }
  if (!signal.signalId || !signal.assetId || !signal.asOf || !isValidIso(signal.asOf)) {
    throw new EvaluationError('EVAL_MALFORMED', 'SIGNAL_RECORD_MALFORMED');
  }

  validateProfile(profile);

  const scenario = profile.executionScenario;
  const exitPolicy = profile.exitPolicy;

  // Universal Timing calculation (PRD Section 8.1)
  const tDecisionReady = signal.asOf;
  const tPolicyDecided = signal.materializedAt ?? signal.asOf;
  const tDeliveryEligible = Date.parse(tDecisionReady) >= Date.parse(tPolicyDecided) ? tDecisionReady : tPolicyDecided;
  const tDelivery = signal.materializedAt ?? signal.asOf;
  const dActionMs = scenario.actionDelayMs;
  const tActionReferenceMs = Date.parse(tDelivery) + dActionMs;
  const tActionReference = new Date(tActionReferenceMs).toISOString();

  const timing: UniversalTiming = {
    tDecisionReady,
    tPolicyDecided,
    tDeliveryEligible,
    tDelivery,
    dActionMs,
    tActionReference,
    actionablePriceTime: null,
  };

  // Check for malformed observations
  if (!Array.isArray(observations)) {
    throw new EvaluationError('EVAL_MALFORMED', 'OBSERVATIONS_NOT_ARRAY');
  }

  // Sort observations chronologically
  const sortedObs = [...observations].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // Chronology validation: check timestamps are valid
  for (const obs of sortedObs) {
    if (!obs.timestamp || !isValidIso(obs.timestamp)) {
      return buildOutcomeRecord({
        signal,
        profile,
        scenario,
        timing,
        state: 'INVALID_DATA',
        signalSuccess: false,
        tradableSuccess: false,
        signalOutcome: 'SIGNAL_INVALID',
        tradableOutcome: 'INVALID_DATA',
        entryPrice: null,
        exitPrice: null,
        exitTime: null,
        rawReturn: null,
        netReturn: null,
        mfe: null,
        mae: null,
        modeledImpactBps: 0,
        totalFeesUsd: 0,
        liquiditySurvives: false,
        securitySurvives: false,
        failureReason: 'OBSERVATION_TIMESTAMP_MALFORMED',
      });
    }
  }

  // Find actionable entry observation: first observation at or after tActionReference
  const entryIndex = sortedObs.findIndex((o) => Date.parse(o.timestamp) >= tActionReferenceMs);

  if (entryIndex === -1) {
    // No observation at or after actionable time yet
    const asOfMs = Date.parse(signal.asOf);
    const horizonMs = exitPolicy.maxHorizonMs;
    const nowMs = evaluationTime ? Date.parse(evaluationTime) : Date.now();

    if (nowMs > asOfMs + horizonMs + dActionMs) {
      // Past horizon with no observations -> CENSORED
      return buildOutcomeRecord({
        signal,
        profile,
        scenario,
        timing,
        state: 'CENSORED',
        signalSuccess: false,
        tradableSuccess: false,
        signalOutcome: 'SIGNAL_CENSORED',
        tradableOutcome: 'CENSORED',
        entryPrice: null,
        exitPrice: null,
        exitTime: null,
        rawReturn: null,
        netReturn: null,
        mfe: null,
        mae: null,
        modeledImpactBps: 0,
        totalFeesUsd: 0,
        liquiditySurvives: true,
        securitySurvives: true,
        failureReason: 'NO_ACTIONABLE_OBSERVATIONS_FOUND',
      });
    }

    return buildOutcomeRecord({
      signal,
      profile,
      scenario,
      timing,
      state: 'PENDING',
      signalSuccess: false,
      tradableSuccess: false,
      signalOutcome: 'SIGNAL_PENDING',
      tradableOutcome: 'PENDING',
      entryPrice: null,
      exitPrice: null,
      exitTime: null,
      rawReturn: null,
      netReturn: null,
      mfe: null,
      mae: null,
      modeledImpactBps: 0,
      totalFeesUsd: 0,
      liquiditySurvives: true,
      securitySurvives: true,
      failureReason: null,
    });
  }

  const entryObs = sortedObs[entryIndex]!;
  timing.actionablePriceTime = entryObs.timestamp;

  const rawEntryPrice = entryObs.priceUsd;
  if (typeof rawEntryPrice !== 'number' || rawEntryPrice <= 0 || !Number.isFinite(rawEntryPrice)) {
    return buildOutcomeRecord({
      signal,
      profile,
      scenario,
      timing,
      state: 'INVALID_DATA',
      signalSuccess: false,
      tradableSuccess: false,
      signalOutcome: 'SIGNAL_INVALID',
      tradableOutcome: 'INVALID_DATA',
      entryPrice: null,
      exitPrice: null,
      exitTime: null,
      rawReturn: null,
      netReturn: null,
      mfe: null,
      mae: null,
      modeledImpactBps: 0,
      totalFeesUsd: 0,
      liquiditySurvives: false,
      securitySurvives: false,
      failureReason: 'ENTRY_PRICE_INVALID',
    });
  }

  // Initial security & liquidity check at entry
  if (entryObs.securityStatus === 'RUG_PULL' || entryObs.securityStatus === 'CRITICAL_SECURITY_EVENT') {
    return buildOutcomeRecord({
      signal,
      profile,
      scenario,
      timing,
      state: 'FULLY_MATURED',
      signalSuccess: false,
      tradableSuccess: false,
      signalOutcome: 'SIGNAL_LOSS',
      tradableOutcome: 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY',
      entryPrice: rawEntryPrice,
      exitPrice: 0,
      exitTime: entryObs.timestamp,
      rawReturn: -1.0,
      netReturn: -1.0,
      mfe: 1.0,
      mae: 0.0,
      modeledImpactBps: 0,
      totalFeesUsd: 0,
      liquiditySurvives: false,
      securitySurvives: false,
      failureReason: `ENTRY_SECURITY_FAILURE:${entryObs.securityStatus}`,
    });
  }

  if (entryObs.poolLiquidityUsd < scenario.minLiquidityUsd) {
    return buildOutcomeRecord({
      signal,
      profile,
      scenario,
      timing,
      state: 'FULLY_MATURED',
      signalSuccess: false,
      tradableSuccess: false,
      signalOutcome: 'SIGNAL_LOSS',
      tradableOutcome: 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY',
      entryPrice: rawEntryPrice,
      exitPrice: 0,
      exitTime: entryObs.timestamp,
      rawReturn: -1.0,
      netReturn: -1.0,
      mfe: 1.0,
      mae: 0.0,
      modeledImpactBps: 0,
      totalFeesUsd: 0,
      liquiditySurvives: false,
      securitySurvives: true,
      failureReason: 'ENTRY_LIQUIDITY_INSUFFICIENT',
    });
  }

  // Calculate Entry Impact & Fees
  // Price impact in basis points: slippage proportional to notional / liquidity
  const entryImpactRatio = entryObs.poolLiquidityUsd > 0 ? scenario.notionalUsd / entryObs.poolLiquidityUsd : 1.0;
  const entryImpactBps = Math.min(scenario.maxImpactBps, entryImpactRatio * scenario.slippageBps);
  const executableEntryPrice = rawEntryPrice * (1 + entryImpactBps / 10000);

  // Total fees at entry: network + priority + pool fee + token transfer fee
  const entryFeesUsd =
    scenario.networkFeeUsd +
    scenario.priorityFeeUsd +
    scenario.notionalUsd * ((scenario.poolFeeBps + scenario.tokenTransferFeeBps) / 10000);

  const entryTimeMs = Date.parse(entryObs.timestamp);
  const horizonEndMs = entryTimeMs + exitPolicy.maxHorizonMs;

  // Track forward path
  let maxPriceSeen = rawEntryPrice;
  let minPriceSeen = rawEntryPrice;
  let signalTargetHit = false;
  let signalStopHit = false;

  let tradableExitPrice: number | null = null;
  let tradableExitTime: string | null = null;
  let tradableOutcome: TradableOutcomeLabel | null = null;
  let tradableSuccess = false;
  let liquiditySurvives = true;
  let securitySurvives = true;
  let failureReason: string | null = null;

  const forwardSlice = sortedObs.slice(entryIndex + 1);

  // Pure signal target multipliers
  const signalTargetPrice = rawEntryPrice * profile.signalTargetMultiplier;
  const signalStopPrice = rawEntryPrice * profile.signalStopMultiplier;

  // Tradable target multipliers (applied to executable entry price)
  const tradableTargetPrice = executableEntryPrice * exitPolicy.targetMultiplier;
  const tradableStopPrice = executableEntryPrice * exitPolicy.stopLossMultiplier;

  let exitImpactBps = 0;
  let exitFeesUsd = 0;

  for (let i = 0; i < forwardSlice.length; i++) {
    const obs = forwardSlice[i]!;
    const obsTimeMs = Date.parse(obs.timestamp);

    if (obsTimeMs > horizonEndMs) {
      break;
    }

    const price = obs.priceUsd;
    if (price > maxPriceSeen) maxPriceSeen = price;
    if (price < minPriceSeen) minPriceSeen = price;

    // Check pure signal target
    if (!signalTargetHit && price >= signalTargetPrice) {
      signalTargetHit = true;
    }
    if (!signalStopHit && price <= signalStopPrice) {
      signalStopHit = true;
    }

    // Check Security Terminal Event
    if (obs.securityStatus === 'RUG_PULL' || obs.securityStatus === 'CRITICAL_SECURITY_EVENT') {
      securitySurvives = false;
      tradableOutcome = 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY';
      tradableSuccess = false;
      tradableExitPrice = 0;
      tradableExitTime = obs.timestamp;
      failureReason = `SECURITY_TERMINAL_EVENT:${obs.securityStatus}`;
      break;
    }

    // Check Liquidity Survival
    if (obs.poolLiquidityUsd < scenario.minLiquidityUsd) {
      liquiditySurvives = false;
      tradableOutcome = 'TRADABLE_FAILURE_SECURITY_OR_LIQUIDITY';
      tradableSuccess = false;
      tradableExitPrice = 0;
      tradableExitTime = obs.timestamp;
      failureReason = 'LIQUIDITY_DROPPED_BELOW_MINIMUM';
      break;
    }

    // Check Tradable Target Reached
    if (tradableOutcome === null && price >= tradableTargetPrice) {
      const exitImpactRatio = obs.poolLiquidityUsd > 0 ? scenario.notionalUsd / obs.poolLiquidityUsd : 1.0;
      exitImpactBps = Math.min(scenario.maxImpactBps, exitImpactRatio * scenario.slippageBps);
      const executableExitPrice = price * (1 - exitImpactBps / 10000);
      exitFeesUsd =
        scenario.networkFeeUsd +
        scenario.priorityFeeUsd +
        scenario.notionalUsd * ((scenario.poolFeeBps + scenario.tokenTransferFeeBps) / 10000);

      tradableExitPrice = executableExitPrice;
      tradableExitTime = obs.timestamp;
      tradableSuccess = true;
      tradableOutcome = 'TRADABLE_SUCCESS';
      break;
    }

    // Check Tradable Stop-Loss Hit
    if (tradableOutcome === null && price <= tradableStopPrice) {
      const exitImpactRatio = obs.poolLiquidityUsd > 0 ? scenario.notionalUsd / obs.poolLiquidityUsd : 1.0;
      exitImpactBps = Math.min(scenario.maxImpactBps, exitImpactRatio * scenario.slippageBps);
      const executableExitPrice = Math.max(0, price * (1 - exitImpactBps / 10000));
      exitFeesUsd =
        scenario.networkFeeUsd +
        scenario.priorityFeeUsd +
        scenario.notionalUsd * ((scenario.poolFeeBps + scenario.tokenTransferFeeBps) / 10000);

      tradableExitPrice = executableExitPrice;
      tradableExitTime = obs.timestamp;
      tradableSuccess = false;
      tradableOutcome = 'TRADABLE_FAILURE';
      failureReason = 'STOP_LOSS_TRIGGERED';
      break;
    }
  }

  // Calculate MFE and MAE
  const mfe = maxPriceSeen / rawEntryPrice;
  const mae = minPriceSeen / rawEntryPrice;

  // Pure signal outcome resolution
  let signalSuccess = false;
  let signalOutcome: SignalOutcomeLabel = 'SIGNAL_NEUTRAL';
  if (signalTargetHit) {
    signalSuccess = true;
    signalOutcome = 'SIGNAL_WIN';
  } else if (signalStopHit) {
    signalSuccess = false;
    signalOutcome = 'SIGNAL_LOSS';
  } else {
    signalSuccess = false;
    signalOutcome = 'SIGNAL_NEUTRAL';
  }

  // Handle expiration at horizon if no early exit triggered
  const lastObs = forwardSlice.length > 0 ? forwardSlice[forwardSlice.length - 1]! : entryObs;
  const lastObsTimeMs = Date.parse(lastObs.timestamp);

  let state: OutcomeState = 'FULLY_MATURED';

  if (tradableOutcome === null) {
    if (lastObsTimeMs < horizonEndMs) {
      // Horizon not reached yet and no terminal event -> PENDING / PARTIALLY_MATURED
      state = forwardSlice.length > 0 ? 'PARTIALLY_MATURED' : 'PENDING';
      tradableOutcome = 'PENDING';
      tradableSuccess = false;
    } else {
      // Matured at horizon: evaluate final price
      const exitImpactRatio = lastObs.poolLiquidityUsd > 0 ? scenario.notionalUsd / lastObs.poolLiquidityUsd : 1.0;
      exitImpactBps = Math.min(scenario.maxImpactBps, exitImpactRatio * scenario.slippageBps);
      const executableExitPrice = lastObs.priceUsd * (1 - exitImpactBps / 10000);
      exitFeesUsd =
        scenario.networkFeeUsd +
        scenario.priorityFeeUsd +
        scenario.notionalUsd * ((scenario.poolFeeBps + scenario.tokenTransferFeeBps) / 10000);

      tradableExitPrice = executableExitPrice;
      tradableExitTime = lastObs.timestamp;

      const totalFeesUsd = entryFeesUsd + exitFeesUsd;
      const netRet = (executableExitPrice - executableEntryPrice) / executableEntryPrice - totalFeesUsd / scenario.notionalUsd;

      if (netRet > 0.05) {
        tradableSuccess = true;
        tradableOutcome = 'TRADABLE_SUCCESS';
      } else if (netRet < -0.05) {
        tradableSuccess = false;
        tradableOutcome = 'TRADABLE_FAILURE';
        failureReason = 'HORIZON_EXPIRATION_NET_LOSS';
      } else {
        tradableSuccess = false;
        tradableOutcome = 'TRADABLE_NEUTRAL';
      }
    }
  }

  // Check for UNTRADABLE_SIGNAL_WIN (AC-040 & PRD Section 8.2)
  // When signal reached target (signalSuccess = true), but tradable execution failed or was untradable
  if (signalSuccess && !tradableSuccess) {
    tradableOutcome = 'UNTRADABLE_SIGNAL_WIN';
    if (!failureReason) {
      failureReason = 'SIGNAL_WIN_UNTRADABLE_DUE_TO_EXECUTION_FRICTION';
    }
  }

  // Calculate final returns and fees
  const totalFeesUsd = entryFeesUsd + exitFeesUsd;
  const rawReturn = tradableExitPrice !== null ? (tradableExitPrice - rawEntryPrice) / rawEntryPrice : null;
  const netReturn =
    tradableExitPrice !== null
      ? (tradableExitPrice - executableEntryPrice) / executableEntryPrice - totalFeesUsd / scenario.notionalUsd
      : null;

  return buildOutcomeRecord({
    signal,
    profile,
    scenario,
    timing,
    state,
    signalSuccess,
    tradableSuccess,
    signalOutcome,
    tradableOutcome,
    entryPrice: executableEntryPrice,
    exitPrice: tradableExitPrice,
    exitTime: tradableExitTime,
    rawReturn,
    netReturn,
    mfe,
    mae,
    modeledImpactBps: entryImpactBps + exitImpactBps,
    totalFeesUsd,
    liquiditySurvives,
    securitySurvives,
    failureReason,
  });
};

/**
 * Batch outcome evaluation: evaluates an array of signals deterministically.
 */
export const evaluateOutcomes = (
  signals: SignalRecord[],
  profile: OutcomeProfile,
  observationsByAssetId: Map<string, ForwardObservation[]> | Record<string, ForwardObservation[]>,
  evaluationTime?: string | undefined,
): OutcomeRecord[] => {
  if (!Array.isArray(signals)) {
    throw new EvaluationError('EVAL_MALFORMED', 'SIGNALS_NOT_ARRAY');
  }

  const obsMap: Map<string, ForwardObservation[]> =
    observationsByAssetId instanceof Map
      ? observationsByAssetId
      : new Map(Object.entries(observationsByAssetId));

  const outcomes: OutcomeRecord[] = [];

  for (const signal of signals) {
    const obs = obsMap.get(signal.assetId) ?? [];
    const outcome = evaluateOutcome({
      signal,
      profile,
      observations: obs,
      evaluationTime,
    });
    outcomes.push(outcome);
  }

  // Deterministic ordering by outcomeId
  outcomes.sort((a, b) => a.outcomeId.localeCompare(b.outcomeId));

  return outcomes;
};

// ---------------------------------------------------------------------------
// Record Builder & Serialization
// ---------------------------------------------------------------------------

interface BuildOutcomeParams {
  signal: SignalRecord;
  profile: OutcomeProfile;
  scenario: OutcomeProfile['executionScenario'];
  timing: UniversalTiming;
  state: OutcomeState;
  signalSuccess: boolean;
  tradableSuccess: boolean;
  signalOutcome: SignalOutcomeLabel;
  tradableOutcome: TradableOutcomeLabel;
  entryPrice: number | null;
  exitPrice: number | null;
  exitTime: string | null;
  rawReturn: number | null;
  netReturn: number | null;
  mfe: number | null;
  mae: number | null;
  modeledImpactBps: number;
  totalFeesUsd: number;
  liquiditySurvives: boolean;
  securitySurvives: boolean;
  failureReason: string | null;
}

const buildOutcomeRecord = (params: BuildOutcomeParams): OutcomeRecord => {
  const {
    signal,
    profile,
    scenario,
    timing,
    state,
    signalSuccess,
    tradableSuccess,
    signalOutcome,
    tradableOutcome,
    entryPrice,
    exitPrice,
    exitTime,
    rawReturn,
    netReturn,
    mfe,
    mae,
    modeledImpactBps,
    totalFeesUsd,
    liquiditySurvives,
    securitySurvives,
    failureReason,
  } = params;

  const canonicalPayload = {
    signalId: signal.signalId,
    assetId: signal.assetId,
    chainId: signal.chainId,
    asOf: signal.asOf,
    profileId: profile.profileId,
    profileVersion: profile.version,
    scenarioId: scenario.scenarioId,
    state,
    signalSuccess,
    tradableSuccess,
    signalOutcome,
    tradableOutcome,
    timing: {
      tDecisionReady: timing.tDecisionReady,
      tPolicyDecided: timing.tPolicyDecided,
      tDeliveryEligible: timing.tDeliveryEligible,
      tDelivery: timing.tDelivery,
      dActionMs: timing.dActionMs,
      tActionReference: timing.tActionReference,
      actionablePriceTime: timing.actionablePriceTime,
    },
    entryPrice,
    exitPrice,
    exitTime,
    rawReturn: rawReturn !== null ? Math.round(rawReturn * 1_000_000) / 1_000_000 : null,
    netReturn: netReturn !== null ? Math.round(netReturn * 1_000_000) / 1_000_000 : null,
    mfe: mfe !== null ? Math.round(mfe * 1_000_000) / 1_000_000 : null,
    mae: mae !== null ? Math.round(mae * 1_000_000) / 1_000_000 : null,
    modeledImpactBps: Math.round(modeledImpactBps * 100) / 100,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    liquiditySurvives,
    securitySurvives,
    failureReason,
  };

  const canonicalJson = JSON.stringify(canonicalize(canonicalPayload));
  const sha256 = sha256Hex(canonicalJson);
  const bytes = new TextEncoder().encode(canonicalJson).byteLength;
  const outcomeId = `out_${sha256.slice(0, 32)}`;

  return Object.freeze({
    outcomeId,
    signalId: signal.signalId,
    assetId: signal.assetId,
    chainId: signal.chainId,
    asOf: signal.asOf,
    profileId: profile.profileId,
    profileVersion: profile.version,
    scenarioId: scenario.scenarioId,
    state,
    signalSuccess,
    tradableSuccess,
    signalOutcome,
    tradableOutcome,
    timing,
    entryPrice,
    exitPrice,
    exitTime,
    rawReturn: rawReturn !== null ? Math.round(rawReturn * 1_000_000) / 1_000_000 : null,
    netReturn: netReturn !== null ? Math.round(netReturn * 1_000_000) / 1_000_000 : null,
    mfe: mfe !== null ? Math.round(mfe * 1_000_000) / 1_000_000 : null,
    mae: mae !== null ? Math.round(mae * 1_000_000) / 1_000_000 : null,
    modeledImpactBps: Math.round(modeledImpactBps * 100) / 100,
    totalFeesUsd: Math.round(totalFeesUsd * 100) / 100,
    liquiditySurvives,
    securitySurvives,
    failureReason,
    canonicalJson,
    sha256,
    bytes,
  }) as OutcomeRecord;
};
