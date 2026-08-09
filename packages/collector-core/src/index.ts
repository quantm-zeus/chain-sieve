import { createHash } from 'node:crypto';

export type Finality = 'processed' | 'confirmed' | 'finalized';
export type ChainId = 'solana';

export interface AllowlistEntry {
  chain: ChainId;
  program: string;
  programVersion: string;
  account?: string;
  eventFamilies: string[];
  finality: Finality;
}

export interface VersionedAllowlist {
  version: string;
  chains: ChainId[];
  programs: AllowlistEntry[];
  updatedAt: string;
}

export interface CollectorCoordinates {
  slot: bigint;
  blockHash: string;
  signature: string;
  instructionIndex: number;
  logIndex?: number;
  accountIndex?: number;
}

export interface CollectorStreamRecord {
  endpoint: string;
  subscriptionVersion: string;
  filterVersion: string;
  connectionGeneration: number;
  slot: bigint;
  blockHash: string;
  transaction: string;
  signature: string;
  coordinates: CollectorCoordinates;
  receivedAt: string;
  availableAt: string;
  earliestSystemAvailability: string;
  finality: Finality;
  rawArtifactHash: string;
  decoderVersion: string;
  rightsPolicy: string;
  chain: ChainId;
  program: string;
  programVersion: string;
  eventFamily: string;
  raw: Uint8Array;
}

export interface Checkpoint {
  partition: string;
  slot: bigint;
  sequence: bigint;
  updatedAt: string;
}

export interface Gap {
  partition: string;
  fromSlot: bigint;
  toSlot: bigint;
  fromSequence: bigint;
  toSequence: bigint;
  detectedAt: string;
  status: 'detected' | 'backfilled' | 'unresolved';
  retrievalTime?: string;
}

export interface Health {
  connected: boolean;
  endpointGeneration: number;
  headSlot: bigint;
  finalizedSlot: bigint;
  checkpointLag: bigint;
  gapCount: number;
  gapDurationMs: number;
  backfillStatus: 'idle' | 'running' | 'failed';
  decodeFailureRate: number;
  streamedBytes: number;
  eventRate: number;
  deduplicationRate: number;
  cpuPercent: number;
  memoryBytes: number;
  networkBytes: number;
  subscriptionCount: number;
}

export interface Incident {
  id: string;
  scope: string;
  reason: string;
  createdAt: string;
  affectedPrograms: string[];
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export const hashRaw = (raw: Uint8Array): string => sha256Hex(raw);

export const isAllowlisted = (allowlist: VersionedAllowlist, program: string, version: string, eventFamily: string): boolean => {
  const entry = allowlist.programs.find((p) => p.program === program && p.programVersion === version);
  if (!entry) return false;
  return entry.eventFamilies.includes(eventFamily);
};

export const assertAvailableAtNotBackdated = (availableAt: string, receivedAt: string): void => {
  if (Date.parse(availableAt) < Date.parse(receivedAt)) {
    throw new Error('AVAILABLE_AT_BACKDATED');
  }
};

export class CheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint>();
  set(cp: Checkpoint): void {
    const existing = this.checkpoints.get(cp.partition);
    if (existing && cp.slot < existing.slot) throw new Error('CHECKPOINT_NOT_MONOTONIC_SLOT');
    if (existing && cp.sequence < existing.sequence) throw new Error('CHECKPOINT_NOT_MONOTONIC_SEQUENCE');
    this.checkpoints.set(cp.partition, cp);
  }
  get(partition: string): Checkpoint | undefined {
    return this.checkpoints.get(partition);
  }
  all(): Checkpoint[] {
    return [...this.checkpoints.values()];
  }
}

export class GapTracker {
  private readonly gaps: Gap[] = [];
  detect(partition: string, fromSlot: bigint, toSlot: bigint, fromSeq: bigint, toSeq: bigint): Gap {
    if (toSlot <= fromSlot) throw new Error('INVALID_GAP_RANGE');
    const gap: Gap = {
      partition,
      fromSlot,
      toSlot,
      fromSequence: fromSeq,
      toSequence: toSeq,
      detectedAt: new Date().toISOString(),
      status: 'detected',
    };
    this.gaps.push(gap);
    return gap;
  }
  markBackfilled(partition: string, fromSlot: bigint, retrievalTime: string): void {
    const g = this.gaps.find((x) => x.partition === partition && x.fromSlot === fromSlot);
    if (g) {
      g.status = 'backfilled';
      g.retrievalTime = retrievalTime;
    }
  }
  markUnresolved(partition: string, fromSlot: bigint): void {
    const g = this.gaps.find((x) => x.partition === partition && x.fromSlot === fromSlot);
    if (g) g.status = 'unresolved';
  }
  unresolvedCount(): number {
    return this.gaps.filter((g) => g.status === 'detected' || g.status === 'unresolved').length;
  }
  list(): Gap[] {
    return [...this.gaps];
  }
}

export class Deduplicator {
  private readonly seen = new Set<string>();
  isDuplicate(signature: string, slot: bigint): boolean {
    const key = `${signature}:${slot.toString()}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
}

export type RevisionKind = 'original' | 'revision' | 'compensating';
export interface ImmutableRevision {
  id: string;
  kind: RevisionKind;
  previousId?: string;
  record: CollectorStreamRecord;
  createdAt: string;
}

export class RevisionStore {
  private readonly revisions: ImmutableRevision[] = [];
  append(record: CollectorStreamRecord, kind: RevisionKind = 'original', previousId?: string): ImmutableRevision {
    const rev: ImmutableRevision = {
      id: sha256Hex(`${record.signature}:${record.slot.toString()}:${Date.now()}:${this.revisions.length}`),
      kind,
      previousId,
      record,
      createdAt: new Date().toISOString(),
    };
    this.revisions.push(rev);
    return rev;
  }
  all(): ImmutableRevision[] {
    return [...this.revisions];
  }
  findBySignature(sig: string): ImmutableRevision[] {
    return this.revisions.filter((r) => r.record.signature === sig);
  }
}

export class CollectorHealth {
  private health: Health = {
    connected: false,
    endpointGeneration: 0,
    headSlot: 0n,
    finalizedSlot: 0n,
    checkpointLag: 0n,
    gapCount: 0,
    gapDurationMs: 0,
    backfillStatus: 'idle',
    decodeFailureRate: 0,
    streamedBytes: 0,
    eventRate: 0,
    deduplicationRate: 0,
    cpuPercent: 0,
    memoryBytes: 0,
    networkBytes: 0,
    subscriptionCount: 0,
  };
  update(p: Partial<Health>): void {
    this.health = { ...this.health, ...p };
  }
  snapshot(): Health {
    return { ...this.health };
  }
}
