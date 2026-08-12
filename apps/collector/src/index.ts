import { createAllowlist, createCheckpointStore, commitCheckpoint, createHealthSnapshot } from '@ciag/collector-core';

export function createCollectorApp(allowlistVersion: string) {
  const allowlist = createAllowlist(allowlistVersion, [
    { chain: 'solana', program: 'pump', programVersion: 'bonding_curve_v1', accounts: ['acc-1'], eventFamilies: ['pool_creation'], finality: 'confirmed' },
  ]);
  const checkpoints = createCheckpointStore();
  commitCheckpoint(checkpoints, 'partition-1', 100, 'hash-100');
  const health = createHealthSnapshot({
    connected: true,
    endpointGeneration: 1,
    headSlot: 105,
    finalizedSlot: 90,
    checkpointSlot: 100,
    gapCount: 0,
    gapDurationSlots: 0,
    backfillStatus: 'IDLE',
    decodeFailureRate: 0,
    streamedBytes: 1024,
    eventRate: 10,
    deduplicationRate: 0.01,
    resourceConsumption: { cpu: 0.2, memoryMb: 128, networkKbps: 512 },
  });
  return { allowlist, checkpoints, health };
}

export const COLLECTOR_PUBLIC_API = 'apps/collector/public-api';
