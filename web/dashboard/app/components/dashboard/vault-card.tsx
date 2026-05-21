'use client';

import type { Vault } from '@/lib/sample-data';
import { formatUsd, shortenAddress, timeAgo } from '@/lib/format';
import { vaultDisplayName } from '@/lib/vault-identity';
import { AnimatedNumber } from '../ui/animated-number';
import { Sparkline } from './sparkline';
import { CodeTag } from '../ui/code-tag';
import type { PricedVaultState } from '../../hooks/use-live-vault';
import type { NavHistory } from '../../hooks/use-live-nav-history';
import type { LiveStrategy } from '@/lib/strategies';

interface VaultCardProps {
  vault: Vault;
  /** Sample history shown only when no live vault is detected. */
  sampleHistory: number[];
  /** Real on-chain state, when available. Overrides matching sample fields. */
  live?: PricedVaultState;
  /**
   * Real vault ID (object address). Used to derive a stable display name
   * since vaults carry no on-chain name field.
   */
  liveVaultId?: string;
  /** Real hired strategy resolved from the on-chain `strategy_id`. */
  liveStrategy?: Pick<LiveStrategy, 'name' | 'version'> | null;
  /** Real NAV history series. Falls back to `sampleHistory` if absent. */
  liveHistory?: NavHistory | null;
  loading?: boolean;
}

/**
 * Top-of-dashboard hero card. NAV, 24h change, sparkline, and labels are
 * all live-data-first; sample fields render only when no real vault has
 * been detected for the connected wallet.
 */
