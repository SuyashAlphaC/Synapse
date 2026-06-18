'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { useBacktestIndex } from '../../hooks/use-backtest';
import { CodeTag } from '../ui/code-tag';

/**
 * Hero strip on /marketplace — live 90-day backtests for every active
 * marketplace strategy (CoinGecko SUI/USD + real evaluate() replay).
 */
export function BacktestSummaryStrip() {
  const { data, isLoading, isError } = useBacktestIndex();

  if (isLoading) {
    return (
      <div className="card-flat mb-8 p-5 font-mono text-xs text-ink-mute">
        Loading live 90-day backtests from CoinGecko…
      </div>
    );
  }

  if (isError || !data || data.strategies.length === 0) return null;

  const ok = data.strategies.filter((s) => !s.error);

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card-flat mb-8 overflow-hidden"
    >
      <div className="flex flex-col gap-2 border-b border-divider p-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>backtest</CodeTag> · live · 90-day window ·{' '}
            <span className="text-ink">
              {data.startDate} → {data.endDate}
            </span>
          </p>
          <h2 className="mt-1 font-display text-2xl font-bold tracking-tight md:text-3xl">
            Real returns,{' '}
            <span className="font-serif italic">verifiable inputs</span>.
          </h2>
        </div>
        <p className="max-w-xs text-xs leading-relaxed text-ink-soft">
          {ok.length} active strateg{ok.length === 1 ? 'y' : 'ies'} replayed against CoinGecko
          SUI/USD daily prices — same <code className="font-mono">evaluate()</code> as the runtime.
          Refreshed hourly. 0.25% per-trade fee assumed.
        </p>
      </div>
      <div className="flex divide-x divide-divider overflow-x-auto">
        {data.strategies.map((s) => {
          const accent =
            s.slug === 'conservative-rebalancer'
              ? 'var(--accent-green)'
              : s.slug === 'balanced-yield'
                ? 'var(--accent-blue)'
                : s.slug.includes('aggressive')
                  ? 'var(--accent-orange)'
                  : 'var(--accent-purple)';
          const winning = !s.error && s.alphaPct >= 0;
          const href = s.strategyId.startsWith('0x')
            ? `/marketplace#${s.strategyId}`
            : `/marketplace#${s.slug}`;

          return (
            <Link
              key={s.strategyId}
              href={href}
              className="group flex min-w-[200px] flex-1 flex-col gap-2 p-5 transition-colors hover:bg-paper"
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: accent }}
                />
                <span className="truncate font-display text-[13px] font-semibold leading-tight">
                  {s.name.replace(/^Synapse /, '')}
                </span>
              </div>
              {s.error ? (
                <span className="font-mono text-[11px] text-ink-mute">Backtest unavailable</span>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="num-display text-4xl"
                      style={{
                        color: winning ? 'var(--state-active)' : 'var(--accent-orange)',
                      }}
                    >
                      {s.totalReturnPct >= 0 ? '+' : ''}
                      {s.totalReturnPct.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                    <span>
                      α {s.alphaPct >= 0 ? '+' : ''}
                      {s.alphaPct.toFixed(2)}%
                    </span>
                    <span>DD −{s.maxDrawdownPct.toFixed(1)}%</span>
                    <span>Sharpe {s.sharpeAnnualized.toFixed(2)}</span>
                    <span>{s.tradesExecuted} trades</span>
                  </div>
                </>
              )}
            </Link>
          );
        })}
      </div>
    </motion.section>
  );
}
