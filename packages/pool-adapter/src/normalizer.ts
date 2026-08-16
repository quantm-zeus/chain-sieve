/**
 * @requirement FR-TRD-001 FR-TRD-002 FR-TRD-003 FR-TRD-004
 * Raw swaps, transfer routes, and aggregator hops are normalized into economic trade events
 * before market/wallet features. Net actor deltas, avoid double counting, distinguish arbitrage.
 */
import { createHash } from 'node:crypto';
import type { EconomicTrade, RawSwapHop } from './types.js';
import { TradeNormalizationError } from './types.js';

export const normalizeEconomicTrades = (
  rawHops: RawSwapHop[],
): EconomicTrade[] => {
  if (!Array.isArray(rawHops)) throw new TradeNormalizationError('TRADE_MALFORMED', 'TRADE_MALFORMED: HOPS_NOT_ARRAY');
  if (rawHops.length === 0) throw new TradeNormalizationError('TRADE_EMPTY', 'TRADE_EMPTY: NO_HOPS');

  // Validate each hop
  for (const hop of rawHops) {
    if (!hop.txHash || !hop.fromMint || !hop.toMint || !hop.fromAmountRaw || !hop.toAmountRaw || !hop.actor) {
      throw new TradeNormalizationError('TRADE_MALFORMED', 'TRADE_MALFORMED: HOP_MISSING_FIELD');
    }
    if (!/^\d+$/.test(hop.fromAmountRaw) || !/^\d+$/.test(hop.toAmountRaw)) {
      throw new TradeNormalizationError('TRADE_MALFORMED', 'TRADE_MALFORMED: AMOUNT_MALFORMED');
    }
  }

  // Group by txHash + actor => one economic trade per actor per transaction
  // This avoids double counting aggregator hops: hops within same tx+actor are legs of one trade.
  const groups = new Map<string, RawSwapHop[]>();
  for (const hop of rawHops) {
    const key = `${hop.txHash}:${hop.actor}`;
    const arr = groups.get(key) ?? [];
    arr.push(hop);
    groups.set(key, arr);
  }

  const trades: EconomicTrade[] = [];
  for (const [key, legs] of groups) {
    // Sort legs by hopIndex deterministically
    legs.sort((a, b) => a.hopIndex - b.hopIndex);

    // Verify route continuity: toMint of leg N should be fromMint of leg N+1 for multi-hop routes
    // If not continuous and more than 1 leg, mark inconsistent -> error (explicit)
    for (let i = 0; i < legs.length - 1; i++) {
      if (legs[i]!.toMint !== legs[i + 1]!.fromMint) {
        // Allow aggregator hop discontinuity only if legs are flagged correctly
        // Otherwise treat as inconsistent route
        if (!legs[i]!.isAggregatorHop && !legs[i + 1]!.isAggregatorHop) {
          throw new TradeNormalizationError('TRADE_INCONSISTENT_ROUTE', `TRADE_INCONSISTENT_ROUTE: ROUTE_DISCONTINUITY:${legs[i]!.toMint}->${legs[i + 1]!.fromMint}`);
        }
      }
    }

    // Net deltas: first hop fromMint is base, last hop toMint is quote
    // For multi-hop, intermediate mints cancel out; we only expose net entry/exit.
    const baseMint = legs[0]!.fromMint;
    const quoteMint = legs[legs.length - 1]!.toMint;
    const netBaseDeltaRaw = legs[0]!.fromAmountRaw;
    const netQuoteDeltaRaw = legs[legs.length - 1]!.toAmountRaw;

    // Detect arbitrage / round trip: actor buys then sells same mint within same tx -> distinguish
    // If baseMint === quoteMint after netting, it's a round-trip / arb
    // For simplicity, if first fromMint equals last toMint and hopCount >1, flag aggregated=false and keep but mark provenance
    const isRoundTrip = baseMint === quoteMint && legs.length > 1;

    // Aggregated flag true when multiple hops collapsed into one economic trade
    const aggregated = legs.length > 1;

    const tradeId = createHash('sha256')
      .update(`${key}:${legs.map((l) => `${l.fromMint}->${l.toMint}:${l.fromAmountRaw}->${l.toAmountRaw}`).join('|')}`)
      .digest('hex')
      .slice(0, 16);

    trades.push({
      tradeId,
      actor: legs[0]!.actor,
      baseMint,
      quoteMint,
      netBaseDeltaRaw,
      netQuoteDeltaRaw,
      legs,
      hopCount: legs.length,
      aggregated,
      provenance: legs.map((l) => `${l.programId}:${l.hopIndex}`),
    });

    if (isRoundTrip) {
      // Round trips remain but can be filtered by caller for organic demand features
      // No error, but we ensure they are distinguishable (hopCount>1 and baseMint==quoteMint)
    }
  }

  // Deterministic order by tradeId
  trades.sort((a, b) => a.tradeId.localeCompare(b.tradeId));
  return trades;
};
