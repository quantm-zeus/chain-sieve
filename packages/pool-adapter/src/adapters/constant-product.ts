import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface ConstantProductRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  updatedAt: string;
}

export const constantProductAdapter: PoolAdapter = {
  adapterId: 'constant-product',
  version: 'v1',
  family: 'CONSTANT_PRODUCT_AMM',
  supportedCurveTypes: ['CONSTANT_PRODUCT'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'constant-product',
      supportedVersions: ['v4', 'v1', '1', '4'],
      supportedCurves: ['CONSTANT_PRODUCT'],
    });
    const raw = input.raw as ConstantProductRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    if (!/^\d+$/.test(raw.baseReserveRaw) || !/^\d+$/.test(raw.quoteReserveRaw)) {
      throw new PoolAdapterError('INVALID_LAYOUT', 'RESERVES_MALFORMED');
    }
    // PumpSwap/Raydium AMM use constant-product validation
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'CONSTANT_PRODUCT' as CurveType,
      adapterId: 'constant-product',
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
    snapshot.liquidityUsd = null;
    return toAdapterResult(snapshot);
  },
};
