'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { Modal } from '../ui/modal';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import { buildRevokePTB } from '@/lib/ptb';
import { explorerTxUrl } from '@/lib/synapse-config';
import { shortenHash } from '@/lib/format';

interface DangerZoneProps {
  /**
   * If provided, revoke targets this real on-chain AgentIdentity. If
   * undefined, the button stays disabled with a clear "no live vault"
   * message rather than mock-firing.
   */
  vaultId?: string;
  /** Strategy this vault was minted against — required by `agent::revoke`. */
  strategyId?: string;
}

/**
 * The "Revoke vault" button + confirmation modal. When a real `vaultId` is
 * provided this constructs an actual `agent::revoke` PTB and signs it via
 * the connected wallet — no simulation. Tx digest links out to suiscan.
 */
export function DangerZone({ vaultId, strategyId }: DangerZoneProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'submitting' | 'awaiting' | 'done' | 'failed'>(
    'idle',
  );
  const [digest, setDigest] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function performRevoke() {
    if (!vaultId || !strategyId) {
      toast.push({
        variant: 'warn',
        title: 'No live vault to revoke',
        body: 'Mint a real vault first — the demo display data is read-only.',
      });
      return;
    }
    if (!account) {
      toast.push({
        variant: 'warn',
        title: 'Connect your wallet first',
        body: 'Only the owner address can sign a revocation.',
      });
      return;
    }

    setPhase('submitting');
    setErrorMsg(null);
    try {
      const tx = buildRevokePTB({ agentId: vaultId, strategyId });
      toast.push({
        variant: 'info',
        title: 'Approve revoke PTB in your wallet',
        durationMs: 7000,
      });
      const result = await signAndExecute({ transaction: tx });
      setDigest(result.digest);
      setPhase('awaiting');
      await suiClient.waitForTransaction({ digest: result.digest });
      setPhase('done');
      toast.push({
        variant: 'danger',
        title: 'Vault revoked on-chain',
        body: `tx ${shortenHash(result.digest)} confirmed`,
        durationMs: 7000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setPhase('failed');
      toast.push({
        variant: 'danger',
        title: 'Revoke failed',
        body: msg.slice(0, 160),
        durationMs: 9000,
      });
    }
  }

  function close() {
    if (phase === 'submitting' || phase === 'awaiting') return;
    setOpen(false);
    setTimeout(() => {
      setPhase('idle');
      setDigest(null);
      setErrorMsg(null);
    }, 220);
  }

  return (
    <>
      <div className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-6 shadow-[4px_4px_0_0_var(--ink)]">
        <div
          className="absolute inset-x-0 top-0 h-1.5"
          style={{ backgroundColor: 'var(--accent-orange)' }}
        />
        <div className="mb-4 flex items-center gap-2 text-accent-orange">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
            <CodeTag>danger zone</CodeTag>
          </span>
        </div>
        <h3 className="font-display text-2xl font-bold">Revoke this vault</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
          One PTB flips <code className="font-mono text-[12px]">AgentIdentity.revoked</code> and
          emits <code className="font-mono text-[12px]">AgentRevokedEvent</code>. The off-chain
          indexer picks up the event to invalidate the MemWal delegate and queue Walrus eviction.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            className="btn-flat"
            data-variant="danger"
            onClick={() => {
              setOpen(true);
              setPhase('confirming');
            }}
            disabled={!vaultId || !account}
            title={
              !vaultId
                ? 'No live vault on this dashboard view'
                : !account
                  ? 'Connect a wallet to enable revoke'
                  : 'Revoke this vault on-chain'
            }
          >
            Revoke vault
          </button>
          <button
            className="btn-flat"
            data-variant="ghost"
            disabled
            title="Pause toggling lands in v2 with a strategy::pause Move entry function"
          >
            Pause strategy <span className="ml-1 text-[10px]">· v2</span>
          </button>
        </div>
      </div>

      <Modal
        open={open}
        onClose={close}
        title={
          phase === 'done'
            ? 'Vault revoked'
            : phase === 'failed'
              ? 'Revoke failed'
              : 'Confirm revocation'
        }
        accent="var(--accent-orange)"
        footer={
          phase === 'done' || phase === 'failed' ? (
            <button className="btn-flat" data-variant="primary" onClick={close}>
              Close
            </button>
          ) : (
            <>
              <button
                className="btn-flat"
                data-variant="ghost"
                onClick={close}
                disabled={phase === 'submitting' || phase === 'awaiting'}
              >
                Cancel
              </button>
              <button
                className="btn-flat"
                data-variant="danger"
                onClick={performRevoke}
                disabled={phase === 'submitting' || phase === 'awaiting'}
              >
                {phase === 'submitting'
                  ? 'Awaiting wallet…'
                  : phase === 'awaiting'
                    ? 'Confirming on chain…'
                    : 'Revoke now'}
              </button>
            </>
          )
        }
      >
        {phase === 'done' ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <p className="text-sm text-ink-soft">
              The revoke PTB landed on Sui testnet. The agent's session-key actions will now abort
              at the policy gate; the off-chain indexer reacts to the emitted event to revoke the
              MemWal delegate and queue Walrus eviction.
            </p>
            {digest && (
              <div className="rounded-sm border border-divider bg-paper p-3 font-mono text-[11px]">
                <p className="text-state-active">● confirmed</p>
                <p className="mt-1 text-ink">tx {shortenHash(digest)}</p>
                <a
                  href={explorerTxUrl(digest)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-accent-blue underline"
                >
                  view on suiscan →
                </a>
              </div>
            )}
          </motion.div>
        ) : phase === 'failed' ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">The PTB did not land. Common causes:</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>Connected wallet is not the vault owner</li>
              <li>Vault is already revoked</li>
              <li>Wallet rejected the signature request</li>
            </ul>
            {errorMsg && (
              <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
                {errorMsg}
              </pre>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-soft">
              You're about to revoke{' '}
              <span className="font-mono text-[12px] text-ink">{shortenHash(vaultId ?? '')}</span>.
              This is an irreversible on-chain action signed by your connected wallet.
            </p>
            <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[11px] text-ink-soft">
{`tx.moveCall({
  target: '${vaultId ? '<pkg>::agent::revoke' : '—'}',
  arguments: [tx.object('${shortenHash(vaultId ?? '0x…')}')]
});`}
            </pre>
            <p className="rounded-sm border-l-2 border-accent-orange bg-paper p-3 font-mono text-[11px] text-ink-soft">
              <span className="text-accent-orange">!</span> Reverts if the connected address is not
              the vault owner (
              <span className="text-ink">
                {account ? shortenHash(account.address) : '— not connected —'}
              </span>
              ).
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
