import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface ConcentratedRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  currentTick: number;
  tickSpacing: number;
  ticks: { tickIndex: number; liquidityNet: string }[] | null | undefined;
  ticksRequired?: number;
  updatedAt: string;
}

export const concentratedLiquidityAdapter: PoolAdapter = {
  adapterId: 'concentrated-liquidity',
  version: 'v1',
  family: 'CONCENTRATED_LIQUIDITY_AMM',
  supportedCurveTypes: ['CONCENTRATED_LIQUIDITY'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'concentrated-liquidity',
      supportedVersions: ['v1', '1'],
      supportedCurves: ['CONCENTRATED_LIQUIDITY'],
    });
    const raw = input.raw as ConcentratedRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    if (typeof raw.currentTick !== 'number' || typeof raw.tickSpacing !== 'number') {
      throw new PoolAdapterError('INVALID_LAYOUT', 'TICK_PARAMS_MALFORMED');
    }
    const ticksLoaded = raw.ticks ? raw.ticks.length : 0;
    const ticksRequired = raw.ticksRequired ?? 10;
    const incomplete = !raw.ticks || ticksLoaded < ticksRequired;

    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'CONCENTRATED_LIQUIDITY' as CurveType,
      adapterId: 'concentrated-liquidity',
      adapterVersion: 'v1',
      reserves: {
        baseRaw: raw.baseReserveRaw,
        quoteRaw: raw.quoteReserveRaw,
        baseDecimals: raw.baseDecimals,
        quoteDecimals: raw.quoteDecimals,
      },
      feeBps: raw.feeBps,
      updatedAt: raw.updatedAt,
      provenanceSource: `${input.dex}:${input.programVersion}`,
      rawHash: hashRaw(raw),
      normalizedAt: new Date().toISOString(),
    });
    snapshot.concentrated = {
      currentTick: raw.currentTick,
      tickSpacing: raw.tickSpacing,
      ticksLoaded,
      ticksRequired,
      incomplete,
    };
    if (incomplete) {
      snapshot.stateCompleteness = 'INCOMPLETE';
      snapshot.incompletenessReasons = ['MISSING_TICK_DATA'];
      snapshot.quality = 'INCOMPLETE';
    } else {
      snapshot.stateCompleteness = 'COMPLETE';
      snapshot.quality = 'VALID';
    }
    // AC-232: missing tick state must not be assumed uniform; mark incomplete
    const result = toAdapterResult(snapshot);
    // Ensure validation passes even for incomplete (reasons present)
    return result;
  },
};
