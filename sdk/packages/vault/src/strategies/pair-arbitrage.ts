/**
 * Pair Arbitrage Strategy
 *
 * Compares two DeepBookV3 pools for the same base/quote pair (or two
 * pools whose mid prices SHOULD track each other) and trades to capture
 * the divergence when it exceeds a threshold.
 *
 * Example: if SUI/USDC mid is 1.0820 on pool A but 1.0780 on pool B
 * (40bps spread), the strategy buys SUI on the cheap pool and would
 * sell on the rich pool — though the actual sell leg requires the vault
 * to already hold the right inventory; for v1 we just execute the buy
 * leg and rely on subsequent ticks (or other strategies) to close.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const PAIR_ARBITRAGE_ID = 'pair-arbitrage' as const;
const STRATEGY_VERSION = '1.0.0';

export interface PairArbitrageConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Two pool IDs to compare; first is preferred for the buy leg. */
  poolAId: string;
  poolBId: string;
  /** Minimum divergence (in bps) before firing — covers fees + slippage. */
  divergenceThresholdBps: number;
  /** Max USD value to deploy per arb tick. */
  maxTradeUsd: number;
  slippageTolerance: number;
}

export function pairArbitrage(config: PairArbitrageConfig): Strategy {
  validate(config);
  return {
    id: PAIR_ARBITRAGE_ID,
    name: 'Pair Arbitrage',
    version: STRATEGY_VERSION,
    description:
      `Compares two ${config.baseSymbol}/${config.quoteSymbol} pools each tick; when mid prices ` +
      `diverge by ≥${config.divergenceThresholdBps}bps, buys on the cheaper side. Cap ` +
      `$${config.maxTradeUsd.toFixed(2)}/tick.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
  };
}

function validate(c: PairArbitrageConfig): void {
  if (c.divergenceThresholdBps <= 0 || c.divergenceThresholdBps > 1000) {
    throw new Error('pairArbitrage: divergenceThresholdBps ∉ (0, 1000]');
  }
  if (c.maxTradeUsd <= 0) {
    throw new Error('pairArbitrage: maxTradeUsd must be positive');
  }
  if (c.poolAId === c.poolBId) {
    throw new Error('pairArbitrage: poolAId and poolBId must differ');
  }
}

async function evaluate(
  config: PairArbitrageConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }

  const poolA = input.market.pools.find((p) => p.poolId === config.poolAId);
  const poolB = input.market.pools.find((p) => p.poolId === config.poolBId);
  if (!poolA || !poolB) {
    return {
      kind: 'noop',
      rationale: `Both pools required (A=${!!poolA}, B=${!!poolB}).`,
    };
  }
  if (poolA.mid <= 0 || poolB.mid <= 0) {
    return { kind: 'noop', rationale: 'Pool mid prices unhealthy.' };
  }

  // Divergence in bps. Positive means A > B (so B is cheaper for buying base).
  const divergenceBps = ((poolA.mid - poolB.mid) / poolB.mid) * 10_000;
  const absDivBps = Math.abs(divergenceBps);

  if (absDivBps < config.divergenceThresholdBps) {
    return {
      kind: 'noop',
      rationale: `Divergence ${absDivBps.toFixed(1)}bps < ${config.divergenceThresholdBps}bps threshold. Hold.`,
      signals: { poolAMid: poolA.mid, poolBMid: poolB.mid, divergenceBps },
    };
  }

  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);
  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  if (!quote || !base) {
    return { kind: 'noop', rationale: `Asset missing (base=${!!base}, quote=${!!quote}).` };
  }

  // Buy base on the CHEAPER pool (smaller mid = smaller quote per base).
  const cheaperPool = poolA.mid < poolB.mid ? poolA : poolB;
  const sizingUsd = Math.min(config.maxTradeUsd, quote.valueUsd);
  if (sizingUsd <= 0) {
    return { kind: 'noop', rationale: `No ${quote.symbol} to deploy.` };
  }

  const amountIn = usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals);
  const minOut = usdToAtomic(
    sizingUsd * (1 - config.slippageTolerance),
    base.priceUsd,
    base.decimals,
  );
  const trade: PlannedTrade = {
    poolId: cheaperPool.poolId,
    fromTypeTag: config.quoteTypeTag,
    toTypeTag: config.baseTypeTag,
    amountIn,
    minAmountOut: minOut,
    direction: 1,
  };

  const trades = [trade];
  return {
    kind: 'rebalance',
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary:
      `Divergence ${divergenceBps >= 0 ? '+' : ''}${divergenceBps.toFixed(1)}bps → buy ` +
      `$${sizingUsd.toFixed(2)} of ${base.symbol} on cheaper pool ${cheaperPool.poolId.slice(0, 10)}…`,
    trades,
    rationaleMarkdown: [
      `### Pair Arbitrage diagnosis`,
      ``,
      `- **Pool A mid**: ${poolA.mid.toFixed(6)} (${poolA.poolId.slice(0, 10)}…)`,
      `- **Pool B mid**: ${poolB.mid.toFixed(6)} (${poolB.poolId.slice(0, 10)}…)`,
      `- **Divergence**: ${divergenceBps.toFixed(1)} bps`,
      `- **Threshold**: ${config.divergenceThresholdBps} bps`,
      `- **Cheaper pool** (buy leg): ${cheaperPool.poolId.slice(0, 10)}…`,
      `- **Size**: $${sizingUsd.toFixed(2)}`,
    ].join('\n'),
    signals: { divergenceBps, poolAMid: poolA.mid, poolBMid: poolB.mid, sizingUsd },
  };
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}
