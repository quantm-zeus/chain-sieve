import type { Gap } from './types.js';

export interface BackfillRequest {
  partition: string;
  fromSlot: number;
  toSlot: number;
  endpoint: string;
  availableAt: string;
}

export interface BackfillResult {
  request: BackfillRequest;
  retrievedAt: string;
  eventsFound: number;
  unresolved: boolean;
}

export const createBackfillRequest = (gap: Gap, endpoint: string, nowIso: string): BackfillRequest => ({
  partition: gap.partition,
  fromSlot: gap.fromSlot,
  toSlot: gap.toSlot,
  endpoint,
  availableAt: nowIso,
});

export const preserveRetrievalTime = (result: BackfillResult): string => result.retrievedAt;

export const isAvailableAtBackdated = (chainTimeIso: string, availableAtIso: string): boolean =>
  new Date(availableAtIso).getTime() < new Date(chainTimeIso).getTime();
