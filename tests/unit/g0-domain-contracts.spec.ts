import { describe, it, expect } from 'vitest';
import { createAssetRepresentation, normalizeAddress, createPoolIdentity, createAssetGroup } from '../../packages/domain/src/identity.js';
import { assertNoBackdating, isAvailableAtPointInTime, filterByAvailableAt, createBackfillRecord } from '../../packages/domain/src/temporal.js';
import { isCandidateLifecycle, isCandidateRiskState, canTransitionLifecycle, assertLifecycleAndRiskIndependent, validateLifecycleTransition } from '../../packages/domain/src/state-machines.js';
import { ObservationEnvelopeSchema } from '../../packages/shared-schemas/src/data.js';
import { CandidateLifecycleSchema, CandidateRiskStateSchema, CandidateLifecycleTransitionSchema } from '../../packages/shared-schemas/src/sig.js';
import { RequiredTimestampsSchema } from '../../packages/shared-schemas/src/temporal.js';

describe('g0-domain-contracts', () => {
  it('identity normalizes chain-specifically', () => {
    expect(normalizeAddress('eip155:1', '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12')).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(normalizeAddress('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'So11111111111111111111111111111111111111112')).toBe('So11111111111111111111111111111111111111112');
    const asset = createAssetRepresentation({ chainId: 'eip155:1', contractAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12', decimals: 6, decimalsVersion: 'v1', decimalsSource: 'chain' });
    expect(asset.representationId).toBe('eip155:1:0xabcdef1234567890abcdef1234567890abcdef12');
    expect(() => createAssetGroup({ assetId: 'a1', representations: [asset, asset] })).toThrow();
  });
  it('pool identity distinct', () => {
    const a = createPoolIdentity({ chainId: 'eip155:1', dex: 'uniswap-v3', poolAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12' });
    const b = createPoolIdentity({ chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', dex: 'raydium', poolAddress: 'So11111111111111111111111111111111111111112' });
    expect(a.poolId).not.toBe(b.poolId);
  });
  it('no-backdating enforced', () => {
    expect(() => assertNoBackdating('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z')).toThrow('AVAILABLE_AT_BACKDATED');
    expect(isAvailableAtPointInTime('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')).toBe(true);
    expect(isAvailableAtPointInTime('2026-01-01T00:00:02.000Z', '2026-01-01T00:00:01.000Z')).toBe(false);
    const filtered = filterByAvailableAt([{ availableAt: '2026-01-01T00:00:00.000Z' }, { availableAt: '2026-01-01T00:00:05.000Z' }], '2026-01-01T00:00:02.000Z');
    expect(filtered).toHaveLength(1);
    const bf = createBackfillRecord({ backfillJobId: 'job1', backfillReason: 'gap', historicalEventAt: '2026-01-01T00:00:00.000Z', retrievedAt: '2026-01-01T00:00:10.000Z' });
    expect(bf.availableAt).toBe('2026-01-01T00:00:10.000Z');
    expect(bf.retrospectiveOnly).toBe(true);
  });
  it('lifecycle and risk are independent without collapsing', () => {
    expect(isCandidateLifecycle('DISCOVERED')).toBe(true);
    expect(isCandidateLifecycle('CRITICAL')).toBe(false);
    expect(isCandidateRiskState('CRITICAL')).toBe(true);
    expect(isCandidateRiskState('DISCOVERED')).toBe(false);
    expect(canTransitionLifecycle('DISCOVERED', 'QUALIFIED')).toBe(true);
    expect(canTransitionLifecycle('DISCOVERED', 'CONFIRMED')).toBe(false);
    expect(assertLifecycleAndRiskIndependent('CONFIRMED', 'HIGH')).toEqual({ lifecycle: 'CONFIRMED', risk: 'HIGH' });
    expect(() => validateLifecycleTransition({ fromState: 'DISCOVERED', toState: 'CONFIRMED', reasonCodes: ['x'], featureVersion: 'v1', rankingVersion: 'v1', policyVersion: 'v1', evidenceIds: [], actorType: 'SYSTEM', runId: null, eventAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:01.000Z' })).toThrow();
  });
  it('schemas preserve point-in-time and no-backdating', () => {
    const good = { id: 'obs1', representationId: 'eip155:1:0xabc', poolId: null, eventAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:01.000Z', availabilityProvenance: 'FIRST_PARTY_LIVE_OBSERVED' as const, quality: 'VALID' as const };
    expect(ObservationEnvelopeSchema.safeParse(good).success).toBe(true);
    expect(ObservationEnvelopeSchema.safeParse({ ...good, availableAt: '2025-12-31T23:59:59.000Z' }).success).toBe(false);
    expect(RequiredTimestampsSchema.safeParse({ eventAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:01.000Z', availabilityProvenance: 'PROVIDER_LIVE_RESPONSE' }).success).toBe(true);
    expect(RequiredTimestampsSchema.safeParse({ eventAt: '2026-01-01T00:00:02.000Z', availableAt: '2026-01-01T00:00:01.000Z', availabilityProvenance: 'PROVIDER_LIVE_RESPONSE' }).success).toBe(false);
    expect(CandidateLifecycleTransitionSchema.safeParse({ fromState: 'DISCOVERED', toState: 'QUALIFIED', reasonCodes: ['rc'], featureVersion: 'v1', rankingVersion: 'v1', policyVersion: 'v1', evidenceIds: [], actorType: 'SYSTEM', runId: null, eventAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:01.000Z' }).success).toBe(true);
    expect(CandidateLifecycleTransitionSchema.safeParse({ fromState: 'DISCOVERED', toState: 'CONFIRMED', reasonCodes: ['rc'], featureVersion: 'v1', rankingVersion: 'v1', policyVersion: 'v1', evidenceIds: [], actorType: 'SYSTEM', runId: null, eventAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:01.000Z' }).success).toBe(false);
    expect(CandidateLifecycleSchema.safeParse('DISCOVERED').success).toBe(true);
    expect(CandidateLifecycleSchema.safeParse('CRITICAL').success).toBe(false);
    expect(CandidateRiskStateSchema.safeParse('CRITICAL').success).toBe(true);
    expect(CandidateRiskStateSchema.safeParse('DISCOVERED').success).toBe(false);
  });
});
