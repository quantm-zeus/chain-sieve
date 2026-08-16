import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface DynamicFeeRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseFeeBps: number;
  variableFeeBps: number;
  feeBps?: number;
  updatedAt: string;
}

export const dynamicFeeAdapter: PoolAdapter = {
  adapterId: 'dynamic-fee',
  version: 'v1',
  family: 'DYNAMIC_FEE_AMM',
  supportedCurveTypes: ['DYNAMIC_FEE', 'CONSTANT_PRODUCT'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'dynamic-fee',
      supportedVersions: ['v1', 'v2', '1', '2'],
      supportedCurves: ['DYNAMIC_FEE', 'CONSTANT_PRODUCT'],
    });
    const raw = input.raw as DynamicFeeRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    if (typeof raw.baseFeeBps !== 'number' || typeof raw.variableFeeBps !== 'number') {
      throw new PoolAdapterError('INVALID_LAYOUT', 'DYNAMIC_FEE_MALFORMED');
    }
    if (raw.baseFeeBps < 0 || raw.variableFeeBps < 0) throw new PoolAdapterError('INVALID_LAYOUT', 'FEE_NEGATIVE');
    const totalFee = raw.baseFeeBps + raw.variableFeeBps;
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: input.curveType as CurveType,
      adapterId: 'dynamic-fee',
      adapterVersion: 'v1',
      reserves: {
        baseRaw: raw.baseReserveRaw,
        quoteRaw: raw.quoteReserveRaw,
        baseDecimals: raw.baseDecimals,
        quoteDecimals: raw.quoteDecimals,
      },
      feeBps: totalFee,
      updatedAt: raw.updatedAt,
      provenanceSource: `${input.dex}:${input.programVersion}`,
      rawHash: hashRaw(raw),
      normalizedAt: new Date().toISOString(),
    });
    snapshot.dynamicFee = {
      baseFeeBps: raw.baseFeeBps,
      variableFeeBps: raw.variableFeeBps,
    };
    snapshot.stateCompleteness = 'COMPLETE';
    snapshot.quality = 'VALID';
    return toAdapterResult(snapshot);
  },
};
