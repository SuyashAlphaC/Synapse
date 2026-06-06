import { describe, expect, it } from 'vitest';

import {
  outcomeMatchesStrategy,
  pickLatestStrategyOutcome,
  type ParsedOutcomeRow,
} from '../src/runtime/memory.js';

function row(args: {
  decisionId: string;
  epoch: string;
  executedAt: string;
  counters?: Record<string, number>;
  facts?: string[];
  strategyId?: string;
  rationale?: string;
}): ParsedOutcomeRow {
  return {
    entry: {
      decisionId: args.decisionId,
      epoch: BigInt(args.epoch),
      kind: 'noop',
      rationale: args.rationale ?? 'hold',
    },
    epoch: BigInt(args.epoch),
    executedAtMs: Date.parse(args.executedAt),
    raw: {
      decision: {
        decisionId: args.decisionId,
        epoch: BigInt(args.epoch),
        kind: 'noop',
        rationale: args.rationale ?? 'hold',
      },
      executedAtMs: Date.parse(args.executedAt),
      counters: args.counters ?? {},
      facts: args.facts ?? [],
      strategyId: args.strategyId,
    },
  };
}

describe('outcomeMatchesStrategy', () => {
  it('matches explicit strategyId on the payload', () => {
    expect(
      outcomeMatchesStrategy(
        { counters: {}, facts: [], strategyId: 'momentum-yield-maximizer' },
        'momentum-yield-maximizer',
      ),
    ).toBe(true);
    expect(
      outcomeMatchesStrategy(
        { counters: {}, facts: [], strategyId: 'peer-coordinated-yield' },
        'momentum-yield-maximizer',
      ),
    ).toBe(false);
  });

  it('matches MYM markers when strategyId is absent (legacy rows)', () => {
    expect(
      outcomeMatchesStrategy(
        { counters: { mymTicks: 2 }, facts: ['mym:px:0.1,0.2'], strategyId: undefined },
        'momentum-yield-maximizer',
      ),
    ).toBe(true);
    expect(
      outcomeMatchesStrategy(
        { counters: { pcyTicks: 2 }, facts: ['pcy:px:0.1'], strategyId: undefined },
        'momentum-yield-maximizer',
      ),
    ).toBe(false);
  });
});

describe('pickLatestStrategyOutcome', () => {
  it('prefers higher mymTicks over stale asset-missing rows in the same epoch', () => {
    const decisions = [
      row({
        decisionId: 'noop-old',
        epoch: '1122',
        executedAt: '2026-06-06T09:00:00.000Z',
        rationale: 'Asset missing (base=false, quote=false).',
      }),
      row({
        decisionId: 'noop-new',
        epoch: '1122',
        executedAt: '2026-06-06T10:40:00.000Z',
        counters: { mymTicks: 4 },
        facts: ['mym:px:0.1,0.2,0.3,0.4'],
        strategyId: 'momentum-yield-maximizer',
        rationale: 'Warming up price history (3/10 samples).',
      }),
      row({
        decisionId: 'noop-stale-warmup',
        epoch: '1122',
        executedAt: '2026-06-06T10:30:00.000Z',
        counters: { mymTicks: 2 },
        facts: ['mym:px:0.1,0.2'],
        strategyId: 'momentum-yield-maximizer',
        rationale: 'Warming up price history (1/10 samples).',
      }),
    ];

    const latest = pickLatestStrategyOutcome(decisions, 'momentum-yield-maximizer');
    expect(latest?.raw.counters.mymTicks).toBe(4);
    expect(latest?.raw.facts[0]).toBe('mym:px:0.1,0.2,0.3,0.4');
  });

  it('ignores peer-strategy rows when selecting MYM state', () => {
    const decisions = [
      row({
        decisionId: 'pcy-new',
        epoch: '1122',
        executedAt: '2026-06-06T13:17:32.000Z',
        counters: { pcyTicks: 99 },
        facts: ['pcy:px:1,2,3,4,5,6,7,8,9,10'],
        strategyId: 'peer-coordinated-yield',
      }),
      row({
        decisionId: 'mym-new',
        epoch: '1122',
        executedAt: '2026-06-06T13:07:33.000Z',
        counters: { mymTicks: 4 },
        facts: ['mym:px:0.1,0.2,0.3,0.4'],
        strategyId: 'momentum-yield-maximizer',
      }),
    ];

    const latest = pickLatestStrategyOutcome(decisions, 'momentum-yield-maximizer');
    expect(latest?.raw.counters.mymTicks).toBe(4);
  });
});
