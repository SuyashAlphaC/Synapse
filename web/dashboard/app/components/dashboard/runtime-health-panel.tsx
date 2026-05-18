'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import { CodeTag } from '../ui/code-tag';
import { SYNAPSE_PACKAGE_ID, SYNAPSE_PACKAGE_HISTORY, explorerTxUrl } from '@/lib/synapse-config';
import { shortenHash, timeAgo } from '@/lib/format';

interface RuntimeHealthPanelProps {
  vaultId: string;
}

interface LatestTick {
  timestampMs: number;
  digest: string;
  alphaBpsPos: number;
  alphaBpsNeg: number;
  epoch: bigint;
}

/**
 * Reads the most-recent `TickRecordedEvent` for the vault and reports the
 * autonomous runtime's apparent health.
 *
 * Buckets (configurable):
 *   - online   = last tick ≤ 15 minutes ago
 *   - stalled  = last tick 15–60 minutes ago (one cycle missed, maybe more)
 *   - offline  = last tick > 60 minutes ago, or no ticks ever recorded
 *
 * The panel polls every 30s and ticks the "time since last" display every
 * second so the status feels live without thrashing the RPC.
 */
export function RuntimeHealthPanel({ vaultId }: RuntimeHealthPanelProps) {
  const client = useSuiClient();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const query = useQuery({
    queryKey: ['synapse-latest-tick', vaultId],
    staleTime: 0,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<LatestTick | null> => {
      // TickRecordedEvent's on-chain type tag is namespaced by the
      // package that *first defined* it (v1 strategy_registry). A
      // query for the latest package's type returns zero — same
      // multi-version trap loadStrategies/loadOwnedVaults already
      // handle. Walk every historical package; keep the newest hit.
      const packages =
        SYNAPSE_PACKAGE_HISTORY.length > 0 ? SYNAPSE_PACKAGE_HISTORY : [SYNAPSE_PACKAGE_ID];
      let best: LatestTick | null = null;

      for (const pkg of packages) {
        const eventType = `${pkg}::strategy_registry::TickRecordedEvent`;
        let cursor: { txDigest: string; eventSeq: string } | null = null;
        try {
          for (let pageIdx = 0; pageIdx < 6; pageIdx++) {
            const page = await client.queryEvents({
              query: { MoveEventType: eventType },
              cursor,
              order: 'descending',
              limit: 50,
            });
            for (const ev of page.data) {
              const parsed = ev.parsedJson as
                | {
                    vault_id?: string;
                    alpha_bps_pos?: string | number;
                    alpha_bps_neg?: string | number;
                    epoch?: string | number;
                  }
                | undefined;
              if (parsed?.vault_id !== vaultId) continue;
              const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
              if (best === null || ts > best.timestampMs) {
                best = {
                  timestampMs: ts,
                  digest: ev.id.txDigest,
                  alphaBpsPos: Number(parsed?.alpha_bps_pos ?? 0),
                  alphaBpsNeg: Number(parsed?.alpha_bps_neg ?? 0),
                  epoch: BigInt(parsed?.epoch ?? 0),
                };
              }
              // First (newest) match in this package version is
              // enough — pages were descending, no later event in
              // this package can be newer.
              break;
            }
            if (page.data.length === 0 || !page.hasNextPage || !page.nextCursor) break;
            cursor = page.nextCursor;
          }
        } catch {
          // Skip packages the indexer hasn't backfilled or that
          // never emitted this event type.
        }
      }
      return best;
    },
  });

  const latest = query.data ?? null;
  const minutesSince = useMemo(() => {
    if (!latest || latest.timestampMs === 0) return null;
    return Math.max(0, Math.floor((nowMs - latest.timestampMs) / 60_000));
  }, [latest, nowMs]);

  const status = computeStatus(minutesSince);

  return (
    <div
      className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-5 shadow-[2px_2px_0_0_var(--ink)]"
    >
      <div
        className="absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: status.accent }}
      />
      <div className="grid gap-1 sm:flex sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center gap-3">
          <StatusDot color={status.dot} pulsing={status.kind === 'online'} />
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              <CodeTag>runtime</CodeTag>
            </p>
            <p className="mt-0.5 font-display text-base font-semibold text-ink">
              {status.label}
            </p>
            <p className="font-mono text-[11px] text-ink-mute">
              {latest && minutesSince !== null
                ? `last tick ${formatMinutes(minutesSince)} ago · ${
                    latest.alphaBpsPos > 0
                      ? `+${latest.alphaBpsPos}bps`
                      : latest.alphaBpsNeg > 0
                        ? `-${latest.alphaBpsNeg}bps`
                        : 'flat'
                  } · ${shortenHash(latest.digest)}`
                : query.isLoading
                  ? 'querying TickRecordedEvent…'
                  : 'no ticks recorded yet — runtime not started or never ticked this vault'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latest && (
            <a
              href={explorerTxUrl(latest.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-accent-blue hover:underline"
            >
              tx ↗
            </a>
          )}
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="font-mono text-[11px] text-ink-soft hover:text-ink disabled:opacity-50"
          >
            {query.isFetching ? 'refreshing…' : 'refresh'}
          </button>
        </div>
      </div>

      {status.kind !== 'online' && (
        <p
          className="mt-3 rounded-sm border-l-2 bg-paper p-3 font-mono text-[11px] text-ink-soft"
          style={{ borderColor: status.accent }}
        >
          {status.hint}
        </p>
      )}
    </div>
  );
}

type StatusKind = 'online' | 'stalled' | 'offline';

function computeStatus(minutesSince: number | null): {
  kind: StatusKind;
  label: string;
  hint: string;
  accent: string;
  dot: string;
} {
  if (minutesSince === null) {
    return {
      kind: 'offline',
      label: 'Agent offline · no ticks',
      hint: 'Deploy the runtime (locally or to AWS via infrastructure/aws) and fund the session key — the autonomous loop will start emitting TickRecordedEvent automatically.',
      accent: 'var(--accent-orange)',
      dot: 'var(--accent-orange)',
    };
  }
  if (minutesSince <= 15) {
    return {
      kind: 'online',
      label: `Agent online · ticking on schedule`,
      hint: '',
      accent: 'var(--state-active)',
      dot: 'var(--state-active)',
    };
  }
  if (minutesSince <= 60) {
    return {
      kind: 'stalled',
      label: `Agent stalled · ${minutesSince}m since last tick`,
      hint: 'The runtime missed at least one expected cycle. Check the Fargate task logs in CloudWatch (or your local terminal) for errors.',
      accent: 'var(--accent-yellow)',
      dot: 'var(--accent-yellow)',
    };
  }
  return {
    kind: 'offline',
    label: `Agent offline · ${minutesSince}m since last tick`,
    hint: 'The runtime has not ticked in over an hour. It is likely stopped or crashed. Restart your runtime container or check CloudWatch for the cause.',
    accent: 'var(--accent-orange)',
    dot: 'var(--accent-orange)',
  };
}

function StatusDot({ color, pulsing }: { color: string; pulsing: boolean }) {
  return (
    <span className="relative inline-block h-3 w-3 rounded-full" style={{ backgroundColor: color }}>
      {pulsing && (
        <span
          className="absolute inset-0 animate-pulse-ring rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
    </span>
  );
}

function formatMinutes(min: number): string {
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.floor(min / 1440)}d`;
}
