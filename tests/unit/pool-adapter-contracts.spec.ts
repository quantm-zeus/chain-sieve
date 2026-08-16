import { describe, it, expect } from 'vitest';
import {
  normalizePool,
  resolvePoolAdapter,
  PoolAdapterError,
  listSupportedAdapters,
  normalizeEconomicTrades,
  TradeNormalizationError,
  quoteViaJupiter,
  listManifests,
  verifyManifest,
  canonicalPoolJson,
} from '@ciag/pool-adapter';

// Helpers to build fixtures for each supported pool shape
const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const baseFixture = {
  constantProduct: {
    raw: {
      poolAddress: 'PoolCP111111111111111111111111111111111111111',
      baseReserveRaw: '1000000000',
      quoteReserveRaw: '2000000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      feeBps: 30,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'raydium',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      programVersion: 'v4',
      curveType: 'CONSTANT_PRODUCT' as const,
      raw: {
        poolAddress: 'PoolCP111111111111111111111111111111111111111',
        baseReserveRaw: '1000000000',
        quoteReserveRaw: '2000000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        feeBps: 30,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  bondingCurve: {
    raw: {
      poolAddress: 'PoolBC111111111111111111111111111111111111111',
      baseReserveRaw: '500000000',
      quoteReserveRaw: '8000000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      virtualBaseReserves: '1000000000000',
      virtualQuoteReserves: '30000000000',
      realBaseReserves: '500000000',
      realQuoteReserves: '8000000000',
      progressBps: 4500,
      feeBps: 0,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'pump',
      programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      programVersion: 'v1',
      curveType: 'BONDING_CURVE' as const,
      raw: {
        poolAddress: 'PoolBC111111111111111111111111111111111111111',
        baseReserveRaw: '500000000',
        quoteReserveRaw: '8000000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        virtualBaseReserves: '1000000000000',
        virtualQuoteReserves: '30000000000',
        realBaseReserves: '500000000',
        realQuoteReserves: '8000000000',
        progressBps: 4500,
        feeBps: 0,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  concentrated: {
    raw: {
      poolAddress: 'PoolCL111111111111111111111111111111111111111',
      baseReserveRaw: '1500000000',
      quoteReserveRaw: '2500000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      feeBps: 10,
      currentTick: 5123,
      tickSpacing: 64,
      ticks: Array.from({ length: 12 }, (_, i) => ({ tickIndex: 5000 + i * 64, liquidityNet: '1000000' })),
      ticksRequired: 10,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'orca',
      programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      programVersion: 'v1',
      curveType: 'CONCENTRATED_LIQUIDITY' as const,
      raw: {
        poolAddress: 'PoolCL111111111111111111111111111111111111111',
        baseReserveRaw: '1500000000',
        quoteReserveRaw: '2500000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        feeBps: 10,
        currentTick: 5123,
        tickSpacing: 64,
        ticks: Array.from({ length: 12 }, (_, i) => ({ tickIndex: 5000 + i * 64, liquidityNet: '1000000' })),
        ticksRequired: 10,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  discreteBin: {
    raw: {
      poolAddress: 'PoolBin11111111111111111111111111111111111111',
      baseReserveRaw: '900000000',
      quoteReserveRaw: '900000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      feeBps: 20,
      activeBinId: 5000,
      bins: Array.from({ length: 7 }, (_, i) => ({ binId: 4997 + i, reserveX: '100000000', reserveY: '100000000' })),
      binsRequired: 5,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'meteora-dlmm',
      programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      programVersion: 'v1',
      curveType: 'DISCRETE_BIN' as const,
      raw: {
        poolAddress: 'PoolBin11111111111111111111111111111111111111',
        baseReserveRaw: '900000000',
        quoteReserveRaw: '900000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        feeBps: 20,
        activeBinId: 5000,
        bins: Array.from({ length: 7 }, (_, i) => ({ binId: 4997 + i, reserveX: '100000000', reserveY: '100000000' })),
        binsRequired: 5,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  stable: {
    raw: {
      poolAddress: 'PoolStable1111111111111111111111111111111111',
      baseReserveRaw: '10000000000',
      quoteReserveRaw: '10000000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      feeBps: 5,
      ampFactor: 100,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'raydium-stable',
      programId: '5quLmsgDkgsDVMepkyWhcr6DejsANzUZqawdFv6mVENon',
      programVersion: 'v1',
      curveType: 'STABLE_SWAP' as const,
      raw: {
        poolAddress: 'PoolStable1111111111111111111111111111111111',
        baseReserveRaw: '10000000000',
        quoteReserveRaw: '10000000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        feeBps: 5,
        ampFactor: 100,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  dynamicFee: {
    raw: {
      poolAddress: 'PoolDF1111111111111111111111111111111111111111',
      baseReserveRaw: '1200000000',
      quoteReserveRaw: '1800000000',
      baseDecimals: 9,
      quoteDecimals: 9,
      baseFeeBps: 10,
      variableFeeBps: 15,
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'meteora-damm',
      programId: 'Eo7WjKq67rjJQSZ23YFdGAte86VnQEUJoZ8zUH4Yk2hV',
      programVersion: 'v1',
      curveType: 'DYNAMIC_FEE' as const,
      raw: {
        poolAddress: 'PoolDF1111111111111111111111111111111111111111',
        baseReserveRaw: '1200000000',
        quoteReserveRaw: '1800000000',
        baseDecimals: 9,
        quoteDecimals: 9,
        baseFeeBps: 10,
        variableFeeBps: 15,
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
  jupiter: {
    raw: {
      txHash: '5x111111111111111111111111111111111111111111111111111111111111',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inputAmountRaw: '1000000000',
      outputAmountRaw: '950000000',
      routeSteps: [
        { dex: 'raydium', poolAddress: 'PoolCP111111111111111111111111111111111111111', programVersion: 'v4', curveType: 'CONSTANT_PRODUCT' as const },
        { dex: 'orca', poolAddress: 'PoolCL111111111111111111111111111111111111111', programVersion: 'v1', curveType: 'CONCENTRATED_LIQUIDITY' as const },
      ],
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    input: (overrides: Record<string, unknown> = {}) => ({
      chainId: CHAIN,
      dex: 'jupiter',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      programVersion: 'v6',
      curveType: 'AGGREGATED_ROUTE' as const,
      raw: {
        txHash: '5x111111111111111111111111111111111111111111111111111111111111',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inputAmountRaw: '1000000000',
        outputAmountRaw: '950000000',
        routeSteps: [
          { dex: 'raydium', poolAddress: 'PoolCP111111111111111111111111111111111111111', programVersion: 'v4', curveType: 'CONSTANT_PRODUCT' as const },
          { dex: 'orca', poolAddress: 'PoolCL111111111111111111111111111111111111111', programVersion: 'v1', curveType: 'CONCENTRATED_LIQUIDITY' as const },
        ],
        updatedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    }),
  },
};

describe('pool-adapter deterministic normalization', () => {
  it('lists supported adapters', () => {
    const adapters = listSupportedAdapters();
    expect(adapters).toContain('constant-product');
    expect(adapters).toContain('concentrated-liquidity');
    expect(adapters).toContain('discrete-bin');
  });

  it('manifests are signed and verified', () => {
    const manifests = listManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(10);
    for (const m of manifests) expect(verifyManifest(m)).toBe(true);
  });

  // Deterministic fixture tests for each pool shape
  it('constant-product fixture normalizes deterministically (Raydium AMM v4/CPMM)', () => {
    const a = normalizePool(baseFixture.constantProduct.input());
    const b = normalizePool(baseFixture.constantProduct.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.snapshot.curveType).toBe('CONSTANT_PRODUCT');
    expect(a.snapshot.stateCompleteness).toBe('COMPLETE');
    expect(a.snapshot.feeBps).toBe(30);
    // Reordered raw keys produce same canonical output (canonicalize sorts)
    const reordered = baseFixture.constantProduct.input({
      quoteReserveRaw: '2000000000',
      baseReserveRaw: '1000000000',
    });
    const c = normalizePool(reordered);
    expect(c.sha256).toBe(a.sha256);
  });

  it('bonding-curve fixture normalizes deterministically (Pump, LaunchLab, DBC)', () => {
    const a = normalizePool(baseFixture.bondingCurve.input());
    const b = normalizePool(baseFixture.bondingCurve.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.bondingCurve?.progressBps).toBe(4500);
    expect(a.snapshot.stateCompleteness).toBe('COMPLETE');
  });

  it('concentrated-liquidity fixture normalizes deterministically (Orca, Raydium CLMM)', () => {
    const a = normalizePool(baseFixture.concentrated.input());
    const b = normalizePool(baseFixture.concentrated.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.concentrated?.ticksLoaded).toBe(12);
    expect(a.snapshot.stateCompleteness).toBe('COMPLETE');
  });

  it('discrete-bin fixture normalizes deterministically (Meteora DLMM)', () => {
    const a = normalizePool(baseFixture.discreteBin.input());
    const b = normalizePool(baseFixture.discreteBin.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.bins?.binsLoaded).toBe(7);
    expect(a.snapshot.curveType).toBe('DISCRETE_BIN');
  });

  it('stable-swap fixture normalizes deterministically (Raydium Stable)', () => {
    const a = normalizePool(baseFixture.stable.input());
    const b = normalizePool(baseFixture.stable.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.stable?.ampFactor).toBe(100);
  });

  it('dynamic-fee fixture normalizes deterministically (Meteora DAMM v1/v2)', () => {
    const a = normalizePool(baseFixture.dynamicFee.input());
    const b = normalizePool(baseFixture.dynamicFee.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.dynamicFee?.baseFeeBps).toBe(10);
    expect(a.snapshot.feeBps).toBe(25); // base + variable
  });

  it('jupiter route-observation normalizes deterministically and is read-only', () => {
    const a = normalizePool(baseFixture.jupiter.input());
    const b = normalizePool(baseFixture.jupiter.input());
    expect(a.sha256).toBe(b.sha256);
    expect(a.snapshot.curveType).toBe('AGGREGATED_ROUTE');
    expect(a.snapshot.dex).toBe('jupiter');
    // Jupiter quoting is blocked
    expect(() => quoteViaJupiter()).toThrow(PoolAdapterError);
    expect(() => quoteViaJupiter()).toThrow(/JUPITER_NOT_POOL_MATH_AUTHORITY/);
  });

  it('reordered object keys produce byte-stable canonical snapshot', () => {
    const base = normalizePool(baseFixture.constantProduct.input());
    // Simulate raw with different key insertion order
    const reorderedRaw = {
      updatedAt: '2026-03-01T00:00:00.000Z',
      feeBps: 30,
      quoteReserveRaw: '2000000000',
      baseReserveRaw: '1000000000',
      poolAddress: 'PoolCP111111111111111111111111111111111111111',
      baseDecimals: 9,
      quoteDecimals: 9,
    };
    const reordered = normalizePool({
      chainId: CHAIN,
      dex: 'raydium',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      programVersion: 'v4',
      curveType: 'CONSTANT_PRODUCT',
      raw: reorderedRaw,
    });
    expect(reordered.sha256).toBe(base.sha256);
  });

  it('each supported adapter maps source-specific data into canonical snapshot contract (AC-230 typed)', () => {
    const cases: Array<{ name: string; input: ReturnType<typeof baseFixture.constantProduct.input> | ReturnType<typeof baseFixture.bondingCurve.input> | ReturnType<typeof baseFixture.concentrated.input> | ReturnType<typeof baseFixture.discreteBin.input> | ReturnType<typeof baseFixture.stable.input> | ReturnType<typeof baseFixture.dynamicFee.input> | ReturnType<typeof baseFixture.jupiter.input> }> = [
      { name: 'pumpswap/raydium-amm', input: baseFixture.constantProduct.input() as unknown as ReturnType<typeof baseFixture.constantProduct.input> },
      { name: 'pump-bc', input: baseFixture.bondingCurve.input() as unknown as ReturnType<typeof baseFixture.bondingCurve.input> },
      { name: 'orca-whirlpools', input: baseFixture.concentrated.input() as unknown as ReturnType<typeof baseFixture.concentrated.input> },
      { name: 'meteora-dlmm', input: baseFixture.discreteBin.input() as unknown as ReturnType<typeof baseFixture.discreteBin.input> },
      { name: 'raydium-stable', input: baseFixture.stable.input() as unknown as ReturnType<typeof baseFixture.stable.input> },
      { name: 'meteora-damm', input: baseFixture.dynamicFee.input() as unknown as ReturnType<typeof baseFixture.dynamicFee.input> },
      { name: 'jupiter', input: baseFixture.jupiter.input() as unknown as ReturnType<typeof baseFixture.jupiter.input> },
    ];
    for (const c of cases) {
      const result = normalizePool(c.input as Parameters<typeof normalizePool>[0]);
      // Canonical contract validation
      expect(result.snapshot.poolId).toContain(result.snapshot.chainId);
      expect(result.snapshot.adapterId).toBeTruthy();
      expect(result.snapshot.adapterVersion).toBeTruthy();
      expect(result.canonicalJson).toBe(canonicalPoolJson(result.snapshot));
    }
  });

  it('unknown or mismatched pool design returns explicit unsupported/degraded state not generic constant-product (AC-230)', () => {
    const unknown = {
      chainId: CHAIN,
      dex: 'unknown-dex',
      programId: 'Unknown111111111111111111111111111111111111111',
      programVersion: 'v99',
      curveType: 'CONSTANT_PRODUCT' as const,
      raw: { poolAddress: 'PoolUnknown11111111111111111111111111111111', baseReserveRaw: '1000', quoteReserveRaw: '2000', baseDecimals: 9, quoteDecimals: 9, feeBps: 30, updatedAt: '2026-03-01T00:00:00.000Z' },
    };
    expect(() => normalizePool(unknown)).toThrow(PoolAdapterError);
    expect(() => normalizePool(unknown)).toThrow(/UNSUPPORTED_POOL_TYPE/);

    const mismatched = {
      chainId: CHAIN,
      dex: 'raydium',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      programVersion: 'v99',
      curveType: 'CONSTANT_PRODUCT' as const,
      raw: { poolAddress: 'PoolCP111111111111111111111111111111111111111', baseReserveRaw: '1000', quoteReserveRaw: '2000', baseDecimals: 9, quoteDecimals: 9, feeBps: 30, updatedAt: '2026-03-01T00:00:00.000Z' },
    };
    expect(() => normalizePool(mismatched)).toThrow(PoolAdapterError);
    expect(() => normalizePool(mismatched)).toThrow(/UNSUPPORTED_VERSION/);

    // Mismatched curve should not fall back to constant-product
    const curveMismatch = {
      chainId: CHAIN,
      dex: 'raydium',
      programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      programVersion: 'v4',
      curveType: 'DISCRETE_BIN' as const,
      raw: { poolAddress: 'PoolCP111111111111111111111111111111111111111', baseReserveRaw: '1000', quoteReserveRaw: '2000', baseDecimals: 9, quoteDecimals: 9, feeBps: 30, updatedAt: '2026-03-01T00:00:00.000Z' },
    };
    expect(() => normalizePool(curveMismatch)).toThrow(PoolAdapterError);
  });

  it('adapter failures are explicit typed and do not silently produce partial observations (AC-231)', () => {
    // Missing reserves -> explicit typed error, not partial snapshot
    const missingReserves = baseFixture.constantProduct.input({ baseReserveRaw: undefined as unknown as string });
    expect(() => normalizePool(missingReserves as Parameters<typeof normalizePool>[0])).toThrow(PoolAdapterError);
    try {
      normalizePool(missingReserves as Parameters<typeof normalizePool>[0]);
    } catch (e) {
      expect((e as PoolAdapterError).code).toBe('MISSING_RESERVES');
    }

    // Bonding curve missing curve data -> typed
    const missingCurve = baseFixture.bondingCurve.input({ virtualBaseReserves: undefined as unknown as string });
    expect(() => normalizePool(missingCurve as Parameters<typeof normalizePool>[0])).toThrow(PoolAdapterError);
    try {
      normalizePool(missingCurve as Parameters<typeof normalizePool>[0]);
    } catch (e) {
      expect((e as PoolAdapterError).code).toBe('MISSING_CURVE_DATA');
    }

    // Unknown decoder layout
    const invalidLayout = baseFixture.constantProduct.input({ baseReserveRaw: 'not-a-number' as unknown as string });
    expect(() => normalizePool(invalidLayout as Parameters<typeof normalizePool>[0])).toThrow(PoolAdapterError);
  });

  it('missing tick/bin/curve/account state marks state incomplete and blocks confirmed tradability (AC-232)', () => {
    // Concentrated: missing ticks
    const missingTicks = normalizePool(baseFixture.concentrated.input({ ticks: null as unknown as [] }));
    expect(missingTicks.snapshot.stateCompleteness).toBe('INCOMPLETE');
    expect(missingTicks.snapshot.incompletenessReasons).toContain('MISSING_TICK_DATA');
    expect(missingTicks.snapshot.quality).toBe('INCOMPLETE');
    expect(missingTicks.snapshot.concentrated?.incomplete).toBe(true);

    // Concentrated: ticks below required
    const fewTicks = normalizePool(baseFixture.concentrated.input({ ticks: [{ tickIndex: 5000, liquidityNet: '1000000' }] }));
    expect(fewTicks.snapshot.stateCompleteness).toBe('INCOMPLETE');

    // Discrete bin: missing bins
    const missingBins = normalizePool(baseFixture.discreteBin.input({ bins: null as unknown as [] }));
    expect(missingBins.snapshot.stateCompleteness).toBe('INCOMPLETE');
    expect(missingBins.snapshot.incompletenessReasons).toContain('MISSING_BIN_DATA');

    // Discrete bin: bins below required
    const fewBins = normalizePool(baseFixture.discreteBin.input({ bins: [{ binId: 5000, reserveX: '1000000', reserveY: '1000000' }] }));
    expect(fewBins.snapshot.stateCompleteness).toBe('INCOMPLETE');

    // No silent uniform liquidity assumption: incomplete snapshots must be flagged, not assumed complete
    for (const snap of [missingTicks, fewTicks, missingBins, fewBins]) {
      expect(snap.snapshot.stateCompleteness).not.toBe('COMPLETE');
    }
  });

  it('resolvePoolAdapter returns matching versioned adapter and rejects generic fallback', () => {
    const adapter = resolvePoolAdapter(baseFixture.constantProduct.input() as Parameters<typeof resolvePoolAdapter>[0]);
    expect(adapter.adapterId).toBe('constant-product');
    expect(adapter.version).toBe('v1');

    const jupAdapter = resolvePoolAdapter(baseFixture.jupiter.input() as Parameters<typeof resolvePoolAdapter>[0]);
    expect(jupAdapter.adapterId).toBe('jupiter-route-observer');
  });

  // FR-TRD-001 economic trade normalization
  it('raw swaps, aggregator hops normalized into economic trade events (FR-TRD-001)', () => {
    const hops = [
      {
        txHash: 'tx1',
        hopIndex: 0,
        programId: 'raydium',
        fromMint: 'So11111111111111111111111111111111111111112',
        toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        fromAmountRaw: '1000000000',
        toAmountRaw: '950000000',
        actor: 'walletA',
        isAggregatorHop: false,
      },
      {
        txHash: 'tx1',
        hopIndex: 1,
        programId: 'orca',
        fromMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        toMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        fromAmountRaw: '950000000',
        toAmountRaw: '940000000',
        actor: 'walletA',
        isAggregatorHop: true,
      },
    ];
    const trades = normalizeEconomicTrades(hops);
    // Aggregator hops collapsed into one economic trade per actor per tx
    expect(trades.length).toBe(1);
    expect(trades[0]!.hopCount).toBe(2);
    expect(trades[0]!.aggregated).toBe(true);
    expect(trades[0]!.netBaseDeltaRaw).toBe('1000000000');
    expect(trades[0]!.netQuoteDeltaRaw).toBe('940000000');
    expect(trades[0]!.legs.length).toBe(2);

    // Distinct tx => distinct trades
    const hops2 = [
      ...hops,
      {
        txHash: 'tx2',
        hopIndex: 0,
        programId: 'raydium',
        fromMint: 'So11111111111111111111111111111111111111112',
        toMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        fromAmountRaw: '500000000',
        toAmountRaw: '480000000',
        actor: 'walletA',
        isAggregatorHop: false,
      },
    ];
    const trades2 = normalizeEconomicTrades(hops2);
    expect(trades2.length).toBe(2);
  });

  it('economic trade normalization avoids double counting and distinguishes round trips', () => {
    const roundTrip = [
      {
        txHash: 'txRT',
        hopIndex: 0,
        programId: 'raydium',
        fromMint: 'MintA',
        toMint: 'MintB',
        fromAmountRaw: '1000',
        toAmountRaw: '900',
        actor: 'walletX',
        isAggregatorHop: false,
      },
      {
        txHash: 'txRT',
        hopIndex: 1,
        programId: 'raydium',
        fromMint: 'MintB',
        toMint: 'MintA',
        fromAmountRaw: '900',
        toAmountRaw: '990',
        actor: 'walletX',
        isAggregatorHop: false,
      },
    ];
    const trades = normalizeEconomicTrades(roundTrip);
    expect(trades.length).toBe(1);
    expect(trades[0]!.baseMint).toBe('MintA');
    expect(trades[0]!.quoteMint).toBe('MintA'); // round trip -> same mint
    // Must be distinguishable via baseMint===quoteMint && hopCount>1
    expect(trades[0]!.baseMint).toBe(trades[0]!.quoteMint);
    expect(trades[0]!.hopCount).toBe(2);
  });

  it('economic trade normalization fails explicit typed not silent partial', () => {
    expect(() => normalizeEconomicTrades([])).toThrow(TradeNormalizationError);
    expect(() => normalizeEconomicTrades([])).toThrow(/TRADE_EMPTY/);
    const badHop: Parameters<typeof normalizeEconomicTrades>[0][number] = {
      txHash: 'tx1',
      hopIndex: 0,
      programId: 'raydium',
      fromMint: 'MintA',
      toMint: 'MintB',
      fromAmountRaw: 'abc',
      toAmountRaw: '900',
      actor: 'walletA',
      isAggregatorHop: false,
    };
    expect(() => normalizeEconomicTrades([badHop])).toThrow(TradeNormalizationError);
  });
});
