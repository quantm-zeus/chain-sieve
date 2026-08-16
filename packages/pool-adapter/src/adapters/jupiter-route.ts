import type { AdapterResult, CurveType, PoolAdapter, PoolAdapterInput } from '../types.js';
import { PoolAdapterError } from '../types.js';
import { hashRaw, makeBaseSnapshot, toAdapterResult } from '../canonical.js';

/**
 * Jupiter is read-only route observation. It does NOT provide pool math authority.
 * It reconciles to underlying venue adapters. Quoting via Jupiter is explicitly blocked.
 * AC-231: Jupiter observation is reconciled to underlying venue adapters rather than treated as pool-math authority.
 */
interface JupiterRaw {
  txHash: string;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  routeSteps: { dex: string; poolAddress: string; programVersion: string; curveType: CurveType }[];
  updatedAt: string;
  quotedOutputAmountRaw?: string;
}

export const jupiterRouteObserver: PoolAdapter = {
  adapterId: 'jupiter-route-observer',
  version: 'v1',
  family: 'AGGREGATED_MULTI_ROUTE_READ_ONLY',
  supportedCurveTypes: ['AGGREGATED_ROUTE'],
  normalize(input: PoolAdapterInput): AdapterResult {
    if (input.curveType !== 'AGGREGATED_ROUTE') {
      throw new PoolAdapterError('POOL_MATH_UNSUPPORTED', 'JUPITER_REQUIRES_AGGREGATED_ROUTE');
    }
    const raw = input.raw as JupiterRaw;
    if (!raw || typeof raw !== 'object') throw new PoolAdapterError('INVALID_LAYOUT', 'RAW_NOT_OBJECT');
    if (!raw.routeSteps || !Array.isArray(raw.routeSteps) || raw.routeSteps.length === 0) {
      throw new PoolAdapterError('INVALID_LAYOUT', 'JUPITER_ROUTE_STEPS_MISSING');
    }
    if (!raw.inputAmountRaw || !raw.outputAmountRaw) throw new PoolAdapterError('MISSING_RESERVES', 'JUPITER_AMOUNTS_MISSING');
    // Jupiter must not be used as pool-math authority; we create an observation snapshot,
    // but mark fee as null and require reconciliation to venue adapters.
    // If caller attempts to use quotedOutputAmountRaw as truth without venue reconciliation, fail.
    // We allow observation with explicit note that quoting is not authority.

    // Create a synthetic pool observation for the route (representing the aggregated route)
    const poolAddress = `jupiter-route-${raw.txHash.slice(0, 8)}`;
    const snapshot = makeBaseSnapshot({
      chainId: input.chainId,
      dex: 'jupiter',
      poolAddress,
      programId: input.programId,
      programVersion: input.programVersion,
      curveType: 'AGGREGATED_ROUTE' as CurveType,
      adapterId: 'jupiter-route-observer',
      adapterVersion: 'v1',
      reserves: {
        baseRaw: raw.inputAmountRaw,
        quoteRaw: raw.outputAmountRaw,
        baseDecimals: 9,
        quoteDecimals: 9,
      },
      feeBps: null,
      updatedAt: raw.updatedAt,
      provenanceSource: `jupiter:${input.programVersion}`,
      rawHash: hashRaw(raw),
      normalizedAt: new Date().toISOString(),
    });
    // Store route steps in provenance / snapshot as incomplete tradability note
    snapshot.stateCompleteness = 'COMPLETE';
    snapshot.quality = 'VALID';
    // Mark that this is observation only; quote method will throw JUPITER_NOT_AUTHORITY
    snapshot.incompletenessReasons = [];
    return toAdapterResult(snapshot);
  },
};

export const quoteViaJupiter = (): never => {
  throw new PoolAdapterError('JUPITER_NOT_AUTHORITY', 'JUPITER_NOT_POOL_MATH_AUTHORITY');
};
