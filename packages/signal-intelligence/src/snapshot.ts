/**
 * @requirement FR-DATA-004 - Online/offline feature consistency via byte-stable canonical snapshots
 * @requirement FR-SIG-001 - Versioned Feature Registry / Snapshot identity
 * @requirement FR-SIG-009 - Numeric stability controls
 *
 * Canonical market/pool snapshots with reproducible serialization and deterministic validation.
 * Equivalent ordered input state (reordered pools, reordered object keys) MUST produce byte-identical output.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataQualityCode =
  | 'VALID'
  | 'LOW_SAMPLE'
  | 'INSUFFICIENT_DATA'
  | 'STALE'
  | 'PARTIAL'
  | 'ESTIMATED'
  | 'CONFLICTING'
  | 'GAP_AFFECTED';

export interface PoolLiquiditySnapshot {
  poolId: string; // CHAIN:DEX:ADDRESS
  chainId: string;
  dex: string;
  poolAddress: string;
  liquidityUsd: string; // decimal string, non-negative
  volumeUsd24h: string; // decimal string, non-negative
  quoteAssetRepresentationId: string | null;
  updatedAt: string; // ISO datetime, must be <= snapshot.asOf
  quality: DataQualityCode;
}

export interface MarketState {
  priceUsd: string; // decimal string
  volumeUsd24h: string;
  marketCapUsd: string | null;
  updatedAt: string;
}

export interface SnapshotProvenance {
  observationIds: string[];
  evidenceHashes: string[]; // sha256 hex
  collectedAt: string; // ISO datetime
}

export interface MarketSnapshot {
  snapshotId: string; // assetId + asOf
  assetId: string;
  chainId: string;
  asOf: string; // ISO datetime - point-in-time projection bound
  version: string; // snapshot schema version, e.g. "1.0.0"
  pools: PoolLiquiditySnapshot[];
  market: MarketState;
  provenance: SnapshotProvenance;
  quality: DataQualityCode;
}

export interface CanonicalSnapshotOutput {
  canonicalJson: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Validation errors - deterministic codes
// ---------------------------------------------------------------------------

export class SnapshotValidationError extends Error {
  constructor(
    public readonly code:
      | 'SNAPSHOT_MALFORMED'
      | 'SNAPSHOT_INCOMPLETE'
      | 'SNAPSHOT_INCONSISTENT',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const POOL_ID_RE = /^.+:[^:]+:[^:]+$/;

const isValidIso = (v: string): boolean =>
  ISO_DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v));

const isValidDecimal = (v: string): boolean =>
  DECIMAL_RE.test(v) && Number.isFinite(Number(v)) && Number(v) >= 0;

const isValidPoolId = (v: string): boolean => POOL_ID_RE.test(v);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const validatePoolSnapshot = (pool: unknown): void => {
  if (pool === null || typeof pool !== 'object')
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_NOT_OBJECT');
  const p = pool as Record<string, unknown>;

  const required = [
    'poolId',
    'chainId',
    'dex',
    'poolAddress',
    'liquidityUsd',
    'volumeUsd24h',
    'updatedAt',
    'quality',
  ] as const;

  for (const key of required) {
    if (!(key in p) || p[key] === undefined || p[key] === null) {
      if (key === 'quality' && p[key] === undefined) {
        // quality is required
        throw new SnapshotValidationError('SNAPSHOT_INCOMPLETE', `POOL_MISSING_${key}`);
      }
      if (p[key] === undefined || p[key] === null) {
        throw new SnapshotValidationError('SNAPSHOT_INCOMPLETE', `POOL_MISSING_${key}`);
      }
    }
  }

  if (typeof p.poolId !== 'string' || !isValidPoolId(p.poolId))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_ID_MALFORMED');
  if (typeof p.chainId !== 'string' || p.chainId.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_CHAIN_ID_MALFORMED');
  if (typeof p.dex !== 'string' || p.dex.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_DEX_MALFORMED');
  if (typeof p.poolAddress !== 'string' || p.poolAddress.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_ADDRESS_MALFORMED');
  if (typeof p.liquidityUsd !== 'string' || !isValidDecimal(p.liquidityUsd))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_LIQUIDITY_MALFORMED');
  if (typeof p.volumeUsd24h !== 'string' || !isValidDecimal(p.volumeUsd24h))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_VOLUME_MALFORMED');
  if (typeof p.updatedAt !== 'string' || !isValidIso(p.updatedAt))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_UPDATED_AT_MALFORMED');
  if (typeof p.quality !== 'string' || !isValidQuality(p.quality))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_QUALITY_MALFORMED');
  if (
    p.quoteAssetRepresentationId !== null &&
    p.quoteAssetRepresentationId !== undefined &&
    typeof p.quoteAssetRepresentationId !== 'string'
  )
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOL_QUOTE_ID_MALFORMED');
};

const VALID_QUALITY = new Set<string>([
  'VALID',
  'LOW_SAMPLE',
  'INSUFFICIENT_DATA',
  'STALE',
  'PARTIAL',
  'ESTIMATED',
  'CONFLICTING',
  'GAP_AFFECTED',
]);
const isValidQuality = (v: string): boolean => VALID_QUALITY.has(v);

export const validateSnapshot = (snapshot: unknown): MarketSnapshot => {
  if (snapshot === null || typeof snapshot !== 'object')
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'SNAPSHOT_NOT_OBJECT');
  const s = snapshot as Record<string, unknown>;

  const requiredTop = ['snapshotId', 'assetId', 'chainId', 'asOf', 'version', 'pools', 'market', 'provenance', 'quality'] as const;
  for (const key of requiredTop) {
    if (!(key in s) || s[key] === undefined || s[key] === null) {
      throw new SnapshotValidationError('SNAPSHOT_INCOMPLETE', `MISSING_${key}`);
    }
  }

  if (typeof s.snapshotId !== 'string' || s.snapshotId.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'SNAPSHOT_ID_MALFORMED');
  if (typeof s.assetId !== 'string' || s.assetId.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'ASSET_ID_MALFORMED');
  if (typeof s.chainId !== 'string' || s.chainId.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'CHAIN_ID_MALFORMED');
  if (typeof s.asOf !== 'string' || !isValidIso(s.asOf))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'AS_OF_MALFORMED');
  if (typeof s.version !== 'string' || s.version.length === 0)
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'VERSION_MALFORMED');
  if (!Array.isArray(s.pools))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'POOLS_NOT_ARRAY');
  if (typeof s.quality !== 'string' || !isValidQuality(s.quality))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'QUALITY_MALFORMED');

  // market
  if (s.market === null || typeof s.market !== 'object')
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'MARKET_NOT_OBJECT');
  const m = s.market as Record<string, unknown>;
  for (const k of ['priceUsd', 'volumeUsd24h', 'updatedAt'] as const) {
    if (!(k in m) || m[k] === undefined || m[k] === null)
      throw new SnapshotValidationError('SNAPSHOT_INCOMPLETE', `MARKET_MISSING_${k}`);
  }
  if (typeof m.priceUsd !== 'string' || !isValidDecimal(m.priceUsd))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'MARKET_PRICE_MALFORMED');
  if (typeof m.volumeUsd24h !== 'string' || !isValidDecimal(m.volumeUsd24h))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'MARKET_VOLUME_MALFORMED');
  if (m.marketCapUsd !== null && m.marketCapUsd !== undefined && (typeof m.marketCapUsd !== 'string' || !isValidDecimal(m.marketCapUsd as string)))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'MARKET_CAP_MALFORMED');
  if (typeof m.updatedAt !== 'string' || !isValidIso(m.updatedAt))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'MARKET_UPDATED_AT_MALFORMED');

  // provenance
  if (s.provenance === null || typeof s.provenance !== 'object')
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'PROVENANCE_NOT_OBJECT');
  const prov = s.provenance as Record<string, unknown>;
  if (!Array.isArray(prov.observationIds) || !Array.isArray(prov.evidenceHashes))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'PROVENANCE_ARRAYS_MALFORMED');
  if (typeof prov.collectedAt !== 'string' || !isValidIso(prov.collectedAt as string))
    throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'PROVENANCE_COLLECTED_AT_MALFORMED');
  for (const h of prov.evidenceHashes as unknown[]) {
    if (typeof h !== 'string' || !SHA256_RE.test(h))
      throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'PROVENANCE_HASH_MALFORMED');
  }
  for (const id of prov.observationIds as unknown[]) {
    if (typeof id !== 'string' || id.length === 0)
      throw new SnapshotValidationError('SNAPSHOT_MALFORMED', 'PROVENANCE_OBSERVATION_ID_MALFORMED');
  }

  // pools validation
  const pools = s.pools as unknown[];
  for (const p of pools) validatePoolSnapshot(p);

  // Consistency checks (deterministic)
  const asOfMs = Date.parse(s.asOf as string);
  const marketUpdatedMs = Date.parse(m.updatedAt as string);
  if (marketUpdatedMs > asOfMs)
    throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'MARKET_UPDATED_AFTER_AS_OF');

  const poolIds = new Set<string>();
  for (const p of pools as PoolLiquiditySnapshot[]) {
    if (poolIds.has(p.poolId))
      throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'DUPLICATE_POOL_ID');
    poolIds.add(p.poolId);
    if (p.chainId !== s.chainId)
      throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'POOL_CHAIN_MISMATCH');
    const updatedMs = Date.parse(p.updatedAt);
    if (updatedMs > asOfMs)
      throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'POOL_UPDATED_AFTER_AS_OF');
    // poolId must embed chainId and dex (basic consistency)
    if (!p.poolId.startsWith(`${p.chainId}:${p.dex}:`))
      throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'POOL_ID_INCONSISTENT');
  }

  // snapshotId should be deterministic: assetId:asOf (enforce)
  const expectedId = `${s.assetId}:${s.asOf}`;
  if (s.snapshotId !== expectedId) {
    throw new SnapshotValidationError('SNAPSHOT_INCONSISTENT', 'SNAPSHOT_ID_INCONSISTENT');
  }

  return s as unknown as MarketSnapshot;
};

// ---------------------------------------------------------------------------
// Canonical serialization - byte-stable
// ---------------------------------------------------------------------------

/**
 * Recursively canonicalize: sort object keys lexicographically, sort pools by poolId.
 * Arrays of pools are sorted; other arrays retain order but have elements canonicalized.
 * This guarantees equivalent ordered input state produces identical bytes.
 */
