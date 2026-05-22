'use client';

import type { Vault } from '@/lib/sample-data';
import { formatUsd } from '@/lib/format';
import type { PricedHolding, PricedVaultState } from '../../hooks/use-live-vault';

interface HoldingsPanelProps {
  vault: Vault;
  /** Real on-chain priced holdings. When provided, replaces sample rows. */
  live?: PricedVaultState;
  loading?: boolean;
}

const ACCENT_PALETTE = [
  'var(--accent-blue)',
  'var(--accent-green)',
  'var(--accent-purple)',
  'var(--accent-orange)',
  'var(--accent-pink)',
  'var(--accent-yellow)',
];

interface UnifiedHolding {
  symbol: string;
  typeTag: string;
  displayAmount: number;
  priceUsd: number;
  valueUsd: number;
  accent: string;
}

/**
 * Stacked holdings allocation bar + per-asset detail rows. When live data
 * is supplied, every row reflects a real on-chain balance priced via Pyth.
 * Falls back to deterministic sample data otherwise.
 */
export function HoldingsPanel({ vault, live, loading }: HoldingsPanelProps) {
  const holdings: UnifiedHolding[] = live
    ? live.pricedHoldings.map((h, i) => ({
        symbol: h.symbol,
        typeTag: h.coinTypeTag,
        displayAmount: h.displayAmount,
        priceUsd: h.priceUsd,
        valueUsd: h.valueUsd,
        accent: ACCENT_PALETTE[i % ACCENT_PALETTE.length] ?? 'var(--accent-blue)',
      }))
    : vault.holdings.map((h) => ({
        symbol: h.symbol,
        typeTag: h.typeTag,
        displayAmount: h.amount,
        priceUsd: h.priceUsd,
        valueUsd: h.valueUsd,
        accent: h.accentColor,
      }));

  const total = holdings.reduce((s, h) => s + h.valueUsd, 0);
  const dataMode: 'live' | 'demo' = live ? 'live' : 'demo';
  const first = holdings[0];
  const driftPct = first && total > 0 ? Math.abs(0.5 - first.valueUsd / total) * 100 : 0;

  return (
    <div className="card-flat p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h3 className="font-display text-2xl font-bold">Holdings</h3>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
            Target 50 / 50 · Drift {driftPct.toFixed(2)}% · {dataMode}
            {loading ? ' · refreshing' : ''}
          </p>
        </div>
        <span className="font-serif italic text-ink-mute">{dataMode}</span>
      </div>

      {live?.unpriced && live.unpriced.length > 0 && (
        <div
          className="mb-4 rounded-sm border-2 border-accent-orange bg-paper-strong p-3 font-mono text-[11px] text-ink-soft"
        >
          <span className="font-semibold text-accent-orange">Price oracle unavailable</span>
          {' '}&mdash; {live.unpriced.join(', ')} showing as $0.
          Balances are correct; USD values will update when the oracle recovers.
          {live.priceError && (
            <span className="ml-1 text-ink-mute">({live.priceError})</span>
          )}
        </div>
      )}

      {holdings.length === 0 ? (
        <p className="rounded-sm border border-dashed border-ink-mute p-6 text-center font-mono text-xs text-ink-mute">
          Treasury is empty. Fund the vault to see holdings here.
        </p>
      ) : (
        <>
          {/* Stacked bar */}
          <div className="mb-6 flex h-12 overflow-hidden rounded-sm border-2 border-ink">
            {holdings.map((h) => (
              <div
                key={h.symbol + h.typeTag}
                className="relative flex items-center justify-center transition-all duration-500"
                style={{
                  width: `${total > 0 ? (h.valueUsd / total) * 100 : 100 / holdings.length}%`,
                  backgroundColor: h.accent,
                }}
              >
                <span className="font-display text-xs font-bold text-ink">{h.symbol}</span>
                <span className="absolute -bottom-5 left-2 font-mono text-[10px] text-ink-mute">
                  {total > 0 ? ((h.valueUsd / total) * 100).toFixed(1) : '—'}%
                </span>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-4">
            {holdings.map((h) => (
              <HoldingRow key={h.symbol + h.typeTag} holding={h} mode={dataMode} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function HoldingRow({ holding, mode }: { holding: UnifiedHolding; mode: 'live' | 'demo' }) {
  return (
    <div className="grid grid-cols-[40px_1fr_auto_auto] items-center gap-4 border-b border-divider pb-4 last:border-0">
      <div
        className="flex h-10 w-10 items-center justify-center rounded-sm border-2 border-ink"
        style={{ backgroundColor: holding.accent }}
      >
        <span className="font-display text-sm font-extrabold text-ink">{holding.symbol[0]}</span>
      </div>
      <div>
        <div className="font-display font-semibold">{holding.symbol}</div>
        <div className="font-mono text-[10px] text-ink-mute">
          {holding.typeTag.length > 28 ? `${holding.typeTag.slice(0, 22)}…` : holding.typeTag}
        </div>
      </div>
      <div className="text-right">
        <div className="num text-sm">
          {holding.displayAmount.toLocaleString('en-US', { maximumFractionDigits: 6 })}
        </div>
        <div className="font-mono text-[10px] text-ink-mute">
          @ {formatUsd(holding.priceUsd, { fine: true })}
        </div>
      </div>
      <div className="text-right">
        <div className="num font-semibold">{formatUsd(holding.valueUsd)}</div>
        <div className="font-mono text-[10px] text-state-active">
          {mode === 'live' ? '● on-chain' : '● demo'}
        </div>
      </div>
    </div>
  );
}
