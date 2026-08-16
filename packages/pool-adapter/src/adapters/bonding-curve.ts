import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface BondingCurveRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  virtualBaseReserves: string;
  virtualQuoteReserves: string;
  realBaseReserves: string;
  realQuoteReserves: string;
  progressBps: number;
  feeBps: number;
  updatedAt: string;
}

export const bondingCurveAdapter: PoolAdapter = {
  adapterId: 'pump-bonding-curve',
  version: 'v1',
  family: 'BONDING_CURVE',
  supportedCurveTypes: ['BONDING_CURVE'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'pump-bonding-curve',
      supportedVersions: ['v1', '1'],
      supportedCurves: ['BONDING_CURVE'],
    });
    const raw = input.raw as BondingCurveRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.virtualBaseReserves || !raw.virtualQuoteReserves || !raw.realBaseReserves || !raw.realQuoteReserves) {
      throw new PoolAdapterError('MISSING_CURVE_DATA', 'BONDING_CURVE_MISSING');
    }
    for (const v of [raw.virtualBaseReserves, raw.virtualQuoteReserves, raw.realBaseReserves, raw.realQuoteReserves]) {
      if (!/^\d+$/.test(v)) throw new PoolAdapterError('INVALID_LAYOUT', 'BONDING_RESERVES_MALFORMED');
    }
    if (typeof raw.progressBps !== 'number' || raw.progressBps < 0 || raw.progressBps > 10000) {
      throw new PoolAdapterError('INVALID_LAYOUT', 'PROGRESS_BPS_MALFORMED');
    }
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'BONDING_CURVE' as CurveType,
      adapterId: 'pump-bonding-curve',
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
    snapshot.bondingCurve = {
      virtualBaseReserves: raw.virtualBaseReserves,
      virtualQuoteReserves: raw.virtualQuoteReserves,
      realBaseReserves: raw.realBaseReserves,
      realQuoteReserves: raw.realQuoteReserves,
      progressBps: raw.progressBps,
    };
    // State is complete only if all reserves present
    snapshot.stateCompleteness = 'COMPLETE';
    snapshot.quality = 'VALID';
    return toAdapterResult(snapshot);
  },
};
