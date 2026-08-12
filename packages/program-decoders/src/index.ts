export interface DecoderVersion {
  program: string;
  version: string;
  decoderVersion: string;
  layoutHash: string;
}

export const DECODER_VERSIONS: DecoderVersion[] = [
  { program: 'pump', version: 'bonding_curve_v1', decoderVersion: '1.0.0', layoutHash: 'hash-pump-bc' },
  { program: 'jupiter', version: 'route_observation_v1', decoderVersion: '1.0.0', layoutHash: 'hash-jupiter-route' },
];

export function getDecoderVersion(program: string, version: string): DecoderVersion | undefined {
  return DECODER_VERSIONS.find((d) => d.program === program && d.version === version);
}

export function isDecoderSupported(program: string, version: string): boolean {
  return DECODER_VERSIONS.some((d) => d.program === program && d.version === version);
}
