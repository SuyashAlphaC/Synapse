/**
 * Aggressive Momentum Strategy
 *
 * Trend-following on the base asset's short-term price drift, with a Pyth
 * confidence-interval gate. The signal:
 *
 *   momentum = (priceNow - priceLookback) / priceLookback
 *
 * computed from `StrategyMemory.counters['priceHistory']` (a rolling buffer
 * the runtime maintains across ticks). When momentum exceeds the entry
 * threshold and Pyth's confidence interval is *tight* (i.e., the oracle
 * agrees on price), the strategy buys the base. When momentum reverses or
 * the confidence interval widens beyond `maxConfBps`, it exits to quote.
 *
 * Aggressive vs Balanced:
 *   - Target weight swings between 100% base (full momentum) and 0% base
 *     (full exit), instead of micro-adjusting around a fixed ratio.
 *   - Acts on every tick (vs only on drift). Drawdown tolerance higher.
 *   - Position sizing scales with momentum strength, not just drift.
 *
 * All execution flows through `wallet::spend` + `deepbook_adapter::swap`
 * just like the other strategies — Move VM gates remain authoritative.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  RebalancePlan,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const AGGRESSIVE_MOMENTUM_ID = 'aggressive-momentum' as const;
const STRATEGY_VERSION = '1.0.0';

export interface AggressiveMomentumConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Momentum entry threshold (decimal). e.g. 0.02 = enter on +2% drift. */
  entryThreshold: number;
  /** Momentum exit threshold (decimal). e.g. -0.01 = exit on -1% reversal. */
  exitThreshold: number;
  /**
   * Max acceptable Pyth confidence interval (basis points of price). If
   * `conf > maxConfBps`, the strategy refuses to act (treats the oracle as
   * untrusted).
   */
  maxConfBps: number;
  /** Base slippage tolerance for momentum entries (decimal). */
  slippageTolerance: number;
  /** Cap on what fraction of NAV the strategy will swap in one tick. */
  maxPositionFraction: number;
  poolId: string;
}

