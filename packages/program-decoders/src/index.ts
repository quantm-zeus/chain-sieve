import { sha256Hex } from '@ciag/collector-core';

export type DecodeStatus = 'decoded' | 'unsupported' | 'paused';
export interface DecodeResult {
  status: DecodeStatus;
  program: string;
  programVersion: string;
  eventFamily?: string;
  decoded?: unknown;
  reason?: string;
  decoderVersion: string;
  rawHash: string;
}

export interface Decoder {
  program: string;
  version: string;
  decode(raw: Uint8Array, eventFamily: string): DecodeResult;
}

const makeUnsupported = (program: string, version: string, raw: Uint8Array, reason: string): DecodeResult => ({
  status: 'unsupported',
  program,
  programVersion: version,
  reason,
  decoderVersion: `${program}-${version}-unsupported`,
  rawHash: sha256Hex(raw),
});

const makePaused = (program: string, version: string, raw: Uint8Array, reason: string): DecodeResult => ({
  status: 'paused',
  program,
  programVersion: version,
  reason,
  decoderVersion: `${program}-${version}-paused`,
  rawHash: sha256Hex(raw),
});

export const createPumpBondingCurveDecoder = (): Decoder => ({
  program: 'pump',
  version: 'bonding-curve-v1',
  decode(raw, family) {
    const hash = sha256Hex(raw);
    const allowed = ['pool_creation', 'state_progress', 'migration', 'liquidity_change', 'authority_change', 'swap'];
    if (!allowed.includes(family)) return makeUnsupported('pump', 'bonding-curve-v1', raw, `UNKNOWN_FAMILY:${family}`);
    if (raw.length === 0) return makePaused('pump', 'bonding-curve-v1', raw, 'EMPTY_RAW');
    return { status: 'decoded', program: 'pump', programVersion: 'bonding-curve-v1', eventFamily: family, decoded: { family, hash }, decoderVersion: 'pump-bonding-curve-v1-1.0.0', rawHash: hash };
  },
});

export const createPumpSwapDecoder = (): Decoder => ({
  program: 'pump',
  version: 'pumpswap-v1',
  decode(raw, family) {
    const hash = sha256Hex(raw);
    const allowed = ['pool_creation', 'swap', 'liquidity_change'];
    if (!allowed.includes(family)) return makeUnsupported('pump', 'pumpswap-v1', raw, `UNKNOWN_FAMILY:${family}`);
    return { status: 'decoded', program: 'pump', programVersion: 'pumpswap-v1', eventFamily: family, decoded: { family, hash }, decoderVersion: 'pump-pumpswap-v1-1.0.0', rawHash: hash };
  },
});

export const createRaydiumDecoder = (version: 'amm-v4' | 'cpmm-v1' | 'clmm-v1' | 'stable-amm-v1' | 'launchlab-v1'): Decoder => ({
  program: 'raydium',
  version,
  decode(raw, family) {
    const hash = sha256Hex(raw);
    const map: Record<string, string[]> = {
      'amm-v4': ['pool_creation', 'liquidity_change', 'swap'],
      'cpmm-v1': ['pool_creation', 'liquidity_change', 'swap'],
      'clmm-v1': ['pool_creation', 'liquidity_change', 'swap', 'authority_change'],
      'stable-amm-v1': ['pool_creation', 'swap'],
      'launchlab-v1': ['launch_creation', 'state_progress', 'migration', 'swap'],
    };
    const allowed = map[version] ?? [];
    if (!allowed.includes(family)) return makeUnsupported('raydium', version, raw, `UNKNOWN_FAMILY:${family}`);
    return { status: 'decoded', program: 'raydium', programVersion: version, eventFamily: family, decoded: { family, hash }, decoderVersion: `raydium-${version}-1.0.0`, rawHash: hash };
  },
});

export const createOrcaDecoder = (): Decoder => ({
  program: 'orca',
  version: 'whirlpools-v1',
  decode(raw, family) {
    const hash = sha256Hex(raw);
    if (!['pool_creation', 'liquidity_change', 'swap', 'authority_change'].includes(family)) return makeUnsupported('orca', 'whirlpools-v1', raw, `UNKNOWN_FAMILY:${family}`);
    return { status: 'decoded', program: 'orca', programVersion: 'whirlpools-v1', eventFamily: family, decoded: { family, hash }, decoderVersion: 'orca-whirlpools-v1-1.0.0', rawHash: hash };
  },
});

export const createMeteoraDecoder = (version: 'dlmm-v1' | 'damm-v1' | 'damm-v2' | 'dynamic-bonding-curve-v1'): Decoder => ({
  program: 'meteora',
  version,
  decode(raw, family) {
    const hash = sha256Hex(raw);
    const map: Record<string, string[]> = {
      'dlmm-v1': ['pool_creation', 'liquidity_change', 'swap'],
      'damm-v1': ['pool_creation', 'swap'],
      'damm-v2': ['pool_creation', 'swap', 'liquidity_change'],
      'dynamic-bonding-curve-v1': ['pool_creation', 'state_progress', 'swap'],
    };
    if (!(map[version] ?? []).includes(family)) return makeUnsupported('meteora', version, raw, `UNKNOWN_FAMILY:${family}`);
    return { status: 'decoded', program: 'meteora', programVersion: version, eventFamily: family, decoded: { family, hash }, decoderVersion: `meteora-${version}-1.0.0`, rawHash: hash };
  },
});

export const createJupiterDecoder = (): Decoder => ({
  program: 'jupiter',
  version: 'route-observation-v1',
  decode(raw, family) {
    const hash = sha256Hex(raw);
    if (!['route_observation', 'reconciliation'].includes(family)) return makeUnsupported('jupiter', 'route-observation-v1', raw, `UNKNOWN_FAMILY:${family}`);
    return { status: 'decoded', program: 'jupiter', programVersion: 'route-observation-v1', eventFamily: family, decoded: { family, hash, note: 'observation-only' }, decoderVersion: 'jupiter-route-observation-v1-1.0.0', rawHash: hash };
  },
});

export class DecoderRegistry {
  private readonly decoders = new Map<string, Decoder>();
  constructor(decoders: Decoder[]) {
    for (const d of decoders) this.decoders.set(`${d.program}:${d.version}`, d);
  }
  resolve(program: string, version: string): Decoder | undefined {
    return this.decoders.get(`${program}:${version}`);
  }
  decode(program: string, version: string, raw: Uint8Array, family: string): DecodeResult {
    const decoder = this.resolve(program, version);
    if (!decoder) return makeUnsupported(program, version, raw, `UNKNOWN_PROGRAM_VERSION:${program}:${version}`);
    return decoder.decode(raw, family);
  }
  supportedKeys(): string[] {
    return [...this.decoders.keys()];
  }
}

export const defaultRegistry = (): DecoderRegistry =>
  new DecoderRegistry([
    createPumpBondingCurveDecoder(),
    createPumpSwapDecoder(),
    createRaydiumDecoder('amm-v4'),
    createRaydiumDecoder('cpmm-v1'),
    createRaydiumDecoder('clmm-v1'),
    createRaydiumDecoder('stable-amm-v1'),
    createRaydiumDecoder('launchlab-v1'),
    createOrcaDecoder(),
    createMeteoraDecoder('dlmm-v1'),
    createMeteoraDecoder('damm-v1'),
    createMeteoraDecoder('damm-v2'),
    createMeteoraDecoder('dynamic-bonding-curve-v1'),
    createJupiterDecoder(),
  ]);
