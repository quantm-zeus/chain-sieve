export interface RawEvent {
  signature: string;
  slot: number;
  program: string;
  version: string;
  raw: string;
}

export interface DecodedEvent {
  signature: string;
  decodedAt: string;
  incidentRequired: boolean;
  preserveRaw: boolean;
}

export const decodeEvent = (event: RawEvent): DecodedEvent => {
  const known = new Set([
    'PumpBondingCurve:v1',
    'PumpSwap:v1',
    'RaydiumAMMv4:v4',
    'RaydiumCPMM:v1',
    'RaydiumCLMM:v1',
    'RaydiumStableAMM:v1',
    'RaydiumLaunchLab:v1',
    'OrcaWhirlpools:v1',
    'MeteoraDLMM:v1',
    'MeteoraDAMMv1:v1',
    'MeteoraDAMMv2:v2',
    'MeteoraDBC:v1',
    'Jupiter:v6',
  ]);
  const key = `${event.program}:${event.version}`;
  const supported = known.has(key);
  return {
    signature: event.signature,
    decodedAt: new Date().toISOString(),
    incidentRequired: !supported,
    preserveRaw: true,
  };
};

export const isReorgRevision = (previousSlot: number, nextSlot: number): boolean => nextSlot < previousSlot;
