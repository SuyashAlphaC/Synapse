'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { sha256 } from '@noble/hashes/sha2.js';
import { synapseTarget, explorerTxUrl } from '@/lib/synapse-config';
import { useToast } from '../ui/toast';
import { shortenHash } from '@/lib/format';

interface RunTickButtonProps {
  vaultId: string;
}

/**
 * Submit a real "strategy tick" event on-chain from the connected wallet.
 *
 * The full production runtime runs as a Node worker (see
 * `@synapse-core/vault` runtime). This in-browser variant lets the owner
 * produce a real on-chain audit log entry from the dashboard — useful for
 * demos and for end-of-day "I checked the vault" attestations.
 *
 * The PTB calls `attestation::log_owner_action(...)` so the action is
 * recorded against the owner address and visible in the audit timeline.
 */
export function RunTickButton({ vaultId }: RunTickButtonProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [lastDigest, setLastDigest] = useState<string | null>(null);

  async function runTick() {
    if (!account) {
      toast.push({
        variant: 'warn',
        title: 'Connect a wallet first',
        body: 'Only the vault owner can log a manual tick.',
      });
      return;
    }
    try {
      const payload = JSON.stringify({
        kind: 'manual-tick',
        vaultId,
        owner: account.address,
        at: new Date().toISOString(),
      });
      const digest = sha256(new TextEncoder().encode(payload));
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('attestation', 'log_owner_action'),
        arguments: [
          tx.object(vaultId),
          tx.pure.u8(255), // KIND_CUSTOM
          tx.pure.string(`Manual owner tick at ${new Date().toISOString()}`),
          tx.pure.vector('u8', Array.from(digest)),
        ],
      });
      toast.push({
        variant: 'info',
        title: 'Approve tick PTB in your wallet',
        durationMs: 7000,
      });
      const result = await signAndExecute({ transaction: tx });
      await suiClient.waitForTransaction({ digest: result.digest });
      setLastDigest(result.digest);
      toast.push({
        variant: 'success',
        title: 'Manual tick logged',
        body: `tx ${shortenHash(result.digest)} confirmed`,
        durationMs: 6000,
      });
      // Invalidate the timeline + vault state so they re-fetch.
      void queryClient.invalidateQueries({ queryKey: ['synapse-vault', vaultId] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        variant: 'danger',
        title: 'Tick failed',
        body: msg.slice(0, 160),
        durationMs: 9000,
      });
    }
  }

  return (
    <div className="flex items-center gap-3">
      {lastDigest && (
        <a
          className="font-mono text-[11px] text-state-active hover:underline"
          href={explorerTxUrl(lastDigest)}
          target="_blank"
          rel="noreferrer"
        >
          last tx {shortenHash(lastDigest)} ↗
        </a>
      )}
      <button
        className="btn-flat"
        data-variant="primary"
        onClick={runTick}
        disabled={isPending || !account}
        title={
          !account
            ? 'Connect a wallet to enable manual ticks'
            : 'Submit a real audit log entry on-chain'
        }
      >
        {isPending ? 'Signing…' : 'Run tick now'}
      </button>
    </div>
  );
}
