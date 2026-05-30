'use client';

import { useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientQuery,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import { explorerTxUrl, NETWORK } from '@/lib/synapse-config';
import { shortenAddress, shortenHash } from '@/lib/format';

interface FundSessionPanelProps {
  /** The vault's on-chain session address (gas wallet for ticks). */
  sessionAddr: string;
}

const MIST_PER_SUI = 1_000_000_000n;
const PRESETS_SUI = ['0.05', '0.1', '0.25'] as const;

/**
 * Fund the vault's session address with SUI for gas.
 *
 * The session key signs every tick (and one-shot ops like cross-agent reads),
 * so it needs SUI to pay gas — separate from the vault treasury. This splits
 * SUI from the connected wallet's gas coin and transfers it to the session
 * address. Mint already seeds ~0.02 SUI; use this to top up.
 */
export function FundSessionPanel({ sessionAddr }: FundSessionPanelProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [amountInput, setAmountInput] = useState('0.05');
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live session-gas balance, so the operator can see whether a top-up is
  // even needed (mint already seeds ~0.02 SUI).
  const balanceQ = useSuiClientQuery(
    'getBalance',
    { owner: sessionAddr, coinType: '0x2::sui::SUI' },
    { enabled: sessionAddr.length > 0, refetchInterval: 15_000 },
  );
  const sessionSui = balanceQ.data ? Number(BigInt(balanceQ.data.totalBalance)) / 1e9 : null;

  const amountMist = parseSuiToMist(amountInput);
  const valid = account !== null && amountMist !== null && amountMist > 0n;

  async function submit() {
    setError(null);
    if (!account) {
      setError('Connect your wallet first.');
      return;
    }
    if (amountMist === null || amountMist <= 0n) {
      setError('Enter a positive SUI amount.');
      return;
    }
    try {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [amountMist]);
      if (!coin) throw new Error('splitCoins returned no coin');
      tx.transferObjects([coin], tx.pure.address(sessionAddr));
      toast.push({
        variant: 'info',
        title: 'Awaiting wallet signature',
        body: `Sending ${amountInput} SUI to the session gas wallet.`,
        durationMs: 6000,
      });
      const signed = await signAndExecute({ transaction: tx });
      await suiClient.waitForTransaction({ digest: signed.digest, timeout: 30_000 });
      setDigest(signed.digest);
      void queryClient.invalidateQueries({ queryKey: ['getBalance'] });
      void balanceQ.refetch();
      toast.push({
        variant: 'success',
        title: 'Session funded',
        body: `${amountInput} SUI sent · tx ${shortenHash(signed.digest)}`,
        durationMs: 6000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-6 shadow-[4px_4px_0_0_var(--ink)]">
      <div className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundColor: 'var(--accent-orange)' }} />
      <div className="mb-3 flex items-center gap-2 text-accent-orange">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
          <CodeTag>session gas</CodeTag>
        </span>
      </div>
      <h3 className="font-display text-2xl font-bold">Fund session gas</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-soft">
        The session key pays gas for every tick (and one-shot ops like
        cross-agent reads). Top it up from your connected wallet — separate
        from the treasury.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-[11px]">
        <span className="text-ink-mute">
          session{' '}
          <span className="text-ink">{shortenAddress(sessionAddr)}</span>
        </span>
        <span className="text-ink-mute">
          balance{' '}
          <span className={sessionSui !== null && sessionSui < 0.01 ? 'text-state-revoked' : 'text-state-active'}>
            {sessionSui !== null ? `${sessionSui.toFixed(4)} SUI` : balanceQ.isLoading ? '…' : '—'}
          </span>
        </span>
      </div>

      {digest ? (
        <div className="mt-4 space-y-2 text-sm">
          <p className="text-state-active">● session funded</p>
          <a
            href={explorerTxUrl(digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-orange underline"
          >
            tx {shortenHash(digest)} ↗
          </a>
          <button
            type="button"
            className="btn-flat ml-2"
            data-variant="ghost"
            onClick={() => setDigest(null)}
          >
            Fund again
          </button>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                Amount (SUI)
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-32 rounded-sm border border-divider bg-paper px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
            </label>
            <div className="flex gap-2 pb-2 font-mono text-[10px]">
              {PRESETS_SUI.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmountInput(p)}
                  className="text-accent-orange hover:underline"
                >
                  {p}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn-flat"
              data-variant="primary"
              disabled={!valid || isPending}
              onClick={submit}
              title={!account ? 'Connect a wallet to fund' : undefined}
            >
              {isPending ? 'Signing…' : 'Fund session'}
            </button>
          </div>
          {NETWORK !== 'mainnet' && (
            <p className="font-mono text-[10px] text-ink-mute">
              Out of SUI? Grab testnet tokens at faucet.sui.io, then fund here.
            </p>
          )}
          {error && (
            <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
              {error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function parseSuiToMist(input: string): bigint | null {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > 9) return null;
  try {
    return BigInt(whole ?? '0') * MIST_PER_SUI + BigInt(frac.padEnd(9, '0') || '0');
  } catch {
    return null;
  }
}
