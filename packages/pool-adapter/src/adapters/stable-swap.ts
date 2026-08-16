import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { assertAdapterInput, hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

interface StableRaw {
  poolAddress: string;
  baseReserveRaw: string;
  quoteReserveRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
  ampFactor: number;
  updatedAt: string;
}

export const stableSwapAdapter: PoolAdapter = {
  adapterId: 'stable-swap',
  version: 'v1',
  family: 'STABLE_CURVE',
  supportedCurveTypes: ['STABLE_SWAP'],
  normalize(input: PoolAdapterInput): AdapterResult {
    assertAdapterInput(input, {
      adapterId: 'stable-swap',
      supportedVersions: ['v1', '1'],
      supportedCurves: ['STABLE_SWAP'],
    });
    const raw = input.raw as StableRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.poolAddress) throw new PoolAdapterError('MISSING_ACCOUNT', 'POOL_ADDRESS_MISSING');
    if (!raw.baseReserveRaw || !raw.quoteReserveRaw) throw new PoolAdapterError('MISSING_RESERVES', 'RESERVES_MISSING');
    if (typeof raw.ampFactor !== 'number' || raw.ampFactor <= 0) {
      throw new PoolAdapterError('INVALID_LAYOUT', 'AMP_FACTOR_MALFORMED');
    }
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: input.dex,
      poolAddress: raw.poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'STABLE_SWAP' as CurveType,
      adapterId: 'stable-swap',
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
      normalizedAt: raw.updatedAt,
    });
    snapshot.stable = { ampFactor: raw.ampFactor };
    snapshot.stateCompleteness = 'COMPLETE';
    snapshot.quality = 'VALID';
    return toAdapterResult(snapshot);
  },
};
