'use client';

import { useState } from 'react';
import { VaultCard } from './vault-card';
import { HoldingsPanel } from './holdings-panel';
import { AuditTimeline } from './audit-timeline';
import { DangerZone } from './danger-zone';
import { DashboardToolbar } from './dashboard-toolbar';
import { LiveVaultBanner } from './live-vault-banner';
import { ArtifactsPanel } from './artifacts-panel';
import { PolicyPanel } from './policy-panel';
import { RunTickButton } from './run-tick-button';
import { SessionKeyPanel } from './session-key-panel';
import { DepositPanel } from './deposit-panel';
import { WithdrawPanel } from './withdraw-panel';
import { FundSessionPanel } from './fund-session-panel';
import { RuntimeHealthPanel } from './runtime-health-panel';
import dynamic from 'next/dynamic';

// The in-browser runtime pulls in @synapse-core/vault → @mysten/walrus,
// which loads a Node WASM blob at module-eval time and explodes during
// SSR/prerender. It's a client-only feature (File API, live ticking)
// so load it with ssr:false — keeps the heavy SDK out of the server
// bundle entirely.
const InBrowserRuntimePanel = dynamic(
  () => import('./in-browser-runtime-panel').then((m) => m.InBrowserRuntimePanel),
  {
    ssr: false,
    loading: () => (
      <div className="card-flat p-6 text-sm text-ink-soft">Loading runtime…</div>
    ),
  },
);

// MemWal recall panel — same client-only constraints (File API + SDK) as the
// runtime panel, so it's loaded ssr:false too.
const MemWalRecallPanel = dynamic(
  () => import('./memwal-recall-panel').then((m) => m.MemWalRecallPanel),
  {
    ssr: false,
    loading: () => (
      <div className="card-flat p-6 text-sm text-ink-soft">Loading memory…</div>
    ),
  },
);

const HostedRuntimePanel = dynamic(
  () => import('./hosted-runtime-panel').then((m) => m.HostedRuntimePanel),
  {
    ssr: false,
    loading: () => (
      <div className="card-flat p-6 text-sm text-ink-soft">Loading hosted runtime…</div>
    ),
  },
);

const CoordinationPanel = dynamic(
  () => import('./coordination-panel').then((m) => m.CoordinationPanel),
  {
    ssr: false,
    loading: () => (
      <div className="card-flat p-6 text-sm text-ink-soft">Loading coordination…</div>
    ),
  },
);

import { CodeTag } from '../ui/code-tag';
import {
  SAMPLE_REBALANCE_HISTORY,
  SAMPLE_TIMELINE,
  SAMPLE_VAULT,
} from '@/lib/sample-data';
import { formatUsd } from '@/lib/format';
import type { LocalVaultRecord } from '@/lib/local-vaults';
import { useLiveVault } from '../../hooks/use-live-vault';
import { useLiveNavHistory } from '../../hooks/use-live-nav-history';
import { useStrategies } from '../../hooks/use-strategies';
import { requiresWalrusConsent, requiresAnthropicApiKey } from '@/lib/strategies';
import { VaultExpiredBanner } from './vault-expired-banner';
import { VaultSessionGasBanner } from './vault-session-gas-banner';

interface DashboardShellProps {
  /**
   * When present, overrides the LiveVaultBanner's auto-detect of the
   * connected wallet's newest vault. Wired by the dynamic route at
   * `/dashboard/[vaultId]` so each vault has its own shareable URL.
   */
  forcedVaultId?: string;
}

/**
 * Top-level dashboard client island. Detects the user's live vault, fetches
 * live on-chain state + Pyth prices for it, and threads that data into every
 * panel. Falls back to sample data only when there's no live vault to show.
 *
 * When `forcedVaultId` is passed (via the `/dashboard/[vaultId]` dynamic
 * route), that vault is loaded directly — no auto-detect, no picker
 * default. Without it, the original LiveVaultBanner picker behavior
 * applies so `/dashboard` remains a no-id entry point.
 */
