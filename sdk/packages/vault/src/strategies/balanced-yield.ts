/**
 * Balanced Yield Strategy
 *
 * Volatility-gated rebalancer. Same SUI/USDC two-asset target structure as
 * the Conservative Rebalancer, but rebalances more aggressively (lower drift
 * threshold) when realized volatility from MemWal memory is *low*, and less
 * aggressively when volatility is *high*. The signal aim: capture mean
 * reversion in calm tape, sit on hands during dislocations.
 *
 * Volatility input: the strategy reads its own recent decisions from
 * `StrategyMemory.recentDecisions` and computes the standard deviation of
 * realized PnL across the window. No external feeds required — the math
 * any auditor can verify by hand from the audit log.
 *
 * Differences from Conservative:
 *   - Target weight defaults 60% base / 40% quote (slight base tilt, leaning
 *     into SUI's positive drift).
 *   - Drift threshold dynamically scales between [thresholdLow, thresholdHigh]
 *     based on a rolling volatility band.
 *   - Slippage tolerance widens when volatility is high (so the trade still
 *     fills) and tightens when calm.
 *
 * All decisions remain bounded by the on-chain spend cap and contract
 * allowlist — Move VM enforcement is the moat, not the strategy code.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  RebalancePlan,
  PlannedTrade,
  PastDecision,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const BALANCED_YIELD_ID = 'balanced-yield' as const;
const STRATEGY_VERSION = '1.0.0';

export interface BalancedYieldConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Target base weight when volatility is mid-band. e.g. 0.6 = 60/40 base/quote. */
  targetBaseWeight: number;
  /** Drift threshold floor — used in calm regimes (lower → trades more). */
  thresholdLow: number;
  /** Drift threshold ceiling — used in volatile regimes (higher → trades less). */
  thresholdHigh: number;
  /** Slippage tolerance floor (calm regime). */
  slippageLow: number;
  /** Slippage tolerance ceiling (volatile regime). */
  slippageHigh: number;
  /** Lookback window for volatility (number of past decisions). */
  volWindow: number;
  poolId: string;
}

export function balancedYield(config: BalancedYieldConfig): Strategy {
  validate(config);
  return {
    id: BALANCED_YIELD_ID,
    name: 'Balanced Yield',
    version: STRATEGY_VERSION,
    description:
      `Volatility-gated two-asset rebalancer (${(config.targetBaseWeight * 100).toFixed(0)}/` +
      `${((1 - config.targetBaseWeight) * 100).toFixed(0)} ${config.baseSymbol}/${config.quoteSymbol}). ` +
      `Drift threshold adapts between ${(config.thresholdLow * 100).toFixed(2)}% (calm) and ` +
      `${(config.thresholdHigh * 100).toFixed(2)}% (volatile).`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
  };
}

function validate(c: BalancedYieldConfig): void {
  if (c.targetBaseWeight < 0 || c.targetBaseWeight > 1) {
    throw new Error(`balancedYield: targetBaseWeight ∉ [0,1]`);
  }
  if (c.thresholdLow <= 0 || c.thresholdHigh <= c.thresholdLow) {
    throw new Error(`balancedYield: require 0 < thresholdLow < thresholdHigh`);
  }
  if (c.slippageLow < 0 || c.slippageHigh < c.slippageLow || c.slippageHigh > 0.1) {
    throw new Error(`balancedYield: require 0 ≤ slippageLow ≤ slippageHigh ≤ 0.1`);
  }
  if (c.volWindow < 2 || c.volWindow > 200) {
    throw new Error(`balancedYield: volWindow must be in [2, 200]`);
  }
}

