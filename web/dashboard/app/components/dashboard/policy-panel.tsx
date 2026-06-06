'use client';

import { useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
  useSuiClient,
} from '@mysten/dapp-kit';
import { addDelegateKey } from '@mysten-incubation/memwal/account';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { formatUsd, shortenAddress, shortenHash } from '@/lib/format';
import {
  synapseTarget,
  explorerTxUrl,
  MEMWAL_PACKAGE_ID,
  NETWORK,
} from '@/lib/synapse-config';
import { buildSetWalrusConsentPTB, buildSetRequiresAttestationPTB } from '@/lib/ptb';
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

// Canonical DeepBookV3 testnet package, sourced from
// @mysten/deepbook-v3 (testnetPackageIds.DEEPBOOK_PACKAGE_ID).
// Update when the SDK ships a new package upgrade.
const DEEPBOOK_TESTNET_PKG = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';

type EditMode =
  | 'spend'
  | 'expiry'
  | 'add-pkg'
  | 'remove-pkg'
  | 'op-cap'
  | 'walrus-consent'
  | 'attestation'
  | 'memwal-register'
  | null;

/**
 * Classify the on-chain `memwal_delegate_key_id` field:
 *   - 32 bytes → properly-shaped public key, the post-fix format
 *   - 64 bytes → ASCII-hex of a private key (legacy leak — needs key rotation)
 *   - 0 bytes  → MemWal skipped at mint
 *   - other    → unrecognised
 */
type MemwalDelegateStatus = 'public-key' | 'leaked-private-key' | 'skipped' | 'unknown';

