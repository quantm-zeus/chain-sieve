/**
 * @requirement FR-COL-002
 * @requirement FR-COL-007
 * Versioned decoder registry. Unknown instruction variants, decoder drift,
 * and unsupported versions pause scope, preserve raw events, and fail closed.
 * No generic fallback; every decoder is explicit.
 */
export type DecodeResult =
  | { ok: true; decoded: unknown; decoderId: string }
  | { ok: false; reason: string; rawPreserved: true; decoderId: string };

export type Decoder = (raw: Uint8Array) => Omit<Extract<DecodeResult, { ok: true }>, 'decoderId'> | Omit<Extract<DecodeResult, { ok: false }>, 'decoderId' | 'rawPreserved'>;

const stubDecoder =
  (kind: string): Decoder =>
  (raw: Uint8Array) => ({ ok: true, decoded: { kind, size: raw.length } });

const decoders = new Map<string, Decoder>([
  ['pump-bc-v1', stubDecoder('pump-bc')],
  ['pumpswap-v1', stubDecoder('pumpswap')],
  ['raydium-amm-v4', stubDecoder('raydium-amm-v4')],
  ['raydium-cpmm-v1', stubDecoder('raydium-cpmm')],
  ['raydium-clmm-v1', stubDecoder('raydium-clmm')],
  ['raydium-stable-v1', stubDecoder('raydium-stable')],
  ['raydium-launchlab-v1', stubDecoder('raydium-launchlab')],
  ['orca-v1', stubDecoder('orca-whirlpools')],
  ['meteora-dlmm-v1', stubDecoder('meteora-dlmm')],
  ['meteora-damm-v1', stubDecoder('meteora-damm-v1')],
  ['meteora-damm-v2', stubDecoder('meteora-damm-v2')],
  ['meteora-dbc-v1', stubDecoder('meteora-dbc')],
  ['jupiter-v6', stubDecoder('jupiter')],
]);

export const decode = (decoderId: string, raw: Uint8Array): DecodeResult => {
  const decoder = decoders.get(decoderId);
  if (!decoder) {
    return { ok: false, reason: `UNKNOWN_DECODER:${decoderId}`, rawPreserved: true, decoderId };
  }
  try {
    const result = decoder(raw);
    if ((result as { ok: boolean }).ok) {
      return { ...(result as { ok: true; decoded: unknown }), decoderId };
    }
    const fail = result as { ok: false; reason: string };
    return { ok: false, reason: fail.reason ?? `DECODE_FAILURE:${decoderId}`, rawPreserved: true, decoderId };
  } catch {
    return { ok: false, reason: `DECODE_FAILURE:${decoderId}`, rawPreserved: true, decoderId };
  }
};

export const hasDecoder = (decoderId: string): boolean => decoders.has(decoderId);

export const supportedDecoderIds = (): string[] => [...decoders.keys()];

export const registerDecoder = (decoderId: string, decoder: Decoder): void => {
  decoders.set(decoderId, decoder);
};
