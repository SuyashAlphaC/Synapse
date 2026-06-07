import { describe, expect, it } from 'vitest';
import { applyRebalanceTradeGuards, tradeNotionalUsd } from '../src/runtime/trade-guards.js';
import type { HoldingSnapshot, PlannedTrade } from '../src/types.js';

const holdings: HoldingSnapshot[] = [
  {
    coinTypeTag: '0x2::sui::SUI',
    symbol: 'SUI',
    amount: 10_000_000_000n,
    decimals: 9,
    priceUsd: 2,
    valueUsd: 20,
  },
  {
    coinTypeTag: '0xquote::DBUSDC',
    symbol: 'DBUSDC',
    amount: 5_000_000n,
    decimals: 6,
    priceUsd: 1,
    valueUsd: 5,
  },
];

const dustTrade: PlannedTrade = {
  poolId: '0xpool',
  fromTypeTag: '0xquote::DBUSDC',
  toTypeTag: '0x2::sui::SUI',
  amountIn: 300_000n, // $0.30
  minAmountOut: 140_000_000n,
  direction: 1,
};

describe('trade-guards', () => {
  it('computes notional from input leg', () => {
    expect(tradeNotionalUsd(dustTrade, holdings)).toBeCloseTo(0.3, 5);
  });

  it('converts dust rebalance to noop', () => {
    const out = applyRebalanceTradeGuards(
      {
        kind: 'rebalance',
        planId: 'p1',
        summary: 'buy',
        trades: [dustTrade],
        rationaleMarkdown: 'x',
      },
      holdings,
      { minTradeUsd: 1 },
    );
    expect(out.kind).toBe('noop');
    if (out.kind === 'noop') {
      expect(out.rationale).toContain('min notional');
    }
  });

  it('relaxes minAmountOut for small but executable legs', () => {
    const smallTrade: PlannedTrade = { ...dustTrade, amountIn: 2_000_000n }; // $2
    const out = applyRebalanceTradeGuards(
      {
        kind: 'rebalance',
        planId: 'p2',
        summary: 'buy',
        trades: [smallTrade],
        rationaleMarkdown: 'x',
      },
      holdings,
      { minTradeUsd: 1, relaxMinOutBelowUsd: 5 },
    );
    expect(out.kind).toBe('rebalance');
    if (out.kind === 'rebalance') {
      expect(out.trades[0]?.minAmountOut).toBe(1n);
    }
  });
});
