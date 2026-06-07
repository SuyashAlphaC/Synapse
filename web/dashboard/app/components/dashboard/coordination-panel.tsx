'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import { loadLiveTimeline } from '@/lib/live-events';
import { buildAttachMessagingPTB } from '@/lib/ptb';
import { explorerObjectUrl, explorerTxUrl } from '@/lib/synapse-config';
import type { HostedRuntimeStatus } from '@/lib/hosted-runtime/types';

interface Props {
  vaultId: string;
  memwalNamespace: Uint8Array;
  /** True when the vault has a MemWal account id on-chain. */
  memwalEnabled: boolean;
  messagingInbox: string | null;
  messagingOutbox: string | null;
}

function decodeNamespace(bytes: Uint8Array): string {
  if (bytes.length === 0) return '(none)';
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return `(binary, ${bytes.length} bytes)`;
  }
}

function parseVaultIds(raw: string, includeVaultId: string): string {
  const ids = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('0x'));
  if (!ids.includes(includeVaultId)) ids.unshift(includeVaultId);
  return [...new Set(ids)].join('\n');
}

function listVaultIds(raw: string, includeVaultId: string): string[] {
  return parseVaultIds(raw, includeVaultId)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * MemWal cross-agent coordination + Sui Stack Messaging setup and audit visibility.
 */
export function CoordinationPanel({
  vaultId,
  memwalNamespace,
  memwalEnabled,
  messagingInbox,
  messagingOutbox,
}: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending: attaching } = useSignAndExecuteTransaction();
  const namespaceLabel = useMemo(() => decodeNamespace(memwalNamespace), [memwalNamespace]);

  const [peerInput, setPeerInput] = useState('');
  const [updating, setUpdating] = useState(false);
  const [ownerKeyInput, setOwnerKeyInput] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [createdChannelId, setCreatedChannelId] = useState<string | null>(null);
  const [channelVaultIds, setChannelVaultIds] = useState('');
  const [messagingMode, setMessagingMode] = useState<'attach' | 'create'>('attach');
  const [existingChannelInput, setExistingChannelInput] = useState('');

  const messagingAttached = Boolean(messagingInbox && messagingOutbox);
  const channelVaultList = useMemo(
    () => listVaultIds(channelVaultIds || peerInput, vaultId),
    [channelVaultIds, peerInput, vaultId],
  );

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

  const coordinationEventsQuery = useQuery({
    queryKey: ['coordination-events', vaultId],
    staleTime: 30_000,
    refetchInterval: 45_000,
    queryFn: async () => {
      const rows = await loadLiveTimeline({ client: suiClient, agentId: vaultId, limit: 100 });
      return rows.filter((r) =>
        ['cross_agent_read', 'message_sent', 'message_received'].includes(r.kind),
      );
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

  useEffect(() => {
    if (!channelVaultIds.trim()) {
      setChannelVaultIds(parseVaultIds(peerInput, vaultId));
    }
  }, [channelVaultIds, peerInput, vaultId]);

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

  const onCreateChannel = useCallback(async () => {
    const vaultIds = listVaultIds(channelVaultIds || peerInput, vaultId);
    if (vaultIds.length < 2) {
      toast.push({
        variant: 'warn',
        title: 'Need both vault ids',
        body: 'Create the channel once with this vault and every peer vault listed (one per line). Do not create separately on each dashboard.',
        durationMs: 14_000,
      });
      return;
    }
    setCreatingChannel(true);
    try {
      const res = await fetch('/api/messaging/create-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerKey: ownerKeyInput,
          vaultIds: vaultIds.join('\n'),
        }),
      });
      const body = (await res.json()) as {
        channelId?: string;
        digest?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (!body.channelId) throw new Error('create-channel returned no channelId');
      setCreatedChannelId(body.channelId);
      setExistingChannelInput(body.channelId);
      setOwnerKeyInput('');
      toast.push({
        variant: 'success',
        title: 'Messaging channel created',
        body: `${body.message ?? 'Channel ready.'} Attach on this vault, then paste the same channel id on each peer vault.`,
        durationMs: 14_000,
      });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Channel creation failed',
        body: err instanceof Error ? err.message : String(err),
        durationMs: 12_000,
      });
    } finally {
      setCreatingChannel(false);
    }
  }, [channelVaultIds, ownerKeyInput, peerInput, toast, vaultId]);

  const onAttachChannel = useCallback(async () => {
    const channelId = (
      existingChannelInput.trim() ||
      createdChannelId ||
      messagingInbox ||
      ''
    ).trim();
    if (!channelId.startsWith('0x') || channelId.length < 20) {
      toast.push({
        variant: 'warn',
        title: 'Channel id required',
        body: 'Paste the channel id from the vault that created it (or from create-channel success). Both vaults must use the same id.',
        durationMs: 12_000,
      });
      return;
    }
    try {
      const tx = buildAttachMessagingPTB({ agentId: vaultId, channelId });
      await signAndExecute({ transaction: tx });
      toast.push({
        variant: 'success',
        title: 'Messaging attached',
        body: 'Inbox and outbox set to the shared channel. Peers must attach the same channel id.',
        durationMs: 10_000,
      });
      void queryClient.invalidateQueries({ queryKey: ['live-vault', vaultId] });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Attach failed',
        body: err instanceof Error ? err.message : String(err),
        durationMs: 12_000,
      });
    }
  }, [
    createdChannelId,
    existingChannelInput,
    messagingInbox,
    queryClient,
    signAndExecute,
    toast,
    vaultId,
  ]);

  const coordinationEvents = coordinationEventsQuery.data ?? [];
  const crossAgentReads = coordinationEvents.filter((r) => r.kind === 'cross_agent_read');
  const messageSent = coordinationEvents.filter((r) => r.kind === 'message_sent');
  const messageReceived = coordinationEvents.filter((r) => r.kind === 'message_received');
  const recentRead = crossAgentReads[0] ?? null;
  const recentMsg = messageReceived[0] ?? messageSent[0] ?? null;

  return (
    <div className="card-flat p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl font-bold">Coordination</h3>
        <CodeTag>MemWal + Sui Stack Messaging</CodeTag>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-ink-soft">
        <strong className="font-normal text-ink">MemWal cross-agent</strong> pulls peer strategy
        outcomes from a shared namespace (no channel setup).{' '}
        <strong className="font-normal text-ink">Sui Stack Messaging</strong> pushes Seal-encrypted
        rebalance signals on a Walrus-backed channel — attach once per vault, then the hosted runtime
        emits on rebalance and consumes on every tick.
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
        <p>
          <span className="text-ink-mute">Messaging channel · </span>
          {messagingAttached ? (
            <span className="text-state-active">
              attached ✓{' '}
              <a
                href={explorerObjectUrl(messagingInbox!)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-orange underline-offset-2 hover:underline"
              >
                {messagingInbox!.slice(0, 10)}…
              </a>
            </span>
          ) : createdChannelId ? (
            <span>
              created — attach below ·{' '}
              <code className="text-ink">{createdChannelId.slice(0, 14)}…</code>
            </span>
          ) : (
            <span>not attached — create + attach a shared channel below</span>
          )}
        </p>
        {configQuery.data?.apiEnabled && status ? (
          <p>
            <span className="text-ink-mute">Hosted runtime peers · </span>
            {status.crossAgentConfigured ? (
              <span className="text-state-active">{configuredPeers.length} configured ✓</span>
            ) : (
              <span>none — add peer vault ids below</span>
            )}
          </p>
        ) : null}
        <p>
          <span className="text-ink-mute">Cross-agent reads (recent) · </span>
          {coordinationEventsQuery.isLoading ? (
            <span>loading…</span>
          ) : crossAgentReads.length > 0 ? (
            <span className="text-state-active">
              {crossAgentReads.length} in last 100 audit events ✓
            </span>
          ) : (
            <span>none yet</span>
          )}
        </p>
        <p>
          <span className="text-ink-mute">Stack messages (recent) · </span>
          {coordinationEventsQuery.isLoading ? (
            <span>loading…</span>
          ) : messageSent.length + messageReceived.length > 0 ? (
            <span className="text-state-active">
              {messageSent.length} sent · {messageReceived.length} received ✓
            </span>
          ) : (
            <span>none yet — attach channel + peer rebalance</span>
          )}
        </p>
        {recentRead?.txDigest ? (
          <p className="text-[10px]">
            Latest MemWal read tx{' '}
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
        {recentMsg?.txDigest ? (
          <p className="text-[10px]">
            Latest messaging tx{' '}
            <a
              href={explorerTxUrl(recentMsg.txDigest)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-orange underline-offset-2 hover:underline"
            >
              {recentMsg.txDigest.slice(0, 10)}…
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

      {!messagingAttached ? (
        <div className="mb-4 grid gap-3 rounded-sm border border-divider bg-paper p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Sui Stack Messaging channel
          </p>
          <p className="rounded-sm border-l-2 border-accent-orange bg-paper-strong p-3 text-[11px] leading-relaxed text-ink-soft">
            <strong className="font-normal text-ink">One channel per vault pair.</strong> Create it
            once on the first vault (include all vault ids). On every other vault, choose{' '}
            <strong className="font-normal text-ink">Attach existing</strong> and paste the same
            channel id — do not create again.
          </p>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-flat w-fit font-mono text-[10px]"
              data-variant={messagingMode === 'attach' ? 'accent' : undefined}
              onClick={() => setMessagingMode('attach')}
            >
              Attach existing channel
            </button>
            <button
              type="button"
              className="btn-flat w-fit font-mono text-[10px]"
              data-variant={messagingMode === 'create' ? 'accent' : undefined}
              onClick={() => setMessagingMode('create')}
            >
              Create new (once)
            </button>
          </div>

          {messagingMode === 'attach' ? (
            <>
              <p className="text-[11px] leading-relaxed text-ink-soft">
                Paste the channel id from the vault that already created it, then attach with your
                owner wallet.
              </p>
              <input
                value={existingChannelInput}
                disabled={attaching}
                onChange={(e) => setExistingChannelInput(e.target.value.trim())}
                placeholder="0x…shared channel id"
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
              <button
                type="button"
                className="btn-flat w-fit"
                data-variant="accent"
                disabled={attaching || !existingChannelInput.trim()}
                onClick={() => void onAttachChannel()}
              >
                {attaching ? 'Attaching…' : 'Attach to this vault'}
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-ink-soft">
                Creates a Seal-encrypted Walrus channel with every vault session key listed below as
                a member. Your owner key is used once server-side and is not stored.
              </p>
              <textarea
                value={channelVaultIds || parseVaultIds(peerInput, vaultId)}
                disabled={creatingChannel}
                onChange={(e) => setChannelVaultIds(e.target.value)}
                placeholder="0x…this vault&#10;0x…peer vault"
                rows={3}
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
              <p className="font-mono text-[10px] text-ink-mute">
                {channelVaultList.length} vault(s) listed
                {channelVaultList.length < 2 ? ' — need at least 2 for a pair' : ' ✓'}
              </p>
              <input
                type="password"
                value={ownerKeyInput}
                disabled={creatingChannel}
                onChange={(e) => setOwnerKeyInput(e.target.value)}
                placeholder="Owner suiprivkey… (testnet — cleared after create)"
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-flat w-fit"
                  data-variant="accent"
                  disabled={
                    creatingChannel ||
                    !ownerKeyInput.trim() ||
                    channelVaultList.length < 2
                  }
                  onClick={() => void onCreateChannel()}
                >
                  {creatingChannel ? 'Creating…' : 'Create shared channel'}
                </button>
                {(createdChannelId || existingChannelInput.trim()) ? (
                  <button
                    type="button"
                    className="btn-flat w-fit"
                    disabled={attaching}
                    onClick={() => void onAttachChannel()}
                  >
                    {attaching ? 'Attaching…' : 'Attach to this vault'}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}

      {configQuery.data?.apiEnabled ? (
        <div className="grid gap-3 rounded-sm border border-divider bg-paper p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            MemWal cross-agent peers
          </p>
          <p className="text-[11px] leading-relaxed text-ink-soft">
            Peer vault object ids for hosted runtime MemWal recall (
            <code className="font-mono text-[10px]">SYNAPSE_CROSS_AGENT_PEERS</code>). Set on
            the <strong className="font-normal text-ink">reader</strong> vault only — it recalls
            outcomes the writer published to the shared namespace. One id per line.
          </p>
          <textarea
            value={peerInput}
            disabled={updating || !canUpdatePeers}
            onChange={(e) => setPeerInput(e.target.value)}
            placeholder="0x…peer vault AgentIdentity id"
            rows={3}
            className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
          />
          <button
            type="button"
            className="btn-flat w-fit"
            data-variant="accent"
            disabled={updating || !memwalEnabled || !canUpdatePeers}
            onClick={() => void onApplyPeers()}
          >
            {updating ? 'Updating…' : 'Apply peer vaults'}
          </button>
          {!memwalEnabled ? (
            <p className="font-mono text-[10px] text-accent-orange">
              MemWal must be enabled on this vault before cross-agent reads can run.
            </p>
          ) : !canUpdatePeers ? (
            <p className="font-mono text-[10px] text-ink-soft">
              Enable <strong className="font-normal text-ink">Hosted runtime</strong> below first,
              then apply peers here.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-sm border-l-2 border-ink-mute bg-paper p-3 font-mono text-[11px] text-ink-soft">
          Hosted runtime API is off on this dashboard — self-host with{' '}
          <code>SYNAPSE_CROSS_AGENT_PEERS</code> and attach messaging channels manually.
        </p>
      )}
    </div>
  );
}
