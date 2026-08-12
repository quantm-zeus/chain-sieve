import type { HealthSnapshot } from './types.js';

export const createInitialHealth = (): HealthSnapshot => ({
  connected: false,
  endpointGeneration: 0,
  headSlot: 0,
  finalizedSlot: 0,
  checkpointLag: 0,
  gapCount: 0,
  gapDurationMs: 0,
  backfillStatus: 'idle',
  decodeFailureRate: 0,
  streamedBytes: 0,
  eventRate: 0,
  deduplicationRate: 0,
  resourceConsumption: { cpu: 0, memoryMb: 0, networkKbps: 0 },
});

export const updateHealthOnEvent = (health: HealthSnapshot, bytes: number): HealthSnapshot => ({
  ...health,
  streamedBytes: health.streamedBytes + bytes,
  eventRate: health.eventRate + 1,
  resourceConsumption: { ...health.resourceConsumption },
});

export const downgradeForUnresolvedGap = (health: HealthSnapshot): HealthSnapshot => ({
  ...health,
  backfillStatus: 'degraded',
  gapCount: health.gapCount + 1,
});
