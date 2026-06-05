import { describe, expect, it } from 'vitest';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { StrategyDecision, StrategyInput } from '../src/types.js';
import {
  createLangGraphStrategy,
  isLangGraphStrategy,
} from '../src/runtime/langgraph-strategy.js';
import { SYNAPSE_LANGGRAPH_STRATEGY } from '../src/types.js';

describe('createLangGraphStrategy', () => {
  it('marks the strategy and evaluates via the graph', async () => {
    const TickState = Annotation.Root({
      input: Annotation<StrategyInput>,
      decision: Annotation<StrategyDecision | null>,
    });

    const graph = new StateGraph(TickState)
      .addNode('noop', async (state) => ({
        decision: { kind: 'noop' as const, rationale: 'graph noop' },
      }))
      .addEdge(START, 'noop')
      .addEdge('noop', END)
      .compile();

    const strategy = createLangGraphStrategy({
      id: 'test-lg',
      name: 'Test LG',
      version: '0.0.1',
      description: 'test',
      graph,
      buildState: (input) => ({ input, decision: null }),
      extractDecision: (state) => state.decision ?? { kind: 'noop', rationale: 'missing' },
      usesStore: false,
    });

    expect(isLangGraphStrategy(strategy)).toBe(true);
    expect((strategy as Record<symbol, unknown>)[SYNAPSE_LANGGRAPH_STRATEGY]).toBe(true);

    const input = {
      vaultId: '0xabc',
      holdings: [],
      navUsd: 0,
      market: { prices: {}, pools: [] },
      memory: { recentDecisions: [], counters: {}, facts: [] },
      currentEpoch: 1n,
      policy: {
        revoked: false,
        expiryEpoch: 999n,
        spendPerEpochUsd: 100,
        approvedPackages: [],
      },
    } satisfies StrategyInput;

    const decision = await strategy.evaluate(input);
    expect(decision.kind).toBe('noop');
    if (decision.kind === 'noop') {
      expect(decision.rationale).toBe('graph noop');
    }
  });
});
