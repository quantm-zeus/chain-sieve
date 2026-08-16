/**
 * @requirement FR-EXEC-013 FR-EXEC-015 FR-TRD-001
 * @acceptance AC-230 AC-231 AC-232
 *
 * Pool adapter boundary: typed canonical snapshot, explicit failures,
 * versioned registries, and deterministic normalization boundary.
 */

export type CurveType =
  | 'CONSTANT_PRODUCT'
  | 'CONCENTRATED_LIQUIDITY'
  | 'DISCRETE_BIN'
  | 'BONDING_CURVE'
  | 'STABLE_SWAP'
  | 'DYNAMIC_FEE'
  | 'AGGREGATED_ROUTE';

export type AdapterFamily =
  | 'CONSTANT_PRODUCT_AMM'
  | 'CONCENTRATED_LIQUIDITY_AMM'
  | 'DISCRETE_LIQUIDITY_BIN_AMM'
  | 'BONDING_CURVE'
  | 'STABLE_CURVE'
  | 'DYNAMIC_FEE_AMM'
  | 'AGGREGATED_MULTI_ROUTE_READ_ONLY';

export type PoolAdapterErrorCode =
  | 'UNSUPPORTED_POOL_TYPE'
  | 'UNSUPPORTED_PROGRAM_VERSION'
  | 'UNKNOWN_DEX'
  | 'UNKNOWN_CURVE'
  | 'INCOMPLETE_STATE'
  | 'MISSING_TICK_DATA'
  | 'MISSING_BIN_DATA'
  | 'MISSING_CURVE_DATA'
  | 'MISSING_RESERVES'
  | 'MISSING_ACCOUNT'
  | 'INVALID_LAYOUT'
  | 'POOL_MATH_UNSUPPORTED'
  | 'JUPITER_NOT_AUTHORITY'
  | 'DECODE_FAILURE';

export class PoolAdapterError extends Error {
  public readonly code: PoolAdapterErrorCode;
  constructor(code: PoolAdapterErrorCode, message: string) {
    super(message);
    this.name = 'PoolAdapterError';
    this.code = code;
  }
}

export interface CanonicalPoolSnapshot {
  poolId: string; // CHAIN:DEX:ADDRESS
  chainId: string;
  dex: string;
  poolAddress: string;
  programId: string;
  programVersion: string;
  curveType: CurveType;
  adapterId: string;
  adapterVersion: string;
  reserves: {
    baseRaw: string;
    quoteRaw: string;
    baseDecimals: number;
    quoteDecimals: number;
  };
  feeBps: number | null;
  // Family-specific state (validated per curveType)
  bondingCurve?: {
    virtualBaseReserves: string;
    virtualQuoteReserves: string;
    realBaseReserves: string;
    realQuoteReserves: string;
    progressBps: number; // 0..10000
  } | null;
  concentrated?: {
    currentTick: number;
    tickSpacing: number;
    ticksLoaded: number;
    ticksRequired: number;
    incomplete: boolean;
  } | null;
  bins?: {
    activeBinId: number;
    binsLoaded: number;
    binsRequired: number;
    incomplete: boolean;
  } | null;
  stable?: {
    ampFactor: number;
  } | null;
  dynamicFee?: {
    baseFeeBps: number;
    variableFeeBps: number;
  } | null;
  liquidityUsd: string | null;
  updatedAt: string; // ISO
  stateCompleteness: 'COMPLETE' | 'INCOMPLETE' | 'UNSUPPORTED';
  incompletenessReasons: string[];
  quality: 'VALID' | 'INCOMPLETE' | 'UNSUPPORTED';
  provenance: {
    source: string;
    rawHash: string;
    normalizedAt: string;
  };
}

export interface ProgramSupportManifest {
  manifestId: string;
  chainId: string;
  protocolFamily: string; // PUMP, RAYDIUM, ORCA, METEORA, JUPITER
  productFamily: string;
  programId: string;
  accountLayoutVersion: string;
  instructionLayoutVersion: string;
  decoderVersion: string;
  poolMathAdapterVersion: string | null;
  curveTypes: CurveType[];
  capabilityState: 'ACTIVE' | 'SHADOW' | 'DEGRADED' | 'UNAVAILABLE' | 'RETIRED';
  contentHash: string;
  validFrom: string;
  signed: boolean;
  adapterId: string;
}

export interface PoolAdapterInput {
  chainId: string;
  dex: string;
  programId: string;
  programVersion: string;
  curveType: CurveType;
  raw: unknown;
  layoutVersion?: string;
}

export interface AdapterResult {
  snapshot: CanonicalPoolSnapshot;
  canonicalJson: string;
  sha256: string;
}

export interface PoolAdapter {
  readonly adapterId: string;
  readonly version: string;
  readonly family: AdapterFamily;
  readonly supportedCurveTypes: CurveType[];
  normalize(input: PoolAdapterInput): AdapterResult;
}

// Economic trade normalization (FR-TRD-001)
export interface RawSwapHop {
  txHash: string;
  hopIndex: number;
  programId: string;
  fromMint: string;
  toMint: string;
  fromAmountRaw: string;
  toAmountRaw: string;
  actor: string; // wallet / router
  isAggregatorHop: boolean;
  innerHop?: boolean;
}

export interface EconomicTrade {
  tradeId: string;
  actor: string;
  baseMint: string;
  quoteMint: string;
  netBaseDeltaRaw: string;
  netQuoteDeltaRaw: string;
  legs: RawSwapHop[];
  hopCount: number;
  aggregated: boolean;
  provenance: string[];
}

export type TradeNormalizationErrorCode =
  | 'TRADE_MALFORMED'
  | 'TRADE_INCONSISTENT_ROUTE'
  | 'TRADE_EMPTY';

export class TradeNormalizationError extends Error {
  public readonly code: TradeNormalizationErrorCode;
  constructor(code: TradeNormalizationErrorCode, message: string) {
    super(message);
    this.name = 'TradeNormalizationError';
    this.code = code;
  }
}
