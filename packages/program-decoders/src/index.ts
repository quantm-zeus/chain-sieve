/**
 * @requirement FR-COL-002
 * @requirement FR-COL-007
 * Minimal versioned decoder registry. Unknown variants pause scope, preserve raw.
 */
export type DecodeResult = { ok: true; decoded: unknown } | { ok: false; reason: string; rawPreserved: true };
export type Decoder = (raw: Uint8Array) => DecodeResult;
const decoders = new Map<string, Decoder>([
  ['pump-bc-v1', (raw) => ({ ok: true, decoded: { kind: 'pump-bc', size: raw.length } })],
  ['jupiter-v6', (raw) => ({ ok: true, decoded: { kind: 'jupiter', size: raw.length } })],
]);
export const decode = (decoderId: string, raw: Uint8Array): DecodeResult => {
  const decoder = decoders.get(decoderId);
  if (!decoder) return { ok: false, reason: `UNKNOWN_DECODER:${decoderId}`, rawPreserved: true };
  try { return decoder(raw); } catch { return { ok: false, reason: `DECODE_FAILURE:${decoderId}`, rawPreserved: true }; }
};
export const hasDecoder = (decoderId: string): boolean => decoders.has(decoderId);