async function evaluate(
  config: BalancedYieldConfig,
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
  if (input.policy.revoked) {
    return { kind: 'noop', rationale: 'Vault is revoked.' };
  }
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return {
      kind: 'noop',
      rationale: `Vault expired (epoch ${input.policy.expiryEpoch}).`,
    };
  }

  const totalUsd = base.valueUsd + quote.valueUsd;
  if (totalUsd <= 0) {
    return { kind: 'noop', rationale: 'NAV is zero.' };
  }

  const { volatility, sampleSize } = computeRealizedVolatility(
    input.memory.recentDecisions,
    config.volWindow,
  );
  const regime = classifyRegime(volatility);
  const dynamicThreshold = interpolate(regime, config.thresholdLow, config.thresholdHigh);
  const dynamicSlippage = interpolate(regime, config.slippageLow, config.slippageHigh);

  const actualBaseWeight = base.valueUsd / totalUsd;
  const drift = actualBaseWeight - config.targetBaseWeight;
  const absDrift = Math.abs(drift);

  if (absDrift < dynamicThreshold) {
    return {
      kind: 'noop',
      rationale:
        `${(absDrift * 100).toFixed(2)}% drift below regime-${regime.toFixed(2)} threshold ` +
        `${(dynamicThreshold * 100).toFixed(2)}%. Hold.`,
      signals: {
        actualBaseWeight,
        targetBaseWeight: config.targetBaseWeight,
        drift,
        absDrift,
        threshold: dynamicThreshold,
        volatility,
        volSampleSize: sampleSize,
        regime,
        navUsd: input.navUsd,
      },
    };
  }

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) {
    return {
      kind: 'noop',
      rationale: `Pool ${config.poolId} not in market snapshot.`,
    };
  }

  const targetBaseUsd = totalUsd * config.targetBaseWeight;
  const baseExcessUsd = base.valueUsd - targetBaseUsd;

  let trade: PlannedTrade;
  let direction: 'base->quote' | 'quote->base';
  let sellUsd: number;

  if (baseExcessUsd > 0) {
    direction = 'base->quote';
    sellUsd = baseExcessUsd;
    const amountInBase = usdToAtomic(sellUsd, base.priceUsd, base.decimals);
    const expectedOutUsd = sellUsd * (1 - dynamicSlippage);
    const minOutQuote = usdToAtomic(expectedOutUsd, quote.priceUsd, quote.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.baseTypeTag,
      toTypeTag: config.quoteTypeTag,
      amountIn: amountInBase,
      minAmountOut: minOutQuote,
      direction: 0,
    };
  } else {
    direction = 'quote->base';
    sellUsd = -baseExcessUsd;
    const amountInQuote = usdToAtomic(sellUsd, quote.priceUsd, quote.decimals);
    const expectedOutUsd = sellUsd * (1 - dynamicSlippage);
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

  const trades = [trade];
  const planId = computePlanId(input.vaultId, input.currentEpoch, trades);

  const rationaleMarkdown = [
    `### Balanced Yield diagnosis`,
    ``,
    `- **NAV**: $${totalUsd.toFixed(2)}`,
    `- **Realized vol** (n=${sampleSize}): ${(volatility * 100).toFixed(2)}%`,
    `- **Regime**: ${regime.toFixed(2)} (0 = calm, 1 = volatile)`,
    `- **Drift threshold** (this tick): ${(dynamicThreshold * 100).toFixed(2)}%`,
    `- **Slippage tolerance** (this tick): ${(dynamicSlippage * 100).toFixed(2)}%`,
    `- **Actual ${config.baseSymbol} weight**: ${(actualBaseWeight * 100).toFixed(2)}% (target ${(config.targetBaseWeight * 100).toFixed(0)}%)`,
    `- **Drift**: ${(drift * 100).toFixed(2)}% (absolute ${(absDrift * 100).toFixed(2)}%)`,
    ``,
    `### Action`,
    ``,
    direction === 'base->quote'
      ? `${config.baseSymbol} over-weight; sell **$${sellUsd.toFixed(2)}** of ${config.baseSymbol} into ${config.quoteSymbol}.`
      : `${config.quoteSymbol} over-weight; buy **$${sellUsd.toFixed(2)}** of ${config.baseSymbol} with ${config.quoteSymbol}.`,
    ``,
    `### Market context`,
    ``,
    `- Pool bid/ask/mid: ${pool.bestBid.toFixed(6)} / ${pool.bestAsk.toFixed(6)} / ${pool.mid.toFixed(6)}`,
  ].join('\n');

  const plan: RebalancePlan = {
    kind: 'rebalance',
    planId,
    summary:
      `Vol ${(volatility * 100).toFixed(2)}% → regime ${regime.toFixed(2)}. ` +
      `Drift ${(absDrift * 100).toFixed(2)}% exceeds ${(dynamicThreshold * 100).toFixed(2)}%; ` +
      `${direction} on ${shortenPoolId(config.poolId)}.`,
    trades,
    rationaleMarkdown,
    signals: {
      volatility,
      volSampleSize: sampleSize,
      regime,
      actualBaseWeight,
      targetBaseWeight: config.targetBaseWeight,
      drift,
      absDrift,
      threshold: dynamicThreshold,
      slippage: dynamicSlippage,
      navUsd: totalUsd,
      direction,
      poolBid: pool.bestBid,
      poolAsk: pool.bestAsk,
      poolMid: pool.mid,
    },
  };
  return plan;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Std deviation of realized PnL across the last N decisions. If too few
 * samples exist, we report 0 and let the regime fall to "calm" (lower
 * threshold) so the strategy still acts.
 */
function computeRealizedVolatility(
  decisions: PastDecision[],
  window: number,
): { volatility: number; sampleSize: number } {
  const pnls = decisions
    .slice(-window)
    .map((d) => d.realizedPnlUsd ?? 0)
    .filter((n) => Number.isFinite(n));
  if (pnls.length < 2) return { volatility: 0, sampleSize: pnls.length };

  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance =
    pnls.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (pnls.length - 1);
  const stddev = Math.sqrt(variance);
  // Normalize by mean |PnL| so volatility is unit-free.
  const denom = Math.max(1, Math.abs(mean) || 1);
  return { volatility: stddev / denom, sampleSize: pnls.length };
}

/**
 * Map raw volatility to a [0, 1] regime score. 0 = calm, 1 = volatile.
 * Uses a soft logistic so small noise around 0 doesn't whip the threshold.
 */
function classifyRegime(volatility: number): number {
  const k = 6; // logistic steepness
  const x0 = 0.5; // midpoint
  return 1 / (1 + Math.exp(-k * (volatility - x0)));
}

function interpolate(t: number, lo: number, hi: number): number {
  return lo + (hi - lo) * t;
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) return 0n;
  const units = usd / priceUsd;
  return BigInt(Math.max(0, Math.floor(units * Math.pow(10, decimals))));
}

function shortenPoolId(poolId: string): string {
  return `${poolId.slice(0, 10)}…`;
}
