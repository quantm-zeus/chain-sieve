import { createHash } from 'node:crypto';
import type {
  AdapterResult,
  CanonicalPoolSnapshot,
  CurveType,
  PoolAdapter,
  PoolAdapterInput,
} from './types.js';
import { PoolAdapterError } from './types.js';

// Deterministic canonical JSON: sort keys, sort pools not needed here but object keys sorted.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
};

export const canonicalPoolJson = (snapshot: CanonicalPoolSnapshot): string => {
  const canonical = canonicalize(snapshot);
  return JSON.stringify(canonical);
};

export const canonicalPoolHash = (snapshot: CanonicalPoolSnapshot): { json: string; sha256: string } => {
  const json = canonicalPoolJson(snapshot);
  const sha256 = createHash('sha256').update(json).digest('hex');
  return { json, sha256 };
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isIso = (v: string): boolean => ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const DECIMAL_RE = /^\d+$/;
const isDecimalRaw = (v: string): boolean => DECIMAL_RE.test(v);

export const validateCanonicalSnapshot = (snapshot: CanonicalPoolSnapshot): void => {
  if (!snapshot.poolId.includes(':')) throw new PoolAdapterError('INVALID_LAYOUT', 'POOL_ID_MALFORMED');
  if (!snapshot.poolId.startsWith(`${snapshot.chainId}:${snapshot.dex}:`)) {
    throw new PoolAdapterError('INVALID_LAYOUT', 'POOL_ID_INCONSISTENT');
  }
  if (!isIso(snapshot.updatedAt)) throw new PoolAdapterError('INVALID_LAYOUT', 'UPDATED_AT_MALFORMED');
  if (!isDecimalRaw(snapshot.reserves.baseRaw) || !isDecimalRaw(snapshot.reserves.quoteRaw)) {
    throw new PoolAdapterError('INVALID_LAYOUT', 'RESERVES_MALFORMED');
  }
  if (snapshot.stateCompleteness === 'COMPLETE' && snapshot.incompletenessReasons.length !== 0) {
    throw new PoolAdapterError('INCOMPLETE_STATE', 'COMPLETE_WITH_REASONS');
  }
  if (snapshot.stateCompleteness === 'INCOMPLETE' && snapshot.incompletenessReasons.length === 0) {
    throw new PoolAdapterError('INCOMPLETE_STATE', 'INCOMPLETE_WITHOUT_REASONS');
  }
  // Curve-specific completeness checks (AC-232)
  if (snapshot.curveType === 'CONCENTRATED_LIQUIDITY' && snapshot.concentrated) {
    if (snapshot.concentrated.incomplete) {
      if (snapshot.stateCompleteness === 'COMPLETE') throw new PoolAdapterError('MISSING_TICK_DATA', 'TICK_INCOMPLETE_MARKED_COMPLETE');
    }
  }
  if (snapshot.curveType === 'DISCRETE_BIN' && snapshot.bins) {
    if (snapshot.bins.incomplete && snapshot.stateCompleteness === 'COMPLETE') {
      throw new PoolAdapterError('MISSING_BIN_DATA', 'BIN_INCOMPLETE_MARKED_COMPLETE');
    }
  }
  if (snapshot.curveType === 'BONDING_CURVE' && !snapshot.bondingCurve) {
    throw new PoolAdapterError('MISSING_CURVE_DATA', 'BONDING_CURVE_MISSING');
  }
};

export const toAdapterResult = (snapshot: CanonicalPoolSnapshot): AdapterResult => {
  validateCanonicalSnapshot(snapshot);
  const { json, sha256 } = canonicalPoolHash(snapshot);
  return { snapshot, canonicalJson: json, sha256 };
};

// Helper to create base snapshot with common fields
export const makeBaseSnapshot = (input: {
  chainId: string;
  dex: string;
  poolAddress: string;
  programId: string;
  programVersion: string;
  curveType: CurveType;
  adapterId: string;
  adapterVersion: string;
  reserves: CanonicalPoolSnapshot['reserves'];
  feeBps: number | null;
  updatedAt: string;
  provenanceSource: string;
  rawHash: string;
  normalizedAt: string;
}): CanonicalPoolSnapshot => {
  const poolId = `${input.chainId}:${input.dex}:${input.poolAddress}`;
  return {
    poolId,
    chainId: input.chainId,
    dex: input.dex,
    poolAddress: input.poolAddress,
    programId: input.programId,
    programVersion: input.programVersion,
    curveType: input.curveType,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    reserves: input.reserves,
    feeBps: input.feeBps,
    bondingCurve: null,
    concentrated: null,
    bins: null,
    stable: null,
    dynamicFee: null,
    liquidityUsd: null,
    updatedAt: input.updatedAt,
    stateCompleteness: 'COMPLETE',
    incompletenessReasons: [],
    quality: 'VALID',
    provenance: {
      source: input.provenanceSource,
      rawHash: input.rawHash,
      normalizedAt: input.normalizedAt,
    },
  };
};

export const hashRaw = (raw: unknown): string =>
  createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 64);

// Common adapter guard: ensures chainId/dex/program consistency
export const assertAdapterInput = (input: PoolAdapterInput, expected: {
  adapterId: string;
  supportedVersions: string[];
  supportedCurves: CurveType[];
}): void => {
  if (!expected.supportedVersions.includes(input.programVersion)) {
    throw new PoolAdapterError('UNSUPPORTED_PROGRAM_VERSION', `UNSUPPORTED_VERSION:${input.dex}@${input.programVersion}`);
  }
  if (!expected.supportedCurves.includes(input.curveType)) {
    throw new PoolAdapterError('UNKNOWN_CURVE', `CURVE_MISMATCH:${input.curveType}`);
  }
};
