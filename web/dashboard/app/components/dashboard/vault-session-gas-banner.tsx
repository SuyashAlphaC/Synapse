'use client';

import { CodeTag } from '../ui/code-tag';
import type { PricedVaultState } from '../../hooks/use-live-vault';
import {
  effectiveOperationalSpent,
  formatSuiFromMist,
  isOperationalBudgetExhausted,
  isSessionGasCritical,
  isSessionGasLow,
  sessionOperatingMinMist,
} from '@/lib/session-gas';
import { isVaultExpired } from '@/lib/vault-expiry';
import { SYNAPSE_OPS_RUNBOOK_URL } from '@/lib/synapse-config';

interface VaultSessionGasBannerProps {
  live: PricedVaultState;
  /** Dashboard: link to Fund session / Policy. Inspector: read-only hints. */
  showOperatorHints?: boolean;
}

export function VaultSessionGasBanner({
  live,
  showOperatorHints = true,
}: VaultSessionGasBannerProps) {
  const { identity, currentEpoch, sessionBalanceMist } = live;

  if (identity.revoked) return null;
  if (isVaultExpired(currentEpoch, identity.expiryEpoch)) return null;

  const gasLow = isSessionGasLow(sessionBalanceMist, identity.acceptsWalrusExecution);
  const gasCritical = isSessionGasCritical(sessionBalanceMist);
  const opExhausted = isOperationalBudgetExhausted(
    currentEpoch,
    identity.operationalCapPerEpoch,
    identity.operationalSpentThisEpoch,
    identity.operationalLastEpochSeen,
  );

  if (!gasLow && !opExhausted) return null;

  const minMist = sessionOperatingMinMist(identity.acceptsWalrusExecution);
  const opSpentEffective = effectiveOperationalSpent(
    currentEpoch,
    identity.operationalSpentThisEpoch,
    identity.operationalLastEpochSeen,
  );
  const opSpent = formatSuiFromMist(opSpentEffective);
  const opCap = formatSuiFromMist(identity.operationalCapPerEpoch);

  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-md border-2 border-ink bg-paper-strong px-5 py-3 shadow-[2px_2px_0_0_var(--ink)]"
      style={{ borderColor: 'var(--accent-yellow)' }}
      role="status"
    >
      <span
        className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: 'var(--accent-yellow)' }}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CodeTag>runtime gas</CodeTag>
          <span className="font-display text-sm font-semibold text-ink">
            Hosted ticks may be failing
          </span>
        </div>

        {gasLow && (
          <p className="font-display text-sm text-ink-soft">
            Session gas wallet{' '}
            <code className="font-mono text-[11px]">{shortenAddr(identity.sessionAddr)}</code> has{' '}
            <strong className="font-semibold text-ink">
              {formatSuiFromMist(sessionBalanceMist)} SUI
            </strong>
            {gasCritical ? (
              <> — too low for on-chain ticks (needs ~{formatSuiFromMist(minMist)}+ for auto-refuel).</>
            ) : (
              <> — below the runtime floor (~{formatSuiFromMist(minMist)} SUI).</>
            )}
            {showOperatorHints ? (
              <>
                {' '}
                Use <strong className="font-semibold text-ink">Fund session</strong> below (send at
                least 0.1 SUI from the owner wallet). Auto-refuel from treasury cannot run until
                the session can pay gas for <code className="font-mono text-[11px]">pull_operational_funds</code>.
              </>
            ) : (
              <> Fund the session address or raise the operational budget on the owner dashboard.</>
            )}
          </p>
        )}

        {opExhausted && (
          <p className="font-display text-sm text-ink-soft">
            Operational budget for epoch {currentEpoch.toString()} is exhausted (
            {opSpent} / {opCap} SUI pulled from treasury this epoch).
            {showOperatorHints ? (
              <>
                {' '}
                Open <strong className="font-semibold text-ink">Policy → Operational budget →
                Update</strong> to raise the cap, or wait for the next epoch. Ensure the treasury
                holds SUI for future pulls.
              </>
            ) : (
              <> Raise the operational cap or wait for the next epoch.</>
            )}
          </p>
        )}

        <p className="font-mono text-[11px] text-ink-mute">
          <a
            href={SYNAPSE_OPS_RUNBOOK_URL}
            target="_blank"
            rel="noreferrer"
            className="text-accent-blue hover:underline"
          >
            Operations runbook ↗
          </a>
          {' — decision tree, CloudWatch commands, pre-flight checklist.'}
        </p>
      </div>
    </div>
  );
}

function shortenAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
