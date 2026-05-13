/**
 * Conservative Rebalancer Strategy
 *
 * A deterministic two-asset rebalancer that targets a fixed USD-value ratio
 * between a base and a quote asset (default: 50/50 SUI/USDC). Triggers a
 * rebalance when actual allocation drifts more than `driftThreshold` from
 * target. Trades exactly enough to return to target — no leverage, no
 * directional bets, no oracle dependencies beyond spot prices.
 *
 * This is the v1 reference strategy that ships with Synapse Vault. It's
 * deliberately simple — the goal is to demonstrate the full Vault loop
 * (recall → reason → plan → execute → report → remember) end-to-end with
 * mathematics any auditor can verify by hand.
 *
 * Strategy parameters live in the Vault config (not on-chain); changing them
 * requires the owner to deploy a new strategy version.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  RebalancePlan,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const CONSERVATIVE_REBALANCER_ID = 'conservative-rebalancer' as const;
const STRATEGY_VERSION = '1.0.0';

export interface ConservativeRebalancerConfig {
  /** Base asset Coin type tag, e.g. '0x2::sui::SUI'. */
  baseTypeTag: string;
  /** Base asset symbol for display (must match holdings/market). */
  baseSymbol: string;
  /** Quote asset Coin type tag, e.g. an USDC coin type. */
  quoteTypeTag: string;
  /** Quote asset symbol. */
  quoteSymbol: string;
  /** Target weight of base asset in [0, 1]. e.g. 0.5 = 50/50. */
  targetBaseWeight: number;
  /** Drift threshold above which a rebalance triggers, in [0, 1]. */
  driftThreshold: number;
  /** DeepBookV3 pool ID to trade through. */
  poolId: string;
  /** Min slippage tolerance (e.g., 0.005 = 0.5% allowed slippage). */
  slippageTolerance: number;
}

/**
 * Build a configured Conservative Rebalancer strategy instance.
 */
export function conservativeRebalancer(config: ConservativeRebalancerConfig): Strategy {
  if (config.targetBaseWeight < 0 || config.targetBaseWeight > 1) {
    throw new Error(
      `conservativeRebalancer: targetBaseWeight must be in [0,1], got ${config.targetBaseWeight}`,
    );
  }
  if (config.driftThreshold <= 0 || config.driftThreshold > 1) {
    throw new Error(
      `conservativeRebalancer: driftThreshold must be in (0,1], got ${config.driftThreshold}`,
    );
  }
  if (config.slippageTolerance < 0 || config.slippageTolerance > 0.1) {
    throw new Error(
      `conservativeRebalancer: slippageTolerance must be in [0,0.1], got ${config.slippageTolerance}`,
    );
  }

  return {
    id: CONSERVATIVE_REBALANCER_ID,
    name: 'Conservative Rebalancer',
    version: STRATEGY_VERSION,
    description:
      `Two-asset deterministic rebalancer targeting ${(config.targetBaseWeight * 100).toFixed(0)}/${((1 - config.targetBaseWeight) * 100).toFixed(0)} ` +
      `${config.baseSymbol}/${config.quoteSymbol} with ${(config.driftThreshold * 100).toFixed(1)}% drift threshold.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> => evaluate(config, input),
  };
}

async function evaluate(
  config: ConservativeRebalancerConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);

  if (!base || !quote) {
    return {
      kind: 'noop',
      rationale: `Required asset missing from portfolio (base=${!!base}, quote=${!!quote}).`,
      signals: {
        hasBase: !!base,
        hasQuote: !!quote,
      },
    };
  }

  if (input.policy.revoked) {
    return {
      kind: 'noop',
      rationale: 'Vault is revoked; no further actions permitted.',
    };
  }

  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return {
      kind: 'noop',
      rationale: `Vault expired at epoch ${input.policy.expiryEpoch}; current is ${input.currentEpoch}.`,
    };
  }

  const totalUsd = base.valueUsd + quote.valueUsd;
  if (totalUsd <= 0) {
    return {
      kind: 'noop',
      rationale: 'Total portfolio value is zero — nothing to rebalance.',
    };
  }

  const actualBaseWeight = base.valueUsd / totalUsd;
  const drift = actualBaseWeight - config.targetBaseWeight;
  const absDrift = Math.abs(drift);

  if (absDrift < config.driftThreshold) {
    return {
      kind: 'noop',
      rationale: `Drift ${(absDrift * 100).toFixed(2)}% is below threshold ${(config.driftThreshold * 100).toFixed(2)}%. No rebalance needed.`,
      signals: {
        actualBaseWeight,
        targetBaseWeight: config.targetBaseWeight,
        drift,
        absDrift,
        threshold: config.driftThreshold,
        navUsd: input.navUsd,
      },
    };
  }

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) {
    return {
      kind: 'noop',
      rationale: `Configured pool ${config.poolId} not available in market snapshot.`,
      signals: { absDrift, poolId: config.poolId },
    };
  }

  // Trade size: bring the over-weight side back to target.
  // If base is over-weight (drift > 0), sell base → buy quote.
  // If quote is over-weight (drift < 0), sell quote → buy base.
  const targetBaseUsd = totalUsd * config.targetBaseWeight;
  const baseExcessUsd = base.valueUsd - targetBaseUsd;

  let trade: PlannedTrade;
  let direction: 'base->quote' | 'quote->base';
  let rationaleMarkdown: string;

  if (baseExcessUsd > 0) {
    direction = 'base->quote';
    const sellUsd = baseExcessUsd;
    const amountInBase = usdToAtomic(sellUsd, base.priceUsd, base.decimals);
    // Note: per-epoch spend cap is enforced by `wallet::spend` in the Move VM.
    // The strategy does not pre-check it; if exceeded, the PTB aborts cleanly.
    const expectedOutUsd = sellUsd * (1 - config.slippageTolerance);
    const minOutQuote = usdToAtomic(expectedOutUsd, quote.priceUsd, quote.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.baseTypeTag,
      toTypeTag: config.quoteTypeTag,
      amountIn: amountInBase,
      minAmountOut: minOutQuote,
      direction: 0, // DIR_BASE_TO_QUOTE
    };
    rationaleMarkdown = buildRationale({
      direction,
      actualBaseWeight,
      targetBaseWeight: config.targetBaseWeight,
      drift,
      absDrift,
      sellUsd,
      navUsd: totalUsd,
      pool,
      baseSymbol: config.baseSymbol,
      quoteSymbol: config.quoteSymbol,
      slippageTolerance: config.slippageTolerance,
    });
  } else {
    direction = 'quote->base';
    const buyBaseUsd = -baseExcessUsd;
    const amountInQuote = usdToAtomic(buyBaseUsd, quote.priceUsd, quote.decimals);
    const expectedOutUsd = buyBaseUsd * (1 - config.slippageTolerance);
    const minOutBase = usdToAtomic(expectedOutUsd, base.priceUsd, base.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.quoteTypeTag,
      toTypeTag: config.baseTypeTag,
      amountIn: amountInQuote,
      minAmountOut: minOutBase,
      direction: 1, // DIR_QUOTE_TO_BASE
    };
    rationaleMarkdown = buildRationale({
      direction,
      actualBaseWeight,
      targetBaseWeight: config.targetBaseWeight,
      drift,
      absDrift,
      sellUsd: buyBaseUsd,
      navUsd: totalUsd,
      pool,
      baseSymbol: config.baseSymbol,
      quoteSymbol: config.quoteSymbol,
      slippageTolerance: config.slippageTolerance,
    });
  }

  const trades = [trade];
  const planId = computePlanId(input.vaultId, input.currentEpoch, trades);

  const plan: RebalancePlan = {
    kind: 'rebalance',
    planId,
    summary: `Drift ${(absDrift * 100).toFixed(2)}%; rebalance ${direction} on \`${shortenPoolId(config.poolId)}\` to restore ${(config.targetBaseWeight * 100).toFixed(0)}/${((1 - config.targetBaseWeight) * 100).toFixed(0)} target.`,
    trades,
    rationaleMarkdown,
    signals: {
      actualBaseWeight,
      targetBaseWeight: config.targetBaseWeight,
      drift,
      absDrift,
      threshold: config.driftThreshold,
      navUsd: totalUsd,
      direction,
      poolMid: pool.mid,
      poolBid: pool.bestBid,
      poolAsk: pool.bestAsk,
      slippageTolerance: config.slippageTolerance,
    },
  };

  return plan;
}

