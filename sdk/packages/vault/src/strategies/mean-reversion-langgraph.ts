/**
 * Mean Reversion — LangGraph edition.
 *
 * Same economics as {@link meanReversion} but expressed as a compiled
 * LangGraph workflow. Demonstrates full integration: runtime passes
 * {@link StrategyRuntimeContext.store} on each tick; attested enclave
 * execution uses `input.memory` only (no store in TEE).
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { StrategyInput, StrategyDecision } from '../types.js';
import {
  createLangGraphStrategy,
  type LangGraphStrategyConfig,
} from '../runtime/langgraph-strategy.js';
import {
  MEAN_REVERSION_ID,
  meanReversion,
  type MeanReversionConfig,
} from './mean-reversion.js';
import {
  SUI_TYPE_TAG_TESTNET,
  SUI_USDC_POOL_ID_TESTNET,
  USDC_TYPE_TAG_TESTNET,
} from '../runtime/deepbook.js';

const HIST_FACT_PREFIX = 'mr:hist:';

const MeanRevState = Annotation.Root({
  input: Annotation<StrategyInput>,
  decision: Annotation<StrategyDecision | null>,
});

export function meanReversionLangGraph(config: MeanReversionConfig) {
  const legacy = meanReversion(config);

  const graph = new StateGraph(MeanRevState)
    .addNode('decide', async (state) => ({
      decision: await legacy.evaluate(state.input),
    }))
    .addEdge(START, 'decide')
    .addEdge('decide', END)
    .compile();

  const lgConfig: LangGraphStrategyConfig<{ input: StrategyInput; decision: StrategyDecision | null }> =
    {
      id: `${MEAN_REVERSION_ID}-langgraph`,
      name: 'Mean Reversion (LangGraph)',
      version: '1.0.0',
      description:
        `${legacy.description} Implemented as a LangGraph workflow with SynapseStore-backed memory.`,
      graph,
      buildState: (input) => ({ input, decision: null }),
      extractDecision: (state) => {
        if (!state.decision) {
          return { kind: 'noop', rationale: 'LangGraph produced no decision.' };
        }
        return state.decision;
      },
      extractMemoryWrite: async ({ input }) => {
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
      usesStore: true,
    };

  return createLangGraphStrategy(lgConfig);
}

/** Testnet-default LangGraph mean reversion for bundling / demos. */
export function meanReversionLangGraphTestnet(): ReturnType<typeof meanReversionLangGraph> {
  return meanReversionLangGraph({
    baseTypeTag: SUI_TYPE_TAG_TESTNET,
    baseSymbol: 'SUI',
    quoteTypeTag: USDC_TYPE_TAG_TESTNET,
    quoteSymbol: 'USDC',
    window: 30,
    entryZ: 1.5,
    exitZ: 1.5,
    maxPositionFraction: 0.25,
    slippageTolerance: 0.005,
    poolId: SUI_USDC_POOL_ID_TESTNET,
  });
}

export default meanReversionLangGraphTestnet();