export function VaultCard({
  vault,
  sampleHistory,
  live,
  liveVaultId,
  liveStrategy,
  liveHistory,
  loading,
}: VaultCardProps) {
  const navUsd = live?.navUsd ?? vault.navUsd;
  const ownerDisplay = live ? live.identity.owner : vault.owner;
  const sessionDisplay = live ? live.identity.sessionAddr : vault.sessionAddr;
  const expiryDisplay = live ? live.identity.expiryEpoch.toString() : vault.expiryEpoch.toString();
  const aumFeeUsdYear = (navUsd * vault.managementFeeBps) / 10_000;
  const dataMode: 'live' | 'demo' = live ? 'live' : 'demo';

  // Display name: derive a stable label from the real vault ID (no
  // on-chain name field exists) when live; otherwise the sample label.
  const displayName = live && liveVaultId ? vaultDisplayName(liveVaultId) : vault.name;

  // Strategy label: real published name + version when resolved → short
  // strategy ID when live but the strategy object isn't loaded yet →
  // sample label only in demo mode.
  const strategyLabel = liveStrategy
    ? `${liveStrategy.name} v${liveStrategy.version.toString()}`
    : live
      ? `Strategy ${shortenAddress(live.identity.strategyId)}`
      : `${vault.strategyName} v${vault.strategyVersion}`;

  // Inception: the oldest replayed event timestamp is the mint; fall back
  // to the sample inception only in demo mode.
  const firstEventT = liveHistory?.series[0]?.t;
  const inceptionDisplay =
    live && firstEventT !== undefined ? timeAgo(firstEventT) : timeAgo(vault.inceptionTs);

  // 24h change: prefer the real one when we have it; fall back to sample
  // only when not live. Honest "—" when live but no comparison point exists.
  const change24h = pickChange24h({ live, liveHistory, vault });

  // Sparkline data: real series → numeric history → sample.
  const sparklineData =
    liveHistory && liveHistory.series.length > 0
      ? liveHistory.series.map((p) => p.navUsd)
      : sampleHistory;

  const sparklineCount = liveHistory ? liveHistory.series.length : sampleHistory.length;
  const sparklineLabel = liveHistory
    ? sparklineCount <= 1
      ? 'NAV — awaiting strategy ticks'
      : `NAV — ${liveHistory.meaningfulEventCount} ${pluralize('event', liveHistory.meaningfulEventCount)}`
    : `NAV — ${sampleCount(sampleHistory)} epochs`;

  const growthDisplay: string = liveHistory
    ? liveHistory.series.length <= 1
      ? '—'
      : liveHistory.growthPct === null
        ? 'from nil'
        : `${liveHistory.growthPct >= 0 ? '↑' : '↓'} ${Math.abs(liveHistory.growthPct * 100).toFixed(2)}%`
    : '↑ 10.97%';

  return (
    <div className="card-flat relative overflow-hidden">
      <div className="absolute right-0 top-0 h-full w-1/3 crosshatch opacity-30" />

      <div className="relative grid gap-8 p-8 md:grid-cols-[1.4fr_1fr] md:p-10">
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span
              className="pill"
              data-state={live ? (live.identity.revoked ? 'revoked' : 'active') : vault.status}
            >
              <span className="live-dot" />{' '}
              {live ? (live.identity.revoked ? 'revoked' : 'active') : vault.status}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
              {strategyLabel}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              <CodeTag>{dataMode}</CodeTag>
              {loading ? ' · refreshing…' : null}
            </span>
          </div>

          <h2 className="headline text-5xl md:text-6xl">
            {displayName}
            <span className="text-accent-orange">.</span>
          </h2>

          <div className="flex items-end gap-6">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
                Net asset value
              </p>
              <AnimatedNumber
                value={navUsd}
                format={formatUsd}
                className="num-display mt-1 inline-block text-5xl"
              />
            </div>
            <div className="pb-2">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
                24h change
              </p>
              <p
                className="num mt-1 text-xl font-semibold"
                style={{
                  color:
                    change24h.usd === null
                      ? 'var(--ink-mute)'
                      : change24h.usd >= 0
                        ? 'var(--state-active)'
                        : 'var(--state-revoked)',
                }}
              >
                {change24h.label}
              </p>
            </div>
          </div>

          {live && (live.priceError || live.unpriced.length > 0) && (
            <p className="rounded-sm border-l-2 border-state-expired bg-paper p-2 font-mono text-[10px] text-ink-soft">
              {live.priceError ? (
                <>oracle error: {live.priceError}</>
              ) : (
                <>
                  oracle has no feed for {live.unpriced.join(', ')} — value reported is the priced
                  subset only
                </>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <Detail label="Owner" value={shortenAddress(ownerDisplay)} />
            <Detail label="Session" value={shortenAddress(sessionDisplay)} />
            <Detail label="Inception" value={inceptionDisplay} />
            <Detail label="Expires at epoch" value={expiryDisplay} />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4">
          <div className="card-bare flex flex-col gap-2 p-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
              <CodeTag>fees</CodeTag>
            </span>
            <FeeRow
              label="Management"
              accent="var(--accent-blue)"
              value={`${vault.managementFeeBps / 100}%/yr`}
              hint={`${formatUsd(aumFeeUsdYear)} / yr at current NAV`}
            />
            <FeeRow
              label="Performance"
              accent="var(--accent-orange)"
              value={`${vault.performanceFeeBps / 100}%`}
              hint="of realised alpha vs benchmark"
            />
          </div>

          <div className="card-bare p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
                {sparklineLabel}
              </span>
              <span
                className="font-mono text-[11px]"
                style={{
                  color: growthDisplay.startsWith('↑')
                    ? 'var(--state-active)'
                    : growthDisplay.startsWith('↓')
                      ? 'var(--state-revoked)'
                      : growthDisplay === 'from nil'
                        ? 'var(--accent-blue)'
                        : 'var(--ink-mute)',
                }}
              >
                {growthDisplay}
              </span>
            </div>
            {sparklineData.length >= 2 ? (
              <Sparkline data={sparklineData} width={320} height={70} />
            ) : (
              <div className="flex h-[70px] items-center justify-center font-mono text-[11px] text-ink-mute">
                {live
                  ? 'awaiting strategy ticks · history fills here'
                  : 'history will appear once events land'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function pickChange24h({
  live,
  liveHistory,
  vault,
}: {
  live: PricedVaultState | undefined;
  liveHistory: NavHistory | null | undefined;
  vault: Vault;
}): { usd: number | null; label: string } {
  if (live && liveHistory) {
    if (liveHistory.change24hUsd === null) {
      return { usd: null, label: '— · need 24h history' };
    }
    const usd = liveHistory.change24hUsd;
    const pct = liveHistory.change24hPct ?? 0;
    const sign = usd >= 0 ? '+' : '';
    return {
      usd,
      label: `${sign}${formatUsd(usd)} (${sign}${(pct * 100).toFixed(2)}%)`,
    };
  }
  // Sample only.
  const positive = vault.pnl24hUsd >= 0;
  return {
    usd: vault.pnl24hUsd,
    label: `${positive ? '+' : ''}${formatUsd(vault.pnl24hUsd)} (${positive ? '+' : ''}${(vault.pnl24hPct * 100).toFixed(2)}%)`,
  };
}

function sampleCount(history: readonly number[]): number {
  return history.length;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-mono uppercase tracking-[0.18em] text-ink-mute">{label}</span>
      <span className="font-mono text-ink">{value}</span>
    </span>
  );
}

function FeeRow({
  label,
  accent,
  value,
  hint,
}: {
  label: string;
  accent: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: accent }} />
        <span className="font-display text-sm font-semibold text-ink">{label}</span>
      </div>
      <div className="text-right">
        <div className="num font-semibold text-ink">{value}</div>
        <div className="text-[10px] text-ink-mute">{hint}</div>
      </div>
    </div>
  );
}
