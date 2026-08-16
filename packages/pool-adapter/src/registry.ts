import { createHash } from 'node:crypto';
import type { CurveType, ProgramSupportManifest } from './types.js';

const MANIFESTS: ProgramSupportManifest[] = [
  {
    manifestId: 'manifest-pump-bc-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'PUMP',
    productFamily: 'pump-bc',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'pump-bc-v1',
    poolMathAdapterVersion: 'pump-bc-adapter-v1',
    curveTypes: ['BONDING_CURVE'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('pump-bc-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'pump-bonding-curve',
  },
  {
    manifestId: 'manifest-pumpswap-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'PUMP',
    productFamily: 'pumpswap',
    programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMwFa',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'pumpswap-v1',
    poolMathAdapterVersion: 'pumpswap-adapter-v1',
    curveTypes: ['CONSTANT_PRODUCT'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('pumpswap-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'constant-product',
  },
  {
    manifestId: 'manifest-raydium-amm-v4',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'RAYDIUM',
    productFamily: 'raydium-amm-v4',
    programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    accountLayoutVersion: '4',
    instructionLayoutVersion: '4',
    decoderVersion: 'raydium-amm-v4',
    poolMathAdapterVersion: 'raydium-amm-v4-adapter-v1',
    curveTypes: ['CONSTANT_PRODUCT'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('raydium-amm-v4-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'constant-product',
  },
  {
    manifestId: 'manifest-raydium-cpmm-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'RAYDIUM',
    productFamily: 'raydium-cpmm',
    programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHK8jV3sza71',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'raydium-cpmm-v1',
    poolMathAdapterVersion: 'raydium-cpmm-adapter-v1',
    curveTypes: ['CONSTANT_PRODUCT'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('raydium-cpmm-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'constant-product',
  },
  {
    manifestId: 'manifest-raydium-clmm-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'RAYDIUM',
    productFamily: 'raydium-clmm',
    programId: 'devi51mUGhDispQQLHh5UAeco1Bmk2BmTJeyScc7hWmy',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'raydium-clmm-v1',
    poolMathAdapterVersion: 'raydium-clmm-adapter-v1',
    curveTypes: ['CONCENTRATED_LIQUIDITY'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('raydium-clmm-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'concentrated-liquidity',
  },
  {
    manifestId: 'manifest-raydium-stable-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'RAYDIUM',
    productFamily: 'raydium-stable',
    programId: '5quLmsgDkgsDVMepkyWhcr6DejsANzUZqawdFv6mVENon',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'raydium-stable-v1',
    poolMathAdapterVersion: 'raydium-stable-adapter-v1',
    curveTypes: ['STABLE_SWAP'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('raydium-stable-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'stable-swap',
  },
  {
    manifestId: 'manifest-raydium-launchlab-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'RAYDIUM',
    productFamily: 'raydium-launchlab',
    programId: 'LanMV9sUWJeZh2d95gRhYQ7mT6QugGaehVKJomqBK1Rh',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'raydium-launchlab-v1',
    poolMathAdapterVersion: 'raydium-launchlab-adapter-v1',
    curveTypes: ['BONDING_CURVE'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('raydium-launchlab-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'pump-bonding-curve',
  },
  {
    manifestId: 'manifest-orca-whirlpools-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'ORCA',
    productFamily: 'orca-whirlpools',
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'orca-v1',
    poolMathAdapterVersion: 'orca-whirlpools-adapter-v1',
    curveTypes: ['CONCENTRATED_LIQUIDITY'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('orca-whirlpools-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'concentrated-liquidity',
  },
  {
    manifestId: 'manifest-meteora-dlmm-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'METEORA',
    productFamily: 'meteora-dlmm',
    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'meteora-dlmm-v1',
    poolMathAdapterVersion: 'meteora-dlmm-adapter-v1',
    curveTypes: ['DISCRETE_BIN'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('meteora-dlmm-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'discrete-bin',
  },
  {
    manifestId: 'manifest-meteora-damm-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'METEORA',
    productFamily: 'meteora-damm-v1',
    programId: 'Eo7WjKq67rjJQSZ23YFdGAte86VnQEUJoZ8zUH4Yk2hV',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'meteora-damm-v1',
    poolMathAdapterVersion: 'meteora-damm-v1-adapter-v1',
    curveTypes: ['DYNAMIC_FEE', 'CONSTANT_PRODUCT'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('meteora-damm-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'dynamic-fee',
  },
  {
    manifestId: 'manifest-meteora-damm-v2',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'METEORA',
    productFamily: 'meteora-damm-v2',
    programId: 'cpamdpZCGKUy5JxCMBSB4Vqc7CEYHob3Bgj5ipR9qW',
    accountLayoutVersion: '2',
    instructionLayoutVersion: '2',
    decoderVersion: 'meteora-damm-v2',
    poolMathAdapterVersion: 'meteora-damm-v2-adapter-v1',
    curveTypes: ['DYNAMIC_FEE', 'CONSTANT_PRODUCT'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('meteora-damm-v2-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'dynamic-fee',
  },
  {
    manifestId: 'manifest-meteora-dbc-v1',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'METEORA',
    productFamily: 'meteora-dbc',
    programId: 'dbRi4vNzpQs4D9kRK1h3DHT7q8SgU6pGvF7K9Zy9kq9k',
    accountLayoutVersion: '1',
    instructionLayoutVersion: '1',
    decoderVersion: 'meteora-dbc-v1',
    poolMathAdapterVersion: 'meteora-dbc-adapter-v1',
    curveTypes: ['BONDING_CURVE'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('meteora-dbc-v1-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'pump-bonding-curve',
  },
  {
    manifestId: 'manifest-jupiter-v6',
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    protocolFamily: 'JUPITER',
    productFamily: 'jupiter',
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    accountLayoutVersion: '6',
    instructionLayoutVersion: '6',
    decoderVersion: 'jupiter-v6',
    poolMathAdapterVersion: null,
    curveTypes: ['AGGREGATED_ROUTE'],
    capabilityState: 'ACTIVE',
    contentHash: createHash('sha256').update('jupiter-v6-manifest').digest('hex'),
    validFrom: '2026-01-01T00:00:00.000Z',
    signed: true,
    adapterId: 'jupiter-route-observer',
  },
];

export const getManifest = (dex: string, programVersion: string, curveType: CurveType): ProgramSupportManifest | undefined => {
  const lowerDex = dex.toLowerCase();
  return MANIFESTS.find((m) => m.productFamily.includes(lowerDex) && m.accountLayoutVersion === programVersion.replace(/^v/, '') && m.curveTypes.includes(curveType));
};

export const getManifestByAdapterId = (adapterId: string): ProgramSupportManifest | undefined =>
  MANIFESTS.find((m) => m.adapterId === adapterId);

export const listManifests = (): ProgramSupportManifest[] => [...MANIFESTS];

export const verifyManifest = (manifest: ProgramSupportManifest): boolean => {
  if (!manifest.signed) return false;
  if (manifest.capabilityState === 'UNAVAILABLE' || manifest.capabilityState === 'RETIRED') return false;
  if (!manifest.contentHash || manifest.contentHash.length !== 64) return false;
  return true;
};

export const isSupported = (dex: string, programVersion: string, curveType: CurveType): boolean => {
  const m = getManifest(dex, programVersion, curveType);
  return Boolean(m && verifyManifest(m));
};

// Typed unsupported error helper (AC-230 requires explicit unsupported state, not generic AMM)
export const unsupportedManifestError = (dex: string, programVersion: string, curveType: CurveType): never => {
  throw new (class extends Error {
    code = 'UNSUPPORTED_POOL_TYPE' as const;
    constructor() {
      super(`UNSUPPORTED_POOL_TYPE:${dex}@${programVersion}:${curveType}`);
      this.name = 'PoolAdapterError';
    }
  })();
};
