/**
 * @requirement FR-COL-007
 * @requirement FR-COL-008
 * Collector health and degraded behavior. Pause only affected scope on drift.
 */
export interface CollectorHealth {
  connected: boolean;
  endpointGeneration: number;
  headSlot: number | null;
  finalizedSlot: number | null;
  checkpointLag: number;
  gapCount: number;
  gapDurationMs: number | null;
  backfillStatus: 'idle' | 'running' | 'degraded';
  decodeFailureRate: number;
  streamedBytes: number;
  eventRate: number;
  deduplicationRate: number;
  resourceCpu: number;
  resourceMemoryMb: number;
}

export interface Incident {
  scope: string;
  reason: 'program_upgrade' | 'decoder_drift' | 'layout_change' | 'unknown_variant' | 'parity_failure';
  rawPreserved: boolean;
  derivedBlocked: boolean;
  createdAt: string;
}

export const createHealth = (overrides: Partial<CollectorHealth> = {}): CollectorHealth => ({
  connected: false,
  endpointGeneration: 0,
  headSlot: null,
  finalizedSlot: null,
  checkpointLag: 0,
  gapCount: 0,
  gapDurationMs: null,
  backfillStatus: 'idle',
  decodeFailureRate: 0,
  streamedBytes: 0,
  eventRate: 0,
  deduplicationRate: 0,
  resourceCpu: 0,
  resourceMemoryMb: 0,
  ...overrides,
});

export const degradedCoverage = (gaps: { status: string }[]): 'FULL' | 'DEGRADED' => gaps.some((g) => g.status === 'unresolved' || g.status === 'detected') ? 'DEGRADED' : 'FULL';

export const pauseScope = (reason: Incident['reason'], scope: string): Incident => ({
  scope,
  reason,
  rawPreserved: true,
  derivedBlocked: true,
  createdAt: new Date().toISOString(),
});

export const shouldBlockDerivedFacts = (incidents: Incident[]): boolean => incidents.some((i) => i.derivedBlocked);
