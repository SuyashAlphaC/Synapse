'use client';

import { useMemo, useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientQuery,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { synapseTarget, explorerTxUrl } from '@/lib/synapse-config';
import { isNativeSuiCoinType } from '@/lib/vault-state';
import { shortenAddress, shortenHash } from '@/lib/format';

interface DepositPanelProps {
  vaultId: string;
  /** Package that minted the vault — fund PTBs must use this package id. */
  mintPackageId: string;
}

/**
 * Top-up panel. Lets the vault owner (or anyone, since `agent::fund` is
 * permissionless on amount) deposit additional coins into the vault's
 * treasury Bag. Critical for strategies like Conservative Rebalancer that
 * need both SUI and USDC present before they can compute a rebalance.
 *
 * Picks the deposit coin from the connected wallet's coin holdings via
 * `useSuiClientQuery('getAllBalances')` then `getCoins` for the chosen
 * type, builds an `agent::fund<T>` PTB, signs via the connected wallet,
 * and invalidates the vault query so balances update without a manual
 * refresh.
 */
export function DepositPanel({ vaultId, mintPackageId }: DepositPanelProps) {
  const account = useCurrentAccount();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-6 shadow-[4px_4px_0_0_var(--ink)]">
        <div
          className="absolute inset-x-0 top-0 h-1.5"
          style={{ backgroundColor: 'var(--accent-blue)' }}
        />
        <div className="mb-3 flex items-center gap-2 text-accent-blue">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
            <CodeTag>deposit</CodeTag>
          </span>
        </div>
        <h3 className="font-display text-2xl font-bold">Top up treasury</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
          Deposit additional coins from your wallet into the vault's
          treasury via{' '}
          <code className="font-mono text-[12px]">agent::fund&lt;T&gt;</code>.
          Required for two-asset strategies before they can rebalance.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-flat"
            data-variant="primary"
            disabled={!account}
            onClick={() => setOpen(true)}
            title={!account ? 'Connect a wallet to deposit' : undefined}
          >
            Deposit a coin
          </button>
        </div>
      </div>
      {open && (
        <DepositModal vaultId={vaultId} mintPackageId={mintPackageId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

interface CoinChoice {
  coinTypeTag: string;
  symbol: string;
  decimals: number;
  totalBalance: bigint;
  bestCoinId: string;
  bestCoinBalance: bigint;
}

/** Leave headroom on SUI deposits so gas + split share one coin object safely. */
const SUI_GAS_BUFFER_MIST = 500_000_000n;

function DepositModal({
  vaultId,
  mintPackageId,
  onClose,
}: {
  vaultId: string;
  mintPackageId: string;
  onClose: () => void;
}) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();
  const queryClient = useQueryClient();

  // 1) All balances on the wallet → discover which coin types are present.
  const balancesQ = useSuiClientQuery(
    'getAllBalances',
    { owner: account?.address ?? '' },
    { enabled: account !== null, staleTime: 10_000 },
  );

  const [pickedType, setPickedType] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 2) For the picked coin type, fetch concrete coins (and metadata).
  const coinsQ = useSuiClientQuery(
    'getCoins',
    { owner: account?.address ?? '', coinType: pickedType ?? '' },
    { enabled: account !== null && pickedType !== null, staleTime: 10_000 },
  );
  const metaQ = useSuiClientQuery(
    'getCoinMetadata',
    { coinType: pickedType ?? '' },
    { enabled: pickedType !== null, staleTime: 60 * 60_000 },
  );

  const choices: CoinChoice[] = useMemo(() => {
    const balances = balancesQ.data ?? [];
    return balances
      .filter((b) => BigInt(b.totalBalance) > 0n)
      .map((b) => ({
        coinTypeTag: b.coinType,
        symbol: shortTypeName(b.coinType),
        decimals: 9, // placeholder; refined per-pick when metadata loads
        totalBalance: BigInt(b.totalBalance),
        bestCoinId: '',
        bestCoinBalance: 0n,
      }));
  }, [balancesQ.data]);

  const meta = metaQ.data ?? null;
  const isSui = pickedType !== null && isNativeSuiCoinType(pickedType);
  const decimals = meta?.decimals ?? (isSui ? 9 : 6);
  const coins = coinsQ.data?.data ?? [];
  const best = coins
    .slice()
    .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0];

  const maxDepositAtomic =
    best === undefined
      ? 0n
      : isSui && BigInt(best.balance) > SUI_GAS_BUFFER_MIST
        ? BigInt(best.balance) - SUI_GAS_BUFFER_MIST
        : BigInt(best.balance);

  const amount = parseAmount(amountInput, decimals);
  const valid =
    pickedType !== null &&
    best !== undefined &&
    amount !== null &&
    amount > 0n &&
    amount <= maxDepositAtomic;

  async function submit() {
    setError(null);
    if (!account || !pickedType || !best || amount === null) {
      setError('Pick a coin and a positive amount.');
      return;
    }
    if (amount > maxDepositAtomic) {
      setError(
        isSui
          ? 'Amount exceeds wallet SUI after reserving ~0.5 SUI for gas. Try a smaller value.'
          : 'Amount exceeds the largest coin object of this type. Try a smaller value or merge coins first.',
      );
      return;
    }
    try {
      const tx = new Transaction();
      let funded;
      if (isSui) {
        // Split from gas coin — avoids object/gas collisions in single-coin wallets.
        [funded] = tx.splitCoins(tx.gas, [amount]);
      } else {
        const sourceCoin = tx.object(best.coinObjectId);
        [funded] = tx.splitCoins(sourceCoin, [amount]);
      }
      if (!funded) throw new Error('splitCoins returned no coin');
      tx.moveCall({
        target: synapseTarget('agent', 'fund', mintPackageId),
        typeArguments: [pickedType],
        arguments: [tx.object(vaultId), funded],
      });
      toast.push({
        variant: 'info',
        title: 'Awaiting wallet signature',
        body: 'Approve the fund PTB to deposit into the vault treasury.',
        durationMs: 6000,
      });
      const signed = await signAndExecute({ transaction: tx });
      await suiClient.waitForTransaction({ digest: signed.digest, timeout: 30_000 });
      void queryClient.invalidateQueries({ queryKey: ['synapse-vault', vaultId] });
      void queryClient.invalidateQueries({ queryKey: ['synapse-nav-history', vaultId] });
      setDigest(signed.digest);
      toast.push({
        variant: 'success',
        title: 'Deposit landed on-chain',
        body: `tx ${shortenHash(signed.digest)}`,
        durationMs: 6000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={digest ? 'Deposit confirmed' : 'Deposit into vault'}
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
              {isPending ? 'Signing…' : 'Deposit on-chain'}
            </button>
          </>
        )
      }
    >
      {digest ? (
        <div className="space-y-3 text-sm">
          <p className="text-state-active">● treasury updated</p>
          <p className="text-ink-soft">
            The vault's treasury Bag now includes your new balance. Re-run the simulator or
            click <em>Run Tick</em> — the strategy should pick it up.
          </p>
          <a
            href={explorerTxUrl(digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-accent-blue underline"
          >
            tx {shortenHash(digest)} ↗
          </a>
        </div>
      ) : !account ? (
        <p className="text-sm text-ink-soft">Connect a wallet first.</p>
      ) : balancesQ.isLoading ? (
        <p className="font-mono text-xs text-ink-mute">Loading wallet balances…</p>
      ) : choices.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No coins detected in {shortenAddress(account.address)}. Fund this wallet from the
          testnet faucet first.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              pick a coin
            </p>
            <div className="grid gap-2">
              {choices.map((c) => (
                <button
                  type="button"
                  key={c.coinTypeTag}
                  onClick={() => setPickedType(c.coinTypeTag)}
                  className={`group grid grid-cols-[1fr_auto] items-center gap-3 rounded-sm border-2 px-3 py-2.5 text-left transition ${
                    pickedType === c.coinTypeTag
                      ? 'border-ink bg-paper-strong shadow-[2px_2px_0_0_var(--ink)]'
                      : 'border-divider bg-paper hover:border-ink'
                  }`}
                >
                  <div>
                    <p className="font-display text-sm font-semibold">{c.symbol}</p>
                    <p className="font-mono text-[10px] text-ink-mute">
                      {c.coinTypeTag}
                    </p>
                  </div>
                  <span className="num font-semibold">{formatRawBalance(c.totalBalance)}</span>
                </button>
              ))}
            </div>
          </div>
          {pickedType && (
            <div className="space-y-2">
              <label className="grid gap-1.5">
                <span className="font-display text-sm font-semibold">
                  Amount {meta?.symbol ? `(${meta.symbol})` : ''}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder={`max ${best ? humanFromAtomic(maxDepositAtomic, decimals) : '?'}`}
                  className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
                />
                <span className="font-mono text-[10px] text-ink-mute">
                  Decimal value, will be converted to atomic units (10^{decimals}).
                </span>
              </label>
              {best && (
                <div className="flex gap-2 font-mono text-[10px]">
                  {[0.25, 0.5, 1].map((frac) => (
                    <button
                      type="button"
                      key={frac}
                      onClick={() =>
                        setAmountInput(
                          humanFromAtomic(
                            (maxDepositAtomic * BigInt(Math.round(frac * 1000))) / 1000n,
                            decimals,
                          ),
                        )
                      }
                      className="text-accent-blue hover:underline"
                    >
                      {frac === 1 ? 'max' : `${frac * 100}%`}
                    </button>
                  ))}
                </div>
              )}
            </div>
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

function shortTypeName(typeTag: string): string {
  const tail = typeTag.split('::').at(-1) ?? typeTag;
  return tail;
}

function formatRawBalance(raw: bigint): string {
  // Friendly raw display without decimals; the per-coin decimals are
  // resolved after the user picks a type (we don't want to N+1-query
  // metadata for every coin in the wallet).
  const s = raw.toString();
  if (s.length <= 9) return `${s} raw`;
  return `${s.slice(0, s.length - 9)}.${s.slice(s.length - 9, s.length - 6).padStart(3, '0')}M`;
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
