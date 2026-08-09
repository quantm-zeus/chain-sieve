import {
  type AllowlistEntry,
  type CollectorStreamRecord,
  type Finality,
  type Gap,
  type VersionedAllowlist,
  assertAvailableAtNotBackdated,
  hashRaw,
  isAllowlisted,
  sha256Hex,
} from '@ciag/collector-core';

export const SOLANA_CHAIN = 'solana' as const;

export const SUPPORTED_PROGRAMS: AllowlistEntry[] = [
  { chain: 'solana', program: 'pump', programVersion: 'bonding-curve-v1', eventFamilies: ['pool_creation', 'state_progress', 'migration', 'liquidity_change', 'authority_change', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'pump', programVersion: 'pumpswap-v1', eventFamilies: ['pool_creation', 'swap', 'liquidity_change'], finality: 'confirmed' },
  { chain: 'solana', program: 'raydium', programVersion: 'amm-v4', eventFamilies: ['pool_creation', 'liquidity_change', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'raydium', programVersion: 'cpmm-v1', eventFamilies: ['pool_creation', 'liquidity_change', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'raydium', programVersion: 'clmm-v1', eventFamilies: ['pool_creation', 'liquidity_change', 'swap', 'authority_change'], finality: 'confirmed' },
  { chain: 'solana', program: 'raydium', programVersion: 'stable-amm-v1', eventFamilies: ['pool_creation', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'raydium', programVersion: 'launchlab-v1', eventFamilies: ['launch_creation', 'state_progress', 'migration', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'orca', programVersion: 'whirlpools-v1', eventFamilies: ['pool_creation', 'liquidity_change', 'swap', 'authority_change'], finality: 'confirmed' },
  { chain: 'solana', program: 'meteora', programVersion: 'dlmm-v1', eventFamilies: ['pool_creation', 'liquidity_change', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'meteora', programVersion: 'damm-v1', eventFamilies: ['pool_creation', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'meteora', programVersion: 'damm-v2', eventFamilies: ['pool_creation', 'swap', 'liquidity_change'], finality: 'confirmed' },
  { chain: 'solana', program: 'meteora', programVersion: 'dynamic-bonding-curve-v1', eventFamilies: ['pool_creation', 'state_progress', 'swap'], finality: 'confirmed' },
  { chain: 'solana', program: 'jupiter', programVersion: 'route-observation-v1', eventFamilies: ['route_observation', 'reconciliation'], finality: 'confirmed' },
];

export const DEFAULT_ALLOWLIST: VersionedAllowlist = {
  version: '1.0.0',
  chains: ['solana'],
  programs: SUPPORTED_PROGRAMS,
  updatedAt: new Date().toISOString(),
};

export interface SolanaRawEvent {
  endpoint: string;
  subscriptionVersion: string;
  filterVersion: string;
  connectionGeneration: number;
  slot: bigint;
  blockHash: string;
  signature: string;
  instructionIndex: number;
  logIndex?: number;
  accountIndex?: number;
  receivedAt: string;
  finality: Finality;
  program: string;
  programVersion: string;
  eventFamily: string;
  raw: Uint8Array;
  decoderVersion: string;
  rightsPolicy: string;
}

export const toStreamRecord = (event: SolanaRawEvent, availableAt: string): CollectorStreamRecord => {
  assertAvailableAtNotBackdated(availableAt, event.receivedAt);
  const rawHash = hashRaw(event.raw);
  return {
    endpoint: event.endpoint,
    subscriptionVersion: event.subscriptionVersion,
    filterVersion: event.filterVersion,
    connectionGeneration: event.connectionGeneration,
    slot: event.slot,
    blockHash: event.blockHash,
    transaction: event.signature,
    signature: event.signature,
    coordinates: {
      slot: event.slot,
      blockHash: event.blockHash,
      signature: event.signature,
      instructionIndex: event.instructionIndex,
      logIndex: event.logIndex,
      accountIndex: event.accountIndex,
    },
    receivedAt: event.receivedAt,
    availableAt,
    earliestSystemAvailability: availableAt,
    finality: event.finality,
    rawArtifactHash: rawHash,
    decoderVersion: event.decoderVersion,
    rightsPolicy: event.rightsPolicy,
    chain: 'solana',
    program: event.program,
    programVersion: event.programVersion,
    eventFamily: event.eventFamily,
    raw: event.raw,
  };
};

export const isSupported = (allowlist: VersionedAllowlist, program: string, version: string, family: string): boolean =>
  isAllowlisted(allowlist, program, version, family);

export const unknownVersionResult = (program: string, version: string): { supported: false; reason: string } => ({
  supported: false as const,
  reason: `UNSUPPORTED_VERSION:${program}:${version}`,
});

export const backfillAvailableAt = (retrievalTime: string, _originalChainTime: string): string => retrievalTime;

export const shouldPreserveRawOnDecodeFailure = true;

export const createIncidentId = (scope: string, reason: string): string => sha256Hex(`${scope}:${reason}:${Date.now()}`);

export const downgradeCoverageOnUnresolvedGap = (gap: Gap): { coverage: 'DOWNGRADED'; reason: string } => ({
  coverage: 'DOWNGRADED',
  reason: `UNRESOLVED_GAP:${gap.partition}:${gap.fromSlot.toString()}:${gap.toSlot.toString()}`,
});
