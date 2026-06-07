'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useSuiClient } from '@mysten/dapp-kit';
import type { TimelineEntry } from '@/lib/sample-data';
import { loadLiveTimeline } from '@/lib/live-events';
import { formatUsd, shortenHash, timeAgo } from '@/lib/format';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';

interface AuditTimelineProps {
  /** Read-only sample data used when no live vault is detected. */
  sampleEntries: TimelineEntry[];
  /** When set, the timeline pulls live events from Sui RPC for this vault. */
  liveVaultId?: string;
}

const KIND_META: Record<TimelineEntry['kind'], { label: string; symbol: string }> = {
  agent_minted: { label: 'MINT', symbol: '◆' },
  agent_funded: { label: 'FUND', symbol: '▲' },
  spend: { label: 'SPEND', symbol: '$' },
  artifact_published: { label: 'ARTIFACT', symbol: '◐' },
  cross_agent_read: { label: 'READ', symbol: '⤳' },
  cross_agent_write: { label: 'WRITE', symbol: '⤴' },
  message_sent: { label: 'MSG→', symbol: '→' },
  message_received: { label: '←MSG', symbol: '←' },
  swap: { label: 'SWAP', symbol: '⇄' },
  action_log: { label: 'LOG', symbol: '•' },
  agent_revoked: { label: 'REVOKE', symbol: '✕' },
};

const FILTER_GROUPS: Array<{ id: string; label: string; kinds: TimelineEntry['kind'][] }> = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'execution', label: 'Execution', kinds: ['swap', 'spend'] },
  {
    id: 'memory',
    label: 'Memory & Artifacts',
    kinds: ['artifact_published', 'action_log'],
  },
  {
    id: 'messaging',
    label: 'Coordination',
    kinds: ['cross_agent_read', 'cross_agent_write', 'message_sent', 'message_received'],
  },
  {
    id: 'governance',
    label: 'Governance',
    kinds: ['agent_minted', 'agent_funded', 'agent_revoked'],
  },
];

export function AuditTimeline({ sampleEntries, liveVaultId }: AuditTimelineProps) {
  const suiClient = useSuiClient();
  const toast = useToast();
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Pull live events whenever we have a real vault to track.
  useEffect(() => {
    if (!liveVaultId) {
      setLiveEntries(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadLiveTimeline({ client: suiClient, agentId: liveVaultId, limit: 100 })
      .then((rows) => {
        if (!cancelled) setLiveEntries(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[audit] live load failed', err);
          toast.push({
            variant: 'warn',
            title: 'Could not load on-chain audit history',
            body: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveVaultId, suiClient, toast]);

  const baseEntries = liveEntries ?? sampleEntries;
  const sourceLabel = liveEntries ? 'on-chain' : 'demo';

  const visible = useMemo(() => {
    const group = FILTER_GROUPS.find((g) => g.id === activeFilter);
    if (!group || group.kinds.length === 0) return baseEntries;
    const kindSet = new Set<TimelineEntry['kind']>(group.kinds);
    return baseEntries.filter((e) => kindSet.has(e.kind));
  }, [activeFilter, baseEntries]);

  function onExportCsv() {
    const header = 'timestamp,kind,description,tx_digest,amount_usd';
    const rows = visible.map((e) =>
      [
        new Date(e.timestamp).toISOString(),
        e.kind,
        JSON.stringify(e.description),
        e.txDigest,
        e.amountUsd ?? '',
      ].join(','),
    );
    const csv = [header, ...rows].join('\n');
    downloadFile(`audit-timeline-${sourceLabel}.csv`, csv, 'text/csv');
    toast.push({
      variant: 'success',
      title: `Exported ${visible.length} rows`,
      body: `audit-timeline-${sourceLabel}.csv saved to your downloads.`,
    });
  }

  return (
    <div className="card-flat p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl font-bold">Audit timeline</h3>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>{sourceLabel}</CodeTag> {visible.length} of {baseEntries.length}{' '}
            {loading ? '· loading…' : 'signed actions'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-flat"
            data-variant="ghost"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
          >
            Filter {showFilters ? '▴' : '▾'}
          </button>
          <button className="btn-flat" data-variant="ghost" onClick={onExportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      {showFilters && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-5 flex flex-wrap gap-2 rounded-sm border border-divider bg-paper p-3"
        >
          {FILTER_GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveFilter(g.id)}
              className={`rounded-sm border-2 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition ${
                activeFilter === g.id
                  ? 'border-ink bg-ink text-paper'
                  : 'border-divider bg-paper text-ink-soft hover:border-ink'
              }`}
            >
              {g.label}
            </button>
          ))}
        </motion.div>
      )}

      <ol className="relative space-y-3">
        <span className="absolute left-[1.55rem] top-3 bottom-3 w-px bg-divider" aria-hidden />
        {visible.length === 0 && (
          <li className="rounded-sm border border-dashed border-ink-mute p-6 text-center font-mono text-xs text-ink-mute">
            {loading
              ? 'Loading on-chain events…'
              : baseEntries.length > 0
                ? 'No events match this filter.'
                : liveEntries
                  ? 'No events yet. Fund the vault or run a strategy tick.'
                  : 'No events match this filter.'}
          </li>
        )}
        {visible.map((e, i) => (
          <Entry key={e.id} entry={e} delay={i * 0.04} />
        ))}
      </ol>
    </div>
  );
}

function Entry({ entry, delay }: { entry: TimelineEntry; delay: number }) {
  const meta = KIND_META[entry.kind];
  const [copied, setCopied] = useState(false);

  async function copyTx() {
    try {
      await navigator.clipboard.writeText(entry.txDigest);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* swallow */
    }
  }

  return (
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative grid grid-cols-[3rem_1fr_auto] items-start gap-4 rounded-sm border border-divider bg-paper-strong/60 p-3 transition-colors hover:border-ink/40 hover:bg-paper-strong"
    >
      <div
        className="z-10 mt-0.5 flex h-8 w-8 items-center justify-center rounded-sm border-2 border-ink font-mono text-sm font-bold"
        style={{ backgroundColor: entry.accentColor ?? 'var(--paper)', color: 'var(--ink)' }}
      >
        {meta.symbol}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            {meta.label}
          </span>
          {entry.tokenSymbol && (
            <span className="font-mono text-[10px] text-ink-mute">· {entry.tokenSymbol}</span>
          )}
        </div>
        <p className="mt-0.5 truncate font-display text-sm font-medium text-ink">
          {entry.description}
        </p>
        <p className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-ink-mute">
          <button
            onClick={copyTx}
            className="transition-colors hover:text-ink"
            title="Click to copy transaction digest"
          >
            tx {shortenHash(entry.txDigest)} {copied ? '✓ copied' : ''}
          </button>
          {entry.walrusBlobId && (
            <>
              <span>·</span>
              <span>walrus {shortenHash(entry.walrusBlobId)}</span>
            </>
          )}
        </p>
      </div>

      <div className="whitespace-nowrap text-right">
        {entry.amountUsd !== undefined && (
          <div className="num text-sm font-semibold">{formatUsd(entry.amountUsd)}</div>
        )}
        <div className="font-mono text-[10px] text-ink-mute">{timeAgo(entry.timestamp)}</div>
      </div>
    </motion.li>
  );
}

function downloadFile(name: string, body: string, mime: string) {
  if (typeof window === 'undefined') return;
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
