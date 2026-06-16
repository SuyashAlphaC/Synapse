'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSuiClient } from '@mysten/dapp-kit';
import { loadLiveVault, type LiveBalance, type LiveVaultState } from '@/lib/vault-state';
import { fetchPythPricesUsd } from '@/lib/oracle-client';

export interface PricedHolding extends LiveBalance {
  /** USD price per single decimal-adjusted unit. */
  priceUsd: number;
  /** USD value of the entire balance. */
  valueUsd: number;
  /** Display amount (atomic / 10^decimals). */
  displayAmount: number;
}

export interface PricedVaultState extends LiveVaultState {
  /** Sui system epoch at fetch time — used for expiry banners. */
  currentEpoch: bigint;
  /** Session key address SUI balance (gas for ticks). */
  sessionBalanceMist: bigint;
  pricedHoldings: PricedHolding[];
  navUsd: number;
  /** USD price the spend cap is interpreted against. */
  spendCapUsd: number;
  /** ISO timestamp from the most recent successful fetch. */
  asOf: string;
  /** Symbol → USD map actually used for valuation. */
  priceMap: Record<string, number>;
  /** If the oracle call failed, a short message; otherwise null. */
  priceError: string | null;
  /** Symbols the oracle could not price. */
  unpriced: string[];
}

/**
 * Reads live AgentIdentity state + prices its holdings using Pyth Hermes.
 * Re-fetches every 30s by default. Falls back to `null` when no vault is
 * provided.
 *
 * Failure semantics:
 *   - `loadLiveVault` errors → the React Query enters error state, no
 *     stale data is returned.
 *   - The Pyth call failing is NOT fatal: balances still load, NAV degrades
 *     to whatever the stable-peg fallback can recover, and `priceError`
 *     carries the diagnostic.
 *   - Symbols with no oracle coverage AND no peg fallback land in
 *     `unpriced` so the UI can surface a footnote.
 */
export function useLiveVault(
  vaultId: string | null | undefined,
): UseQueryResult<PricedVaultState | null, Error> {
  const client = useSuiClient();
  return useQuery<PricedVaultState | null, Error>({
    queryKey: ['synapse-vault', vaultId],
    queryFn: async ({ signal }) => {
      if (!vaultId) return null;
      const state = await loadLiveVault({ client, vaultId });
      const [systemState, sessionBalance] = await Promise.all([
        client.getLatestSuiSystemState(),
        state.identity.sessionAddr
          ? client
              .getBalance({ owner: state.identity.sessionAddr })
              .then((r) => BigInt(r.totalBalance))
              .catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      const currentEpoch = BigInt(systemState.epoch);
      const symbols = uniqueSymbols(state.balances.map((b) => b.symbol));

      let priceMap: Record<string, number> = {};
      let priceError: string | null = null;
      try {
        priceMap = await fetchPythPricesUsd(symbols, signal);
      } catch (err) {
        priceError = err instanceof Error ? err.message : String(err);
      }

      const stableFallback = stablePegFallback(state.balances, priceMap);
      const prices = { ...stableFallback, ...priceMap };

      const priced = state.balances.map((balance) => {
        const display = Number(balance.amount) / Math.pow(10, balance.decimals);
        const priceUsd = prices[balance.symbol] ?? prices[balance.symbol.toUpperCase()] ?? 0;
        return {
          ...balance,
          displayAmount: display,
          priceUsd,
          valueUsd: display * priceUsd,
        };
      });

      const unpriced = priced
        .filter((p) => p.priceUsd === 0 && p.amount > 0n)
        .map((p) => p.symbol);

      const navUsd = priced.reduce((sum, h) => sum + h.valueUsd, 0);
      const spendCapUsd = inferSpendCapUsd(state.identity.spendPerEpoch, priced);

      return {
        ...state,
        currentEpoch,
        sessionBalanceMist: sessionBalance,
        pricedHoldings: priced,
        navUsd,
        spendCapUsd,
        asOf: new Date().toISOString(),
        priceMap: prices,
        priceError,
        unpriced,
      };
    },
    enabled: !!vaultId,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

function uniqueSymbols(list: readonly string[]): string[] {
  return Array.from(new Set(list.filter(Boolean)));
}

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'DBUSDC']);

function stablePegFallback(
  balances: readonly LiveBalance[],
  oraclePrices: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of balances) {
    const upper = b.symbol.toUpperCase();
    if (STABLE_SYMBOLS.has(upper) && oraclePrices[b.symbol] === undefined) {
      out[b.symbol] = 1;
    }
  }
  return out;
}

/**
 * Pick the largest-USD-value holding as the inferred spend cap denomination.
 * Matches the production runtime's `spendCapUsd` heuristic.
 */
function inferSpendCapUsd(spendPerEpoch: bigint, priced: PricedHolding[]): number {
  if (priced.length === 0) return 0;
  const denom = priced.reduce((best, cur) => (cur.valueUsd > best.valueUsd ? cur : best));
  if (denom.priceUsd <= 0) return 0;
  const scaled = Number(spendPerEpoch) / Math.pow(10, denom.decimals);
  return scaled * denom.priceUsd;
}
