import type { Allowlist, AllowlistEntry, ChainId, ProgramId, ProgramVersion } from './types.js';

const SUPPORTED_PROGRAMS: Array<{ program: ProgramId; versions: ProgramVersion[] }> = [
  { program: 'PumpBondingCurve', versions: ['v1'] },
  { program: 'PumpSwap', versions: ['v1'] },
  { program: 'RaydiumAMMv4', versions: ['v4'] },
  { program: 'RaydiumCPMM', versions: ['v1'] },
  { program: 'RaydiumCLMM', versions: ['v1'] },
  { program: 'RaydiumStableAMM', versions: ['v1'] },
  { program: 'RaydiumLaunchLab', versions: ['v1'] },
  { program: 'OrcaWhirlpools', versions: ['v1'] },
  { program: 'MeteoraDLMM', versions: ['v1'] },
  { program: 'MeteoraDAMMv1', versions: ['v1'] },
  { program: 'MeteoraDAMMv2', versions: ['v2'] },
  { program: 'MeteoraDBC', versions: ['v1'] },
  { program: 'Jupiter', versions: ['v6'] },
];

export const createAllowlist = (version: string): Allowlist => ({
  version,
  entries: SUPPORTED_PROGRAMS.map((entry) => ({
    chain: 'solana' as ChainId,
    program: entry.program,
    versions: [...entry.versions],
    eventFamilies: [
      'pool_creation',
      'state_progress',
      'migration',
      'liquidity_change',
      'authority_change',
      'config_change',
      'swap',
    ],
    finality: 'confirmed',
  })),
});

export const isAllowlisted = (allowlist: Allowlist, program: string, version: string): boolean => {
  const entry = allowlist.entries.find((item) => item.program === program);
  if (!entry) return false;
  return entry.versions.includes(version);
};

export const assertAllowlisted = (allowlist: Allowlist, program: string, version: string): AllowlistEntry => {
  const entry = allowlist.entries.find((item) => item.program === program);
  if (!entry) throw new Error(`UNSUPPORTED_PROGRAM:${program}`);
  if (!entry.versions.includes(version)) throw new Error(`UNSUPPORTED_VERSION:${program}:${version}`);
  return entry;
};
