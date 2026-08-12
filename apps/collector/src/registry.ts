/**
 * @requirement FR-COL-001
 * @requirement FR-COL-002
 * Versioned first-party collector allowlist. No coverage outside explicit scope.
 * Supported chains/programs are versioned and deny unsupported versions.
 */
export type FinalityPolicy = 'processed' | 'confirmed' | 'finalized';
export type ChainId = 'solana';
export type EventFamily =
  | 'pool_create'
  | 'pool_state_progress'
  | 'pool_migration'
  | 'liquidity_change'
  | 'authority_change'
  | 'config_change'
  | 'swap'
  | 'flow';

export interface AllowlistEntry {
  chain: ChainId;
  program: string;
  programVersion: string;
  accounts: string[];
  eventFamilies: EventFamily[];
  finality: FinalityPolicy;
  enabled: boolean;
}

export interface CollectorScope {
  version: string;
  allowlist: AllowlistEntry[];
}

const SUPPORTED: Record<string, Set<string>> = {
  'pump-bc': new Set(['v1']),
  'pumpswap': new Set(['v1']),
  'raydium-amm-v4': new Set(['v4']),
  'raydium-cpmm': new Set(['v1']),
  'raydium-clmm': new Set(['v1']),
  'raydium-stable': new Set(['v1']),
  'raydium-launchlab': new Set(['v1']),
  'orca-whirlpools': new Set(['v1']),
  'meteora-dlmm': new Set(['v1']),
  'meteora-damm-v1': new Set(['v1']),
  'meteora-damm-v2': new Set(['v2']),
  'meteora-dbc': new Set(['v1']),
  'jupiter': new Set(['v6']),
};

export const COLLECTOR_VERSION = '1.0.0';

export const createScope = (overrides: Partial<CollectorScope> = {}): CollectorScope => ({
  version: COLLECTOR_VERSION,
  allowlist: [
    { chain: 'solana', program: 'pump-bc', programVersion: 'v1', accounts: [], eventFamilies: ['pool_create','pool_state_progress'], finality: 'confirmed', enabled: true },
    { chain: 'solana', program: 'jupiter', programVersion: 'v6', accounts: [], eventFamilies: ['swap','flow'], finality: 'confirmed', enabled: true },
  ],
  ...overrides,
});

export const isSupported = (program: string, version: string): boolean => {
  const versions = SUPPORTED[program];
  return versions !== undefined && versions.has(version);
};

export const validateScope = (scope: CollectorScope): { ok: true } | { ok: false; reason: string } => {
  if (!scope.version || typeof scope.version !== 'string') return { ok: false, reason: 'INVALID_VERSION' };
  for (const entry of scope.allowlist) {
    if (!isSupported(entry.program, entry.programVersion)) {
      return { ok: false, reason: `UNSUPPORTED:${entry.program}@${entry.programVersion}` };
    }
    if (entry.enabled && entry.eventFamilies.length === 0) return { ok: false, reason: 'EMPTY_EVENT_FAMILIES' };
  }
  return { ok: true };
};

export const isCovered = (scope: CollectorScope, chain: ChainId, program: string, version: string, family: EventFamily): boolean => {
  if (!isSupported(program, version)) return false;
  return scope.allowlist.some((e) => e.chain === chain && e.program === program && e.programVersion === version && e.enabled && e.eventFamilies.includes(family));
};
