import { createHash } from 'node:crypto';
import type { EvidenceReference } from '@ciag/domain';
import type { ObjectStoreAdapter } from '@ciag/provider-contracts';

const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)])) : value;
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export const freezeEvidence = async (store: ObjectStoreAdapter, key: string, value: unknown, frozenAt: string): Promise<EvidenceReference> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const result = await store.put(key, bytes, { frozenAt, mediaType: 'application/json' });
  return { artifactKey: key, sha256: result.sha256, mediaType: 'application/json', frozenAt };
};
