/**
 * @requirement FR-DATA-001
 * Canonical asset, pool, and migration identity.
 * Symbols and names are never identifiers. Chain + canonical address identifies
 * an asset representation. Pool identity is chain + DEX + pool address.
 * Address normalization is chain-specific. Decimals and USD conversions are
 * versioned and provenance-tracked. CAIP-2/CAIP-10 mapping with explicit
 * quality states. Migration lineage prevents double counting.
 */

export type ChainNamespace = 'eip155' | 'solana' | 'internal';

export interface ChainIdentity {
  chainId: string;
  namespace: ChainNamespace;
  caip2: string | null;
  mappingQuality: 'REGISTERED' | 'INTERNAL_VERSIONED';
}

const KNOWN_CAIP2 = new Map<string, string>([
  ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
  ['eip155:1', 'eip155:1'],
  ['eip155:137', 'eip155:137'],
]);

export const canonicalChainId = (chainId: string): ChainIdentity => {
  const caip2 = KNOWN_CAIP2.get(chainId) ?? null;
  if (caip2) return { chainId, namespace: chainId.startsWith('eip155') ? 'eip155' : 'solana', caip2, mappingQuality: 'REGISTERED' };
  return { chainId, namespace: 'internal', caip2: null, mappingQuality: 'INTERNAL_VERSIONED' };
};

export const normalizeAddress = (chainId: string, address: string): string => {
  if (!address || typeof address !== 'string') throw new Error('ADDRESS_REQUIRED');
  const chain = canonicalChainId(chainId);
  if (chain.namespace === 'eip155') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('EVM_ADDRESS_INVALID');
    return address.toLowerCase();
  }
  if (chain.namespace === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('SOLANA_ADDRESS_INVALID');
    return address;
  }
  return address.trim();
};

export const toCaip10 = (chainId: string, address: string): string | null => {
  const chain = canonicalChainId(chainId);
  if (chain.caip2 === null) return null;
  const normalized = normalizeAddress(chainId, address);
  return `${chain.caip2}:${normalized}`;
};

export interface AssetRepresentation {
  representationId: string;
  chainId: string;
  canonicalContractAddress: string;
  caip10: string | null;
  decimals: number;
  decimalsVersion: string;
  decimalsSource: string;
  symbol: string | null;
  name: string | null;
}

export const createAssetRepresentation = (input: {
  chainId: string;
  contractAddress: string;
  decimals: number;
  decimalsVersion: string;
  decimalsSource: string;
  symbol?: string | null;
  name?: string | null;
}): AssetRepresentation => {
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) throw new Error('DECIMALS_INVALID');
  const canonical = normalizeAddress(input.chainId, input.contractAddress);
  const chain = canonicalChainId(input.chainId);
  return {
    representationId: `${input.chainId}:${canonical}`,
    chainId: input.chainId,
    canonicalContractAddress: canonical,
    caip10: chain.caip2 ? `${chain.caip2}:${canonical}` : null,
    decimals: input.decimals,
    decimalsVersion: input.decimalsVersion,
    decimalsSource: input.decimalsSource,
    symbol: input.symbol ?? null,
    name: input.name ?? null,
  };
};

export interface AssetGroup {
  assetId: string;
  representationIds: string[];
  equivalenceVerified: boolean;
  equivalenceProof: string | null;
}

export const createAssetGroup = (input: { assetId: string; representations: AssetRepresentation[]; equivalenceProof?: string | null }): AssetGroup => {
  if (input.representations.length === 0) throw new Error('ASSET_GROUP_EMPTY');
  const distinctChains = new Set(input.representations.map((r) => r.chainId));
  const verified = input.representations.length > 1 ? Boolean(input.equivalenceProof) : true;
  if (input.representations.length > 1 && !verified) throw new Error('EQUIVALENCE_UNVERIFIED');
  return {
    assetId: input.assetId,
    representationIds: input.representations.map((r) => r.representationId),
    equivalenceVerified: verified,
    equivalenceProof: input.equivalenceProof ?? null,
  };
};

export interface PoolIdentity {
  poolId: string;
  chainId: string;
  dex: string;
  poolAddress: string;
  caip10: string | null;
  quoteAssetRepresentationId: string | null;
}

