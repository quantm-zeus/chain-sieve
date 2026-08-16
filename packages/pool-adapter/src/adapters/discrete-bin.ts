import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface BinRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  activeBinId: number;
  bins: { binId: number; reserveX: string; reserveY: string }[] | null | undefined;
  binsRequired?: number;
  updatedAt: string;
}

export const discreteBinAdapter: PoolAdapter = {
  adapterId: 'discrete-bin',
  version: 'v1',
  family: 'DISCRETE_LIQUIDITY_BIN_AMM',
  supportedCurveTypes: ['DISCRETE_BIN'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'discrete-bin',
      supportedVersions: ['v1', '1'],
      supportedCurves: ['DISCRETE_BIN'],
    });
    const raw = input.raw as BinRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    if (typeof raw.activeBinId !== 'number') throw new PoolAdapterError('INVALID_LAYOUT', 'ACTIVE_BIN_MALFORMED');
    const binsLoaded = raw.bins ? raw.bins.length : 0;
    const binsRequired = raw.binsRequired ?? 5;
    const incomplete = !raw.bins || binsLoaded < binsRequired;
    if (raw.bins) {
      for (const b of raw.bins) {
        if (!/^\d+$/.test(b.reserveX) || !/^\d+$/.test(b.reserveY)) {
          throw new PoolAdapterError('INVALID_LAYOUT', 'BIN_RESERVES_MALFORMED');
        }
      }
    }
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'DISCRETE_BIN' as CurveType,
      adapterId: 'discrete-bin',
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
    snapshot.bins = {
      activeBinId: raw.activeBinId,
      binsLoaded,
      binsRequired,
      incomplete,
    };
    if (incomplete) {
      snapshot.stateCompleteness = 'INCOMPLETE';
      snapshot.incompletenessReasons = ['MISSING_BIN_DATA'];
      snapshot.quality = 'INCOMPLETE';
    } else {
      snapshot.stateCompleteness = 'COMPLETE';
      snapshot.quality = 'VALID';
    }
    return toAdapterResult(snapshot);
  },
};
