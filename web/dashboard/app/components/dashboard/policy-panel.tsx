'use client';

import { useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { formatUsd, shortenAddress, shortenHash } from '@/lib/format';
import { synapseTarget, explorerTxUrl } from '@/lib/synapse-config';
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

const DEEPBOOK_TESTNET_PKG = '0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a';

type EditMode = 'spend' | 'expiry' | 'add-pkg' | 'remove-pkg' | null;

export function PolicyPanel({ live }: PolicyPanelProps) {
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [pkgToRemove, setPkgToRemove] = useState<string | null>(null);

  const spendCap = live ? formatUsd(live.spendCapUsd) : SAMPLE_POLICY.spendCap;
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
          {...(live
            ? { onEdit: () => setEditMode('spend'), editLabel: 'Update' }
            : {})}
        />
        <PolicyRow
          label="Allowlisted contracts"
          value={allowedDisplay}
          hint={allowedHint}
          accent="var(--accent-green)"
          {...(live
            ? { onEdit: () => setEditMode('add-pkg'), editLabel: '+ add' }
            : {})}
        />
        {live && allowedPkgs.length > 0 && (
          <div className="-mt-1 grid gap-1.5 pl-5">
            {allowedPkgs.map((pkg) => (
              <div
                key={pkg}
                className="flex items-center justify-between gap-2 rounded-sm border border-divider bg-paper px-2.5 py-1.5 font-mono text-[10px]"
              >
                <span className="truncate text-ink">{shortenAddress(pkg)}</span>
                <button
                  type="button"
                  onClick={() => {
                    setPkgToRemove(pkg);
                    setEditMode('remove-pkg');
                  }}
                  className="text-accent-orange hover:underline"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}
        <PolicyRow
          label="Expiry"
          value={expiry}
          hint={expiryHint}
          accent="var(--accent-yellow)"
          {...(live
            ? { onEdit: () => setEditMode('expiry'), editLabel: 'Extend' }
            : {})}
        />
        <PolicyRow
          label="Session key"
          value={shortenAddress(sessionAddr)}
          hint={sessionHint}
          accent="var(--accent-purple)"
        />
      </dl>

      {live && editMode === 'spend' && (
        <UpdateSpendModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'expiry' && (
        <ExtendExpiryModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'add-pkg' && (
        <AddPackageModal
          identity={live.identity}
          suggestion={
            live.identity.approvedPackages.includes(DEEPBOOK_TESTNET_PKG)
              ? null
              : DEEPBOOK_TESTNET_PKG
          }
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'remove-pkg' && pkgToRemove && (
        <RemovePackageModal
          identity={live.identity}
          pkg={pkgToRemove}
          onClose={() => {
            setPkgToRemove(null);
            setEditMode(null);
          }}
        />
      )}
    </div>
  );
}

function PolicyRow({
  label,
  value,
  hint,
  accent,
  onEdit,
  editLabel,
}: {
  label: string;
  value: string;
  hint: string;
  accent: string;
  onEdit?: () => void;
  editLabel?: string;
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
          <div className="flex items-baseline gap-3">
            <span className="num text-right text-sm">{value}</span>
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="font-mono text-[10px] text-accent-blue hover:underline"
              >
                {editLabel ?? 'edit'}
              </button>
            )}
          </div>
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-ink-mute">{hint}</p>
      </div>
    </div>
  );
}

// ===========================================================================
// Modals
// ===========================================================================

function useSubmitPolicy(): {
  submit: (args: { tx: Transaction; vaultId: string; successTitle: string }) => Promise<string>;
  pending: boolean;
} {
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();
  const queryClient = useQueryClient();

  async function submit({
    tx,
    vaultId,
    successTitle,
  }: {
    tx: Transaction;
    vaultId: string;
    successTitle: string;
  }): Promise<string> {
    toast.push({
      variant: 'info',
      title: 'Awaiting wallet signature',
      durationMs: 6000,
    });
    const signed = await signAndExecute({ transaction: tx });
    await suiClient.waitForTransaction({ digest: signed.digest, timeout: 30_000 });
    void queryClient.invalidateQueries({ queryKey: ['synapse-vault', vaultId] });
    toast.push({
      variant: 'success',
      title: successTitle,
      body: `tx ${shortenHash(signed.digest)}`,
      durationMs: 6000,
    });
    return signed.digest;
  }
  return { submit, pending: isPending };
}

function UpdateSpendModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const [value, setValue] = useState(identity.spendPerEpoch.toString());
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = /^\d+$/.test(value) && BigInt(value) > 0n;

  async function go() {
    if (!valid) {
      setError('Spend cap must be a positive integer (in MIST or raw atomic units).');
      return;
    }
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'update_spend_per_epoch'),
        arguments: [tx.object(identity.id), tx.pure.u64(value)],
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: 'Spend cap updated',
      });
      setDigest(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Spend cap updated' : 'Update spend cap'}
      accent="var(--accent-blue)"
      footer={
        digest ? (
          <button type="button" className="btn-flat" data-variant="primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-flat"
              data-variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-flat"
              data-variant="primary"
              onClick={go}
              disabled={!valid || pending || !account}
            >
              {pending ? 'Signing…' : 'Update on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <DoneBlock digest={digest} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls <code className="font-mono text-[11px]">agent::update_spend_per_epoch</code>.
            Owner-gated. The value is the raw cap in atomic units of the funding coin (for SUI,
            MIST = 1e9 per SUI). Current cap:{' '}
            <span className="font-mono">{identity.spendPerEpoch.toString()}</span>.
          </p>
          <label className="grid gap-1.5">
            <span className="font-display text-sm font-semibold">New cap (atomic units)</span>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            />
          </label>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function ExtendExpiryModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const [value, setValue] = useState((identity.expiryEpoch + 30n).toString());
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid =
    /^\d+$/.test(value) && BigInt(value) > identity.expiryEpoch;

  async function go() {
    if (!valid) {
      setError(`New expiry must be > current expiry (${identity.expiryEpoch.toString()}).`);
      return;
    }
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'extend_expiry'),
        arguments: [tx.object(identity.id), tx.pure.u64(value)],
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: 'Expiry extended',
      });
      setDigest(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Expiry extended' : 'Extend expiry'}
      accent="var(--accent-yellow)"
      footer={
        digest ? (
          <button type="button" className="btn-flat" data-variant="primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-flat"
              data-variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-flat"
              data-variant="primary"
              onClick={go}
              disabled={!valid || pending || !account}
            >
              {pending ? 'Signing…' : 'Extend on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <DoneBlock digest={digest} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls <code className="font-mono text-[11px]">agent::extend_expiry</code>. New
            expiry must be strictly greater than the current expiry epoch{' '}
            <span className="font-mono">{identity.expiryEpoch.toString()}</span>.
          </p>
          <label className="grid gap-1.5">
            <span className="font-display text-sm font-semibold">New expiry epoch</span>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            />
          </label>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function AddPackageModal({
  identity,
  suggestion,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  suggestion: string | null;
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const [pkg, setPkg] = useState(suggestion ?? '');
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = /^0x[0-9a-fA-F]{1,64}$/.test(pkg.trim());

  async function go() {
    if (!valid) {
      setError('Package must be a 0x-prefixed Sui address.');
      return;
    }
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'add_approved_package'),
        arguments: [tx.object(identity.id), tx.pure.address(pkg.trim())],
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: 'Package added to allowlist',
      });
      setDigest(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Allowlist extended' : 'Add allowlisted package'}
      accent="var(--accent-green)"
      footer={
        digest ? (
          <button type="button" className="btn-flat" data-variant="primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-flat"
              data-variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-flat"
              data-variant="primary"
              onClick={go}
              disabled={!valid || pending || !account}
            >
              {pending ? 'Signing…' : 'Add on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <DoneBlock digest={digest} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls <code className="font-mono text-[11px]">agent::add_approved_package</code>. The
            agent will then be permitted to route trades through this contract.
          </p>
          {suggestion && (
            <p className="rounded-sm border-l-2 border-accent-blue bg-paper p-3 font-mono text-[11px] text-ink-soft">
              Suggested · DeepBookV3 testnet package (required for the bundled strategies' SUI/USDC swaps).
            </p>
          )}
          <label className="grid gap-1.5">
            <span className="font-display text-sm font-semibold">Package address</span>
            <input
              type="text"
              value={pkg}
              onChange={(e) => setPkg(e.target.value)}
              placeholder="0x…"
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-[11px] outline-none focus:border-ink"
            />
          </label>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function RemovePackageModal({
  identity,
  pkg,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  pkg: string;
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'remove_approved_package'),
        arguments: [tx.object(identity.id), tx.pure.address(pkg)],
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: 'Package removed from allowlist',
      });
      setDigest(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Allowlist tightened' : 'Remove allowlisted package'}
      accent="var(--accent-orange)"
      footer={
        digest ? (
          <button type="button" className="btn-flat" data-variant="primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-flat"
              data-variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-flat"
              data-variant="danger"
              onClick={go}
              disabled={pending || !account}
            >
              {pending ? 'Signing…' : 'Remove on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <DoneBlock digest={digest} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls <code className="font-mono text-[11px]">agent::remove_approved_package</code>{' '}
            for <span className="font-mono text-[11px]">{shortenAddress(pkg)}</span>. After this
            lands, any agent attempt to call into that package reverts with
            <code className="font-mono text-[11px]"> ENotWhitelisted</code>.
          </p>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function DoneBlock({ digest }: { digest: string }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-state-active">● confirmed on-chain</p>
      <a
        href={explorerTxUrl(digest)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[11px] text-accent-blue underline"
      >
        tx {shortenHash(digest)} ↗
      </a>
    </div>
  );
}

function ErrorBlock({ msg }: { msg: string }) {
  return (
    <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
      {msg}
    </pre>
  );
}
