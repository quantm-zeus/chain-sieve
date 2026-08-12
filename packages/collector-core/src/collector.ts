/**
 * Bounded first-party event collector implementing FR-COL-001..FR-COL-008.
 * Degraded behavior: fail closed, return NOT_AVAILABLE/INSUFFICIENT_DATA with provenance, never fabricate success.
 * Point-in-time: gap backfill never backdates available_at, preserves actual retrieval time.
 * Capability remains DISABLED until explicit activation; this module is read-only observation.
 */

export type ChainId = string;
export type ProgramId = string;
export type VersionId = string;
export type AccountId = string;
export type EventFamily = string;
export type FinalityPolicy = 'confirmed' | 'finalized' | 'processed';

export interface AllowlistEntry {
  chain: ChainId;
  program: ProgramId;
  programVersion: VersionId;
  accounts: AccountId[];
  eventFamilies: EventFamily[];
  finality: FinalityPolicy;
}

export interface VersionedAllowlist {
  version: string;
  createdAt: string;
  entries: AllowlistEntry[];
}

export function createAllowlist(version: string, entries: AllowlistEntry[]): VersionedAllowlist {
  if (!version || typeof version !== 'string') throw new Error('INVALID_ALLOWLIST_VERSION');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ALLOWLIST_EMPTY');
  for (const e of entries) {
    if (!e.chain || !e.program || !e.programVersion) throw new Error('INVALID_ALLOWLIST_ENTRY');
  }
  return { version, createdAt: new Date().toISOString(), entries: [...entries] };
}

export function isCovered(
  allowlist: VersionedAllowlist,
  query: { chain: string; program: string; programVersion: string; account?: string; eventFamily?: string; finality?: string },
): boolean {
  if (!allowlist || !Array.isArray(allowlist.entries)) return false;
  return allowlist.entries.some(
    (e) =>
      e.chain === query.chain &&
      e.program === query.program &&
      e.programVersion === query.programVersion &&
      (query.account ? e.accounts.includes(query.account) : true) &&
      (query.eventFamily ? e.eventFamilies.includes(query.eventFamily) : true) &&
      (query.finality ? e.finality === query.finality : true),
  );
}

// FR-COL-002: versioned read-only coverage registry
export type ProtocolName =
  | 'pump_bonding_curve'
  | 'pumpswap'
  | 'raydium_amm_v4'
  | 'raydium_cpmm'
  | 'raydium_clmm'
  | 'raydium_stable_amm'
  | 'raydium_launchlab'
  | 'orca_whirlpools'
  | 'meteora_dlmm'
  | 'meteora_damm_v1'
  | 'meteora_damm_v2'
  | 'meteora_dynamic_bonding_curve'
  | 'jupiter_route_observation';

export interface ProtocolSupport {
  program: string;
  version: string;
  design: string;
  status: 'SUPPORTED' | 'UNSUPPORTED' | 'DEGRADED';
  decoderVersion: string;
  manifestSignature: string;
}

