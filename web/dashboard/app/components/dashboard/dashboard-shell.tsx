'use client';

import { useState } from 'react';
import { VaultCard } from './vault-card';
import { HoldingsPanel } from './holdings-panel';
import { AuditTimeline } from './audit-timeline';
import { DangerZone } from './danger-zone';
import { DashboardToolbar } from './dashboard-toolbar';
import { LiveVaultBanner } from './live-vault-banner';
import { PolicyPanel } from './policy-panel';
import { ArtifactsPanel } from './artifacts-panel';
import { RunTickButton } from './run-tick-button';
import { SessionKeyPanel } from './session-key-panel';
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

/**
 * Top-level dashboard client island. Detects the user's live vault, fetches
 * live on-chain state + Pyth prices for it, and threads that data into every
 * panel. Falls back to sample data only when there's no live vault to show.
 */
export function DashboardShell() {
  const [liveVault, setLiveVault] = useState<LocalVaultRecord | null>(null);
  const liveQuery = useLiveVault(liveVault?.agentId);
  const live = liveQuery.data ?? null;
  const historyQuery = useLiveNavHistory(liveVault?.agentId, live);
  const liveHistory = historyQuery.data ?? null;

  const sampleVault = SAMPLE_VAULT;
  const navUsd = live?.navUsd ?? sampleVault.navUsd;
  const aumFeeAccruedToday = (navUsd * sampleVault.managementFeeBps) / 10_000 / 365;

  return (
    <>
      <DashboardToolbar />
      <div className="mt-5">
        <LiveVaultBanner onVaultDetected={setLiveVault} />
      </div>

      <div className="mt-6">
        <VaultCard
          vault={sampleVault}
          sampleHistory={SAMPLE_REBALANCE_HISTORY}
          {...(live ? { live } : {})}
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

      {liveVault && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]">
          <CodeTag>strategy</CodeTag>
          <span className="font-display text-sm">
            Run a noop strategy tick now — produces a real audit event on-chain.
          </span>
          <span className="ml-auto">
            <RunTickButton vaultId={liveVault.agentId} />
          </span>
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
          <DangerZone
            {...(liveVault ? { vaultId: liveVault.agentId } : {})}
            {...(live?.identity.strategyId ? { strategyId: live.identity.strategyId } : {})}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Map a known seeded strategy ID to its human label. Falls through to a
 * generic display when the vault hired an unfamiliar strategy.
 */
function resolveStrategyName(strategyId: string | undefined): string {
  if (!strategyId) return 'Synapse Strategy';
  const seeded: Record<string, string> = {
    '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec':
      'Synapse Conservative Rebalancer',
    '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679':
      'Synapse Balanced Yield',
    '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1':
      'Synapse Aggressive Momentum',
  };
  return seeded[strategyId] ?? 'Synapse Strategy';
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
