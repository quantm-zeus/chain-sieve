/**
 * @requirement FR-DATA-003
 * Point-in-time temporal contracts and no-backdating semantics.
 * Every observation carries event_at and available_at where available_at is
 * the earliest auditable system availability, never inferred from event_at.
 * Replay at decision time T uses only records with available_at <= T.
 */

export type AvailabilityProvenance =
  | 'FIRST_PARTY_LIVE_OBSERVED'
  | 'PROVIDER_LIVE_RESPONSE'
  | 'AUTHORIZED_PUSH_RECEIVED'
  | 'HISTORICAL_QUERY_FETCHED_LATER'
  | 'MANUAL_IMPORT_AVAILABLE'
  | 'DERIVED_FROM_AVAILABLE_INPUTS'
  | 'LEARNED_ARTIFACT_PUBLISHED';

export interface RequiredTimestamps {
  eventAt: string;
  sourceObservedAt?: string | null;
  sourcePublishedAt?: string | null;
  availableAt: string;
  authorizedAt?: string | null;
  requestedAt?: string | null;
  fetchedAt?: string | null;
  ingestedAt?: string | null;
  finalizedAt?: string | null;
  revisedAt?: string | null;
  availabilityProvenance: AvailabilityProvenance;
}

export interface ChainCoordinates {
  chainId: string;
  blockNumberOrSlot: number;
  blockHash: string;
  parentBlockHashOrParentSlot: string | null;
  transactionHash: string;
  transactionIndex: number;
  instructionIndex?: number | null;
  innerInstructionIndex?: number | null;
  confirmationLevel: 'processed' | 'confirmed' | 'finalized';
  reorgVersion: number;
  collectorOrProviderCursor: string;
}

export interface BackfillRecord {
  backfillJobId: string;
  backfillReason: string;
  historicalEventAt: string;
  retrievedAt: string;
  availableAt: string;
  retrospectiveOnly: boolean;
  wouldHaveBeenObservableLive: boolean;
  availabilityProof: string | null;
}

export const assertNoBackdating = (eventTime: string, availableAt: string): void => {
  const eventMs = Date.parse(eventTime);
  const availMs = Date.parse(availableAt);
  if (Number.isNaN(eventMs) || Number.isNaN(availMs)) throw new Error('TIMESTAMP_INVALID');
  if (availMs < eventMs) throw new Error('AVAILABLE_AT_BACKDATED');
};

export const assertAvailableAtMonotonic = (availableAt: string, retrievedAt: string): void => {
  const availMs = Date.parse(availableAt);
  const retMs = Date.parse(retrievedAt);
  if (Number.isNaN(availMs) || Number.isNaN(retMs)) throw new Error('TIMESTAMP_INVALID');
  if (availMs < retMs) throw new Error('AVAILABLE_AT_BEFORE_RETRIEVAL');
};

export const isAvailableAtPointInTime = (availableAt: string, asOf: string): boolean => {
  const availMs = Date.parse(availableAt);
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(availMs) || Number.isNaN(asOfMs)) throw new Error('TIMESTAMP_INVALID');
  return availMs <= asOfMs;
};

export const filterByAvailableAt = <T extends { availableAt: string }>(records: readonly T[], asOf: string): T[] =>
  records.filter((record) => isAvailableAtPointInTime(record.availableAt, asOf));

export const resolveLatestRevision = <T extends { availableAt: string; reorgVersion: number }>(
  revisions: readonly T[],
  asOf: string,
): T | null => {
  const eligible = filterByAvailableAt(revisions, asOf);
  if (eligible.length === 0) return null;
  return eligible.reduce((latest, current) => {
    const latestMs = Date.parse(latest.availableAt);
    const currentMs = Date.parse(current.availableAt);
    if (currentMs > latestMs) return current;
    if (currentMs === latestMs && current.reorgVersion > latest.reorgVersion) return current;
    return latest;
  });
};

export const createBackfillRecord = (input: {
  backfillJobId: string;
  backfillReason: string;
  historicalEventAt: string;
  retrievedAt: string;
  availabilityProof?: string | null;
  wouldHaveBeenObservableLive?: boolean;
}): BackfillRecord => {
  const availableAt = input.retrievedAt;
  assertNoBackdating(input.historicalEventAt, availableAt);
  return {
    backfillJobId: input.backfillJobId,
    backfillReason: input.backfillReason,
    historicalEventAt: input.historicalEventAt,
    retrievedAt: input.retrievedAt,
    availableAt,
    retrospectiveOnly: true,
    wouldHaveBeenObservableLive: input.wouldHaveBeenObservableLive ?? false,
    availabilityProof: input.availabilityProof ?? null,
  };
};

export const deriveAvailableAt = (input: {
  eventAt: string;
  fetchedAt: string;
  ingestedAt: string;
  provenance: AvailabilityProvenance;
  firstPartyLiveReceiptAt?: string | null;
}): string => {
  if (input.provenance === 'FIRST_PARTY_LIVE_OBSERVED' && input.firstPartyLiveReceiptAt) {
    assertNoBackdating(input.eventAt, input.firstPartyLiveReceiptAt);
    return input.firstPartyLiveReceiptAt;
  }
  const candidate = input.ingestedAt ?? input.fetchedAt;
  assertNoBackdating(input.eventAt, candidate);
  if (Date.parse(candidate) < Date.parse(input.fetchedAt)) throw new Error('AVAILABLE_AT_BEFORE_FETCH');
  return candidate;
};

export type DataQualityCode =
  | 'VALID'
  | 'MISSING_PROVIDER'
  | 'NOT_REQUESTED_BY_POLICY'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSUPPORTED_PROGRAM_VERSION'
  | 'STALE'
  | 'PARTIAL'
  | 'ESTIMATED'
  | 'CONFLICTING'
  | 'REORG_PENDING'
  | 'GAP_AFFECTED'
  | 'LOW_SAMPLE'
  | 'DECIMAL_UNCERTAIN'
  | 'LICENSE_RESTRICTED'
  | 'SCHEMA_DEGRADED'
  | 'DEPRECATED_OPERATION'
  | 'COST_BLOCKED'
  | 'QUOTA_RESERVE_PROTECTED'
  | 'CAPACITY_BLOCKED'
  | 'EXECUTION_UNAVAILABLE'
  | 'EXECUTION_PARTIAL'
  | 'POOL_MATH_UNSUPPORTED'
  | 'QUOTE_PARITY_FAILED'
  | 'TOKEN_EXTENSION_UNKNOWN'
  | 'SUPPLY_UNCERTAIN'
  | 'SYSTEM_ADDRESS_UNCERTAIN'
  | 'SOCIAL_UNAVAILABLE'
  | 'SOURCE_DEPENDENCE_HIGH'
  | 'OUTCOME_PENDING'
  | 'OUTCOME_CENSORED'
  | 'RETROSPECTIVE_ONLY';

export interface LearnedArtifactAvailability {
  trainedAt: string;
  trainingDataCutoff: string;
  availableAt: string;
  codeVersion: string;
  featureInputVersions: string[];
  trainingPopulation: string;
  validationHoldoutIds: string[];
  experimentRegistryIds: string[];
  contentHash: string;
}

export const isArtifactAvailableAt = (artifact: LearnedArtifactAvailability, asOf: string): boolean =>
  isAvailableAtPointInTime(artifact.availableAt, asOf);