const canonicalize = (value: unknown, sortPools: boolean): unknown => {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => canonicalize(v, sortPools));
    // If this looks like a pool array (elements have poolId), sort deterministically
    if (sortPools && mapped.length > 0 && typeof mapped[0] === 'object' && mapped[0] !== null && 'poolId' in (mapped[0] as Record<string, unknown>)) {
      return (mapped as Array<Record<string, unknown>>).sort((a, b) =>
        String(a.poolId).localeCompare(String(b.poolId)),
      );
    }
    return mapped;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([k, v]) => [k, canonicalize(v, sortPools)] as const);
    return Object.fromEntries(entries);
  }
  return value;
};

export const canonicalSnapshotJson = (snapshot: MarketSnapshot): string => {
  // Validate first - deterministic rejection
  validateSnapshot(snapshot);
  // Create a shallow copy with pools sorted by poolId (pre-sort for explicitness)
  const sortedPools = [...snapshot.pools].sort((a, b) => a.poolId.localeCompare(b.poolId));
  const withSortedPools: MarketSnapshot = { ...snapshot, pools: sortedPools };
  const canonical = canonicalize(withSortedPools, true);
  return JSON.stringify(canonical);
};

export const canonicalSnapshotBytes = (snapshot: MarketSnapshot): CanonicalSnapshotOutput => {
  const json = canonicalSnapshotJson(snapshot);
  const bytes = new TextEncoder().encode(json);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { canonicalJson: json, sha256, bytes: bytes.byteLength };
};

export const snapshotEquals = (a: MarketSnapshot, b: MarketSnapshot): boolean =>
  canonicalSnapshotBytes(a).sha256 === canonicalSnapshotBytes(b).sha256;
