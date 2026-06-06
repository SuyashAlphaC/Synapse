'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSuiClient } from '@mysten/dapp-kit';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import { loadLiveTimeline } from '@/lib/live-events';
import { explorerObjectUrl, explorerTxUrl } from '@/lib/synapse-config';
import type { HostedRuntimeStatus } from '@/lib/hosted-runtime/types';

interface Props {
  vaultId: string;
  memwalNamespace: Uint8Array;
  /** True when the vault has a MemWal account id on-chain. */
  memwalEnabled: boolean;
}

function decodeNamespace(bytes: Uint8Array): string {
  if (bytes.length === 0) return '(none)';
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return `(binary, ${bytes.length} bytes)`;
  }
}

/**
 * MemWal cross-agent coordination — shared namespace, peer vault config on
 * hosted runtime, and on-chain CrossAgentReadEvent visibility.
 */
export function CoordinationPanel({ vaultId, memwalNamespace, memwalEnabled }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const suiClient = useSuiClient();
  const namespaceLabel = useMemo(() => decodeNamespace(memwalNamespace), [memwalNamespace]);

  const [peerInput, setPeerInput] = useState('');
  const [updating, setUpdating] = useState(false);

  const configQuery = useQuery({
    queryKey: ['hosted-runtime-config'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch('/api/hosted-runtime/config');
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { apiEnabled: boolean };
    },
  });

  const statusQuery = useQuery({
    queryKey: ['hosted-runtime-status', vaultId],
    enabled: Boolean(configQuery.data?.apiEnabled),
    staleTime: 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<HostedRuntimeStatus> => {
      const res = await fetch(
        `/api/hosted-runtime/status?vaultId=${encodeURIComponent(vaultId)}`,
      );
      const body = (await res.json()) as HostedRuntimeStatus | { error?: string };
      if (!res.ok) throw new Error('error' in body ? body.error : res.statusText);
      return body as HostedRuntimeStatus;
    },
  });

  const crossAgentEventsQuery = useQuery({
    queryKey: ['cross-agent-read-count', vaultId],
    staleTime: 30_000,
    refetchInterval: 45_000,
    queryFn: async () => {
      const rows = await loadLiveTimeline({ client: suiClient, agentId: vaultId, limit: 100 });
      return rows.filter((r) => r.kind === 'cross_agent_read');
    },
  });

  const status = statusQuery.data;
  const configuredPeers = status?.crossAgentPeerVaultIds ?? [];
  const canUpdatePeers =
    Boolean(configQuery.data?.apiEnabled) &&
    status &&
    (status.phase === 'live' || status.phase === 'paused');

  useEffect(() => {
    if (configuredPeers.length === 0) return;
    if (!peerInput.trim()) {
      setPeerInput(configuredPeers.join('\n'));
    }
  }, [configuredPeers, peerInput]);

  const onApplyPeers = useCallback(async () => {
    setUpdating(true);
    try {
      const res = await fetch('/api/hosted-runtime/update-coordination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultId,
          crossAgentPeerVaultIds: peerInput,
        }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      toast.push({
        variant: 'success',
        title: 'Coordination updating',
        body: body.message ?? 'Stack update started.',
        durationMs: 10_000,
      });
      void queryClient.invalidateQueries({ queryKey: ['hosted-runtime-status', vaultId] });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Update failed',
        body: err instanceof Error ? err.message : String(err),
        durationMs: 12_000,
      });
    } finally {
      setUpdating(false);
    }
  }, [peerInput, queryClient, toast, vaultId]);

  const crossAgentReads = crossAgentEventsQuery.data ?? [];
  const recentRead = crossAgentReads[0] ?? null;

  return (
    <div className="card-flat p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl font-bold">Coordination</h3>
        <CodeTag>MemWal cross-agent</CodeTag>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-ink-soft">
        Vaults minted under the <strong className="font-normal text-ink">same owner wallet</strong>{' '}
        share one MemWal namespace automatically. On each tick, the hosted runtime can recall peer
        vault outcomes from that namespace and record{' '}
        <code className="font-mono text-[10px]">coordination::CrossAgentReadEvent</code> on-chain.
        No repo clone or messaging channel setup required.
      </p>

      <div className="mb-4 grid gap-2 rounded-sm border border-divider bg-paper p-3 font-mono text-[11px] text-ink-soft">
        <p>
          <span className="text-ink-mute">MemWal namespace · </span>
          <code className="text-ink">{namespaceLabel}</code>
        </p>
        <p>
          <span className="text-ink-mute">MemWal on vault · </span>
          {memwalEnabled ? (
            <span className="text-state-active">enabled ✓</span>
          ) : (
            <span className="text-accent-orange">not configured — mint with MemWal enabled</span>
          )}
        </p>
        {configQuery.data?.apiEnabled && status ? (
          <p>
            <span className="text-ink-mute">Hosted runtime peers · </span>
            {status.crossAgentConfigured ? (
              <span className="text-state-active">
                {configuredPeers.length} configured ✓
              </span>
            ) : (
              <span>none — add peer vault ids below</span>
            )}
          </p>
        ) : null}
        <p>
          <span className="text-ink-mute">Cross-agent reads (recent) · </span>
          {crossAgentEventsQuery.isLoading ? (
            <span>loading…</span>
          ) : crossAgentReads.length > 0 ? (
            <span className="text-state-active">
              {crossAgentReads.length} in last 100 audit events ✓
            </span>
          ) : (
            <span>none yet — peer must tick first, then this vault reads on next tick</span>
          )}
        </p>
        {recentRead?.txDigest ? (
          <p className="text-[10px]">
            Latest read tx{' '}
            <a
              href={explorerTxUrl(recentRead.txDigest)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-orange underline-offset-2 hover:underline"
            >
              {recentRead.txDigest.slice(0, 10)}…
            </a>
          </p>
        ) : null}
      </div>

      {configuredPeers.length > 0 ? (
        <ul className="mb-4 grid gap-1 font-mono text-[10px] text-ink-soft">
          {configuredPeers.map((peerId) => (
            <li key={peerId}>
              <a
                href={explorerObjectUrl(peerId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-orange underline-offset-2 hover:underline"
              >
                {peerId.slice(0, 10)}…{peerId.slice(-6)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {canUpdatePeers ? (
        <div className="grid gap-3 rounded-sm border border-divider bg-paper p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Peer vault ids (hosted runtime)
          </p>
          <p className="text-[11px] leading-relaxed text-ink-soft">
            One peer vault object id per line (or comma-separated). This vault will recall MemWal
            outcomes written by those peers on every tick. Leave empty and apply to clear peers.
          </p>
          <textarea
            value={peerInput}
            disabled={updating}
            onChange={(e) => setPeerInput(e.target.value)}
            placeholder="0x…peer vault AgentIdentity id"
            rows={3}
            className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
          />
          <button
            type="button"
            className="btn-flat w-fit"
            data-variant="accent"
            disabled={updating || !memwalEnabled}
            onClick={() => void onApplyPeers()}
          >
            {updating ? 'Updating…' : 'Apply peer vaults'}
          </button>
          {!memwalEnabled ? (
            <p className="font-mono text-[10px] text-accent-orange">
              MemWal must be enabled on this vault before cross-agent reads can run.
            </p>
          ) : null}
        </div>
      ) : configQuery.data?.apiEnabled ? (
        <p className="rounded-sm border-l-2 border-ink-mute bg-paper p-3 font-mono text-[11px] text-ink-soft">
          Enable <strong className="font-normal text-ink">Hosted runtime</strong> below first — you
          can set peer vault ids when enabling, or update them here once the stack is live.
        </p>
      ) : (
        <p className="rounded-sm border-l-2 border-ink-mute bg-paper p-3 font-mono text-[11px] text-ink-soft">
          Hosted runtime API is off on this dashboard — self-host with{' '}
          <code>SYNAPSE_CROSS_AGENT_PEERS</code> in your runtime environment.
        </p>
      )}
    </div>
  );
}
