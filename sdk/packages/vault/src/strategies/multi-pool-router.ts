/**
 * Multi-pool Router Strategy
 *
 * Same target-weight + drift-threshold logic as the Conservative
 * Rebalancer, but instead of being pinned to one DeepBookV3 pool, it
 * looks at every pool in `market.pools` matching the target pair and
 * picks the one with the best mid for this trade direction.
 *
 * Practical effect: when a rebalance fires, the strategy routes through
 * the deepest / tightest-spread pool available. Useful when liquidity is
 * fragmented across multiple pools.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const MULTI_POOL_ROUTER_ID = 'multi-pool-router' as const;
const STRATEGY_VERSION = '1.0.0';

export interface MultiPoolRouterConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  targetBaseWeight: number;
  driftThreshold: number;
  slippageTolerance: number;
}

export function multiPoolRouter(config: MultiPoolRouterConfig): Strategy {
  validate(config);
  return {
    id: MULTI_POOL_ROUTER_ID,
    name: 'Multi-pool Router',
    version: STRATEGY_VERSION,
    description:
      `Target ${(config.targetBaseWeight * 100).toFixed(0)}/${((1 - config.targetBaseWeight) * 100).toFixed(0)} ` +
      `${config.baseSymbol}/${config.quoteSymbol}, ${(config.driftThreshold * 100).toFixed(1)}% threshold. ` +
      `On rebalance, picks the best-priced DeepBookV3 pool from the market snapshot for the trade direction.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
  };
}

function validate(c: MultiPoolRouterConfig): void {
  if (c.targetBaseWeight < 0 || c.targetBaseWeight > 1) {
    throw new Error('multiPoolRouter: targetBaseWeight ∉ [0,1]');
  }
  if (c.driftThreshold <= 0 || c.driftThreshold > 1) {
    throw new Error('multiPoolRouter: driftThreshold ∉ (0,1]');
  }
}

async function evaluate(
  config: MultiPoolRouterConfig,
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

  const actual = base.valueUsd / navUsd;
  const drift = actual - config.targetBaseWeight;
  if (Math.abs(drift) < config.driftThreshold) {
    return {
      kind: 'noop',
      rationale: `Drift ${(Math.abs(drift) * 100).toFixed(2)}% inside threshold.`,
      signals: { actual, target: config.targetBaseWeight, drift, navUsd },
    };
  }

  // Candidate pools: anything in the market snapshot matching the pair.
  const candidates = input.market.pools.filter(
    (p) =>
      p.baseTypeTag === config.baseTypeTag && p.quoteTypeTag === config.quoteTypeTag,
  );
  if (candidates.length === 0) {
    return { kind: 'noop', rationale: 'No pools match the base/quote pair.' };
  }

  // For base→quote (sell base, want high bid), pick max bid.
  // For quote→base (buy base, want low ask), pick min ask.
  const sellingBase = drift > 0;
  const best = sellingBase
    ? candidates.reduce((a, b) => (a.bestBid > b.bestBid ? a : b))
    : candidates.reduce((a, b) => (a.bestAsk < b.bestAsk ? a : b));

  const targetBaseUsd = navUsd * config.targetBaseWeight;
  const sizingUsd = sellingBase ? base.valueUsd - targetBaseUsd : targetBaseUsd - base.valueUsd;
  let trade: PlannedTrade;
  if (sellingBase) {
    const amountIn = usdToAtomic(sizingUsd, base.priceUsd, base.decimals);
    const minOut = usdToAtomic(sizingUsd * (1 - config.slippageTolerance), quote.priceUsd, quote.decimals);
    trade = {
      poolId: best.poolId,
      fromTypeTag: config.baseTypeTag,
      toTypeTag: config.quoteTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 0,
    };
  } else {
    const amountIn = usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals);
    const minOut = usdToAtomic(sizingUsd * (1 - config.slippageTolerance), base.priceUsd, base.decimals);
    trade = {
      poolId: best.poolId,
      fromTypeTag: config.quoteTypeTag,
      toTypeTag: config.baseTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 1,
    };
  }

  const trades = [trade];
  return {
    kind: 'rebalance',
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary: `${sellingBase ? 'SELL' : 'BUY'} $${sizingUsd.toFixed(2)} via best-priced pool (${best.poolId.slice(0, 10)}…).`,
    trades,
    rationaleMarkdown: [
      `### Multi-pool Router diagnosis`,
      ``,
      `- **NAV**: $${navUsd.toFixed(2)}`,
      `- **${config.baseSymbol} weight**: ${(actual * 100).toFixed(2)}% (target ${(config.targetBaseWeight * 100).toFixed(0)}%)`,
      `- **Drift**: ${(drift * 100).toFixed(2)}%`,
      `- **Candidate pools**: ${candidates.length}`,
      `- **Chosen pool**: ${best.poolId.slice(0, 10)}… (bid ${best.bestBid.toFixed(6)}, ask ${best.bestAsk.toFixed(6)})`,
      `- **Action**: ${sellingBase ? 'SELL' : 'BUY'} $${sizingUsd.toFixed(2)}`,
    ].join('\n'),
    signals: {
      actual,
      target: config.targetBaseWeight,
      drift,
      poolCount: candidates.length,
      chosenBid: best.bestBid,
      chosenAsk: best.bestAsk,
    },
  };
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}

