'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useStrategies } from '../../hooks/use-strategies';
import {
  alphaSummary,
  RISK_LABEL,
  type LiveStrategy,
  type RiskProfile,
} from '@/lib/strategies';
import { CodeTag } from '../ui/code-tag';
import { explorerAddressUrl, explorerObjectUrl } from '@/lib/synapse-config';
import { shortenAddress, shortenHash } from '@/lib/format';

type RiskFilter = 'all' | RiskProfile;
type StatusFilter = 'all' | 'active' | 'deprecated';
type SortKey = 'recent' | 'aum' | 'vaults' | 'alpha';

export function MarketplaceBrowser() {
  const query = useStrategies();
  const strategies = query.data ?? [];

  const [risk, setRisk] = useState<RiskFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sort, setSort] = useState<SortKey>('aum');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return strategies
      .filter((s) => (risk === 'all' ? true : s.riskProfile === risk))
      .filter((s) => {
        if (status === 'all') return true;
        if (status === 'active') return s.active;
        return !s.active;
      })
      .filter((s) =>
        search.trim().length === 0
          ? true
          : s.name.toLowerCase().includes(search.toLowerCase()) ||
            s.description.toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => {
        if (sort === 'recent') return Number(b.publishedAtEpoch) - Number(a.publishedAtEpoch);
        if (sort === 'aum') return Number(b.totalAumCommitted - a.totalAumCommitted);
        if (sort === 'vaults') return Number(b.vaultCount - a.vaultCount);
        // alpha
        const aNet = a.cumulativeAlphaBpsPos - a.cumulativeAlphaBpsNeg;
        const bNet = b.cumulativeAlphaBpsPos - b.cumulativeAlphaBpsNeg;
        return Number(bNet - aNet);
      });
  }, [strategies, risk, status, sort, search]);

  return (
    <>
      <div className="card-flat mb-6 flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <input
          type="search"
          placeholder="Search strategies…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Selector
            label="risk"
            value={risk}
            onChange={(v) => setRisk(v as RiskFilter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 0, label: 'Conservative' },
              { value: 1, label: 'Balanced' },
              { value: 2, label: 'Aggressive' },
            ]}
          />
          <Selector
            label="status"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'deprecated', label: 'Deprecated' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Selector
            label="sort"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={[
              { value: 'aum', label: 'AUM' },
              { value: 'vaults', label: 'Vaults' },
              { value: 'alpha', label: 'Alpha' },
              { value: 'recent', label: 'Recent' },
            ]}
          />
          <Link href="/marketplace/publish" className="btn-flat" data-variant="accent">
            <span>Publish strategy →</span>
          </Link>
        </div>
      </div>

      {query.isLoading && (
        <p className="font-mono text-sm text-ink-mute">Loading marketplace…</p>
      )}
      {!query.isLoading && filtered.length === 0 && (
        <div className="card-flat p-8 text-center">
          <p className="font-display text-xl font-semibold">No strategies match these filters</p>
          <p className="mt-2 text-sm text-ink-soft">
            Try clearing search or relaxing the risk filter.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((s) => (
          <StrategyCard key={s.id} strategy={s} />
        ))}
      </div>
    </>
  );
}

function Selector<T extends string | number>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
      {label}
      <select
        className="rounded-sm border border-divider bg-paper-strong px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-ink"
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StrategyCard({ strategy }: { strategy: LiveStrategy }) {
  const alpha = alphaSummary(strategy);
  const accent =
    strategy.riskProfile === 0
      ? 'var(--accent-green)'
      : strategy.riskProfile === 1
        ? 'var(--accent-blue)'
        : 'var(--accent-orange)';
  return (
    <motion.article
      layout
      className="card-flat relative flex flex-col gap-4 overflow-hidden p-5"
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>strategy</CodeTag> v{strategy.version.toString()}
          </p>
          <h3 className="mt-2 font-display text-xl font-bold leading-tight">{strategy.name}</h3>
        </div>
        <span
          className="rounded-full border border-ink/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ backgroundColor: accent }}
        >
          {RISK_LABEL[strategy.riskProfile]}
        </span>
      </header>

      <p className="line-clamp-3 text-sm leading-relaxed text-ink-soft">{strategy.description}</p>

      <dl className="grid grid-cols-3 gap-2 border-t border-divider pt-3 text-[11px]">
        <Stat label="vaults" value={`${strategy.activeVaultCount}/${strategy.vaultCount}`} />
        <Stat
          label="royalty"
          value={`${(strategy.royaltyBps / 100).toFixed(1)}%`}
        />
        <Stat
          label="net α"
          value={
            alpha.ticks === 0n
              ? '—'
              : `${alpha.netBps >= 0n ? '+' : ''}${alpha.netBps.toString()}bps`
          }
        />
      </dl>

      <footer className="flex items-center justify-between border-t border-divider pt-3 font-mono text-[11px] text-ink-mute">
        <a
          href={explorerAddressUrl(strategy.strategist)}
          target="_blank"
          rel="noreferrer"
          className="hover:text-ink"
        >
          by {shortenAddress(strategy.strategist)}
        </a>
        <div className="flex items-center gap-3">
          <a
            href={explorerObjectUrl(strategy.id)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink"
          >
            {shortenHash(strategy.id)} ↗
          </a>
          <Link
            href={`/mint?strategy=${strategy.id}`}
            className="font-display text-[11px] text-accent-orange hover:underline"
          >
            hire →
          </Link>
        </div>
      </footer>

      {!strategy.active && (
        <span className="absolute right-3 top-3 rounded-sm border border-accent-orange bg-paper px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-accent-orange">
          deprecated
        </span>
      )}
    </motion.article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">{label}</p>
      <p className="font-display text-sm font-semibold">{value}</p>
    </div>
  );
}