interface RationaleArgs {
  direction: 'base->quote' | 'quote->base';
  actualBaseWeight: number;
  targetBaseWeight: number;
  drift: number;
  absDrift: number;
  sellUsd: number;
  navUsd: number;
  pool: { bestBid: number; bestAsk: number; mid: number };
  baseSymbol: string;
  quoteSymbol: string;
  slippageTolerance: number;
}

function buildRationale(a: RationaleArgs): string {
  return [
    `### Strategy diagnosis`,
    ``,
    `- **NAV**: $${a.navUsd.toFixed(2)}`,
    `- **Actual ${a.baseSymbol} weight**: ${(a.actualBaseWeight * 100).toFixed(2)}%`,
    `- **Target ${a.baseSymbol} weight**: ${(a.targetBaseWeight * 100).toFixed(2)}%`,
    `- **Drift**: ${(a.drift * 100).toFixed(2)}% (absolute ${(a.absDrift * 100).toFixed(2)}%)`,
    ``,
    `### Action`,
    ``,
    a.direction === 'base->quote'
      ? `${a.baseSymbol} is over-weight by ${(a.absDrift * 100).toFixed(2)}%. Sell **$${a.sellUsd.toFixed(2)}** worth of ${a.baseSymbol} into ${a.quoteSymbol} via the configured DeepBookV3 pool to restore target ratio.`
      : `${a.quoteSymbol} is over-weight by ${(a.absDrift * 100).toFixed(2)}%. Buy **$${a.sellUsd.toFixed(2)}** worth of ${a.baseSymbol} with ${a.quoteSymbol} via the configured DeepBookV3 pool to restore target ratio.`,
    ``,
    `### Market context`,
    ``,
    `- Pool bid: ${a.pool.bestBid.toFixed(6)} ${a.quoteSymbol}/${a.baseSymbol}`,
    `- Pool ask: ${a.pool.bestAsk.toFixed(6)} ${a.quoteSymbol}/${a.baseSymbol}`,
    `- Pool mid: ${a.pool.mid.toFixed(6)} ${a.quoteSymbol}/${a.baseSymbol}`,
    `- Slippage tolerance: ${(a.slippageTolerance * 100).toFixed(2)}%`,
  ].join('\n');
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) return 0n;
  const units = usd / priceUsd;
  const atomic = BigInt(Math.max(0, Math.floor(units * Math.pow(10, decimals))));
  return atomic;
}

function shortenPoolId(poolId: string): string {
  return `${poolId.slice(0, 10)}…`;
}
