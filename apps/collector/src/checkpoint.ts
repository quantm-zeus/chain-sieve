/**
 * @requirement FR-COL-003
 * @requirement FR-COL-004
 * @requirement FR-COL-005
 * @requirement FR-COL-006
 * Collector event envelope, checkpoint, gap detection, and backfill semantics.
 * Never backdates available_at; gaps downgrade coverage.
 */
export type Finality = 'processed' | 'confirmed' | 'finalized';

export interface CollectorEnvelope {
  endpoint: string;
  subscriptionVersion: string;
  connectionGeneration: number;
  slot: number;
  blockHash: string;
  signature: string;
  instructionIndex: number;
  logIndex: number | null;
  accountCoordinates: string | null;
  receivedAt: string;
  availableAt: string;
  earliestSystemAvailability: string;
  finality: Finality;
  rawArtifactHash: string;
  decoderVersion: string;
  rightsPolicy: string;
}

export interface PartitionCheckpoint {
  partition: string;
  slot: number;
  sequence: number;
  updatedAt: string;
}

export const createCheckpoint = (partition: string, slot: number, sequence: number, now: string = new Date().toISOString()): PartitionCheckpoint => ({
  partition, slot, sequence, updatedAt: now,
});

export const isMonotonic = (prev: PartitionCheckpoint | null, next: PartitionCheckpoint): boolean => {
  if (!prev) return true;
  if (prev.partition !== next.partition) return false;
  if (next.slot < prev.slot) return false;
  if (next.slot === prev.slot && next.sequence <= prev.sequence) return false;
  return true;
};

export interface Gap {
  partition: string;
  fromSlot: number;
  toSlot: number;
  fromSequence: number;
  toSequence: number;
  detectedAt: string;
  status: 'detected' | 'backfilled' | 'unresolved';
}

export const detectGap = (checkpoint: PartitionCheckpoint, observedSlot: number, observedSequence: number, now: string = new Date().toISOString()): Gap | null => {
  if (observedSlot < checkpoint.slot) return null;
  if (observedSlot === checkpoint.slot && observedSequence <= checkpoint.sequence) return null;
  const expectedSlot = checkpoint.slot;
  const expectedSequence = checkpoint.sequence + 1;
  const hasGap = observedSlot > expectedSlot || observedSequence > expectedSequence;
  if (!hasGap) return null;
  return {
    partition: checkpoint.partition,
    fromSlot: expectedSlot,
    toSlot: observedSlot,
    fromSequence: expectedSequence,
    toSequence: observedSequence,
    detectedAt: now,
    status: 'detected',
  };
};

export const backfillEnvelope = (envelope: CollectorEnvelope, retrievalTime: string): CollectorEnvelope => {
  const availableAt = retrievalTime > envelope.availableAt ? retrievalTime : envelope.availableAt;
  return { ...envelope, availableAt, earliestSystemAvailability: envelope.earliestSystemAvailability };
};

export const isAvailableAtPointInTime = (envelope: CollectorEnvelope, pointInTime: string): boolean => envelope.availableAt <= pointInTime;

export interface Revision {
  originalSignature: string;
  revision: number;
  type: 'reorg' | 'duplicate' | 'delayed' | 'out_of_order' | 'revised';
  compensatingEvent: CollectorEnvelope | null;
  createdAt: string;
}

export const createRevision = (originalSignature: string, type: Revision['type'], compensating: CollectorEnvelope | null = null): Revision => ({
  originalSignature,
  revision: 1,
  type,
  compensatingEvent: compensating,
  createdAt: new Date().toISOString(),
});

export type IngestResult =
  | { kind: 'accepted'; envelope: CollectorEnvelope }
  | { kind: 'duplicate'; canonicalKey: string };

const canonicalKey = (e: CollectorEnvelope): string =>
  `${e.signature}:${e.slot}:${e.instructionIndex}:${e.logIndex ?? 'null'}:${e.blockHash}`;

export class IngestionStore {
  private seen = new Set<string>();
  private envelopes: CollectorEnvelope[] = [];
  private checkpoint: PartitionCheckpoint | null = null;

  constructor(private readonly partition: string) {}

  ingest(envelope: CollectorEnvelope): IngestResult {
    const key = canonicalKey(envelope);
    if (this.seen.has(key)) return { kind: 'duplicate', canonicalKey: key };
    this.seen.add(key);
    this.envelopes.push(envelope);
    return { kind: 'accepted', envelope };
  }

  getCheckpoint(): PartitionCheckpoint | null { return this.checkpoint; }

  commitCheckpoint(next: PartitionCheckpoint): { ok: true } | { ok: false; reason: string } {
    if (!isMonotonic(this.checkpoint, next)) return { ok: false, reason: 'NON_MONOTONIC_CHECKPOINT' };
    this.checkpoint = next;
    return { ok: true };
  }

  detectGapFor(observedSlot: number, observedSequence: number, now?: string): ReturnType<typeof detectGap> {
    if (!this.checkpoint) return null;
    return detectGap(this.checkpoint, observedSlot, observedSequence, now);
  }

  count(): number { return this.envelopes.length; }
  all(): readonly CollectorEnvelope[] { return this.envelopes; }
}
