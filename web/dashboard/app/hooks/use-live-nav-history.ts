'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSuiClient } from '@mysten/dapp-kit';
import { loadLiveTimeline } from '@/lib/live-events';
import type { TimelineEntry } from '@/lib/sample-data';
import type { PricedVaultState } from './use-live-vault';

export interface NavSeriesPoint {
  /** Wall-clock timestamp (epoch ms) of the event. */
  t: number;
  /** Cumulative NAV in USD at this point, valued at CURRENT prices. */
  navUsd: number;
}

export interface NavHistory {
  /** Sorted oldest → newest. */
  series: NavSeriesPoint[];
  /** Number of real on-chain events that moved the balance. */
  meaningfulEventCount: number;
  /**
   * Growth from first → last point, as a fraction (e.g. `0.0697` = +6.97%).
   * `null` when the first point is zero — "growth from nil" is undefined
   * and the UI surfaces a distinct label rather than misleading "0.00%".
   */
  growthPct: number | null;
  /** 24-hour change in USD, or null if we don't have a comparison point. */
  change24hUsd: number | null;
  change24hPct: number | null;
  /** The current NAV (== last point). */
  navUsd: number;
}

/**
 * Replays on-chain `agent_minted` / `agent_funded` / `spend` / `swap` events
 * into a NAV time series, valued using the CURRENT Pyth prices. This is a
 * deliberate choice: historical prices would require an oracle TWAP we
 * haven't wired yet, and the most useful chart for a treasury operator is
 * "how has the balance evolved" — not "how has the market moved."
 *
 * Empty / single-point histories are honest: we don't fake a curve. Callers
 * should render flat lines when `series.length < 2`.
 */
