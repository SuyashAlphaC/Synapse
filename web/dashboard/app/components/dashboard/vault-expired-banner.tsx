'use client';

import { CodeTag } from '../ui/code-tag';
import { isVaultExpired } from '@/lib/vault-expiry';
import { SYNAPSE_OPS_RUNBOOK_URL } from '@/lib/synapse-config';

interface VaultExpiredBannerProps {
  currentEpoch: bigint;
  expiryEpoch: bigint;
  /** When true, mention Policy → Extend (dashboard). Inspector is read-only. */
  showExtendHint?: boolean;
}

export function VaultExpiredBanner({
  currentEpoch,
  expiryEpoch,
  showExtendHint = true,
}: VaultExpiredBannerProps) {
  if (!isVaultExpired(currentEpoch, expiryEpoch)) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]"
      style={{ borderColor: 'var(--accent-orange)' }}
      role="status"
    >
      <span
        className="inline-flex h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: 'var(--accent-orange)' }}
        aria-hidden
      />
      <CodeTag>expired</CodeTag>
      <span className="font-display text-sm">
        This vault reached its expiry epoch ({expiryEpoch.toString()}). Sui is at epoch{' '}
        {currentEpoch.toString()}, so the agent session cannot spend or swap — hosted runtime
        ticks exit as noops with no new on-chain actions.
        {showExtendHint ? (
          <>
            {' '}
            Connect the owner wallet and use Policy → Expiry → Extend to resume autonomous
            ticks.
          </>
        ) : (
          <> Historical audit events remain queryable below.</>
        )}{' '}
        <a
          href={SYNAPSE_OPS_RUNBOOK_URL}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-accent-blue hover:underline"
        >
          Runbook ↗
        </a>
      </span>
    </div>
  );
}
