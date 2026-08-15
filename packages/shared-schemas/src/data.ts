import { z } from 'zod';
import { DataQualityCodeSchema, ProvenanceSchema } from './temporal.js';

const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'EVM_ADDRESS_CANONICAL_LOWER');
const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const anyAddress = z.string().min(1);

export const ChainIdentitySchema = z.object({
  chainId: z.string().min(1),
  namespace: z.enum(['eip155', 'solana', 'internal']),
  caip2: z.string().nullable(),
  mappingQuality: z.enum(['REGISTERED', 'INTERNAL_VERSIONED']),
});

export const AssetRepresentationSchema = z.object({
  representationId: z.string().regex(/^[^:]+:[^:]+$/, 'CHAIN:ADDRESS'),
  chainId: z.string().min(1),
  canonicalContractAddress: anyAddress,
  caip10: z.string().nullable(),
  decimals: z.number().int().min(0).max(36),
  decimalsVersion: z.string().min(1),
  decimalsSource: z.string().min(1),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  quality: DataQualityCodeSchema.optional(),
});

export const AssetGroupSchema = z
  .object({
    assetId: z.string().min(1),
    representationIds: z.array(z.string().min(1)).min(1),
    equivalenceVerified: z.boolean(),
    equivalenceProof: z.string().nullable(),
  })
  .superRefine((value, context) => {
    if (value.representationIds.length > 1 && !value.equivalenceVerified) {
      context.addIssue({ code: 'custom', path: ['equivalenceVerified'], message: 'EQUIVALENCE_UNVERIFIED' });
    }
    if (value.representationIds.length > 1 && !value.equivalenceProof) {
      context.addIssue({ code: 'custom', path: ['equivalenceProof'], message: 'EQUIVALENCE_PROOF_REQUIRED' });
    }
  });

export const PoolIdentitySchema = z.object({
  poolId: z.string().regex(/^[^:]+:[^:]+:[^:]+$/, 'CHAIN:DEX:ADDRESS'),
  chainId: z.string().min(1),
  dex: z.string().min(1),
  poolAddress: anyAddress,
  caip10: z.string().nullable(),
  quoteAssetRepresentationId: z.string().nullable(),
});

export const QuoteConversionSchema = z.object({
  quoteAssetRepresentationId: z.string().min(1),
  usdPerQuoteUnit: z.string().regex(/^\d+(\.\d+)?$/, 'DECIMAL_STRING'),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  quality: z.enum(['VALID', 'STALE', 'DEPEG', 'ESTIMATED']),
});

export const TokenAmountSchema = z.object({
  raw: z.string().regex(/^\d+$/, 'RAW_INTEGER'),
  decimals: z.number().int().min(0).max(36),
});

export const MigrationEventSchema = z
  .object({
    migrationId: z.string().min(1),
    launchPoolId: z.string().min(1),
    migratedPoolId: z.string().min(1),
    eventAt: z.string().datetime(),
    txHash: z.string().nullable(),
  })
  .superRefine((value, context) => {
    if (value.launchPoolId === value.migratedPoolId) {
      context.addIssue({ code: 'custom', path: ['migratedPoolId'], message: 'MIGRATION_SELF_LOOP' });
    }
  });

export const PoolCanonicalizationInputSchema = z.object({
  poolId: z.string().min(1),
  verifiedRepresentation: z.boolean(),
  supportedDex: z.boolean(),
  quoteAssetQuality: z.number().min(0).max(1),
  usableLiquidityUsd: z.string().regex(/^\d+(\.\d+)?$/),
  recentRealVolumeUsd: z.string().regex(/^\d+(\.\d+)?$/),
  poolAgeMs: z.number().int().nonnegative(),
  migrationLineageVerified: z.boolean(),
  manipulationRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']),
  providerAgreementCount: z.number().int().nonnegative(),
});

export const ObservationEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    representationId: z.string().min(1),
    poolId: z.string().min(1).nullable().optional(),
    eventAt: z.string().datetime(),
    sourceObservedAt: z.string().datetime().nullable().optional(),
    availableAt: z.string().datetime(),
    availabilityProvenance: ProvenanceSchema,
    quality: DataQualityCodeSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.availableAt) < Date.parse(value.eventAt)) {
      context.addIssue({ code: 'custom', path: ['availableAt'], message: 'AVAILABLE_AT_BACKDATED' });
    }
  });

export const isEvmCanonicalAddress = (value: string): boolean => evmAddress.safeParse(value).success;
export const isSolanaAddress = (value: string): boolean => solanaAddress.safeParse(value).success;