export function DashboardShell({ forcedVaultId }: DashboardShellProps = {}) {
  // Banner-detected vault (no URL param) OR forced-from-URL ID. The
  // effective `vaultId` we hand to every downstream query is the
  // forced one when present, else whatever the banner surfaces.
  const [detectedVault, setDetectedVault] = useState<LocalVaultRecord | null>(null);
  const effectiveVaultId = forcedVaultId ?? detectedVault?.agentId;
  // Synthesize a minimal LocalVaultRecord when we're URL-driven —
  // downstream components that take `liveVault` only need .agentId
  // plus a few cosmetic fields, all populatable from on-chain state.
  const liveVault: LocalVaultRecord | null = forcedVaultId
    ? {
        agentId: forcedVaultId,
        ownerAddress: '',
        digest: '',
        sessionAddress: '',
        memwalAccountId: null,
        mintedAtMs: Date.now(),
      }
    : detectedVault;
  const liveQuery = useLiveVault(effectiveVaultId);
  const live = liveQuery.data ?? null;
  const historyQuery = useLiveNavHistory(liveVault?.agentId, live);
  const liveHistory = historyQuery.data ?? null;
  const strategiesQuery = useStrategies();
  const hiredStrategy =
    strategiesQuery.data?.find((s) => s.id === live?.identity.strategyId) ?? null;

  const sampleVault = SAMPLE_VAULT;
  const navUsd = live?.navUsd ?? sampleVault.navUsd;
  const aumFeeAccruedToday = (navUsd * sampleVault.managementFeeBps) / 10_000 / 365;

  // When the user navigated to a specific vault (`/dashboard/[vaultId]`) and it
  // failed to load, do NOT fall back to the SAMPLE_VAULT placeholder numbers —
  // that presents fabricated treasury/holdings as if they were this vault's.
  // The sample preview is only for the no-vault landing state.
  if (forcedVaultId && liveQuery.isError && !live) {
    return (
      <>
        <DashboardToolbar />
        <div
          className="mt-6 rounded-md border-2 border-ink bg-paper-strong px-6 py-8 shadow-[2px_2px_0_0_var(--ink)]"
          style={{ borderColor: 'var(--accent-orange)' }}
        >
          <h2 className="text-lg font-semibold">Vault not found</h2>
          <p className="mt-2 text-sm text-ink-mute">
            Couldn&apos;t load vault <code className="break-all">{forcedVaultId}</code> from the
            chain. Check the ID is correct and that it was minted on this network, then retry.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <DashboardToolbar />
      <div className="mt-5">
        <LiveVaultBanner
          onVaultDetected={setDetectedVault}
          activeVaultId={forcedVaultId ?? null}
        />
      </div>

      <div className="mt-6">
        <VaultCard
          vault={sampleVault}
          sampleHistory={SAMPLE_REBALANCE_HISTORY}
          {...(live ? { live } : {})}
          {...(effectiveVaultId ? { liveVaultId: effectiveVaultId } : {})}
          {...(hiredStrategy ? { liveStrategy: hiredStrategy } : {})}
          {...(liveHistory ? { liveHistory } : {})}
          loading={liveQuery.isLoading || historyQuery.isLoading}
        />
      </div>

      <section className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MicroCard
          label="Fees accrued today"
          value={formatUsd(aumFeeAccruedToday)}
          accent="var(--accent-green)"
        />
        <MicroCard
          label="Walrus artifacts"
          value={live ? live.identity.artifactCount.toString() : '73'}
          accent="var(--accent-purple)"
        />
        <MicroCard
          label="Spend cap (USD)"
          value={live ? formatUsd(live.spendCapUsd) : formatUsd(62_379)}
          accent="var(--accent-blue)"
        />
        <MicroCard label="Strategy revs" value="1.0.0" accent="var(--accent-yellow)" />
      </section>

      {live?.identity.revoked && (
        <div
          className="mt-6 flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]"
          style={{ borderColor: 'var(--accent-orange)' }}
        >
          <span
            className="inline-flex h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: 'var(--accent-orange)' }}
          />
          <CodeTag>revoked</CodeTag>
          <span className="font-display text-sm">
            This vault is permanently revoked. The agent's session key has no on-chain
            authority. Deposits, holdings reads, and audit history remain queryable; mutations
            abort at the Move VM.
          </span>
        </div>
      )}

      {live && !live.identity.revoked && (
        <div className="mt-6 space-y-4">
          <VaultExpiredBanner
            currentEpoch={live.currentEpoch}
            expiryEpoch={live.identity.expiryEpoch}
          />
          <VaultSessionGasBanner live={live} />
        </div>
      )}

      {live && !live.identity.revoked && hiredStrategy && (
        <WalrusExecutionBadge
          strategy={hiredStrategy}
          consented={live.identity.acceptsWalrusExecution}
        />
      )}

      {liveVault && (
        <div className="mt-6 grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <RuntimeHealthPanel vaultId={liveVault.agentId} />
          <div className="flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]">
            <CodeTag>owner</CodeTag>
            <span className="font-display text-sm">
              {live?.identity.revoked
                ? 'Owner attestations disabled — vault is revoked.'
                : 'Log a manual check-in — appears in the audit timeline.'}
            </span>
            <span className="ml-auto">
              <RunTickButton
                vaultId={liveVault.agentId}
                {...(live?.identity.revoked ? { revoked: true } : {})}
              />
            </span>
          </div>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 xl:grid-cols-[1.05fr_1fr]">
        <AuditTimeline
          sampleEntries={SAMPLE_TIMELINE}
          {...(liveVault ? { liveVaultId: liveVault.agentId } : {})}
        />
        <div className="flex flex-col gap-8">
          <HoldingsPanel
            vault={sampleVault}
            {...(live ? { live } : {})}
            loading={liveQuery.isLoading}
          />
          <PolicyPanel {...(live ? { live } : {})} />
          {liveVault && live && (
            <DepositPanel vaultId={liveVault.agentId} mintPackageId={live.mintPackageId} />
          )}
          {liveVault && live && live.pricedHoldings.some((h) => h.amount > 0n) && (
            <WithdrawPanel
              vaultId={liveVault.agentId}
              owner={live.identity.owner}
              holdings={live.pricedHoldings}
            />
          )}
          {live && live.identity.sessionAddr.length > 0 && (
            <FundSessionPanel sessionAddr={live.identity.sessionAddr} />
          )}
          {liveVault && (
            <SessionKeyPanel
              vaultId={liveVault.agentId}
              {...(live?.identity.strategyId
                ? { strategyId: live.identity.strategyId }
                : {})}
              strategyName={resolveStrategyName(live?.identity.strategyId)}
            />
          )}
          {liveVault && <ArtifactsPanel vaultId={liveVault.agentId} />}
          {live && (
            <MemWalRecallPanel
              memwalAccountId={live.identity.memwalAccountId}
              memwalNamespace={live.identity.memwalNamespace}
              {...(live.identity.strategyId
                ? { strategyId: live.identity.strategyId }
                : {})}
            />
          )}
          {live && liveVault && (
            <CoordinationPanel
              vaultId={liveVault.agentId}
              memwalNamespace={live.identity.memwalNamespace}
              memwalEnabled={live.identity.memwalAccountId.length > 0}
              messagingInbox={live.identity.messagingInbox}
              messagingOutbox={live.identity.messagingOutbox}
            />
          )}
          {liveVault && (
            <HostedRuntimePanel
              vaultId={liveVault.agentId}
              needsAnthropicKey={hiredStrategy ? requiresAnthropicApiKey(hiredStrategy) : false}
              requiresAttestation={live?.identity.requiresAttestation ?? false}
            />
          )}
          {liveVault && <InBrowserRuntimePanel vaultId={liveVault.agentId} />}
          <DangerZone
            {...(liveVault ? { vaultId: liveVault.agentId } : {})}
            {...(live?.identity.strategyId ? { strategyId: live.identity.strategyId } : {})}
            {...(live?.identity.revoked ? { revoked: true } : {})}
            {...(live
              ? {
                  memwalAccountId: live.identity.memwalAccountId,
                  memwalDelegateKeyId: live.identity.memwalDelegateKeyId,
                }
              : {})}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Map a known seeded strategy ID to its human label. Falls through to a
 * generic display when the vault hired an unfamiliar strategy. The
 * canonical set of seeded IDs lives in `lib/strategies.ts` so the mint
 * wizard + dashboard agree.
 */
const SEEDED_STRATEGY_LABELS: Record<string, string> = {
  '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec':
    'Synapse Conservative Rebalancer',
  '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679':
    'Synapse Balanced Yield',
  '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1':
    'Synapse Aggressive Momentum',
};

function resolveStrategyName(strategyId: string | undefined): string {
  if (!strategyId) return 'Synapse Strategy';
  return SEEDED_STRATEGY_LABELS[strategyId] ?? 'Synapse Strategy';
}

/**
 * Surfaces how the hired strategy will be executed at every tick:
 *   - Seeded: runtime runs its built-in TypeScript implementation.
 *   - Walrus + consented: runtime fetches + hash-verifies + executes
 *     the marketplace bundle.
 *   - Walrus + NOT consented: runtime falls back to its default,
 *     ignoring the hired strategy. Critical to surface — the vault
 *     looks like it hired one thing but executes another. Owner must
 *     opt in via the Policy panel.
 */
function WalrusExecutionBadge({
  strategy,
  consented,
}: {
  strategy: { sourceWalrusBlob: string };
  consented: boolean;
}) {
  if (!requiresWalrusConsent(strategy)) {
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]">
        <span
          className="inline-flex h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: 'var(--state-active)' }}
        />
        <CodeTag>seeded</CodeTag>
        <span className="font-display text-sm">
          Runtime executes this strategy from its built-in implementation. No Walrus loading needed.
        </span>
      </div>
    );
  }
  if (consented) {
    return (
      <div
        className="mt-6 flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]"
        style={{ borderColor: 'var(--accent-purple)' }}
      >
        <span
          className="inline-flex h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: 'var(--accent-purple)' }}
        />
        <CodeTag>walrus-loaded</CodeTag>
        <span className="font-display text-sm">
          Each tick fetches this strategy&apos;s bundle from Walrus and verifies its sha256
          against the on-chain commitment before executing.
        </span>
      </div>
    );
  }
  return (
    <div
      className="mt-6 flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]"
      style={{ borderColor: 'var(--accent-orange)' }}
    >
      <span
        className="inline-flex h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: 'var(--accent-orange)' }}
      />
      <CodeTag>consent missing</CodeTag>
      <span className="font-display text-sm">
        This vault hired a marketplace strategy whose code lives on Walrus, but consent
        is off. The runtime is falling back to its default — your hired strategy is{' '}
        <strong>not executing</strong>. Enable in the Policy panel below.
      </span>
    </div>
  );
}

function MicroCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="card-flat group relative overflow-hidden p-4">
      <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</p>
      <p className="num-display mt-2 text-2xl">{value}</p>
    </div>
  );
}