export function useLiveNavHistory(
  vaultId: string | null | undefined,
  priced: PricedVaultState | null,
): UseQueryResult<NavHistory | null, Error> {
  const client = useSuiClient();
  return useQuery<NavHistory | null, Error>({
    queryKey: ['synapse-nav-history', vaultId, priced?.asOf ?? ''],
    queryFn: async () => {
      if (!vaultId || !priced) return null;

      const timeline = await loadLiveTimeline({ client, agentId: vaultId, limit: 500 });
      const events = orderOldestFirst(timeline);
      const series = replayEvents(events, priced);

      const navUsd = series.length === 0 ? priced.navUsd : (series.at(-1)?.navUsd ?? priced.navUsd);
      const first = series[0]?.navUsd ?? navUsd;
      // NAV is valued at current prices, so its change over the window is
      // driven by DEPOSITS, not market performance (swaps are neutral). A
      // large first→last change therefore means the treasury was built up
      // from near-nothing during the window → report "from nil" rather than
      // a misleading four-digit "growth". Only when the vault was already
      // funded across the whole window (first ≈ last) is the residual a
      // meaningful ~flat return.
      const builtFromNil = first <= 0 || first < navUsd * 0.5;
      const growthPct: number | null = builtFromNil ? null : (navUsd - first) / first;

      const nowMs = Date.now();
      const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
      let baseline24h: number | null = null;
      for (const point of series) {
        if (point.t <= dayAgoMs) baseline24h = point.navUsd;
        else break;
      }
      // If the entire history is younger than 24h, we don't have a fair
      // comparison point — leave change24h null rather than misreport.
      const change24hUsd = baseline24h === null ? null : navUsd - baseline24h;
      const change24hPct =
        baseline24h === null || baseline24h === 0 ? null : (navUsd - baseline24h) / baseline24h;

      return {
        series,
        meaningfulEventCount: events.filter(isBalanceMoving).length,
        growthPct,
        change24hUsd,
        change24hPct,
        navUsd,
      };
    },
    enabled: !!vaultId && !!priced,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function orderOldestFirst(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return [...timeline].sort((a, b) => a.timestamp - b.timestamp);
}

function isBalanceMoving(e: TimelineEntry): boolean {
  return (
    e.kind === 'agent_minted' ||
    e.kind === 'agent_funded' ||
    e.kind === 'spend' ||
    e.kind === 'swap'
  );
}

/**
 * Per-symbol decimal fallbacks for tokens that appear in historical
 * funding events but may not be in the CURRENT holdings (so their decimals
 * can't be read off `pricedHoldings`).
 */
const KNOWN_DECIMALS: Record<string, number> = {
  SUI: 9,
  USDC: 6,
  DBUSDC: 6,
  USDT: 6,
  WAL: 9,
};

/** Stablecoin USD price fallbacks for symbols missing from the oracle set. */
const STABLE_USD: Record<string, number> = { USDC: 1, DBUSDC: 1, USDT: 1 };

/**
 * Build the running NAV series.
 *
 * Key modeling choice: valued at CURRENT prices, total NAV only changes
 * when value enters or leaves the treasury EXTERNALLY — i.e. on deposits
 * (`agent_funded`). Internal trading is NAV-neutral: a DeepBook swap trades
 * $X of one coin for ~$X of another, and the `SpendEvent` that feeds the
 * swap is the swap's input leg, NOT an external outflow. Counting those
 * spends would double-penalize (we'd subtract the input without crediting
 * the swap output). So the curve steps at deposits and stays flat through
 * all the trading/noop ticks in between — which is the honest picture of a
 * treasury's value over time.
 *
 * We RECONCILE against the real current NAV rather than replaying from an
 * assumed-empty start: starting NAV = current − Σ(deposits in USD). Any
 * value not explained by a deposit event (e.g. a direct coin transfer)
 * lands in the starting NAV, so the curve shows "held since inception"
 * instead of a spurious 0 → vertical-spike.
 */
function replayEvents(events: readonly TimelineEntry[], priced: PricedVaultState): NavSeriesPoint[] {
  const priceBySymbol: Record<string, number> = {};
  const decimalsBySymbol: Record<string, number> = {};
  for (const h of priced.pricedHoldings) {
    const sym = h.symbol.toUpperCase();
    priceBySymbol[sym] = h.priceUsd;
    decimalsBySymbol[sym] = h.decimals;
  }

  const flowUsd = (event: TimelineEntry): number =>
    externalFlowUsd(event, decimalsBySymbol, priceBySymbol);

  const totalFlow = events.reduce((sum, event) => sum + flowUsd(event), 0);
  let nav = priced.navUsd - totalFlow; // pre-history starting NAV

  const out: NavSeriesPoint[] = [];
  for (const event of events) {
    nav += flowUsd(event);
    // Clamp: small negatives are reconciliation noise (swap fees/slippage,
    // price drift since the deposit). NAV is never truly negative.
    out.push({ t: event.timestamp, navUsd: Math.max(0, nav) });
  }

  // Anchor the final point to the exact current NAV so the sparkline
  // endpoint matches the headline number precisely.
  const last = out.at(-1);
  if (last) last.navUsd = priced.navUsd;
  return out;
}

/**
 * USD value an event moves into (+) or out of (−) the treasury externally.
 * Only `agent_funded` deposits count; swaps and the spends that feed them
 * are NAV-neutral at current prices (see `replayEvents`). Returns 0 for
 * anything else.
 */
function externalFlowUsd(
  event: TimelineEntry,
  decimalsBySymbol: Record<string, number>,
  priceBySymbol: Record<string, number>,
): number {
  if (event.kind !== 'agent_funded') return 0;
  if (event.amount === undefined || !event.tokenSymbol) return 0;
  const symbol = event.tokenSymbol.toUpperCase();
  const decimals = decimalsBySymbol[symbol] ?? KNOWN_DECIMALS[symbol] ?? 9;
  const price = priceBySymbol[symbol] ?? STABLE_USD[symbol] ?? 0;
  return (event.amount / Math.pow(10, decimals)) * price;
}
