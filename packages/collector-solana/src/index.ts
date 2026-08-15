/**
 * @requirement FR-COL-002
 * @requirement FR-COL-001
 * Versioned read-only Solana protocol registry. Unsupported versions remain
 * explicit and cannot inherit generic behavior. Fail-closed for unknown programs.
 */
export type ProtocolKind =
  | 'pump-bc'
  | 'pumpswap'
  | 'raydium-amm-v4'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'raydium-stable'
  | 'raydium-launchlab'
  | 'orca-whirlpools'
  | 'meteora-dlmm'
  | 'meteora-damm-v1'
  | 'meteora-damm-v2'
  | 'meteora-dbc'
  | 'jupiter';

export interface ProtocolEntry {
  kind: ProtocolKind;
  version: string;
  supported: boolean;
  decoder: string;
}

const REGISTRY: ProtocolEntry[] = [
  { kind: 'pump-bc', version: 'v1', supported: true, decoder: 'pump-bc-v1' },
  { kind: 'pumpswap', version: 'v1', supported: true, decoder: 'pumpswap-v1' },
  { kind: 'raydium-amm-v4', version: 'v4', supported: true, decoder: 'raydium-amm-v4' },
  { kind: 'raydium-cpmm', version: 'v1', supported: true, decoder: 'raydium-cpmm-v1' },
  { kind: 'raydium-clmm', version: 'v1', supported: true, decoder: 'raydium-clmm-v1' },
  { kind: 'raydium-stable', version: 'v1', supported: true, decoder: 'raydium-stable-v1' },
  { kind: 'raydium-launchlab', version: 'v1', supported: true, decoder: 'raydium-launchlab-v1' },
  { kind: 'orca-whirlpools', version: 'v1', supported: true, decoder: 'orca-v1' },
  { kind: 'meteora-dlmm', version: 'v1', supported: true, decoder: 'meteora-dlmm-v1' },
  { kind: 'meteora-damm-v1', version: 'v1', supported: true, decoder: 'meteora-damm-v1' },
  { kind: 'meteora-damm-v2', version: 'v2', supported: true, decoder: 'meteora-damm-v2' },
  { kind: 'meteora-dbc', version: 'v1', supported: true, decoder: 'meteora-dbc-v1' },
  { kind: 'jupiter', version: 'v6', supported: true, decoder: 'jupiter-v6' },
];

export const allSupported = (): ProtocolEntry[] => REGISTRY.filter((e) => e.supported);

export const SUPPORTED_PROGRAMS = REGISTRY.map((e) => `${e.kind}@${e.version}`);

export type ResolveResult =
  | ProtocolEntry
  | { supported: false; reason: string };

export const resolveProtocol = (kind: string, version: string): ResolveResult => {
  const entry = REGISTRY.find((e) => e.kind === kind && e.version === version);
  if (entry) return entry;
  const known = REGISTRY.some((e) => e.kind === kind);
  if (!known) return { supported: false, reason: `UNKNOWN_PROTOCOL:${kind}` };
  return { supported: false, reason: `UNSUPPORTED_VERSION:${kind}@${version}` };
};

export const isSupportedProtocol = (kind: string, version: string): boolean => {
  const r = resolveProtocol(kind, version);
  return (r as ProtocolEntry).supported === true;
};
