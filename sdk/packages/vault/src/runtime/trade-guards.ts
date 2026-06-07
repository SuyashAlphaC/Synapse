import type { HoldingSnapshot, PlannedTrade, StrategyDecision } from '../types.js';

export interface TradeGuardOptions {
  /** Skip rebalance when every leg is below this USD notional. Default 1. */
  minTradeUsd: number;
  /**
   * For legs below this USD notional, clamp `minAmountOut` to 1 atom so
   * DeepBook's `EMinimumQuantityOutNotMet` (abort 12) doesn't fire on dust
   * fills where oracle-based slippage floors overshoot the book.
   */
  relaxMinOutBelowUsd?: number;
}

/** USD notional of the input leg, using holdings spot prices from this tick. */
export function tradeNotionalUsd(
  trade: PlannedTrade,
  holdings: readonly HoldingSnapshot[],
): number | null {
  const holding = holdings.find((h) => h.coinTypeTag === trade.fromTypeTag);
  if (!holding || !Number.isFinite(holding.priceUsd) || holding.priceUsd <= 0) {
    return null;
  }
  const units = Number(trade.amountIn) / 10 ** holding.decimals;
  if (!Number.isFinite(units) || units <= 0) return 0;
  return units * holding.priceUsd;
}

/**
 * Prevent dust rebalances from aborting DeepBook swaps. Applies only on
 * unattested ticks — attested decisions must match the enclave signature.
 */
export function applyRebalanceTradeGuards(
  decision: StrategyDecision,
  holdings: readonly HoldingSnapshot[],
  opts: TradeGuardOptions,
): StrategyDecision {
  if (decision.kind !== 'rebalance') return decision;

  const relaxBelow = opts.relaxMinOutBelowUsd ?? 5;
  const trades = decision.trades.map((trade) => {
    const usd = tradeNotionalUsd(trade, holdings);
    if (usd !== null && usd < relaxBelow && trade.minAmountOut > 1n) {
      return { ...trade, minAmountOut: 1n };
    }
    return trade;
  });

  const allTooSmall = trades.every((trade) => {
    const usd = tradeNotionalUsd(trade, holdings);
    return usd !== null && usd < opts.minTradeUsd;
  });

  if (allTooSmall) {
    return {
      kind: 'noop',
      rationale:
        `Rebalance skipped: planned leg(s) below $${opts.minTradeUsd.toFixed(2)} min notional ` +
        `(DeepBook lot size / min_out would abort).`,
      ...(decision.signals !== undefined ? { signals: decision.signals } : {}),
    };
  }

  return { ...decision, trades };
}