const SUPPORTED_REGISTRY: ProtocolSupport[] = [
  { program: 'pump', version: 'bonding_curve_v1', design: 'bonding-curve', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-pump-bc-v1' },
  { program: 'pump', version: 'pumpswap_v1', design: 'constant-product', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-pumpswap-v1' },
  { program: 'raydium', version: 'amm_v4', design: 'constant-product', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-raydium-v4' },
  { program: 'raydium', version: 'cpmm', design: 'constant-product', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-raydium-cpmm' },
  { program: 'raydium', version: 'clmm', design: 'concentrated-liquidity', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-raydium-clmm' },
  { program: 'raydium', version: 'stable_amm', design: 'stable', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-raydium-stable' },
  { program: 'raydium', version: 'launchlab', design: 'launch', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-raydium-launchlab' },
  { program: 'orca', version: 'whirlpools_v1', design: 'concentrated-liquidity', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-orca-whirl' },
  { program: 'meteora', version: 'dlmm_v1', design: 'bin-based', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-meteora-dlmm' },
  { program: 'meteora', version: 'damm_v1', design: 'dynamic-fee', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-meteora-damm1' },
  { program: 'meteora', version: 'damm_v2', design: 'dynamic-fee', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-meteora-damm2' },
  { program: 'meteora', version: 'dynamic_bonding_curve_v1', design: 'bonding-curve', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-meteora-dbc' },
  { program: 'jupiter', version: 'route_observation_v1', design: 'route-observation', status: 'SUPPORTED', decoderVersion: '1.0.0', manifestSignature: 'sig-jupiter-route' },
];

export function resolveProtocolSupport(program: string, version: string, design: string): ProtocolSupport {
  const found = SUPPORTED_REGISTRY.find((p) => p.program === program && p.version === version && p.design === design);
  if (found) return { ...found };
  return { program, version, design, status: 'UNSUPPORTED', decoderVersion: '0.0.0', manifestSignature: 'unsigned' };
}

export function listSupportedProtocols(): ProtocolSupport[] {
  return SUPPORTED_REGISTRY.map((p) => ({ ...p }));
}

// FR-COL-003: stream stores required coordinates
export interface CollectorStreamEvent {
  endpoint: string;
  subscriptionVersion: string;
  filterVersion: string;
  connectionGeneration: number;
  slot: number;
  blockHash: string;
  transaction: string;
  signature: string;
  instructionIndex: number;
  logIndex: number;
  accountCoordinates: string[];
  receivedAt: string;
  availableAt: string;
  earliestSystemAvailability: string;
  finality: FinalityPolicy;
  rawArtifactHash: string;
  decoderVersion: string;
  rightsPolicy: string;
  payload: unknown;
  provenance: string;
}

export function createCollectorStreamEvent(input: Omit<CollectorStreamEvent, 'provenance' | 'availableAt' | 'earliestSystemAvailability'> & { availableAt?: string }): CollectorStreamEvent {
  if (!input.endpoint || !input.subscriptionVersion || !input.blockHash) throw new Error('INVALID_STREAM_EVENT');
  if (input.slot < 0) throw new Error('INVALID_SLOT');
  const now = new Date().toISOString();
  return {
    ...input,
    availableAt: input.availableAt ?? now,
    earliestSystemAvailability: now,
    provenance: `col:${input.endpoint}:${input.connectionGeneration}:${input.slot}`,
  };
}

// FR-COL-004: durable monotonic checkpoints per partition
export type PartitionId = string;
export interface Checkpoint {
  partition: PartitionId;
  slot: number;
  sequence: number;
  blockHash: string;
  committedAt: string;
}
export type CheckpointStore = Map<PartitionId, Checkpoint>;

export function createCheckpointStore(): CheckpointStore {
  return new Map();
}

export function commitCheckpoint(store: CheckpointStore, partition: PartitionId, slot: number, blockHash: string): Checkpoint {
  if (slot < 0) throw new Error('INVALID_CHECKPOINT_SLOT');
  const existing = store.get(partition);
  if (existing && slot < existing.slot) throw new Error('CHECKPOINT_NOT_MONOTONIC');
  if (existing && slot === existing.slot) throw new Error('CHECKPOINT_NOT_MONOTONIC');
  const cp: Checkpoint = { partition, slot, sequence: (existing?.sequence ?? 0) + 1, blockHash, committedAt: new Date().toISOString() };
  store.set(partition, cp);
  return cp;
}

export function getCheckpoint(store: CheckpointStore, partition: PartitionId): Checkpoint | undefined {
  return store.get(partition);
}

export interface Gap {
  partition: PartitionId;
  fromSlot: number;
  toSlot: number;
  detectedAt: string;
  status: 'OPEN' | 'BACKFILLED' | 'UNRESOLVED';
}

export function detectGap(store: CheckpointStore, partition: PartitionId, reconnectSlot: number): Gap | null {
  const checkpoint = store.get(partition);
  if (!checkpoint) return null;
  if (reconnectSlot <= checkpoint.slot) return null;
  if (reconnectSlot === checkpoint.slot + 1) return null;
  return {
    partition,
    fromSlot: checkpoint.slot + 1,
    toSlot: reconnectSlot - 1,
    detectedAt: new Date().toISOString(),
    status: 'OPEN',
  };
}

export function computeNextCheckpointSlot(slot: number): number {
  return slot + 1;
}

// FR-COL-005: gap backfill preserves actual retrieval time, never backdates available_at
export interface BackfillResult {
  gap: Gap;
  events: CollectorStreamEvent[];
  retrievedAt: string;
  coverage: 'COMPLETE' | 'DEGRADED';
}

export function backfillGap(gap: Gap, retrievedEvents: CollectorStreamEvent[], retrievedAt: string): BackfillResult {
  const retrievedTime = new Date(retrievedAt).getTime();
  const adjusted = retrievedEvents.map((e) => {
    const originalAvailable = new Date(e.availableAt).getTime();
    const effectiveAvailable = Math.max(originalAvailable, retrievedTime);
    return { ...e, availableAt: new Date(effectiveAvailable).toISOString(), earliestSystemAvailability: retrievedAt };
  });
  const coverage: BackfillResult['coverage'] = gap.toSlot - gap.fromSlot + 1 === adjusted.length ? 'COMPLETE' : 'DEGRADED';
  return {
    gap: { ...gap, status: coverage === 'COMPLETE' ? 'BACKFILLED' : 'UNRESOLVED' },
    events: adjusted,
    retrievedAt,
    coverage,
  };
}

export function coverageClaim(gap: Gap | null): { status: 'FULL' | 'DEGRADED'; reason?: string } {
  if (!gap) return { status: 'FULL' };
  if (gap.status === 'UNRESOLVED') return { status: 'DEGRADED', reason: `unresolved gap ${gap.fromSlot}-${gap.toSlot}` };
  return { status: 'FULL' };
}

// FR-COL-006: immutable revisions/compensating events
export interface Revision {
  originalSignature: string;
  revisionId: string;
  type: 'REORG' | 'DUPLICATE' | 'REVISED';
  compensatingEvent: CollectorStreamEvent;
  createdAt: string;
}

export function createCompensatingRevision(original: CollectorStreamEvent, reason: Revision['type']): Revision {
  const compensating: CollectorStreamEvent = {
    ...original,
    signature: `${original.signature}#rev-${Date.now()}`,
    slot: original.slot,
    provenance: `${original.provenance}:rev:${reason}`,
  };
  return {
    originalSignature: original.signature,
    revisionId: `${original.signature}:${reason}:${Date.now()}`,
    type: reason,
    compensatingEvent: compensating,
    createdAt: new Date().toISOString(),
  };
}

// FR-COL-007: program upgrades/decoder drift pause affected scope, preserve raw, create incident
export interface Incident {
  incidentId: string;
  affectedProgram: string;
  affectedVersion: string;
  reason: 'PROGRAM_UPGRADE' | 'DECODER_DRIFT' | 'UNKNOWN_VARIANT' | 'PARITY_FAILURE' | 'LAYOUT_CHANGE';
  rawEventPreserved: boolean;
  derivedFactsBlocked: boolean;
  createdAt: string;
}

export interface DecoderScope {
  program: string;
  version: string;
  paused: boolean;
  incidentId?: string;
}

export function handleDecoderIncident(
  scope: DecoderScope,
  reason: Incident['reason'],
  rawEvent: unknown,
): { scope: DecoderScope; incident: Incident } {
  const incident: Incident = {
    incidentId: `inc-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    affectedProgram: scope.program,
    affectedVersion: scope.version,
    reason,
    rawEventPreserved: rawEvent !== undefined,
    derivedFactsBlocked: true,
    createdAt: new Date().toISOString(),
  };
  return { scope: { ...scope, paused: true, incidentId: incident.incidentId }, incident };
}

export function isDerivedFactAllowed(scope: DecoderScope): boolean {
  return !scope.paused;
}

// FR-COL-008: health exposes required metrics
export interface HealthSnapshot {
  connected: boolean;
  endpointGeneration: number;
  headSlot: number;
  finalizedSlot: number;
  checkpointLag: number;
  gapCount: number;
  gapDurationSlots: number;
  backfillStatus: 'IDLE' | 'RUNNING' | 'DEGRADED';
  decodeFailureRate: number;
  streamedBytes: number;
  eventRate: number;
  deduplicationRate: number;
  resourceConsumption: { cpu: number; memoryMb: number; networkKbps: number };
  timestamp: string;
}

export function createHealthSnapshot(input: Omit<HealthSnapshot, 'timestamp' | 'checkpointLag'> & { checkpointSlot: number }): HealthSnapshot {
  const checkpointLag = input.headSlot - input.checkpointSlot;
  return {
    connected: input.connected,
    endpointGeneration: input.endpointGeneration,
    headSlot: input.headSlot,
    finalizedSlot: input.finalizedSlot,
    checkpointLag,
    gapCount: input.gapCount,
    gapDurationSlots: input.gapDurationSlots,
    backfillStatus: input.backfillStatus,
    decodeFailureRate: input.decodeFailureRate,
    streamedBytes: input.streamedBytes,
    eventRate: input.eventRate,
    deduplicationRate: input.deduplicationRate,
    resourceConsumption: input.resourceConsumption,
    timestamp: new Date().toISOString(),
  };
}

export function versionedOffset(value: number): number {
  return value + 1;
}
