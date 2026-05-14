'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'motion/react';
import { useQuery } from '@tanstack/react-query';
import { useSuiClient } from '@mysten/dapp-kit';
import { CodeTag } from '../ui/code-tag';
import { useLiveVault } from '../../hooks/use-live-vault';
import { loadLiveTimeline } from '@/lib/live-events';
import { listVaultArtifacts } from '@/lib/artifacts-client';
import { ArtifactsPanel } from '../dashboard/artifacts-panel';
import { AuditTimeline } from '../dashboard/audit-timeline';
import { PolicyPanel } from '../dashboard/policy-panel';
import { explorerObjectUrl } from '@/lib/synapse-config';
import { formatUsd, shortenHash } from '@/lib/format';

const ADDRESS_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Standalone read-only inspector. Paste any AgentIdentity object ID and the
 * tool surfaces its policy, holdings, audit timeline, and published Walrus
 * artifacts via direct Sui RPC + Walrus aggregator reads. No wallet needed.
 */
export function InspectorShell() {
  const [input, setInput] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const client = useSuiClient();

  // Pre-flight: do the dynamic field walks lazily; only fetch when a vault
  // ID is committed.
  const vaultQuery = useLiveVault(active);
  const timelineQuery = useQuery({
    queryKey: ['inspector-timeline', active],
    queryFn: async () => {
      if (!active) return [];
      return loadLiveTimeline({ client, agentId: active, limit: 200 });
    },
    enabled: !!active,
    staleTime: 30_000,
  });
  const artifactsQuery = useQuery({
    queryKey: ['inspector-artifacts', active],
    queryFn: async () => {
      if (!active) return [];
      return listVaultArtifacts({ client, vaultId: active });
    },
    enabled: !!active,
    staleTime: 30_000,
  });

  function submit(value: string) {
    const trimmed = value.trim();
    if (!ADDRESS_RE.test(trimmed)) {
      setActive(null);
      return;
    }
    setActive(trimmed);
  }

  const loading = vaultQuery.isLoading || timelineQuery.isLoading || artifactsQuery.isLoading;
  const errorMsg = vaultQuery.error?.message;

  return (
    <div className="grid gap-10">
      <header className="grid gap-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
          <CodeTag>inspector</CodeTag> · read-only dev tool · no wallet required
        </span>
        <h1 className="font-display text-6xl font-extrabold leading-[0.95] tracking-tight md:text-7xl">
          Memory <span className="font-serif italic">Inspector</span>
          <span className="text-accent-orange">.</span>
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-ink-soft">
          Paste any Synapse <code className="font-mono text-base">AgentIdentity</code> object ID.
          The inspector reconstructs the vault's full state directly from Sui RPC and the public
          Walrus aggregator. Useful for debugging your own vaults, auditing someone else's, or
          showing a compliance officer a verifiable timeline.
        </p>
      </header>

      <section className="card-flat p-6">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <label className="grid gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              <CodeTag>agent_identity</CodeTag>
            </span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x..."
              className="w-full rounded-sm border-2 border-ink bg-paper px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ink/30"
            />
          </label>
          <div className="flex items-end gap-2">
            <button className="btn-flat" data-variant="primary" type="submit">
              Inspect
            </button>
            {active && (
              <a
                href={explorerObjectUrl(active)}
                target="_blank"
                rel="noreferrer"
                className="btn-flat"
                data-variant="ghost"
              >
                Open on suiscan ↗
              </a>
            )}
          </div>
        </form>

        {input && !ADDRESS_RE.test(input.trim()) && (
          <p className="mt-3 rounded-sm border-l-2 border-state-revoked bg-paper p-3 font-mono text-[11px] text-ink-soft">
            Expected a hex address starting with <span className="text-ink">0x</span>.
          </p>
        )}

        {errorMsg && (
          <p className="mt-3 rounded-sm border-l-2 border-state-revoked bg-paper p-3 font-mono text-[11px] text-ink-soft">
            {errorMsg}
          </p>
        )}

        <AnimatePresence>
          {active && (
            <motion.div
              key="summary"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4"
            >
              <SummaryCard
                label="State"
                value={
                  vaultQuery.data
                    ? vaultQuery.data.identity.revoked
                      ? 'revoked'
                      : 'active'
                    : '—'
                }
                accent={
                  vaultQuery.data?.identity.revoked
                    ? 'var(--accent-orange)'
                    : 'var(--accent-green)'
                }
              />
              <SummaryCard
                label="NAV (USD)"
                value={vaultQuery.data ? formatUsd(vaultQuery.data.navUsd) : '—'}
                accent="var(--accent-blue)"
              />
              <SummaryCard
                label="Events"
                value={timelineQuery.data?.length.toString() ?? (loading ? '…' : '0')}
                accent="var(--accent-purple)"
              />
              <SummaryCard
                label="Artifacts"
                value={artifactsQuery.data?.length.toString() ?? (loading ? '…' : '0')}
                accent="var(--accent-yellow)"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {active && (
        <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
          <div className="flex flex-col gap-8">
            <AuditTimeline sampleEntries={[]} liveVaultId={active} />
          </div>
          <div className="flex flex-col gap-8">
            <PolicyPanel {...(vaultQuery.data ? { live: vaultQuery.data } : {})} />
            <ArtifactsPanel vaultId={active} />
            {vaultQuery.data && (
              <div className="card-flat p-6 font-mono text-[11px] text-ink-soft">
                <p className="mb-2 font-display text-sm font-semibold text-ink">Raw identity</p>
                <p>id: {shortenHash(vaultQuery.data.identity.id)}</p>
                <p>owner: {shortenHash(vaultQuery.data.identity.owner)}</p>
                <p>session: {shortenHash(vaultQuery.data.identity.sessionAddr)}</p>
                <p>spend_per_epoch: {vaultQuery.data.identity.spendPerEpoch.toString()}</p>
                <p>spent_this_epoch: {vaultQuery.data.identity.spentThisEpoch.toString()}</p>
                <p>expiry_epoch: {vaultQuery.data.identity.expiryEpoch.toString()}</p>
                <p>artifacts: {vaultQuery.data.identity.artifactCount.toString()}</p>
                <p>
                  memwal_namespace:{' '}
                  {new TextDecoder('utf-8', { fatal: false }).decode(
                    vaultQuery.data.identity.memwalNamespace,
                  ) || '(empty)'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {!active && (
        <div className="card-flat p-8 text-center">
          <p className="font-display text-xl text-ink-soft">
            Or peek at a known testnet vault to see the inspector in action.
          </p>
          <p className="mt-4 font-mono text-[11px] text-ink-mute">
            Tip: mint your own at{' '}
            <Link href="/mint" className="text-accent-blue underline">
              /mint
            </Link>{' '}
            then paste the resulting <CodeTag>AgentIdentity</CodeTag> address here.
          </p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="card-flat group relative overflow-hidden p-4">
      <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</p>
      <p className="num-display mt-2 text-2xl">{value}</p>
    </div>
  );
}
