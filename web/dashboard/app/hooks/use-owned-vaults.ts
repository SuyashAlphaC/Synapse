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
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
