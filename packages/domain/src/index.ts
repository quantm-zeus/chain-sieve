export type CapabilityState =
  | 'IMPLEMENTED'
  | 'AVAILABLE'
  | 'SHADOW'
  | 'PROVEN'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'PAUSED'
  | 'RETIRED'
  | 'DISABLED';

export type Availability = 'AVAILABLE' | 'NOT_AVAILABLE' | 'INSUFFICIENT_DATA';

export interface PointInTime<T> {
  value: T;
  eventTime: string;
  observedAt: string;
  availableAt: string;
  provenance: string;
  quality: 'VERIFIED' | 'SYNTHETIC' | 'CONFLICTED' | 'MISSING';
}

export interface SyntheticAsset {
  id: string;
  chain: 'synthetic';
  symbol: string;
  capability: 'SYNTHETIC_SHADOW';
}

export interface EvidenceReference {
  artifactKey: string;
  sha256: string;
  mediaType: string;
  frozenAt: string;
}

export interface DegradedResult<T> {
  status: Availability;
  value?: T;
  reason?: string;
}

export const assertNoBackdating = (eventTime: string, availableAt: string): void => {
  if (Date.parse(availableAt) < Date.parse(eventTime)) {
    throw new Error('AVAILABLE_AT_BACKDATED');
  }
};
