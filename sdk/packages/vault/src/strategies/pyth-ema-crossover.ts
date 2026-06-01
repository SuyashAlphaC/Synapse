/**
 * Pyth-driven EMA Crossover Strategy
 *
 * Maintains a fast and slow exponential moving average of the base asset's
 * Pyth price (persisted in MemWal counters across ticks). When the fast
 * EMA crosses above the slow EMA → bullish, buy base. When it crosses
 * below → bearish, sell base.
 *
 * Includes the same Pyth-confidence gate as Aggressive Momentum: if the
 * confidence interval is wider than `maxConfBps`, the strategy refuses
 * to trade regardless of signal.
 *
 * Stateful across ticks but the state lives in `memory.counters` so the
 * runtime can persist it via MemWal and the strategy stays a pure
 * function of `StrategyInput`.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const PYTH_EMA_CROSSOVER_ID = 'pyth-ema-crossover' as const;
const STRATEGY_VERSION = '1.0.0';

export interface PythEmaCrossoverConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Smoothing factor for fast EMA (typical 0.3–0.5). */
  fastAlpha: number;
  /** Smoothing factor for slow EMA (typical 0.05–0.15). */
  slowAlpha: number;
  /** Max acceptable Pyth confidence interval (bps of price). */
  maxConfBps: number;
  /** Fraction of NAV to move per crossover. */
  positionFraction: number;
  slippageTolerance: number;
  poolId: string;
}

export function pythEmaCrossover(config: PythEmaCrossoverConfig): Strategy {
  validate(config);
  return {
    id: PYTH_EMA_CROSSOVER_ID,
    name: 'Pyth EMA Crossover',
    version: STRATEGY_VERSION,
    description:
      `Maintains fast (α=${config.fastAlpha}) + slow (α=${config.slowAlpha}) EMAs of ` +
      `${config.baseSymbol}'s Pyth price. Buys on fast↑slow cross, sells on fast↓slow. ` +
      `Refuses to trade when Pyth confidence > ${config.maxConfBps}bps.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
    prepareMemoryWrite: async ({ input }) => {
      const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
      if (!base) return null;
      const price = base.priceUsd;
      const prevFast = input.memory.counters['ema_fast'] ?? price;
      const prevSlow = input.memory.counters['ema_slow'] ?? price;
      const fast = config.fastAlpha * price + (1 - config.fastAlpha) * prevFast;
      const slow = config.slowAlpha * price + (1 - config.slowAlpha) * prevSlow;
      const carriedConf = input.memory.counters['pyth_conf_bps'] ?? 0;
      return {
        counters: {
          ema_fast: fast,
          ema_slow: slow,
          pyth_conf_bps: carriedConf,
          last_price_usd: price,
        },
      };
    },
  };
}

function validate(c: PythEmaCrossoverConfig): void {
  if (c.fastAlpha <= c.slowAlpha) {
    throw new Error('pythEmaCrossover: fastAlpha must be > slowAlpha');
  }
  if (c.fastAlpha <= 0 || c.fastAlpha > 1 || c.slowAlpha <= 0 || c.slowAlpha > 1) {
    throw new Error('pythEmaCrossover: alphas must be in (0, 1]');
  }
  if (c.maxConfBps <= 0 || c.maxConfBps > 5000) {
    throw new Error('pythEmaCrossover: maxConfBps ∉ (0, 5000]');
  }
  if (c.positionFraction <= 0 || c.positionFraction > 1) {
    throw new Error('pythEmaCrossover: positionFraction ∉ (0, 1]');
  }
}

async function evaluate(
  config: PythEmaCrossoverConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }
  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);
  if (!base || !quote) {
    return { kind: 'noop', rationale: `Asset missing (base=${!!base}, quote=${!!quote}).` };
  }
  const navUsd = base.valueUsd + quote.valueUsd;
  if (navUsd <= 0) return { kind: 'noop', rationale: 'NAV is zero.' };

  const confBps = input.memory.counters['pyth_conf_bps'] ?? 0;
  if (confBps > config.maxConfBps) {
    return {
      kind: 'noop',
      rationale: `Pyth confidence ${confBps.toFixed(0)}bps > ${config.maxConfBps}bps gate.`,
      signals: { confBps, maxConfBps: config.maxConfBps },
    };
  }

  const price = base.priceUsd;
  const prevFast = input.memory.counters['ema_fast'] ?? price;
  const prevSlow = input.memory.counters['ema_slow'] ?? price;
  const fast = config.fastAlpha * price + (1 - config.fastAlpha) * prevFast;
  const slow = config.slowAlpha * price + (1 - config.slowAlpha) * prevSlow;
  const prevDiff = prevFast - prevSlow;
  const currDiff = fast - slow;
  const crossedUp = prevDiff <= 0 && currDiff > 0;
  const crossedDown = prevDiff >= 0 && currDiff < 0;

  if (!crossedUp && !crossedDown) {
    return {
      kind: 'noop',
      rationale: `No crossover this tick. fast=${fast.toFixed(6)}, slow=${slow.toFixed(6)}.`,
      signals: { price, fast, slow, diff: currDiff, crossedUp, crossedDown },
    };
  }

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) return { kind: 'noop', rationale: `Pool ${config.poolId} not available.` };

  const sizingUsd = navUsd * config.positionFraction;
  let trade: PlannedTrade;
  let action: 'buy' | 'sell';
  if (crossedUp) {
    action = 'buy';
    const useUsd = Math.min(sizingUsd, quote.valueUsd);
    const amountIn = usdToAtomic(useUsd, quote.priceUsd, quote.decimals);
    const minOut = usdToAtomic(useUsd * (1 - config.slippageTolerance), base.priceUsd, base.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.quoteTypeTag,
      toTypeTag: config.baseTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 1,
    };
  } else {
    action = 'sell';
    const useUsd = Math.min(sizingUsd, base.valueUsd);
    const amountIn = usdToAtomic(useUsd, base.priceUsd, base.decimals);
    const minOut = usdToAtomic(useUsd * (1 - config.slippageTolerance), quote.priceUsd, quote.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.baseTypeTag,
      toTypeTag: config.quoteTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 0,
    };
  }

  const trades = [trade];
  return {
    kind: 'rebalance',
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary: `${action.toUpperCase()} signal: fast EMA ${crossedUp ? 'crossed above' : 'crossed below'} slow.`,
    trades,
    rationaleMarkdown: [
      `### Pyth EMA Crossover diagnosis`,
      ``,
      `- **Price**: $${price.toFixed(6)} (Pyth conf ${confBps.toFixed(0)}bps)`,
      `- **Fast EMA** (α=${config.fastAlpha}): ${fast.toFixed(6)} (was ${prevFast.toFixed(6)})`,
      `- **Slow EMA** (α=${config.slowAlpha}): ${slow.toFixed(6)} (was ${prevSlow.toFixed(6)})`,
      `- **Crossover**: ${crossedUp ? 'fast crossed ABOVE slow → bullish' : 'fast crossed BELOW slow → bearish'}`,
      `- **Action**: ${action.toUpperCase()} sizing $${(navUsd * config.positionFraction).toFixed(2)}`,
    ].join('\n'),
    signals: { price, fast, slow, prevFast, prevSlow, confBps, action, navUsd },
  };
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}
