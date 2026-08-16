import { z } from 'zod';

export const ProvenanceSchema = z.enum([
  'FIRST_PARTY_LIVE_OBSERVED',
  'PROVIDER_LIVE_RESPONSE',
  'AUTHORIZED_PUSH_RECEIVED',
  'HISTORICAL_QUERY_FETCHED_LATER',
  'MANUAL_IMPORT_AVAILABLE',
  'DERIVED_FROM_AVAILABLE_INPUTS',
  'LEARNED_ARTIFACT_PUBLISHED',
]);

export const RequiredTimestampsSchema = z
  .object({
    eventAt: z.string().datetime(),
    sourceObservedAt: z.string().datetime().nullable().optional(),
    sourcePublishedAt: z.string().datetime().nullable().optional(),
    availableAt: z.string().datetime(),
    authorizedAt: z.string().datetime().nullable().optional(),
    requestedAt: z.string().datetime().nullable().optional(),
    fetchedAt: z.string().datetime().nullable().optional(),
    ingestedAt: z.string().datetime().nullable().optional(),
    finalizedAt: z.string().datetime().nullable().optional(),
    revisedAt: z.string().datetime().nullable().optional(),
    availabilityProvenance: ProvenanceSchema,
  })
  .superRefine((value, context) => {
    const eventMs = Date.parse(value.eventAt);
    const availMs = Date.parse(value.availableAt);
    if (availMs < eventMs) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BACKDATED' });
    }
    if (value.fetchedAt && Date.parse(value.availableAt) < Date.parse(value.fetchedAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BEFORE_FETCHED_AT' });
    }
    if (value.ingestedAt && Date.parse(value.availableAt) < Date.parse(value.ingestedAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BEFORE_INGESTED_AT' });
    }
  });

export const ChainCoordinatesSchema = z.object({
  chainId: z.string().min(1),
  blockNumberOrSlot: z.number().int().nonnegative(),
  blockHash: z.string().min(1),
  parentBlockHashOrParentSlot: z.string().nullable(),
  transactionHash: z.string().min(1),
  transactionIndex: z.number().int().nonnegative(),
  instructionIndex: z.number().int().nonnegative().nullable().optional(),
  innerInstructionIndex: z.number().int().nonnegative().nullable().optional(),
  confirmationLevel: z.enum(['processed', 'confirmed', 'finalized']),
  reorgVersion: z.number().int().nonnegative(),
  collectorOrProviderCursor: z.string().min(1),
});

export const BackfillRecordSchema = z
  .object({
    backfillJobId: z.string().min(1),
    backfillReason: z.string().min(1),
    historicalEventAt: z.string().datetime(),
    retrievedAt: z.string().datetime(),
    availableAt: z.string().datetime(),
    retrospectiveOnly: z.literal(true),
    wouldHaveBeenObservableLive: z.boolean(),
    availabilityProof: z.string().nullable(),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.availableAt) < Date.parse(value.historicalEventAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BACKDATED' });
    }
    if (value.availableAt !== value.retrievedAt && Date.parse(value.availableAt) < Date.parse(value.retrievedAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BEFORE_RETRIEVAL' });
    }
  });

export const DataQualityCodeSchema = z.enum([
  'VALID',
  'MISSING_PROVIDER',
  'NOT_REQUESTED_BY_POLICY',
  'UNSUPPORTED_CHAIN',
  'UNSUPPORTED_PROGRAM_VERSION',
  'STALE',
  'PARTIAL',
  'ESTIMATED',
  'CONFLICTING',
  'REORG_PENDING',
  'GAP_AFFECTED',
  'LOW_SAMPLE',
  'DECIMAL_UNCERTAIN',
  'LICENSE_RESTRICTED',
  'SCHEMA_DEGRADED',
  'DEPRECATED_OPERATION',
  'COST_BLOCKED',
  'QUOTA_RESERVE_PROTECTED',
  'CAPACITY_BLOCKED',
  'EXECUTION_UNAVAILABLE',
  'EXECUTION_PARTIAL',
  'POOL_MATH_UNSUPPORTED',
  'QUOTE_PARITY_FAILED',
  'TOKEN_EXTENSION_UNKNOWN',
  'SUPPLY_UNCERTAIN',
  'SYSTEM_ADDRESS_UNCERTAIN',
  'SOCIAL_UNAVAILABLE',
  'SOURCE_DEPENDENCE_HIGH',
  'OUTCOME_PENDING',
  'OUTCOME_CENSORED',
  'RETROSPECTIVE_ONLY',
]);

export const LearnedArtifactAvailabilitySchema = z
  .object({
    trainedAt: z.string().datetime(),
    trainingDataCutoff: z.string().datetime(),
    availableAt: z.string().datetime(),
    codeVersion: z.string().min(1),
    featureInputVersions: z.array(z.string().min(1)),
    trainingPopulation: z.string().min(1),
    validationHoldoutIds: z.array(z.string().min(1)),
    experimentRegistryIds: z.array(z.string().min(1)),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.availableAt) < Date.parse(value.trainedAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BEFORE_TRAINED_AT' });
    }
  });

export const isAvailableAtPointInTime = (availableAt: string, asOf: string): boolean => Date.parse(availableAt) <= Date.parse(asOf);

export const filterByAvailableAt = <T extends { availableAt: string }>(records: readonly T[], asOf: string): T[] =>
  records.filter((record) => isAvailableAtPointInTime(record.availableAt, asOf));
