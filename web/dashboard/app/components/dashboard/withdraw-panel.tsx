'use client';

import { useMemo, useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { explorerTxUrl } from '@/lib/synapse-config';
import { buildDrainAllPTB, buildDrainPTB, buildWithdrawPTB } from '@/lib/ptb';
import { formatUsd, shortenAddress, shortenHash } from '@/lib/format';
import type { PricedHolding } from '../../hooks/use-live-vault';

interface WithdrawPanelProps {
  vaultId: string;
  /** On-chain vault owner — only this address may sign withdraw/drain PTBs. */
  owner: string;
  /** Treasury holdings from live vault state. */
  holdings: PricedHolding[];
}

/**
 * Owner-only treasury withdrawal. Calls `wallet::withdraw<T>` for partial
 * pulls or `wallet::drain<T>` for a full exit on one coin type. Works with
 * multisig owners — connect the multisig wallet and approve the PTB like any
 * other Sui transaction.
 */
export function WithdrawPanel({ vaultId, owner, holdings }: WithdrawPanelProps) {
  const account = useCurrentAccount();
  const [open, setOpen] = useState(false);

  const isOwner =
    account !== null &&
    normalizeSuiAddress(account.address) === normalizeSuiAddress(owner);

  const fundable = holdings.filter((h) => h.amount > 0n);

  return (
    <>
      <div className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-6 shadow-[4px_4px_0_0_var(--ink)]">
        <div
          className="absolute inset-x-0 top-0 h-1.5"
          style={{ backgroundColor: 'var(--accent-green)' }}
        />
        <div className="mb-3 flex items-center gap-2 text-accent-green">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
            <CodeTag>withdraw</CodeTag>
          </span>
        </div>
        <h3 className="font-display text-2xl font-bold">Withdraw treasury</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
          Pull accumulated yield and principal back to the vault owner via{' '}
          <code className="font-mono text-[12px]">wallet::withdraw</code> or{' '}
          <code className="font-mono text-[12px]">wallet::drain</code>. Only the
          owner wallet (including a DAO multisig) may sign.
        </p>
        <p className="mt-2 font-mono text-[10px] text-ink-mute">
          Owner {shortenAddress(owner)}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-flat"
            data-variant="primary"
            disabled={!account || fundable.length === 0}
            onClick={() => setOpen(true)}
            title={
              !account
                ? 'Connect a wallet to withdraw'
                : fundable.length === 0
                  ? 'Treasury is empty'
                  : !isOwner
                    ? 'Connect the vault owner wallet to withdraw'
                    : undefined
            }
          >
            Withdraw funds
          </button>
          {account && !isOwner && (
            <span className="font-mono text-[10px] text-state-revoked">
              Connected wallet is not the vault owner
            </span>
          )}
        </div>
      </div>
      {open && (
        <WithdrawModal
          vaultId={vaultId}
          owner={owner}
          holdings={fundable}
          isOwner={isOwner}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

type WithdrawMode = 'partial' | 'drain' | 'drain-all';

function WithdrawModal({
  vaultId,
  owner,
  holdings,
  isOwner,
  onClose,
}: {
  vaultId: string;
  owner: string;
  holdings: PricedHolding[];
  isOwner: boolean;
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [pickedType, setPickedType] = useState<string | null>(
    holdings[0]?.coinTypeTag ?? null,
  );
  const [mode, setMode] = useState<WithdrawMode>('partial');
  const [amountInput, setAmountInput] = useState('');
  const [recipient, setRecipient] = useState('');
  const [digest, setDigest] = useState<string | null>(null);
  const [completedMode, setCompletedMode] = useState<WithdrawMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const picked = useMemo(
    () => holdings.find((h) => h.coinTypeTag === pickedType) ?? null,
    [holdings, pickedType],
  );

  const recipientAddr = recipient.trim() || account?.address || '';
  const decimals = picked?.decimals ?? 9;
  const amount =
    mode === 'partial' ? parseAmount(amountInput, decimals) : picked?.amount ?? null;

  const valid =
    isOwner &&
    holdings.length > 0 &&
    (mode === 'drain-all' ||
      (picked !== null &&
        picked.amount > 0n &&
        (mode === 'drain' ||
          (recipientAddr.length > 0 &&
            amount !== null &&
            amount > 0n &&
            amount <= picked.amount))));

  async function submit() {
    setError(null);
    if (!account || !valid) {
      setError(
        mode === 'drain-all'
          ? 'Connect the owner wallet to drain all treasury assets.'
          : 'Pick a coin, amount, and connect the owner wallet.',
      );
      return;
    }
    if (normalizeSuiAddress(account.address) !== normalizeSuiAddress(owner)) {
      setError('Only the vault owner may withdraw. Connect the owner / multisig wallet.');
      return;
    }
    try {
      const tx =
        mode === 'drain-all'
          ? buildDrainAllPTB({
              agentId: vaultId,
              coinTypeTags: holdings.map((h) => h.coinTypeTag),
            })
          : mode === 'drain'
            ? buildDrainPTB({ agentId: vaultId, coinTypeTag: picked!.coinTypeTag })
            : buildWithdrawPTB({
                agentId: vaultId,
                amount: amount!,
                to: recipientAddr,
                coinTypeTag: picked!.coinTypeTag,
              });

      const drainSymbols =
        mode === 'drain-all'
          ? holdings.map((h) => h.symbol).join(', ')
          : picked?.symbol ?? '';

      toast.push({
        variant: 'info',
        title: 'Awaiting owner signature',
        body:
          mode === 'drain-all'
            ? `Approve batched drain of ${holdings.length} coin type(s): ${drainSymbols}.`
            : mode === 'drain'
              ? `Approve drain of all ${drainSymbols} from the vault treasury.`
              : 'Approve the withdraw PTB — funds transfer to the recipient you specified.',
        durationMs: 6000,
      });

      const signed = await signAndExecute({ transaction: tx });
      await suiClient.waitForTransaction({ digest: signed.digest, timeout: 30_000 });
      void queryClient.invalidateQueries({ queryKey: ['synapse-vault', vaultId] });
      void queryClient.invalidateQueries({ queryKey: ['synapse-nav-history', vaultId] });
      setCompletedMode(mode);
      setDigest(signed.digest);
      toast.push({
        variant: 'success',
        title:
          mode === 'drain-all'
            ? 'All treasury assets drained'
            : mode === 'drain'
              ? 'Treasury drained on-chain'
              : 'Withdrawal landed on-chain',
        body: `tx ${shortenHash(signed.digest)}`,
        durationMs: 6000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const successMode = completedMode ?? mode;

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Withdrawal confirmed' : 'Withdraw from vault'}
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
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-flat"
              data-variant="primary"
              onClick={submit}
              disabled={!valid || isPending}
            >
              {isPending
                ? 'Signing…'
                : mode === 'drain-all'
                  ? 'Drain all assets'
                  : mode === 'drain'
                    ? 'Drain coin'
                    : 'Withdraw on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <p className="text-state-active">● treasury updated</p>
          <p className="text-ink-soft">
            {successMode === 'drain-all'
              ? `All ${holdings.length} treasury coin type(s) were sent to the vault owner in one PTB.`
              : successMode === 'drain'
                ? `All ${picked?.symbol ?? 'assets'} were sent to the vault owner.`
                : 'Funds were transferred to the recipient address in the same PTB.'}
          </p>
          <a
            href={explorerTxUrl(digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-green underline"
          >
            tx {shortenHash(digest)} ↗
          </a>
        </div>
      ) : !account ? (
        <p className="text-sm text-ink-soft">Connect a wallet first.</p>
      ) : !isOwner ? (
        <div className="space-y-2 text-sm">
          <p className="text-state-revoked">
            Connected wallet is not the vault owner. Connect{' '}
            <code className="font-mono text-[11px]">{shortenAddress(owner)}</code> — for a DAO,
            use your multisig wallet so the PTB collects the required signatures.
          </p>
        </div>
      ) : holdings.length === 0 ? (
        <p className="text-sm text-ink-soft">Treasury is empty — nothing to withdraw.</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              {mode === 'drain-all' ? 'treasury assets (all will drain)' : 'treasury coin'}
            </p>
            <div className="grid gap-2">
              {holdings.map((h) => (
                <button
                  type="button"
                  key={h.coinTypeTag}
                  disabled={mode === 'drain-all'}
                  onClick={() => {
                    if (mode === 'drain-all') return;
                    setPickedType(h.coinTypeTag);
                    setAmountInput('');
                  }}
                  className={`group grid grid-cols-[1fr_auto] items-center gap-3 rounded-sm border-2 px-3 py-2.5 text-left transition ${
                    mode === 'drain-all' || pickedType === h.coinTypeTag
                      ? 'border-ink bg-paper-strong shadow-[2px_2px_0_0_var(--ink)]'
                      : 'border-divider bg-paper hover:border-ink'
                  } ${mode === 'drain-all' ? 'cursor-default opacity-90' : ''}`}
                >
                  <div>
                    <p className="font-display text-sm font-semibold">{h.symbol}</p>
                    <p className="font-mono text-[10px] text-ink-mute">{h.coinTypeTag}</p>
                  </div>
                  <div className="text-right">
                    <p className="num font-semibold">
                      {humanFromAtomic(h.amount, h.decimals)} {h.symbol}
                    </p>
                    {h.valueUsd > 0 && (
                      <p className="font-mono text-[10px] text-ink-mute">{formatUsd(h.valueUsd)}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-sm border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${
                mode === 'partial'
                  ? 'border-ink bg-paper-strong shadow-[2px_2px_0_0_var(--ink)]'
                  : 'border-divider bg-paper'
              }`}
              onClick={() => setMode('partial')}
            >
              Partial
            </button>
            <button
              type="button"
              className={`rounded-sm border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${
                mode === 'drain'
                  ? 'border-ink bg-paper-strong shadow-[2px_2px_0_0_var(--ink)]'
                  : 'border-divider bg-paper'
              }`}
              onClick={() => setMode('drain')}
            >
              Drain coin
            </button>
            <button
              type="button"
              className={`rounded-sm border-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${
                mode === 'drain-all'
                  ? 'border-ink bg-paper-strong shadow-[2px_2px_0_0_var(--ink)]'
                  : 'border-divider bg-paper'
              }`}
              onClick={() => setMode('drain-all')}
            >
              Drain all assets
            </button>
          </div>

          {mode === 'partial' && picked && (
            <>
              <label className="grid gap-1.5">
                <span className="font-display text-sm font-semibold">Amount ({picked.symbol})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder={`max ${humanFromAtomic(picked.amount, picked.decimals)}`}
                  className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
                />
              </label>
              <div className="flex gap-2 font-mono text-[10px]">
                {[0.25, 0.5, 1].map((frac) => (
                  <button
                    type="button"
                    key={frac}
                    onClick={() =>
                      setAmountInput(
                        humanFromAtomic(
                          (picked.amount * BigInt(Math.round(frac * 1000))) / 1000n,
                          picked.decimals,
                        ),
                      )
                    }
                    className="text-accent-green hover:underline"
                  >
                    {frac === 1 ? 'max' : `${frac * 100}%`}
                  </button>
                ))}
              </div>
              <label className="grid gap-1.5">
                <span className="font-display text-sm font-semibold">Recipient address</span>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder={account.address}
                  className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
                />
                <span className="font-mono text-[10px] text-ink-mute">
                  Defaults to your connected wallet. Use your DAO treasury address if different.
                </span>
              </label>
            </>
          )}

          {mode === 'drain' && picked && (
            <p className="rounded-sm border-l-2 border-accent-green bg-paper p-3 text-sm text-ink-soft">
              <code className="font-mono text-[11px]">wallet::drain</code> sends the full{' '}
              {picked.symbol} balance to the vault owner{' '}
              <code className="font-mono text-[11px]">{shortenAddress(owner)}</code> inside the
              Move call — no separate recipient field.
            </p>
          )}

          {mode === 'drain-all' && (
            <p className="rounded-sm border-l-2 border-accent-green bg-paper p-3 text-sm text-ink-soft">
              One PTB calls <code className="font-mono text-[11px]">wallet::drain</code> for each
              coin type ({holdings.map((h) => h.symbol).join(', ')}). Every balance transfers to
              the vault owner{' '}
              <code className="font-mono text-[11px]">{shortenAddress(owner)}</code>. Ideal for a
              full DAO exit after revoking the agent.
            </p>
          )}

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

function humanFromAtomic(atomic: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = atomic / divisor;
  const frac = atomic % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, '0');
  try {
    return BigInt(whole ?? '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  } catch {
    return null;
  }
}
