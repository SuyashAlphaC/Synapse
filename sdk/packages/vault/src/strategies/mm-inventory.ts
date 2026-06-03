/**
 * MM Inventory Strategy
 *
 * Keeps the vault's base-asset weight inside a configured band
 * [lowerBaseWeight, upperBaseWeight]. Trades the minimum needed to
 * bring weight back to the nearest band edge — not all the way to a
 * single target. Gentler than the Conservative Rebalancer, which
 * snaps to a single target every time.
 *
 * Useful when the vault's role is to provide quasi-passive
 * market-making inventory: stay inside the corridor, don't over-trade,
 * never let one side run away.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const MM_INVENTORY_ID = 'mm-inventory' as const;
const STRATEGY_VERSION = '1.0.0';

export interface MmInventoryConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Acceptable base weight floor (e.g. 0.4). */
  lowerBaseWeight: number;
  /** Acceptable base weight ceiling (e.g. 0.6). */
  upperBaseWeight: number;
  slippageTolerance: number;
  poolId: string;
}

export function mmInventory(config: MmInventoryConfig): Strategy {
  validate(config);
  return {
    id: MM_INVENTORY_ID,
    name: 'MM Inventory',
    version: STRATEGY_VERSION,
    description:
      `Maintains ${config.baseSymbol} weight inside [${(config.lowerBaseWeight * 100).toFixed(0)}%, ` +
      `${(config.upperBaseWeight * 100).toFixed(0)}%]. Trades only the minimum needed to re-enter ` +
      `the band — never over-rebalances.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
  };
}

function validate(c: MmInventoryConfig): void {
  if (c.lowerBaseWeight < 0 || c.upperBaseWeight > 1) {
    throw new Error('mmInventory: weights must be in [0,1]');
  }
  if (c.lowerBaseWeight >= c.upperBaseWeight) {
    throw new Error('mmInventory: require lowerBaseWeight < upperBaseWeight');
  }
}

async function evaluate(
  config: MmInventoryConfig,
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

  const baseWeight = base.valueUsd / navUsd;
  // Inside the band? Hold.
  if (baseWeight >= config.lowerBaseWeight && baseWeight <= config.upperBaseWeight) {
    return {
      kind: 'noop',
      rationale: `${config.baseSymbol} weight ${(baseWeight * 100).toFixed(2)}% inside [${(config.lowerBaseWeight * 100).toFixed(0)}%, ${(config.upperBaseWeight * 100).toFixed(0)}%]. Hold.`,
      signals: { baseWeight, lower: config.lowerBaseWeight, upper: config.upperBaseWeight, navUsd },
    };
  }

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) return { kind: 'noop', rationale: `Pool ${config.poolId} not available.` };

  // Move to the NEAREST band edge, not to the midpoint.
  const targetWeight =
    baseWeight < config.lowerBaseWeight ? config.lowerBaseWeight : config.upperBaseWeight;
  const targetBaseUsd = navUsd * targetWeight;
  const deltaUsd = targetBaseUsd - base.valueUsd;
  let trade: PlannedTrade;
  let direction: 'buy' | 'sell';
  let sizingUsd: number;

  if (deltaUsd > 0) {
    direction = 'buy';
    sizingUsd = Math.min(deltaUsd, quote.valueUsd);
    const amountIn = usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals);
    const minOut = usdToAtomic(sizingUsd * (1 - config.slippageTolerance), base.priceUsd, base.decimals);
    trade = {
      poolId: config.poolId,
      fromTypeTag: config.quoteTypeTag,
      toTypeTag: config.baseTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 1,
    };
  } else {
    direction = 'sell';
    sizingUsd = Math.min(-deltaUsd, base.valueUsd);
    const amountIn = usdToAtomic(sizingUsd, base.priceUsd, base.decimals);
    const minOut = usdToAtomic(sizingUsd * (1 - config.slippageTolerance), quote.priceUsd, quote.decimals);
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
    summary: `${config.baseSymbol} ${(baseWeight * 100).toFixed(2)}% outside band → ${direction.toUpperCase()} $${sizingUsd.toFixed(2)} to re-enter at ${(targetWeight * 100).toFixed(0)}%.`,
    trades,
    rationaleMarkdown: [
      `### MM Inventory diagnosis`,
      ``,
      `- **NAV**: $${navUsd.toFixed(2)}`,
      `- **${config.baseSymbol} weight**: ${(baseWeight * 100).toFixed(2)}%`,
      `- **Band**: [${(config.lowerBaseWeight * 100).toFixed(0)}%, ${(config.upperBaseWeight * 100).toFixed(0)}%]`,
      `- **Action**: ${direction.toUpperCase()} to reach band edge ${(targetWeight * 100).toFixed(0)}%`,
      `- **Sizing**: $${sizingUsd.toFixed(2)}`,
    ].join('\n'),
    signals: { baseWeight, lower: config.lowerBaseWeight, upper: config.upperBaseWeight, direction, sizingUsd },
  };
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}
