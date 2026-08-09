import {
  CheckpointStore,
  GapTracker,
  Deduplicator,
  RevisionStore,
  CollectorHealth,
  type VersionedAllowlist,
  type CollectorStreamRecord,
} from '@ciag/collector-core';
import { DEFAULT_ALLOWLIST, toStreamRecord, backfillAvailableAt, downgradeCoverageOnUnresolvedGap, type SolanaRawEvent } from '@ciag/collector-solana';
import { defaultRegistry, type DecodeResult } from '@ciag/program-decoders';

export interface CollectorConfig {
  allowlist: VersionedAllowlist;
  endpoint: string;
  subscriptionVersion: string;
  filterVersion: string;
}

export class Collector {
  private readonly checkpoints = new CheckpointStore();
  private readonly gaps = new GapTracker();
  private readonly dedup = new Deduplicator();
  private readonly revisions = new RevisionStore();
  private readonly health = new CollectorHealth();
  private readonly registry = defaultRegistry();
  private readonly allowlist: VersionedAllowlist;
  private connectionGeneration = 0;
  private connected = false;
  private headSlot = 0n;
  private finalizedSlot = 0n;
  private streamedBytes = 0;
  private eventCount = 0;
  private decodeFailures = 0;
  private dedupCount = 0;

  constructor(private readonly config: CollectorConfig = { allowlist: DEFAULT_ALLOWLIST, endpoint: 'https://api.mainnet.solana', subscriptionVersion: '1', filterVersion: '1' }) {
    this.allowlist = config.allowlist;
  }

  connect(generation: number): void {
    this.connected = true;
    this.connectionGeneration = generation;
    this.health.update({ connected: true, endpointGeneration: generation });
  }

  disconnect(): void {
    this.connected = false;
    this.health.update({ connected: false });
  }

  getAllowlist(): VersionedAllowlist {
    return this.allowlist;
  }

  isAllowlisted(program: string, version: string, family: string): boolean {
    return this.allowlist.programs.some((p) => p.program === program && p.programVersion === version && p.eventFamilies.includes(family));
  }

  ingest(event: SolanaRawEvent): { record: CollectorStreamRecord; decode: DecodeResult; duplicate: boolean } | { duplicate: true } {
    if (this.dedup.isDuplicate(event.signature, event.slot)) {
      this.dedupCount += 1;
      this.health.update({ deduplicationRate: this.dedupCount / Math.max(1, this.eventCount) });
      return { duplicate: true };
    }
    const availableAt = new Date().toISOString();
    const record = toStreamRecord({ ...event, connectionGeneration: this.connectionGeneration }, availableAt);
    this.headSlot = event.slot > this.headSlot ? event.slot : this.headSlot;
    this.streamedBytes += event.raw.byteLength;
    this.eventCount += 1;

    const decode = this.registry.decode(event.program, event.programVersion, event.raw, event.eventFamily);
    if (decode.status !== 'decoded') this.decodeFailures += 1;

    const incidentRequired = decode.status === 'paused' || decode.status === 'unsupported';
    if (!this.isAllowlisted(event.program, event.programVersion, event.eventFamily)) {
      this.decodeFailures += 0;
    }

    this.revisions.append(record, 'original');
    this.health.update({
      headSlot: this.headSlot,
      streamedBytes: this.streamedBytes,
      eventRate: this.eventCount,
      decodeFailureRate: this.eventCount === 0 ? 0 : this.decodeFailures / this.eventCount,
      deduplicationRate: this.eventCount === 0 ? 0 : this.dedupCount / this.eventCount,
    });

    void incidentRequired;
    return { record, decode, duplicate: false };
  }

  checkpoint(partition: string, slot: bigint, sequence: bigint): void {
    this.checkpoints.set({ partition, slot, sequence, updatedAt: new Date().toISOString() });
    const lag = this.headSlot > slot ? this.headSlot - slot : 0n;
    this.health.update({ checkpointLag: lag, finalizedSlot: slot });
    this.finalizedSlot = slot;
  }

  detectGap(partition: string, fromSlot: bigint, toSlot: bigint, fromSeq: bigint, toSeq: bigint): void {
    this.gaps.detect(partition, fromSlot, toSlot, fromSeq, toSeq);
    this.health.update({ gapCount: this.gaps.unresolvedCount(), backfillStatus: 'idle' });
  }

  backfill(partition: string, fromSlot: bigint, retrievalTime: string): { availableAt: string; preserved: boolean } {
    this.gaps.markBackfilled(partition, fromSlot, retrievalTime);
    const availableAt = backfillAvailableAt(retrievalTime, new Date().toISOString());
    this.health.update({ backfillStatus: 'idle', gapCount: this.gaps.unresolvedCount() });
    return { availableAt, preserved: true };
  }

  markUnresolved(partition: string, fromSlot: bigint): { coverage: 'DOWNGRADED'; reason: string } {
    this.gaps.markUnresolved(partition, fromSlot);
    const gap = this.gaps.list().find((g) => g.partition === partition && g.fromSlot === fromSlot);
    const result = gap ? downgradeCoverageOnUnresolvedGap(gap) : { coverage: 'DOWNGRADED' as const, reason: 'UNRESOLVED_GAP:unknown' };
    this.health.update({ gapCount: this.gaps.unresolvedCount() });
    return result;
  }

  handleReorg(signature: string, slot: bigint, corrected: CollectorStreamRecord): void {
    this.revisions.append(corrected, 'compensating', signature);
    void slot;
  }

  healthSnapshot(): ReturnType<CollectorHealth['snapshot']> {
    return this.health.snapshot();
  }

  getCheckpoints(): ReturnType<CheckpointStore['all']> {
    return this.checkpoints.all();
  }

  getGaps(): ReturnType<GapTracker['list']> {
    return this.gaps.list();
  }

  getRevisions(): ReturnType<RevisionStore['all']> {
    return this.revisions.all();
  }
}

export { DEFAULT_ALLOWLIST } from '@ciag/collector-solana';
export * from '@ciag/collector-core';
export * from '@ciag/program-decoders';
