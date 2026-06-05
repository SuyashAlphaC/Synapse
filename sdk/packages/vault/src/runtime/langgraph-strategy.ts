/**
 * LangGraph strategy factory — implements the vault {@link Strategy} contract
 * by invoking a compiled LangGraph workflow with an optional {@link SynapseStore}.
 *
 * Attested (Nautilus) execution calls `evaluate(input)` with no runtime context;
 * graphs MUST read cross-tick state from `input.memory` (recalled before the
 * enclave call). When `runtime.store` is present the graph may also persist
 * auxiliary state via LangGraph's store API.
 */

import type { BaseStore } from '@langchain/langgraph-checkpoint';
import { SynapseStore } from '@synapse-core/adapter-langgraph';
import type {
  MemoryWrite,
  Strategy,
  StrategyDecision,
  StrategyInput,
  StrategyRuntimeContext,
} from '../types.js';
import { SYNAPSE_LANGGRAPH_STRATEGY } from '../types.js';

export interface LangGraphInvokeGraph<TState extends Record<string, unknown>> {
  invoke(
    input: TState,
    config?: {
      configurable?: Record<string, unknown>;
      store?: BaseStore;
    },
  ): Promise<TState>;
}

export interface LangGraphStrategyConfig<TState extends Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Pre-compiled LangGraph workflow. */
  graph: LangGraphInvokeGraph<TState>;
  /** Map tick input (+ recalled MemWal memory) into graph state. */
  buildState: (input: StrategyInput) => TState;
  /** Extract the rebalance / noop decision from terminal graph state. */
  extractDecision: (state: TState, input: StrategyInput) => StrategyDecision;
  /**
   * Optional MemWal fact/counter updates after the tick. When omitted and
   * `usesStore` is true, the runtime relies on graph store writes + the
   * standard outcome record only.
   */
  extractMemoryWrite?: (args: {
    state: TState;
    input: StrategyInput;
    decision: StrategyDecision;
    runtime?: StrategyRuntimeContext;
  }) => MemoryWrite | null | Promise<MemoryWrite | null>;
  /**
   * When true (default), pass `runtime.store` into `graph.invoke` when the
   * runtime provides it. Disable for graphs that only use `input.memory`.
   */
  usesStore?: boolean;
}

type MarkedStrategy = Strategy & { [key: symbol]: true };

/** True when the strategy was produced by {@link createLangGraphStrategy}. */
export function isLangGraphStrategy(strategy: Strategy): strategy is MarkedStrategy {
  return (strategy as MarkedStrategy)[SYNAPSE_LANGGRAPH_STRATEGY as unknown as symbol] === true;
}

/**
 * Wrap a compiled LangGraph workflow as a vault {@link Strategy}.
 * Default-export the return value from Walrus bundles (legacy TS strategies
 * remain valid without republishing).
 */
export function createLangGraphStrategy<TState extends Record<string, unknown>>(
  config: LangGraphStrategyConfig<TState>,
): Strategy {
  const usesStore = config.usesStore !== false;

  const strategy: MarkedStrategy = {
    id: config.id,
    name: config.name,
    version: config.version,
    description: config.description,
    [SYNAPSE_LANGGRAPH_STRATEGY as unknown as symbol]: true,

    evaluate: async (input: StrategyInput, runtime?: StrategyRuntimeContext) => {
      const state = config.buildState(input);
      const invokeConfig: {
        configurable: Record<string, unknown>;
        store?: BaseStore;
      } = {
        configurable: {
          thread_id: runtime?.threadId ?? input.vaultId,
          strategy_id: config.id,
        },
      };
      if (usesStore && runtime?.store) {
        invokeConfig.store = runtime.store;
      }
      const finalState = await config.graph.invoke(state, invokeConfig);
      return config.extractDecision(finalState, input);
    },
  };

  if (config.extractMemoryWrite) {
    strategy.prepareMemoryWrite = async ({ input, decision, runtime }) => {
      const state = config.buildState(input);
      const args: {
        state: TState;
        input: StrategyInput;
        decision: StrategyDecision;
        runtime?: StrategyRuntimeContext;
      } = { state, input, decision };
      if (runtime !== undefined) args.runtime = runtime;
      return config.extractMemoryWrite!(args);
    };
  }

  return strategy;
}

export { SynapseStore };
