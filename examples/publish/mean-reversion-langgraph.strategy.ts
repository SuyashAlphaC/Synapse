/**
 * Self-contained LangGraph mean-reversion strategy for Walrus publish +
 * Nautilus attestation. No `@synapse-core/*` runtime imports — types are
 * inlined so esbuild can produce one hash-verified ESM blob.
 *
 *   npx tsx scripts/bundle-strategy.ts examples/publish/mean-reversion-langgraph.strategy.ts
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

// ---------------------------------------------------------------------------
// Inlined Strategy contract (matches @synapse-core/vault — type-only in publish)
// ---------------------------------------------------------------------------

interface StrategyInput {
  vaultId: string;
  holdings: Array<{
    coinTypeTag: string;
    symbol: string;
    amount: bigint;
    decimals: number;
    priceUsd: number;
    valueUsd: number;
  }>;
  navUsd: number;
  market: { prices: Record<string, number>; pools: Array<{ poolId: string }> };
  memory: { recentDecisions: unknown[]; counters: Record<string, number>; facts: string[] };
  currentEpoch: bigint;
  policy: {
    revoked: boolean;
    expiryEpoch: bigint;
    spendPerEpochUsd: number;
    approvedPackages: string[];
  };
}

type StrategyDecision =
  | { kind: 'noop'; rationale: string; signals?: Record<string, unknown> }
  | {
      kind: 'rebalance';
      planId: string;
      summary: string;
      trades: Array<{
        poolId: string;
        fromTypeTag: string;
        toTypeTag: string;
        amountIn: bigint;
        minAmountOut: bigint;
        direction: 0 | 1;
      }>;
      rationaleMarkdown?: string;
      signals?: Record<string, unknown>;
    };

const config = {
  baseTypeTag: '0x2::sui::SUI',
  baseSymbol: 'SUI',
  quoteTypeTag:
    '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3262cdf230b5f3fe22::dbusdc::DBUSDC',
  quoteSymbol: 'DBUSDC',
  window: 30,
  entryZ: 1.5,
  exitZ: 1.5,
  maxPositionFraction: 0.25,
  slippageTolerance: 0.005,
  poolId: '0xf0f663cf87f1eb124da2fc9be813e0ce262146f3df60bc2052d738eb41a25899',
};

const HIST_FACT_PREFIX = 'mr:hist:';
const STRATEGY_ID = 'mean-reversion-langgraph';

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * 10 ** decimals)));
}

function computePlanId(
  vaultId: string,
  epoch: bigint,
  trades: Array<{ poolId: string; direction: number; amountIn: bigint }>,
): string {
  const short = vaultId.startsWith('0x') ? vaultId.slice(2, 10) : vaultId.slice(0, 8);
  const fp = trades
    .map((t) => `${t.poolId.slice(2, 6)}${t.direction}${t.amountIn.toString(36)}`)
    .join('-');
  return `mr-lg-${short}-e${epoch.toString()}-${fp}`;
}

function decide(input: StrategyInput): StrategyDecision {
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

  const histFact = input.memory.facts.find((f) => f.startsWith(HIST_FACT_PREFIX));
  const historyRaw = histFact ? histFact.slice(HIST_FACT_PREFIX.length) : '';
  const history = historyRaw
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
    history.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, history.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev <= 0) return { kind: 'noop', rationale: 'Stddev is zero — no signal.' };
  const z = (base.priceUsd - mean) / stddev;

  const pool = input.market.pools.find((p) => p.poolId === config.poolId);
  if (!pool) return { kind: 'noop', rationale: `Pool ${config.poolId} not available.` };

  const maxShiftUsd = navUsd * config.maxPositionFraction;
  if (z <= -config.entryZ) {
    const sizingUsd = Math.min(maxShiftUsd, quote.valueUsd);
    const trades = [{
      poolId: config.poolId,
      fromTypeTag: config.quoteTypeTag,
      toTypeTag: config.baseTypeTag,
      amountIn: usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals),
      minAmountOut: usdToAtomic(sizingUsd * (1 - config.slippageTolerance), base.priceUsd, base.decimals),
      direction: 1 as const,
    }];
    return {
      kind: 'rebalance',
      planId: computePlanId(input.vaultId, input.currentEpoch, trades),
      summary: `z=${z.toFixed(2)} → BUY $${sizingUsd.toFixed(2)}`,
      trades,
      rationaleMarkdown: `LangGraph mean reversion: z=${z.toFixed(3)} BUY`,
      signals: { z, mean, stddev, action: 'buy' },
    };
  }
  if (z >= config.exitZ) {
    const sizingUsd = Math.min(maxShiftUsd, base.valueUsd);
    const trades = [{
      poolId: config.poolId,
      fromTypeTag: config.baseTypeTag,
      toTypeTag: config.quoteTypeTag,
      amountIn: usdToAtomic(sizingUsd, base.priceUsd, base.decimals),
      minAmountOut: usdToAtomic(sizingUsd * (1 - config.slippageTolerance), quote.priceUsd, quote.decimals),
      direction: 0 as const,
    }];
    return {
      kind: 'rebalance',
      planId: computePlanId(input.vaultId, input.currentEpoch, trades),
      summary: `z=${z.toFixed(2)} → SELL $${sizingUsd.toFixed(2)}`,
      trades,
      rationaleMarkdown: `LangGraph mean reversion: z=${z.toFixed(3)} SELL`,
      signals: { z, mean, stddev, action: 'sell' },
    };
  }
  return {
    kind: 'noop',
    rationale: `z = ${z.toFixed(2)} inside band. Hold.`,
    signals: { z, mean, stddev, samples: history.length },
  };
}

const TickState = Annotation.Root({
  input: Annotation<StrategyInput>,
  decision: Annotation<StrategyDecision | null>,
});

const graph = new StateGraph(TickState)
  .addNode('decide', async (state) => ({ decision: decide(state.input) }))
  .addEdge(START, 'decide')
  .addEdge('decide', END)
  .compile();

const strategy = {
  id: STRATEGY_ID,
  name: 'Mean Reversion (LangGraph)',
  version: '1.0.0',
  description:
    `LangGraph mean reversion on ${config.baseSymbol}/${config.quoteSymbol}. ` +
    `Publishes as a single Walrus bundle for runtime + Nautilus attestation.`,
  synapseLangGraph: true as const,

  evaluate: async (input: StrategyInput): Promise<StrategyDecision> => {
    const out = await graph.invoke({ input, decision: null });
    return out.decision ?? { kind: 'noop', rationale: 'Graph returned no decision.' };
  },

  prepareMemoryWrite: async ({ input }: { input: StrategyInput; decision: StrategyDecision }) => {
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
    const carried = input.memory.facts.filter((f) => !f.startsWith(HIST_FACT_PREFIX));
    return { facts: [...carried, `${HIST_FACT_PREFIX}${trimmed.join(',')}`] };
  },
};

export default strategy;
