export type ChainId = 'solana';
export type FinalityPolicy = 'confirmed' | 'finalized';
export type ProgramId = string;
export type ProgramVersion = string;
export type EventFamily =
  | 'pool_creation'
  | 'state_progress'
  | 'migration'
  | 'liquidity_change'
  | 'authority_change'
  | 'config_change'
  | 'swap'
  | 'flow';

export interface AllowlistEntry {
  chain: ChainId;
  program: ProgramId;
  versions: ProgramVersion[];
  eventFamilies: EventFamily[];
  finality: FinalityPolicy;
}

export interface Allowlist {
  version: string;
  entries: AllowlistEntry[];
}

export interface CollectorEventCoordinates {
  slot: number;
  blockHash: string;
  signature: string;
  instructionIndex: number;
  logIndex?: number;
  account?: string;
}

export interface CollectorStreamRecord {
  endpoint: string;
  subscriptionVersion: string;
  connectionGeneration: number;
  slot: number;
  blockHash: string;
  signature: string;
  coordinates: CollectorEventCoordinates;
  receivedAt: string;
  availableAt: string;
  finality: FinalityPolicy;
  rawArtifactHash: string;
  decoderVersion: string;
  rightsPolicy: string;
}

export interface Checkpoint {
  partition: string;
  slot: number;
  sequence: number;
  updatedAt: string;
}

export interface Gap {
  partition: string;
  fromSlot: number;
  toSlot: number;
  detectedAt: string;
  resolved: boolean;
}

export interface HealthSnapshot {
  connected: boolean;
  endpointGeneration: number;
  headSlot: number;
  finalizedSlot: number;
  checkpointLag: number;
  gapCount: number;
  gapDurationMs: number;
  backfillStatus: 'idle' | 'running' | 'degraded';
  decodeFailureRate: number;
  streamedBytes: number;
  eventRate: number;
  deduplicationRate: number;
  resourceConsumption: { cpu: number; memoryMb: number; networkKbps: number };
}

export interface Incident {
  id: string;
  scope: string;
  reason: string;
  createdAt: string;
  preservedRaw: boolean;
}