export const createPoolIdentity = (input: {
  chainId: string;
  dex: string;
  poolAddress: string;
  quoteAssetRepresentationId?: string | null;
}): PoolIdentity => {
  if (!input.dex) throw new Error('DEX_REQUIRED');
  const canonical = normalizeAddress(input.chainId, input.poolAddress);
  const chain = canonicalChainId(input.chainId);
  return {
    poolId: `${input.chainId}:${input.dex}:${canonical}`,
    chainId: input.chainId,
    dex: input.dex,
    poolAddress: canonical,
    caip10: chain.caip2 ? `${chain.caip2}:${canonical}` : null,
    quoteAssetRepresentationId: input.quoteAssetRepresentationId ?? null,
  };
};

export interface QuoteConversion {
  quoteAssetRepresentationId: string;
  usdPerQuoteUnit: string;
  source: string;
  observedAt: string;
  quality: 'VALID' | 'STALE' | 'DEPEG' | 'ESTIMATED';
}

export const createQuoteConversion = (input: QuoteConversion): QuoteConversion => {
  if (Number.isNaN(Number(input.usdPerQuoteUnit))) throw new Error('QUOTE_CONVERSION_INVALID');
  return input;
};

export interface TokenAmount {
  raw: string;
  decimals: number;
}

export const parseTokenAmount = (raw: string, decimals: number): TokenAmount => {
  if (!/^\d+$/.test(raw)) throw new Error('TOKEN_AMOUNT_INVALID');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('DECIMALS_INVALID');
  return { raw, decimals };
};

export interface MigrationEvent {
  migrationId: string;
  launchPoolId: string;
  migratedPoolId: string;
  eventAt: string;
  txHash: string | null;
}

export const createMigrationEdge = (input: MigrationEvent): MigrationEvent => {
  if (input.launchPoolId === input.migratedPoolId) throw new Error('MIGRATION_SELF_LOOP');
  return input;
};

export interface MigrationLineage {
  launchPoolId: string;
  migrationEvent: MigrationEvent;
  migratedPoolId: string;
}

export const lineagePools = (lineage: MigrationLineage): readonly string[] => [lineage.launchPoolId, lineage.migratedPoolId];

export interface PoolCanonicalizationInput {
  poolId: string;
  verifiedRepresentation: boolean;
  supportedDex: boolean;
  quoteAssetQuality: number;
  usableLiquidityUsd: string;
  recentRealVolumeUsd: string;
  poolAgeMs: number;
  migrationLineageVerified: boolean;
  manipulationRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  providerAgreementCount: number;
}

export const rankPoolCandidates = (candidates: PoolCanonicalizationInput[]): PoolCanonicalizationInput[] =>
  [...candidates].sort((a, b) => {
    if (a.verifiedRepresentation !== b.verifiedRepresentation) return a.verifiedRepresentation ? -1 : 1;
    if (a.supportedDex !== b.supportedDex) return a.supportedDex ? -1 : 1;
    if (a.quoteAssetQuality !== b.quoteAssetQuality) return b.quoteAssetQuality - a.quoteAssetQuality;
    const liqDiff = Number(b.usableLiquidityUsd) - Number(a.usableLiquidityUsd);
    if (liqDiff !== 0) return liqDiff;
    const volDiff = Number(b.recentRealVolumeUsd) - Number(a.recentRealVolumeUsd);
    if (volDiff !== 0) return volDiff;
    if (a.poolAgeMs !== b.poolAgeMs) return b.poolAgeMs - a.poolAgeMs;
    if (a.migrationLineageVerified !== b.migrationLineageVerified) return a.migrationLineageVerified ? -1 : 1;
    const riskOrder = { LOW: 0, MEDIUM: 1, UNKNOWN: 2, HIGH: 3 } as const;
    if (riskOrder[a.manipulationRisk] !== riskOrder[b.manipulationRisk]) return riskOrder[a.manipulationRisk] - riskOrder[b.manipulationRisk];
    return b.providerAgreementCount - a.providerAgreementCount;
  });

export type IdentityQuality =
  | 'VERIFIED'
  | 'UNVERIFIED_PROGRAM_VERSION'
  | 'AMBIGUOUS_MIGRATION_LINEAGE'
  | 'DECIMAL_UNCERTAIN'
  | 'SUPPLY_UNCERTAIN'
  | 'UNKNOWN_TRANSFER_SEMANTICS'
  | 'UNRESOLVED_QUOTE_ASSET'
  | 'AMBIGUOUS_POOL_IDENTITY'
  | 'INCOMPATIBLE_TOKEN_EXTENSION';

export const requiresAbstention = (quality: IdentityQuality): boolean =>
  quality !== 'VERIFIED';