export function aggressiveMomentum(config: AggressiveMomentumConfig): Strategy {
  validate(config);
  return {
    id: AGGRESSIVE_MOMENTUM_ID,
    name: 'Aggressive Momentum',
    version: STRATEGY_VERSION,
    description:
      `Trend-following on ${config.baseSymbol} with Pyth confidence gate. ` +
      `Enter on ≥${(config.entryThreshold * 100).toFixed(1)}% momentum, ` +
      `exit on ≤${(config.exitThreshold * 100).toFixed(1)}%, ` +
      `refuses oracle conf > ${config.maxConfBps}bps.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
  };
}

function validate(c: AggressiveMomentumConfig): void {
  if (c.entryThreshold <= 0 || c.entryThreshold > 0.5) {
    throw new Error(`aggressiveMomentum: entryThreshold ∉ (0, 0.5]`);
  }
  if (c.exitThreshold >= 0 || c.exitThreshold < -0.5) {
    throw new Error(`aggressiveMomentum: exitThreshold ∉ [-0.5, 0)`);
  }
  if (c.maxConfBps <= 0 || c.maxConfBps > 5000) {
    throw new Error(`aggressiveMomentum: maxConfBps ∉ (0, 5000]`);
  }
  if (c.maxPositionFraction <= 0 || c.maxPositionFraction > 1) {
    throw new Error(`aggressiveMomentum: maxPositionFraction ∉ (0, 1]`);
  }
}

async function evaluate(
  config: AggressiveMomentumConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);

  if (!base || !quote) {
    return {
      kind: 'noop',
      rationale: `Required asset missing (base=${!!base}, quote=${!!quote}).`,
    };
  }
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }

  const totalUsd = base.valueUsd + quote.valueUsd;
  if (totalUsd <= 0) return { kind: 'noop', rationale: 'NAV is zero.' };

  // Pyth confidence gate. We expect the runtime to write the latest
  // confidence (in bps of the price) into `counters['pyth_conf_bps']`
  // alongside the price observations.
  const confBps = input.memory.counters['pyth_conf_bps'] ?? 0;
  if (confBps > config.maxConfBps) {
    return {
      kind: 'noop',
      rationale:
        `Pyth confidence ${confBps.toFixed(0)}bps exceeds ${config.maxConfBps}bps gate. ` +
        `Refusing to trade against an uncertain oracle.`,
      signals: {
        confBps,
        maxConfBps: config.maxConfBps,
        navUsd: totalUsd,
      },
    };
  }

  // Momentum signal — read price now vs lookback from counters.
  const priceNow = base.priceUsd;
  const priceLookback = input.memory.counters['price_lookback_usd'] ?? 0;
  if (priceLookback <= 0) {
    // First tick: warm the buffer, don't trade.
    return {
      kind: 'noop',
      rationale: 'Warming up price buffer — first tick under this strategy.',
      signals: { priceNow, priceLookback, navUsd: totalUsd },
    };
  }
  const momentum = (priceNow - priceLookback) / priceLookback;

  const baseWeight = base.valueUsd / totalUsd;
  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) {
    return { kind: 'noop', rationale: `Pool ${config.poolId} not available.` };
  }

  let trade: PlannedTrade | null = null;
  let action: 'enter' | 'exit' | 'hold' = 'hold';
  let sizingUsd = 0;

  if (momentum >= config.entryThreshold && baseWeight < 1) {
    // Buy base. Size proportional to (momentum / entryThreshold), capped.
    action = 'enter';
    const strength = Math.min(1, momentum / config.entryThreshold);
    const targetBaseUsd = totalUsd * Math.min(1, baseWeight + strength * config.maxPositionFraction);
    sizingUsd = Math.max(0, targetBaseUsd - base.valueUsd);
    if (sizingUsd === 0) {
      action = 'hold';
    } else {
      const amountInQuote = usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals);
      const expectedOutUsd = sizingUsd * (1 - config.slippageTolerance);
      const minOutBase = usdToAtomic(expectedOutUsd, base.priceUsd, base.decimals);
      trade = {
        poolId: config.poolId,
        fromTypeTag: config.quoteTypeTag,
        toTypeTag: config.baseTypeTag,
        amountIn: amountInQuote,
        minAmountOut: minOutBase,
        direction: 1,
      };
    }
  } else if (momentum <= config.exitThreshold && baseWeight > 0) {
    // Sell base. Exit a fraction proportional to |momentum / exitThreshold|.
    action = 'exit';
    const strength = Math.min(1, Math.abs(momentum / config.exitThreshold));
    const targetBaseUsd = totalUsd * Math.max(0, baseWeight - strength * config.maxPositionFraction);
    sizingUsd = Math.max(0, base.valueUsd - targetBaseUsd);
    if (sizingUsd === 0) {
      action = 'hold';
    } else {
      const amountInBase = usdToAtomic(sizingUsd, base.priceUsd, base.decimals);
      const expectedOutUsd = sizingUsd * (1 - config.slippageTolerance);
      const minOutQuote = usdToAtomic(expectedOutUsd, quote.priceUsd, quote.decimals);
      trade = {
        poolId: config.poolId,
        fromTypeTag: config.baseTypeTag,
        toTypeTag: config.quoteTypeTag,
        amountIn: amountInBase,
        minAmountOut: minOutQuote,
        direction: 0,
      };
    }
  }

  if (!trade) {
    return {
      kind: 'noop',
      rationale:
        `Momentum ${(momentum * 100).toFixed(2)}% inside [${(config.exitThreshold * 100).toFixed(2)}%, ` +
        `${(config.entryThreshold * 100).toFixed(2)}%]. Hold ${(baseWeight * 100).toFixed(2)}% base.`,
      signals: {
        momentum,
        confBps,
        priceNow,
        priceLookback,
        baseWeight,
        action,
        navUsd: totalUsd,
      },
    };
  }

  const trades = [trade];
  const planId = computePlanId(input.vaultId, input.currentEpoch, trades);

  const rationaleMarkdown = [
    `### Aggressive Momentum diagnosis`,
    ``,
    `- **NAV**: $${totalUsd.toFixed(2)}`,
    `- **Price now**: $${priceNow.toFixed(6)} (lookback $${priceLookback.toFixed(6)})`,
    `- **Momentum**: ${(momentum * 100).toFixed(2)}%`,
    `- **Pyth confidence**: ${confBps.toFixed(0)} bps (gate ${config.maxConfBps} bps)`,
    `- **Current ${config.baseSymbol} weight**: ${(baseWeight * 100).toFixed(2)}%`,
    `- **Action**: ${action.toUpperCase()} — sizing $${sizingUsd.toFixed(2)}`,
    ``,
    `### Reasoning`,
    ``,
    action === 'enter'
      ? `Momentum crossed +${(config.entryThreshold * 100).toFixed(2)}% entry threshold with tight oracle confidence; lean into the trend. Buy ${config.baseSymbol} with $${sizingUsd.toFixed(2)} of ${config.quoteSymbol}.`
      : `Momentum crossed ${(config.exitThreshold * 100).toFixed(2)}% exit threshold; cut exposure. Sell $${sizingUsd.toFixed(2)} of ${config.baseSymbol} into ${config.quoteSymbol}.`,
    ``,
    `### Market context`,
    ``,
    `- Pool bid: ${pool.bestBid.toFixed(6)}`,
    `- Pool ask: ${pool.bestAsk.toFixed(6)}`,
    `- Slippage tolerance: ${(config.slippageTolerance * 100).toFixed(2)}%`,
    `- Max position fraction (this tick): ${(config.maxPositionFraction * 100).toFixed(2)}%`,
  ].join('\n');

  const plan: RebalancePlan = {
    kind: 'rebalance',
    planId,
    summary:
      `Momentum ${(momentum * 100).toFixed(2)}%, conf ${confBps.toFixed(0)}bps → ${action.toUpperCase()} ` +
      `$${sizingUsd.toFixed(2)} on ${shortenPoolId(config.poolId)}.`,
    trades,
    rationaleMarkdown,
    signals: {
      momentum,
      confBps,
      priceNow,
      priceLookback,
      baseWeight,
      action,
      sizingUsd,
      navUsd: totalUsd,
      poolBid: pool.bestBid,
      poolAsk: pool.bestAsk,
    },
  };
  return plan;
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) return 0n;
  const units = usd / priceUsd;
  return BigInt(Math.max(0, Math.floor(units * Math.pow(10, decimals))));
}

function shortenPoolId(poolId: string): string {
  return `${poolId.slice(0, 10)}…`;
}
