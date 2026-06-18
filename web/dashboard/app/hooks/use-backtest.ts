'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  loadBacktest,
  loadBacktestIndex,
  type BacktestIndex,
  type BacktestSummary,
} from '@/lib/backtests';

/** Live CoinGecko replay — refreshed hourly via `/api/backtests`. */
export function useBacktestIndex(): UseQueryResult<BacktestIndex | null> {
  return useQuery({
    queryKey: ['synapse-backtest-index'],
    queryFn: () => loadBacktestIndex(),
    staleTime: 15 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useBacktest(strategyId: string | null): UseQueryResult<BacktestSummary | null> {
  return useQuery({
    queryKey: ['synapse-backtest', strategyId],
    queryFn: () => (strategyId ? loadBacktest(strategyId) : Promise.resolve(null)),
    enabled: strategyId !== null,
    staleTime: 15 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}
