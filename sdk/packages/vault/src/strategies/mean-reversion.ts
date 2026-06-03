/**
 * Mean-Reversion Strategy
 *
 * Buys when price is N standard deviations below a rolling mean (the asset
 * is "cheap" by recent history), sells when N standard deviations above
 * (it's "rich"). Uses MemWal-backed `counters.price_history_json` for
 * the rolling window so the strategy is reproducible from on-chain state
 * + memory; no hidden external data.
 *
 * Holds a max position in either direction so a sustained drift doesn't
 * accumulate runaway exposure. Refuses to act when sample size is too
 * small (warmup).
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const MEAN_REVERSION_ID = 'mean-reversion' as const;
const STRATEGY_VERSION = '1.0.0';

export interface MeanReversionConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Number of prior prices to keep when computing the rolling mean. */
  window: number;
  /** Z-score threshold to enter a buy (price ≤ mean − entryZ·stddev). */
  entryZ: number;
  /** Z-score threshold to exit/sell (price ≥ mean + exitZ·stddev). */
  exitZ: number;
  /** Cap on what fraction of NAV can shift per tick. */
  maxPositionFraction: number;
  slippageTolerance: number;
  poolId: string;
}

export function meanReversion(config: MeanReversionConfig): Strategy {
  validate(config);
  return {
    id: MEAN_REVERSION_ID,
    name: 'Mean Reversion',
    version: STRATEGY_VERSION,
    description:
      `Buys ${config.baseSymbol} when its price is ≥${config.entryZ.toFixed(1)}σ below a ` +
      `${config.window}-sample rolling mean; exits at ≥${config.exitZ.toFixed(1)}σ above. ` +
      `Reads price history from MemWal facts for full reproducibility.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
    prepareMemoryWrite: async ({ input }) => {
      const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
      if (!base || base.priceUsd <= 0) return null;
      const existing = input.memory.facts.find((f) => f.startsWith(HIST_FACT_PREFIX));
      const historyRaw = existing ? existing.slice(HIST_FACT_PREFIX.length) : '';
      const history = historyRaw
        .split(',')
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(-config.window + 1);
      history.push(base.priceUsd);
      const trimmed = history.slice(-config.window);
      // Carry forward any non-mr:hist facts unchanged (freeze flags, etc).
      const carried = input.memory.facts.filter((f) => !f.startsWith(HIST_FACT_PREFIX));
      return {
        facts: [...carried, `${HIST_FACT_PREFIX}${trimmed.join(',')}`],
      };
    },
  };
}

const HIST_FACT_PREFIX = 'mr:hist:';

function validate(c: MeanReversionConfig): void {
  if (c.window < 5 || c.window > 200) {
    throw new Error('meanReversion: window must be in [5, 200]');
  }
  if (c.entryZ <= 0 || c.exitZ <= 0) {
    throw new Error('meanReversion: entryZ and exitZ must be positive');
  }
  if (c.maxPositionFraction <= 0 || c.maxPositionFraction > 1) {
    throw new Error('meanReversion: maxPositionFraction ∉ (0, 1]');
  }
}

async function evaluate(
  config: MeanReversionConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);
  if (!base || !quote) {
    return { kind: 'noop', rationale: `Asset missing (base=${!!base}, quote=${!!quote}).` };
  }
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }
  const navUsd = base.valueUsd + quote.valueUsd;
  if (navUsd <= 0) return { kind: 'noop', rationale: 'NAV is zero.' };

  // Rolling history from memory.facts; encoded as comma-separated string.
  const histFact = input.memory.facts.find((f) => f.startsWith('mr:hist:'));
  const historyRaw = typeof histFact === 'string' ? histFact.slice('mr:hist:'.length) : '';
  const history: number[] = historyRaw
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(-config.window);

  if (history.length < Math.max(5, Math.floor(config.window / 4))) {
    return {
      kind: 'noop',
      rationale: `Warming up rolling window (${history.length}/${config.window} samples).`,
      signals: { samples: history.length, required: config.window },
    };
  }

  const mean = history.reduce((s, x) => s + x, 0) / history.length;
  const variance =
    history.reduce((acc, x) => acc + (x - mean) ** 2, 0) / Math.max(1, history.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev <= 0) {
    return { kind: 'noop', rationale: 'Stddev is zero — no signal.' };
  }
  const z = (base.priceUsd - mean) / stddev;

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) return { kind: 'noop', rationale: `Pool ${config.poolId} not available.` };

  let trade: PlannedTrade | null = null;
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let sizingUsd = 0;

  const maxShiftUsd = navUsd * config.maxPositionFraction;
  if (z <= -config.entryZ) {
    // Cheap — buy base with quote.
    action = 'buy';
    sizingUsd = Math.min(maxShiftUsd, quote.valueUsd);
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
  } else if (z >= config.exitZ) {
    // Rich — sell base into quote.
    action = 'sell';
    sizingUsd = Math.min(maxShiftUsd, base.valueUsd);
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

  if (!trade) {
    return {
      kind: 'noop',
      rationale: `z = ${z.toFixed(2)} inside [-${config.entryZ}, +${config.exitZ}]. Hold.`,
      signals: { z, mean, stddev, priceNow: base.priceUsd, samples: history.length },
    };
  }

  const trades = [trade];
  return {
    kind: 'rebalance',
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary: `z=${z.toFixed(2)} → ${action.toUpperCase()} $${sizingUsd.toFixed(2)} on ${pool.poolId.slice(0, 10)}…`,
    trades,
    rationaleMarkdown: [
      `### Mean Reversion diagnosis`,
      ``,
      `- **NAV**: $${navUsd.toFixed(2)}`,
      `- **Price now**: $${base.priceUsd.toFixed(6)}`,
      `- **Rolling mean** (n=${history.length}): $${mean.toFixed(6)}`,
      `- **Stddev**: $${stddev.toFixed(6)}`,
      `- **Z-score**: ${z.toFixed(3)} (entry ±${config.entryZ}, exit ±${config.exitZ})`,
      `- **Action**: ${action.toUpperCase()} — sizing $${sizingUsd.toFixed(2)}`,
    ].join('\n'),
    signals: { z, mean, stddev, priceNow: base.priceUsd, action, sizingUsd, navUsd },
  };
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}
