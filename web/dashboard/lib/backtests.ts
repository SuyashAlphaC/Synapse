/**
 * Backtest data loader — live API first, static JSON fallback for offline dev.
 */

export type {
  BacktestPoint,
  BacktestSummary,
  BacktestIndex,
  BacktestIndexEntry,
} from './backtest-engine';

export { slugFromStrategyName as backtestSlugForStrategy } from './backtest-engine';

export async function loadBacktestIndex(): Promise<import('./backtest-engine').BacktestIndex | null> {
  try {
    const res = await fetch('/api/backtests', { cache: 'no-store' });
    if (res.ok) {
      return (await res.json()) as import('./backtest-engine').BacktestIndex;
    }
  } catch {
    /* fall through */
  }
  const res = await fetch('/backtests/index.json', { cache: 'no-store' });
  if (!res.ok) return null;
  const legacy = (await res.json()) as LegacyIndex;
  return migrateLegacyIndex(legacy);
}

export async function loadBacktest(
  strategyId: string,
): Promise<import('./backtest-engine').BacktestSummary | null> {
  try {
    const res = await fetch(`/api/backtests/${strategyId}`, { cache: 'no-store' });
    if (res.ok) {
      return (await res.json()) as import('./backtest-engine').BacktestSummary;
    }
  } catch {
    /* fall through */
  }
  const slug = strategyId.includes('-') ? strategyId : null;
  if (!slug) return null;
  const res = await fetch(`/backtests/${slug}.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  const summary = (await res.json()) as import('./backtest-engine').BacktestSummary;
  return { ...summary, strategyId: summary.strategyId || strategyId };
}

interface LegacyIndex {
  generatedAt: string;
  startDate: string;
  endDate: string;
  strategies: Array<{
    slug: string;
    name: string;
    totalReturnPct: number;
    benchmarkReturnPct: number;
    alphaPct: number;
    maxDrawdownPct: number;
    sharpeAnnualized: number;
    tradesExecuted: number;
  }>;
}

function migrateLegacyIndex(legacy: LegacyIndex): import('./backtest-engine').BacktestIndex {
  return {
    generatedAt: legacy.generatedAt,
    startDate: legacy.startDate,
    endDate: legacy.endDate,
    priceSource: 'coingecko',
    strategies: legacy.strategies.map((s) => ({
      strategyId: s.slug,
      slug: s.slug,
      name: s.name,
      totalReturnPct: s.totalReturnPct,
      benchmarkReturnPct: s.benchmarkReturnPct,
      alphaPct: s.alphaPct,
      maxDrawdownPct: s.maxDrawdownPct,
      sharpeAnnualized: s.sharpeAnnualized,
      tradesExecuted: s.tradesExecuted,
    })),
  };
}