function classifyDelegateKey(bytes: Uint8Array): MemwalDelegateStatus {
  if (bytes.length === 0) return 'skipped';
  if (bytes.length === 32) return 'public-key';
  if (bytes.length === 64) return 'leaked-private-key';
  return 'unknown';
}

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
        {live && (
          <PolicyRow
            label="Operational budget"
            value={
              live.identity.operationalCapPerEpoch === 0n
                ? 'Not set'
                : `${(Number(live.identity.operationalSpentThisEpoch) / 1e9).toFixed(4)} / ${(Number(live.identity.operationalCapPerEpoch) / 1e9).toFixed(4)} SUI`
            }
            hint={
              live.identity.operationalCapPerEpoch === 0n
                ? 'Agent must be manually refueled — set a cap to enable self-funding'
                : 'Per-epoch cap on `pull_operational_funds`; auto-refuel pulls from treasury'
            }
            accent="var(--accent-coral)"
            onEdit={() => setEditMode('op-cap')}
            editLabel={live.identity.operationalCapPerEpoch === 0n ? '+ enable' : 'Update'}
          />
        )}
        {live && (() => {
          const status = classifyDelegateKey(live.identity.memwalDelegateKeyId);
          const accountIdUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(
            live.identity.memwalAccountId,
          );
          const hasAccount = accountIdUtf8.startsWith('0x');
          let value: string;
          let hint: string;
          let editLabel: string | null = null;
          let editMode: EditMode | null = null;
          switch (status) {
            case 'public-key':
              value = hasAccount
                ? 'Registered shape — may need relayer registration'
                : 'Public key on-chain';
              hint = hasAccount
                ? `MemWal account ${shortenAddress(accountIdUtf8)} · click Register if a tick fails MemWal auth`
                : 'MemWal account ID missing — no relayer registration possible';
              editLabel = hasAccount ? 'Register' : null;
              editMode = hasAccount ? 'memwal-register' : null;
              break;
            case 'leaked-private-key':
              value = '⚠ Legacy: private key leaked on-chain';
              hint =
                'Rotate this delegate in your MemWal dashboard immediately; this vault should be revoked + re-minted.';
              break;
            case 'skipped':
              value = 'Skipped at mint';
              hint = 'No MemWal persistence; DCA/EMA counters reset every tick.';
              break;
            default:
              value = `Unknown shape (${live.identity.memwalDelegateKeyId.length} bytes)`;
              hint = 'Unexpected delegate key format — investigate.';
          }
          return (
            <PolicyRow
              label="MemWal delegate"
              value={value}
              hint={hint}
              accent="var(--accent-coral)"
              {...(editLabel && editMode
                ? { onEdit: () => setEditMode(editMode), editLabel }
                : {})}
            />
          );
        })()}

        {live && (
          <PolicyRow
            label="Walrus execution"
            value={
              live.identity.acceptsWalrusExecution
                ? 'Opted in · runtime loads strategy bundle from Walrus'
                : 'Opted out · runtime falls back to seeded impls only'
            }
            hint={
              live.identity.acceptsWalrusExecution
                ? 'Bundle is hash-verified against on-chain code_hash before each tick'
                : 'Required to execute any non-seeded marketplace strategy'
            }
            accent="var(--accent-purple)"
            onEdit={() => setEditMode('walrus-consent')}
            editLabel={live.identity.acceptsWalrusExecution ? 'Revoke' : '+ enable'}
          />
        )}

        {live && (
          <PolicyRow
            label="Attested execution"
            value={
              live.identity.requiresAttestation
                ? 'Required · chain rejects trades not signed by the enclave'
                : 'Off · trades execute without enclave attestation'
            }
            hint={
              live.identity.requiresAttestation
                ? 'Every spend aborts unless a valid Nautilus enclave decision was attested this epoch'
                : 'Enable to require a Nautilus (TEE) enclave signature before any trade'
            }
            accent="var(--accent-blue)"
            onEdit={() => setEditMode('attestation')}
            editLabel={live.identity.requiresAttestation ? 'Disable' : '+ require'}
          />
        )}
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
      {live && editMode === 'op-cap' && (
        <OperationalCapModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'walrus-consent' && (
        <WalrusConsentModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'attestation' && (
        <AttestationModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
        />
      )}
      {live && editMode === 'memwal-register' && (
        <MemwalRegisterModal
          identity={live.identity}
          onClose={() => setEditMode(null)}
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

function OperationalCapModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const currentSui = Number(identity.operationalCapPerEpoch) / 1e9;
  const [valueSui, setValueSui] = useState(
    currentSui > 0 ? currentSui.toString() : '0.1',
  );
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = /^\d+(\.\d+)?$/.test(valueSui.trim()) && Number(valueSui) > 0;
  const mistValue = valid ? BigInt(Math.round(Number(valueSui) * 1e9)) : 0n;

  async function go() {
    if (!valid) {
      setError('Cap must be a positive decimal (in SUI).');
      return;
    }
    setError(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'set_operational_cap'),
        arguments: [tx.object(identity.id), tx.pure.u64(mistValue)],
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: 'Operational cap set on-chain',
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
      title={digest ? 'Operational budget set' : 'Set operational budget'}
      accent="var(--accent-coral)"
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
              {pending ? 'Signing…' : 'Set on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <DoneBlock digest={digest} />
          <p className="text-ink-soft">
            The runtime will start auto-refueling from the treasury on its next tick.
            No more manual <code className="font-mono text-[11px]">sui client pay-sui</code>{' '}
            top-ups — the vault funds its own operational expenses within the cap.
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls{' '}
            <code className="font-mono text-[11px]">agent::set_operational_cap</code>. The
            session can then pull up to this many SUI per epoch from the treasury via
            <code className="ml-1 font-mono text-[11px]">pull_operational_funds&lt;SUI&gt;</code>,
            bounded automatically by the Move VM.
          </p>
          {currentSui > 0 && (
            <p className="font-mono text-[11px] text-ink-mute">
              Current cap: {currentSui.toFixed(4)} SUI/epoch · spent this epoch{' '}
              {(Number(identity.operationalSpentThisEpoch) / 1e9).toFixed(4)} SUI
            </p>
          )}
          <label className="grid gap-1.5">
            <span className="font-display text-sm font-semibold">
              New cap (SUI per epoch)
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={valueSui}
              onChange={(e) => setValueSui(e.target.value)}
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            />
            <span className="font-mono text-[10px] text-ink-mute">
              Atomic: {valid ? mistValue.toString() : '—'} MIST. Recommended: 0.05–0.2 SUI
              for a vault ticking every 10 min.
            </span>
          </label>
          {error && (
            <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
              {error}
            </pre>
          )}
        </div>
      )}
    </Modal>
  );
}

function WalrusConsentModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const enabling = !identity.acceptsWalrusExecution;
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    try {
      const tx = buildSetWalrusConsentPTB({
        agentId: identity.id,
        accept: enabling,
      });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: enabling ? 'Walrus execution enabled' : 'Walrus execution revoked',
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
      title={
        digest
          ? enabling
            ? 'Walrus execution enabled'
            : 'Walrus execution revoked'
          : enabling
            ? 'Enable Walrus-loaded strategy execution'
            : 'Revoke Walrus consent'
      }
      accent={enabling ? 'var(--accent-purple)' : 'var(--accent-orange)'}
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
              data-variant={enabling ? 'primary' : 'danger'}
              onClick={go}
              disabled={pending || !account}
            >
              {pending ? 'Signing…' : enabling ? 'Enable on-chain' : 'Revoke on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <DoneBlock digest={digest} />
          <p className="text-ink-soft">
            {enabling
              ? 'On the next tick, the runtime will fetch this vault’s strategy bundle from Walrus, verify its sha256 matches the on-chain code_hash, and execute it.'
              : 'On the next tick, the runtime will fall back to its locally bundled strategy implementations. The vault’s hired strategy will no longer execute as published.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls{' '}
            <code className="font-mono text-[11px]">agent::set_walrus_consent</code>. Owner-only.
            {enabling
              ? ' Required so the runtime can fetch + hash-verify + execute any non-seeded marketplace strategy.'
              : ' After this lands, the runtime stops executing the vault’s strategy bundle and falls back to its built-in implementations.'}
          </p>
          <p className="rounded-sm border-l-2 border-accent-blue bg-paper p-3 font-mono text-[11px] text-ink-soft">
            Trust model: loaded code runs with full runtime privileges. The
            sha256 guarantee ties what runs to what the strategist committed to
            on-chain — it does not prevent the bundle from reading env or
            opening sockets. Sandboxing is a follow-up.
          </p>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function AttestationModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const { submit, pending } = useSubmitPolicy();
  const enabling = !identity.requiresAttestation;
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    try {
      const tx = buildSetRequiresAttestationPTB({ agentId: identity.id, required: enabling });
      const d = await submit({
        tx,
        vaultId: identity.id,
        successTitle: enabling ? 'Attestation required' : 'Attestation requirement removed',
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
      title={
        digest
          ? enabling
            ? 'Attestation required'
            : 'Attestation requirement removed'
          : enabling
            ? 'Require enclave-attested decisions'
            : 'Stop requiring attestation'
      }
      accent={enabling ? 'var(--accent-blue)' : 'var(--accent-orange)'}
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
              data-variant={enabling ? 'primary' : 'danger'}
              onClick={go}
              disabled={pending || !account}
            >
              {pending ? 'Signing…' : enabling ? 'Require on-chain' : 'Remove on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <DoneBlock digest={digest} />
          <p className="text-ink-soft">
            {enabling
              ? 'The Move spend gate now aborts any trade unless a valid Nautilus enclave decision was attested this epoch. The chain — not the runtime — enforces it.'
              : 'Trades will execute without an enclave signature again.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls{' '}
            <code className="font-mono text-[11px]">agent::set_requires_attestation</code>. Owner-only.
            {enabling
              ? ' After this lands, every spend by this vault aborts (ENotAttested) unless decision_attestation::attest_decision verified an enclave signature this epoch.'
              : ' The vault returns to executing trades without enclave attestation.'}
          </p>
          <p className="rounded-sm border-l-2 border-accent-blue bg-paper p-3 font-mono text-[11px] text-ink-soft">
            Nautilus: the AI decision is produced + signed inside an attested TEE
            enclave; the Move VM verifies that signature before the swap. Requires
            a registered enclave (real Oyster/AWS Nitro, or a dev box on testnet).
            {enabling
              ? ' If you use Hosted runtime, set enclave URL + object ID when enabling — every tick is attested on-chain.'
              : null}
          </p>
          {error && <ErrorBlock msg={error} />}
        </div>
      )}
    </Modal>
  );
}

function MemwalRegisterModal({
  identity,
  onClose,
}: {
  identity: PricedVaultState['identity'];
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const accountIdUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(
    identity.memwalAccountId,
  );
  const publicKeyHex = Array.from(identity.memwalDelegateKeyId)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  async function go() {
    if (!account) {
      setError('Connect a wallet first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await addDelegateKey({
        packageId: MEMWAL_PACKAGE_ID,
        accountId: accountIdUtf8,
        publicKey: identity.memwalDelegateKeyId,
        label: `Synapse Vault ${shortenHash(identity.id)} (retry)`,
        suiNetwork: NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
        suiClient,
        walletSigner: {
          address: account.address,
          signAndExecuteTransaction: async ({ transaction }) => {
            const r = await signAndExecute({ transaction });
            return { digest: r.digest };
          },
          signPersonalMessage: async ({ message }) => {
            const r = await signPersonalMessage({ message });
            return { signature: r.signature };
          },
        },
      });
      setDigest(result.digest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const pending = submitting || isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Delegate registered with MemWal' : 'Register MemWal delegate'}
      accent="var(--accent-coral)"
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
              disabled={pending || !account}
            >
              {pending ? 'Signing…' : 'Register on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <DoneBlock digest={digest} />
          <p className="text-ink-soft">
            The MemWal relayer now accepts signatures from this vault&rsquo;s delegate. The
            runtime&rsquo;s next tick will successfully recall + remember.
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-soft">
            Calls{' '}
            <code className="font-mono text-[11px]">memwal::account::add_delegate_key</code>{' '}
            against your MemWal account, authorizing this vault&rsquo;s on-chain delegate
            public key. Owner-signed via your connected wallet. Use this when:
          </p>
          <ul className="ml-4 list-disc space-y-1 text-xs text-ink-soft">
            <li>The mint-time registration failed (e.g. SDK version mismatch).</li>
            <li>You rotated your MemWal account or moved this vault to a new account.</li>
            <li>Runtime ticks are aborting with MemWal authentication errors.</li>
          </ul>
          <dl className="rounded-sm border border-divider bg-paper p-3">
            <RowKv label="MemWal account" value={shortenAddress(accountIdUtf8)} />
            <RowKv
              label="Delegate public key"
              value={`${publicKeyHex.slice(0, 12)}…${publicKeyHex.slice(-6)}`}
            />
            <RowKv label="Label" value={`Synapse Vault ${shortenHash(identity.id)} (retry)`} />
          </dl>
          {error && (
            <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
              {error}
            </pre>
          )}
        </div>
      )}
    </Modal>
  );
}

function RowKv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-divider/50 py-1 last:border-0">
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <span className="num font-mono text-[10px] text-ink">{value}</span>
    </div>
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
