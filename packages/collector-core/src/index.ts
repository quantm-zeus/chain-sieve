/**
 * @requirement FR-COL-003
 * @requirement FR-COL-004
 * @requirement FR-COL-005
 * @requirement FR-COL-006
 * Bounded Solana observation contracts: idempotent checkpointed ingestion,
 * gap detection, backfill point-in-time semantics, and immutable reorg revisions.
 * Never destructively rewrites prior observations; never backdates available_at.
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

export const createCheckpoint = (
  partition: string,
  slot: number,
  sequence: number,
  now: string = new Date().toISOString(),
): PartitionCheckpoint => ({ partition, slot, sequence, updatedAt: now });

export const isMonotonic = (
  prev: PartitionCheckpoint | null,
  next: PartitionCheckpoint,
): boolean => {
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

export const detectGap = (
  checkpoint: PartitionCheckpoint,
  observedSlot: number,
  observedSequence: number,
  now: string = new Date().toISOString(),
): Gap | null => {
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

/**
 * Backfill must preserve actual retrieval time and never backdate available_at.
 * FR-COL-005: retrievalTime becomes availableAt if later; otherwise keep original.
 */
export const backfillEnvelope = (
  envelope: CollectorEnvelope,
  retrievalTime: string,
): CollectorEnvelope => {
  const availableAt = retrievalTime > envelope.availableAt ? retrievalTime : envelope.availableAt;
  return { ...envelope, availableAt, earliestSystemAvailability: envelope.earliestSystemAvailability };
};

export const isAvailableAtPointInTime = (
  envelope: CollectorEnvelope,
  pointInTime: string,
): boolean => envelope.availableAt <= pointInTime;

// --- Immutable revision semantics (FR-COL-006) ---

export interface Revision {
  originalSignature: string;
  revision: number;
  type: 'reorg' | 'duplicate' | 'delayed' | 'out_of_order' | 'revised';
  compensatingEvent: CollectorEnvelope | null;
  createdAt: string;
}

export const createRevision = (
  originalSignature: string,
  type: Revision['type'],
  compensating: CollectorEnvelope | null = null,
): Revision => ({
  originalSignature,
  revision: 1,
  type,
  compensatingEvent: compensating,
  createdAt: new Date().toISOString(),
});

// --- Idempotent ingestion store ---

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

  getCheckpoint(): PartitionCheckpoint | null {
    return this.checkpoint;
  }

  commitCheckpoint(next: PartitionCheckpoint): { ok: true } | { ok: false; reason: string } {
    if (!isMonotonic(this.checkpoint, next)) {
      return { ok: false, reason: 'NON_MONOTONIC_CHECKPOINT' };
    }
    this.checkpoint = next;
    return { ok: true };
  }

  detectGapFor(observedSlot: number, observedSequence: number, now?: string): Gap | null {
    if (!this.checkpoint) return null;
    return detectGap(this.checkpoint, observedSlot, observedSequence, now);
  }

  count(): number {
    return this.envelopes.length;
  }

  all(): readonly CollectorEnvelope[] {
    return this.envelopes;
  }
}

// --- Backfill operation (bounded, FR-COL-005) ---

export type BackfillStatus = 'idle' | 'running' | 'unresolved';
export interface BackfillOperation {
  gapId: string;
  bounded: boolean;
  maxSlots: number;
  status: BackfillStatus;
  retrievedAt: string | null;
}

export const createBackfill = (gapId: string, maxSlots = 500): BackfillOperation => ({
  gapId,
  bounded: true,
  maxSlots,
  status: 'idle',
  retrievedAt: null,
});

export const markUnresolved = (op: BackfillOperation): BackfillOperation => ({
  ...op,
  status: 'unresolved',
});

export const completeBackfill = (
  op: BackfillOperation,
  retrievedAt: string,
): BackfillOperation => ({ ...op, status: 'idle', retrievedAt });
