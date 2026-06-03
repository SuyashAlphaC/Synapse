/**
 * DCA / TWAP Strategy
 *
 * Time-weighted accumulation: every Nth tick, swap a fixed USD-denominated
 * amount of one side into the other, ignoring price entirely. The classic
 * "buy a fixed dollar amount of SUI every week regardless of how the
 * market is moving" pattern.
 *
 * Tick counter is recovered from MemWal — `counters.dca_tick_index`
 * increments on every tick that fires, regardless of NOOP vs trade. The
 * strategy itself remains a pure function of input.
 */

import type {
  Strategy,
  StrategyInput,
  StrategyDecision,
  RebalancePlan,
  PlannedTrade,
} from '../types.js';
import { computePlanId } from '../executor.js';

export const DCA_TWAP_ID = 'dca-twap' as const;
const STRATEGY_VERSION = '1.0.0';

export type DcaDirection = 'accumulate-base' | 'accumulate-quote';

export interface DcaTwapConfig {
  baseTypeTag: string;
  baseSymbol: string;
  quoteTypeTag: string;
  quoteSymbol: string;
  /** Direction of accumulation. */
  direction: DcaDirection;
  /** Trade every N ticks. e.g. 6 with a 10-min cadence = once per hour. */
  cadenceTicks: number;
  /** USD value to swap per trade. */
  tradeSizeUsd: number;
  slippageTolerance: number;
  poolId: string;
}

export function dcaTwap(config: DcaTwapConfig): Strategy {
  validate(config);
  const accumulating =
    config.direction === 'accumulate-base' ? config.baseSymbol : config.quoteSymbol;
  return {
    id: DCA_TWAP_ID,
    name: 'DCA / TWAP',
    version: STRATEGY_VERSION,
    description:
      `Accumulates ${accumulating} on a fixed schedule: $${config.tradeSizeUsd.toFixed(2)} every ` +
      `${config.cadenceTicks} ticks, ignoring price. Classic time-weighted average. ` +
      `Tick index persisted via MemWal counter.`,
    evaluate: async (input: StrategyInput): Promise<StrategyDecision> =>
      evaluate(config, input),
    prepareMemoryWrite: async ({ input }) => {
      const prev = input.memory.counters['dca_tick_index'] ?? 0;
      return { counters: { dca_tick_index: prev + 1 } };
    },
  };
}

function validate(c: DcaTwapConfig): void {
  if (c.cadenceTicks < 1 || c.cadenceTicks > 10_000) {
    throw new Error('dcaTwap: cadenceTicks must be in [1, 10000]');
  }
  if (c.tradeSizeUsd <= 0) {
    throw new Error('dcaTwap: tradeSizeUsd must be positive');
  }
}

async function evaluate(
  config: DcaTwapConfig,
  input: StrategyInput,
): Promise<StrategyDecision> {
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }

  const tickIndex = Math.floor(input.memory.counters['dca_tick_index'] ?? 0);
  const dueThisTick = tickIndex % config.cadenceTicks === 0;
  if (!dueThisTick) {
    return {
      kind: 'noop',
      rationale: `Tick ${tickIndex} not a DCA execution slot (every ${config.cadenceTicks} ticks).`,
      signals: { tickIndex, cadence: config.cadenceTicks },
    };
  }

  const base = input.holdings.find((h) => h.coinTypeTag === config.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === config.quoteTypeTag);
  if (!base || !quote) {
    return { kind: 'noop', rationale: `Asset missing (base=${!!base}, quote=${!!quote}).` };
  }

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) return { kind: 'noop', rationale: `Pool ${config.poolId} not in market snapshot.` };

  // Pull funds from the side we're spending; cap at available balance.
  const isBuyingBase = config.direction === 'accumulate-base';
  const fromSide = isBuyingBase ? quote : base;
  const toSide = isBuyingBase ? base : quote;
  const sizingUsd = Math.min(config.tradeSizeUsd, fromSide.valueUsd);
  if (sizingUsd <= 0) {
    return {
      kind: 'noop',
      rationale: `No ${fromSide.symbol} left to spend.`,
      signals: { fromBalanceUsd: fromSide.valueUsd },
    };
  }

  const amountIn = usdToAtomic(sizingUsd, fromSide.priceUsd, fromSide.decimals);
  const minOut = usdToAtomic(
    sizingUsd * (1 - config.slippageTolerance),
    toSide.priceUsd,
    toSide.decimals,
  );
  const trade: PlannedTrade = {
    poolId: config.poolId,
    fromTypeTag: fromSide.coinTypeTag,
    toTypeTag: toSide.coinTypeTag,
    amountIn,
    minAmountOut: minOut,
    direction: isBuyingBase ? 1 : 0,
  };

  const trades = [trade];
  const plan: RebalancePlan = {
    kind: 'rebalance',
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary: `DCA #${tickIndex}: buy $${sizingUsd.toFixed(2)} of ${toSide.symbol} with ${fromSide.symbol}.`,
    trades,
    rationaleMarkdown: [
      `### DCA / TWAP execution`,
      ``,
      `- **Tick index**: ${tickIndex}`,
      `- **Cadence**: every ${config.cadenceTicks} ticks`,
      `- **Direction**: ${config.direction}`,
      `- **Trade size**: $${sizingUsd.toFixed(2)}`,
      `- **Price at execution**: ${pool.mid.toFixed(6)} ${fromSide.symbol}/${toSide.symbol}`,
      ``,
      `Price is informational only — DCA ignores it by design.`,
    ].join('\n'),
    signals: {
      tickIndex,
      direction: config.direction,
      sizingUsd,
      midPrice: pool.mid,
    },
  };
  return plan;
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * Math.pow(10, decimals))));
}
