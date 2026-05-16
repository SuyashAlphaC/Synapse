'use client';

import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { loadOwnedVaults, type OwnedVault } from '@/lib/owned-vaults';

export function useOwnedVaults(): UseQueryResult<OwnedVault[]> {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const owner = account?.address ?? null;
  return useQuery({
    queryKey: ['synapse-owned-vaults', owner],
    queryFn: () => (owner ? loadOwnedVaults({ client, owner }) : Promise.resolve([])),
    enabled: owner !== null,
    // Always refetch when the dashboard mounts so a fresh navigation
    // immediately after a mint surfaces the new vault. Also poll every
    // 20s as a safety net for tabs that stay open across mints.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}
