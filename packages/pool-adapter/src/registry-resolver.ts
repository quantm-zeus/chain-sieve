import { PoolAdapterError } from './types.js';
import type { CurveType, PoolAdapter, PoolAdapterInput } from './types.js';
import { constantProductAdapter } from './adapters/constant-product.js';
import { bondingCurveAdapter } from './adapters/bonding-curve.js';
import { concentratedLiquidityAdapter } from './adapters/concentrated-liquidity.js';
import { discreteBinAdapter } from './adapters/discrete-bin.js';
import { stableSwapAdapter } from './adapters/stable-swap.js';
import { dynamicFeeAdapter } from './adapters/dynamic-fee.js';
import { jupiterRouteObserver } from './adapters/jupiter-route.js';

type RegistryEntry = {
  dexMatchers: string[]; // lower case dex names
  programVersions: string[];
  curveTypes: CurveType[];
  adapter: PoolAdapter;
};

const REGISTRY: RegistryEntry[] = [
  {
    dexMatchers: ['pumpswap', 'raydium'],
    programVersions: ['v4', 'v1', '1', '4'],
    curveTypes: ['CONSTANT_PRODUCT'],
    adapter: constantProductAdapter,
  },
  {
    dexMatchers: ['pump', 'raydium-launchlab', 'meteora-dbc'],
    programVersions: ['v1', '1'],
    curveTypes: ['BONDING_CURVE'],
    adapter: bondingCurveAdapter,
  },
  {
    dexMatchers: ['raydium-clmm', 'raydium', 'orca', 'orca-whirlpools'],
    programVersions: ['v1', '1'],
    curveTypes: ['CONCENTRATED_LIQUIDITY'],
    adapter: concentratedLiquidityAdapter,
  },
  {
    dexMatchers: ['meteora-dlmm', 'meteora', 'dlmm'],
    programVersions: ['v1', '1'],
    curveTypes: ['DISCRETE_BIN'],
    adapter: discreteBinAdapter,
  },
  {
    dexMatchers: ['raydium-stable', 'stable'],
    programVersions: ['v1', '1'],
    curveTypes: ['STABLE_SWAP'],
    adapter: stableSwapAdapter,
  },
  {
    dexMatchers: ['meteora-damm', 'meteora', 'damm'],
    programVersions: ['v1', 'v2', '1', '2'],
    curveTypes: ['DYNAMIC_FEE', 'CONSTANT_PRODUCT'],
    adapter: dynamicFeeAdapter,
  },
  {
    dexMatchers: ['jupiter'],
    programVersions: ['v6', '6'],
    curveTypes: ['AGGREGATED_ROUTE'],
    adapter: jupiterRouteObserver,
  },
];

const matchDex = (dex: string, matchers: string[]): boolean => {
  const lower = dex.toLowerCase();
  return matchers.some((m) => lower === m || lower.includes(m) || m.includes(lower));
};

export const resolvePoolAdapter = (input: PoolAdapterInput): PoolAdapter => {
  // Exact match: find entry where dex matches and version and curve match
  for (const entry of REGISTRY) {
    if (
      matchDex(input.dex, entry.dexMatchers) &&
      entry.programVersions.includes(input.programVersion) &&
      entry.curveTypes.includes(input.curveType)
    ) {
      return entry.adapter;
    }
  }
  // Check if dex known but version/curve mismatch -> explicit typed error, not generic fallback
  const knownDex = REGISTRY.some((e) => matchDex(input.dex, e.dexMatchers));
  if (knownDex) {
    // Determine if version unsupported
    const versionKnown = REGISTRY.some((e) => matchDex(input.dex, e.dexMatchers) && e.programVersions.includes(input.programVersion));
    if (!versionKnown) {
      throw new PoolAdapterError('UNSUPPORTED_PROGRAM_VERSION', `UNSUPPORTED_VERSION:${input.dex}@${input.programVersion}`);
    }
    throw new PoolAdapterError('UNKNOWN_CURVE', `CURVE_MISMATCH:${input.dex}:${input.curveType}`);
  }
  throw new PoolAdapterError('UNSUPPORTED_POOL_TYPE', `UNSUPPORTED_POOL_TYPE:${input.dex}@${input.programVersion}:${input.curveType}`);
};

export const normalizePool = (input: PoolAdapterInput) => {
  const adapter = resolvePoolAdapter(input);
  return adapter.normalize(input);
};

export const listSupportedAdapters = (): string[] => [...new Set(REGISTRY.map((r) => r.adapter.adapterId))];
