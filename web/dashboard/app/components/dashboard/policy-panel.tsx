'use client';

import { CodeTag } from '../ui/code-tag';
import { formatUsd, shortenAddress } from '@/lib/format';
import type { PricedVaultState } from '../../hooks/use-live-vault';
import { SAMPLE_VAULT } from '@/lib/sample-data';

interface PolicyPanelProps {
  /** Real on-chain identity. When provided, every row reflects on-chain state. */
  live?: PricedVaultState;
}

const SAMPLE_POLICY = {
  spendCap: '5%/epoch · ≈ $62,379',
  spendCapHint: 'Per-epoch outflow cap, enforced by wallet::spend',
  allowedPackages: ['DeepBookV3 SUI/USDC pool'],
  allowedHint: 'Single approved counterparty package',
  expiry: '63 epochs remaining',
  expiryHint: 'Automatic kill at epoch 2148',
  sessionAddr: SAMPLE_VAULT.sessionAddr,
  sessionHint: 'Active 27 days · rotatable',
};

export function PolicyPanel({ live }: PolicyPanelProps) {
  const spendCap = live
    ? formatUsd(live.spendCapUsd)
    : SAMPLE_POLICY.spendCap;
  const spendCapHint = live
    ? `Raw cap ${live.identity.spendPerEpoch.toString()} · enforced by wallet::spend`
    : SAMPLE_POLICY.spendCapHint;

  const allowedPkgs = live ? live.identity.approvedPackages : SAMPLE_POLICY.allowedPackages;
  const allowedDisplay =
    allowedPkgs.length === 0
      ? 'None (no contracts allow-listed)'
      : allowedPkgs.length === 1
        ? shortenAddress(allowedPkgs[0]!)
        : `${allowedPkgs.length} packages`;
  const allowedHint = live
    ? allowedPkgs.length === 0
      ? 'Vault rejects every contract call — must be governance-extended'
      : `${allowedPkgs.length} contract allowlist entries`
    : SAMPLE_POLICY.allowedHint;

  const expiry = live ? `Epoch ${live.identity.expiryEpoch.toString()}` : SAMPLE_POLICY.expiry;
  const expiryHint = live
    ? `Spent this epoch: ${live.identity.spentThisEpoch.toString()} · auto-kill on expiry`
    : SAMPLE_POLICY.expiryHint;

  const sessionAddr = live ? live.identity.sessionAddr : SAMPLE_POLICY.sessionAddr;
  const sessionHint = live
    ? live.identity.revoked
      ? 'REVOKED — session key has no on-chain authority'
      : 'Active · rotatable via agent::rotate_session_key'
    : SAMPLE_POLICY.sessionHint;

  return (
    <div className="card-flat p-6">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="font-display text-2xl font-bold">Policy bounds</h3>
        <CodeTag>{live ? 'on-chain' : 'demo'}</CodeTag>
      </div>
      <dl className="grid gap-4">
        <PolicyRow
          label="Spend cap"
          value={spendCap}
          hint={spendCapHint}
          accent="var(--accent-blue)"
        />
        <PolicyRow
          label="Allowlisted contracts"
          value={allowedDisplay}
          hint={allowedHint}
          accent="var(--accent-green)"
        />
        <PolicyRow label="Expiry" value={expiry} hint={expiryHint} accent="var(--accent-yellow)" />
        <PolicyRow
          label="Session key"
          value={shortenAddress(sessionAddr)}
          hint={sessionHint}
          accent="var(--accent-purple)"
        />
      </dl>
    </div>
  );
}

function PolicyRow({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-divider pb-3 last:border-0 last:pb-0">
      <span
        className="mt-1 h-2.5 w-2.5 rounded-sm border border-ink"
        style={{ backgroundColor: accent }}
      />
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-display text-sm font-semibold">{label}</span>
          <span className="num text-right text-sm">{value}</span>
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-ink-mute">{hint}</p>
      </div>
    </div>
  );
}
