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
  /** True when the vault is revoked — disables the button to stop
   *  misleading attestations after the vault has been killed. */
  revoked?: boolean;
}

/**
 * Owner check-in button. NOT a real strategy tick.
 *
 * The autonomous strategy loop is a separate Node process (see
 * `@synapse-core/vault` runtime, deployable via the AWS Fargate stack in
 * `infrastructure/aws/`). That loop signs with the agent's session key
 * and is the only thing the Move VM authorizes to mutate the vault.
 *
 * This button signs from the OWNER wallet — which by design cannot run
 * a strategy tick (`assert_can_act` rejects non-session signers). So it
 * only does what it's allowed to: emit an `ActionLogEvent` via
 * `attestation::log_owner_action`. Useful for end-of-day "I reviewed
 * the vault" attestations that show up in the audit timeline alongside
 * the agent's automated decisions.
 */
export function RunTickButton({ vaultId, revoked }: RunTickButtonProps) {
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
        disabled={isPending || !account || revoked}
        title={
          revoked
            ? 'Vault is revoked — owner attestations no longer apply'
            : !account
              ? 'Connect a wallet to enable owner attestations'
              : 'Sign an attestation::log_owner_action — visible in audit timeline'
        }
      >
        {isPending
          ? 'Signing…'
          : revoked
            ? 'Vault revoked'
            : 'Log owner check-in'}
      </button>
    </div>
  );
}
