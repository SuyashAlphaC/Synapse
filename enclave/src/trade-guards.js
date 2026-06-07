/**
 * Mirror of sdk/packages/vault/src/runtime/trade-guards.ts for the decision
 * enclave. Attested vaults sign the post-guard decision — without this,
 * oracle-based minAmountOut on small DeepBook legs aborts with code 12.
 */

/** USD notional of the input leg from holdings spot prices. */
export function tradeNotionalUsd(trade, holdings) {
  const holding = holdings.find((h) => h.coinTypeTag === trade.fromTypeTag);
  if (!holding || !Number.isFinite(holding.priceUsd) || holding.priceUsd <= 0) return null;
  const units = Number(trade.amountIn) / 10 ** holding.decimals;
  if (!Number.isFinite(units) || units <= 0) return 0;
  return units * holding.priceUsd;
}

/**
 * @param {object} decision
 * @param {readonly object[]} holdings
 * @param {{ minTradeUsd?: number, relaxMinOutBelowUsd?: number }} opts
 */
export function applyRebalanceTradeGuards(decision, holdings, opts) {
  if (decision.kind !== 'rebalance') return decision;

  const minTradeUsd = opts.minTradeUsd ?? 1;
  const relaxBelow = opts.relaxMinOutBelowUsd ?? 15;

  const trades = decision.trades.map((trade) => {
    const usd = tradeNotionalUsd(trade, holdings);
    if (usd !== null && usd < relaxBelow && trade.minAmountOut > 1n) {
      return { ...trade, minAmountOut: 1n };
    }
    return trade;
  });

  const allTooSmall = trades.every((trade) => {
    const usd = tradeNotionalUsd(trade, holdings);
    return usd !== null && usd < minTradeUsd;
  });

  if (allTooSmall) {
    return {
      kind: 'noop',
      rationale:
        `Rebalance skipped: planned leg(s) below $${minTradeUsd.toFixed(2)} min notional ` +
        `(DeepBook lot size / min_out would abort).`,
      ...(decision.signals !== undefined ? { signals: decision.signals } : {}),
    };
  }

  return { ...decision, trades };
}
