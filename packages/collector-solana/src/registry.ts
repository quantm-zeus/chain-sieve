export type DecoderVersion = string;
export interface DecoderManifest {
  program: string;
  version: DecoderVersion;
  supported: boolean;
  signed: boolean;
}

const SUPPORTED: DecoderManifest[] = [
  { program: 'PumpBondingCurve', version: 'v1', supported: true, signed: true },
  { program: 'PumpSwap', version: 'v1', supported: true, signed: true },
  { program: 'RaydiumAMMv4', version: 'v4', supported: true, signed: true },
  { program: 'RaydiumCPMM', version: 'v1', supported: true, signed: true },
  { program: 'RaydiumCLMM', version: 'v1', supported: true, signed: true },
  { program: 'RaydiumStableAMM', version: 'v1', supported: true, signed: true },
  { program: 'RaydiumLaunchLab', version: 'v1', supported: true, signed: true },
  { program: 'OrcaWhirlpools', version: 'v1', supported: true, signed: true },
  { program: 'MeteoraDLMM', version: 'v1', supported: true, signed: true },
  { program: 'MeteoraDAMMv1', version: 'v1', supported: true, signed: true },
  { program: 'MeteoraDAMMv2', version: 'v2', supported: true, signed: true },
  { program: 'MeteoraDBC', version: 'v1', supported: true, signed: true },
  { program: 'Jupiter', version: 'v6', supported: true, signed: true },
];

export const resolveDecoder = (program: string, version: string): DecoderManifest | undefined =>
  SUPPORTED.find((item) => item.program === program && item.version === version);

export const assertSupportedDecoder = (program: string, version: string): DecoderManifest => {
  const manifest = resolveDecoder(program, version);
  if (!manifest) throw new Error(`UNSUPPORTED_DECODER:${program}:${version}`);
  if (!manifest.supported) throw new Error(`DEGRADED_DECODER:${program}:${version}`);
  return manifest;
};

export const listSupportedDecoders = (): DecoderManifest[] => SUPPORTED.map((item) => ({ ...item }));
