'use client';

import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { loadStrategies, type LiveStrategy } from '@/lib/strategies';

/**
 * Live marketplace catalog. Polls every 30s so newly published strategies
 * show up without a hard refresh, but never spams the RPC during the
 * mint-wizard back-and-forth.
 */
export function useStrategies(): UseQueryResult<LiveStrategy[]> {
  const client = useSuiClient();
  return useQuery({
    queryKey: ['synapse-strategies'],
    queryFn: () => loadStrategies({ client }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
}
