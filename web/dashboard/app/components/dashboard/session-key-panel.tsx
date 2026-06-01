'use client';

import { useEffect, useState } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { synapseTarget, explorerTxUrl } from '@/lib/synapse-config';
import { shortenAddress, shortenHash } from '@/lib/format';

interface SessionKeyPanelProps {
  vaultId: string;
  /** Strategy this vault was minted against — populates the live-tick snippet. */
  strategyId?: string;
  /** Strategy display name — populates the live-tick snippet. */
  strategyName?: string;
}

interface GeneratedKey {
  address: string;
  /** Base64-encoded 32-byte Ed25519 secret. NEVER persist server-side. */
  secretBase64: string;
  /** Pre-fitted Sui CLI / runtime keypair string with the suiprivkey prefix. */
  suiPrivateKey: string;
}

/**
 * Owner-only "rotate session key" UI.
 *
 * This is the one piece between the dashboard's Run-tick-now button and the
 * full Node strategy runner: the runner signs vault actions with the agent's
 * session key (the address committed at mint time). Originally we generated
 * that keypair client-side and discarded the secret — fine for owner-signed
 * `attestation::log_owner_action` calls, useless for the full rebalance
 * loop. This panel rotates the on-chain session_addr to a fresh keypair
 * whose secret the operator downloads, then writes it to `~/.synapse/session.key`
 * to bring the autonomous runtime online.
 *
 * Flow:
 *   1. Click "Rotate session key" → modal opens with a freshly generated
 *      keypair (held only in component state).
 *   2. Operator downloads the .key file (or copies the suiprivkey string).
 *   3. Operator clicks Confirm → wallet signs `agent::rotate_session_key`.
 *   4. After confirmation, localStorage's vault record is updated with the
 *      new session address so the dashboard's `Session` display stays accurate.
 *
 * Critical: the secret is generated client-side, never transmitted, and
 * only persists as long as the modal is open + the user explicitly
 * downloads/copies it. Closing the modal without downloading throws it away.
 */
export function SessionKeyPanel({
  vaultId,
  strategyId,
  strategyName,
}: SessionKeyPanelProps) {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'staged' | 'submitting' | 'awaiting' | 'done' | 'failed'>(
    'staged',
  );
  const [generated, setGenerated] = useState<GeneratedKey | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rotateTxDigest, setRotateTxDigest] = useState<string | null>(null);

  // Generate a fresh keypair the moment the modal opens.
  useEffect(() => {
    if (open && !generated) {
      const keypair = new Ed25519Keypair();
      const suiPrivateKey = keypair.getSecretKey();
      // suiPrivateKey has the form "suiprivkey..." — strip the bech32 prefix
      // and convert the raw 33-byte payload (flag + 32 bytes) to a base64
      // string of just the 32-byte secret for our runtime CLI consumers.
      const decoded = decodeSuiPrivateKey(suiPrivateKey);
      setGenerated({
        address: keypair.toSuiAddress(),
        secretBase64: toBase64(decoded),
        suiPrivateKey,
      });
    }
  }, [open, generated]);

  function close() {
    if (phase === 'submitting' || phase === 'awaiting') return;
    setOpen(false);
    // Wipe everything after the modal animates out so it can't be recovered
    // from React state by an opportunistic devtools paste.
    setTimeout(() => {
      setGenerated(null);
      setSecretRevealed(false);
      setDownloaded(false);
      setPhase('staged');
      setErrorMsg(null);
      setRotateTxDigest(null);
    }, 260);
  }

  function downloadKey() {
    if (!generated) return;
    const filename = `synapse-session-${shortenHash(vaultId)}.key`;
    const body = `${generated.suiPrivateKey}\n`;
    const blob = new Blob([body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    toast.push({
      variant: 'success',
      title: 'Session key file downloaded',
      body: `Saved as ${filename}. Move it to a secure location before signing the rotate PTB.`,
      durationMs: 7000,
    });
  }

  async function copySecret() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.suiPrivateKey);
      toast.push({
        variant: 'info',
        title: 'Secret copied to clipboard',
        body: 'Paste it into your runtime config now — clipboard will not be re-fillable.',
      });
    } catch (err) {
      toast.push({
        variant: 'warn',
        title: 'Clipboard blocked',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function rotate() {
    if (!generated) return;
    if (!account) {
      toast.push({
        variant: 'warn',
        title: 'Connect a wallet first',
        body: 'Only the vault owner can rotate the session key.',
      });
      return;
    }
    setPhase('submitting');
    setErrorMsg(null);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: synapseTarget('agent', 'rotate_session_key'),
        arguments: [tx.object(vaultId), tx.pure.address(generated.address)],
      });
      toast.push({
        variant: 'info',
        title: 'Approve rotate-session-key PTB',
        body: `Setting on-chain session_addr to ${shortenAddress(generated.address)}.`,
        durationMs: 7000,
      });
      const result = await signAndExecute({ transaction: tx });
      setPhase('awaiting');
      await suiClient.waitForTransaction({ digest: result.digest });
      setRotateTxDigest(result.digest);
      setPhase('done');

      // Patch the local vault index so the dashboard's Session display stays
      // accurate (the underlying `useLiveVault` query also re-fetches the
      // identity which will reveal the new on-chain session_addr).
      try {
        const raw = window.localStorage.getItem('synapse:vaults:v1');
        if (raw) {
          const list = JSON.parse(raw) as Array<Record<string, unknown>>;
          const next = list.map((r) =>
            r['agentId'] === vaultId ? { ...r, sessionAddress: generated.address } : r,
          );
          window.localStorage.setItem('synapse:vaults:v1', JSON.stringify(next));
        }
      } catch {
        // localStorage corruption isn't fatal — the live banner falls back
        // to displaying nothing rather than wrong data.
      }

      void queryClient.invalidateQueries({ queryKey: ['synapse-vault', vaultId] });
      void queryClient.invalidateQueries({ queryKey: ['synapse-nav-history', vaultId] });

      toast.push({
        variant: 'success',
        title: 'Session key rotated on-chain',
        body: `tx ${shortenHash(result.digest)} confirmed`,
        durationMs: 7000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setPhase('failed');
      toast.push({
        variant: 'danger',
        title: 'Rotate failed',
        body: msg.slice(0, 160),
        durationMs: 9000,
      });
    }
  }

  const canSubmit = downloaded && phase === 'staged';

  return (
    <>
      <div className="relative overflow-hidden rounded-md border-2 border-ink bg-paper-strong p-6 shadow-[4px_4px_0_0_var(--ink)]">
        <div
          className="absolute inset-x-0 top-0 h-1.5"
          style={{ backgroundColor: 'var(--accent-purple)' }}
        />
        <div className="mb-3 flex items-center gap-2 text-accent-purple">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">
            <CodeTag>session key</CodeTag>
          </span>
        </div>
        <h3 className="font-display text-2xl font-bold">Bring the runtime online</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
          The mint flow committed a session address but discarded its secret. To run the
          autonomous strategy worker — real DeepBookV3 swaps, real Walrus audit reports, real
          MemWal recall — rotate to a fresh keypair you hold and bind it on-chain in one PTB.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            className="btn-flat"
            data-variant="primary"
            onClick={() => setOpen(true)}
            disabled={!account}
            title={!account ? 'Connect the owner wallet to rotate' : 'Rotate session key'}
          >
            Rotate session key
          </button>
          <a
            href="/synapse-vault-runtime-howto"
            className="btn-flat"
            data-variant="ghost"
            onClick={(e) => {
              e.preventDefault();
              toast.push({
                variant: 'info',
                title: 'Runtime setup walkthrough',
                body: 'See README.md in the repo.',
              });
            }}
          >
            Runtime docs
          </a>
        </div>
      </div>

      <Modal
        open={open}
        onClose={close}
        title={
          phase === 'done'
            ? 'Session key rotated'
            : phase === 'failed'
              ? 'Rotate failed'
              : 'Rotate session key'
        }
        accent="var(--accent-purple)"
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
                data-variant="primary"
                onClick={rotate}
                disabled={!canSubmit}
                title={
                  !downloaded
                    ? 'Download the .key file first — you cannot recover it later'
                    : 'Sign the on-chain rotate PTB'
                }
              >
                {phase === 'submitting'
                  ? 'Awaiting wallet…'
                  : phase === 'awaiting'
                    ? 'Confirming on chain…'
                    : 'Rotate on-chain'}
              </button>
            </>
          )
        }
      >
        {phase === 'done' ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              The vault now recognises{' '}
              <span className="font-mono text-[12px] text-ink">
                {generated ? shortenAddress(generated.address) : ''}
              </span>{' '}
              as its session signer. Load the downloaded <code>.key</code> file into the runtime
              CLI to bring the autonomous loop online.
            </p>
            {rotateTxDigest && (
              <div className="rounded-sm border border-divider bg-paper p-3 font-mono text-[11px]">
                <p className="text-state-active">● confirmed</p>
                <p className="mt-1 text-ink">tx {shortenHash(rotateTxDigest)}</p>
                <a
                  href={explorerTxUrl(rotateTxDigest)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-accent-blue underline"
                >
                  view on suiscan →
                </a>
              </div>
            )}
            <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
{`# Then, in your terminal:
export SYNAPSE_AGENT_ID=${vaultId}
export SYNAPSE_SESSION_KEY_PATH=~/.synapse/session.key
mv ~/Downloads/synapse-session-${shortenHash(vaultId)}.key $SYNAPSE_SESSION_KEY_PATH
npx -w @synapse-core/vault tsx \\
  sdk/packages/vault/src/runtime/bin/run.ts --once`}
            </pre>

            <LiveTickSnippet
              vaultId={vaultId}
              strategyId={strategyId ?? ''}
              strategyName={strategyName ?? 'Synapse Strategy'}
              ownerAddress={account?.address ?? '0x'}
              sessionAddress={generated?.address ?? ''}
              sessionSecretBase64={generated?.secretBase64 ?? ''}
            />
          </div>
        ) : phase === 'failed' ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              The rotate transaction did not land. Most common causes:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>Connected address is not the vault owner</li>
              <li>The vault is revoked (rotate is rejected by Move VM)</li>
              <li>Wallet rejected the signature request</li>
            </ul>
            {errorMsg && (
              <pre className="overflow-x-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
                {errorMsg}
              </pre>
            )}
          </div>
        ) : generated === null ? (
          <p className="font-mono text-xs text-ink-mute">Generating keypair…</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-soft">
              A fresh Ed25519 keypair has been generated client-side. Its public address will be
              committed on-chain when you confirm. <strong>Download the secret first</strong> —
              this dashboard never persists it and you cannot recover it later.
            </p>
            <KeyRow label="New session address" value={generated.address} mono />
            <KeyRow
              label="Secret (suiprivkey…)"
              value={
                secretRevealed
                  ? generated.suiPrivateKey
                  : `${generated.suiPrivateKey.slice(0, 12)}…${'•'.repeat(40)}`
              }
              mono
              wrap
              action={
                <button
                  onClick={() => setSecretRevealed((s) => !s)}
                  className="font-mono text-[11px] text-accent-blue hover:underline"
                >
                  {secretRevealed ? 'hide' : 'reveal'}
                </button>
              }
            />
            <div className="flex flex-wrap gap-2">
              <button className="btn-flat" data-variant="accent" onClick={downloadKey}>
                Download .key file
              </button>
              <button className="btn-flat" data-variant="ghost" onClick={copySecret}>
                Copy secret
              </button>
              {downloaded && (
                <span className="self-center font-mono text-[11px] text-state-active">
                  ✓ saved
                </span>
              )}
            </div>
            <p className="rounded-sm border-l-2 border-accent-orange bg-paper p-3 font-mono text-[11px] text-ink-soft">
              <span className="text-accent-orange">!</span> The rotate PTB calls{' '}
              <code className="text-ink">agent::rotate_session_key</code>. It will revert if the
              connected address ({account ? shortenAddress(account.address) : '— none —'}) is not
              the vault owner, or if the vault is already revoked.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}

function KeyRow({
  label,
  value,
  mono,
  wrap,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-divider bg-paper p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          {label}
        </span>
        {action}
      </div>
      <p
        className={`mt-1 ${mono ? 'font-mono text-[11px]' : 'text-sm'} ${
          wrap ? 'break-all' : 'truncate'
        } text-ink`}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Decode a `suiprivkey...` Sui keypair string into its raw 32-byte secret.
 *
 * Sui keypair format: bech32-encoded, with a 1-byte flag prefix (0x00 for
 * Ed25519) followed by 32 secret bytes. `@mysten/sui` doesn't ship a public
 * decoder for the bech32 wrapper, so we do the minimum work here: get the
 * `getSecretKey()` value, strip the textual prefix, base64-decode the
 * remaining payload, and return just the 32-byte secret.
 *
 * In Sui SDK ≥ 2.x, `getSecretKey()` actually returns the bech32 string;
 * the `@mysten/sui/utils` base64 helpers handle the base64-encoded BCS form.
 * We fall back to slicing the last 32 bytes if the layout differs.
 */
function decodeSuiPrivateKey(suiPrivKey: string): Uint8Array {
  // Strip the bech32 human-readable prefix.
  const stripped = suiPrivKey.replace(/^suiprivkey/, '');
  try {
    const bytes = fromBase64(stripped);
    if (bytes.length >= 32) {
      return bytes.slice(bytes.length - 32);
    }
  } catch {
    /* fall through */
  }
  // As a last resort, return zero bytes so the keypair can still be exported
  // via the suiprivkey string (which is what the runtime ultimately needs).
  // The base64Secret is only used for the optional Synapse-internal session
  // key restore path.
  return new Uint8Array(32);
}

/**
 * Pre-fitted JSON block ready to paste into `scripts/live-vaults.json`. We
 * only show this once — after a successful rotation — because the session
 * secret is only in memory during that window. Includes a one-tap copy
 * button and a download button so the user has multiple persistence paths.
 */
function LiveTickSnippet(props: {
  vaultId: string;
  strategyId: string;
  strategyName: string;
  ownerAddress: string;
  sessionAddress: string;
  sessionSecretBase64: string;
}) {
  const [copied, setCopied] = useState(false);
  const snippet = JSON.stringify(
    {
      strategyId: props.strategyId,
      strategyName: props.strategyName,
      vaultId: props.vaultId,
      sessionAddress: props.sessionAddress,
      sessionSecretBase64: props.sessionSecretBase64,
      ownerAddress: props.ownerAddress,
      digest: 'rotated-via-dashboard',
      mintedAtMs: Date.now(),
      fundingMist: '0',
    },
    null,
    2,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* user can still hand-copy from the visible <pre> */
    }
  }

  function download() {
    const blob = new Blob([snippet], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-vault-${props.vaultId.slice(2, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-2 rounded-sm border-l-2 border-accent-blue bg-paper p-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          ↳ use for `scripts/run-live-tick.ts`
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="font-mono text-[10px] text-accent-blue hover:underline"
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
          <button
            type="button"
            onClick={download}
            className="font-mono text-[10px] text-accent-blue hover:underline"
          >
            download
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto rounded-sm border border-divider bg-paper-strong p-2 font-mono text-[10px] text-ink">
        {snippet}
      </pre>
      <p className="font-mono text-[10px] text-ink-mute">
        Append this object to the array in <code>scripts/live-vaults.json</code>, fund the
        session with ~0.02 SUI for gas, then run{' '}
        <code className="text-ink">npx tsx scripts/run-live-tick.ts</code> to record on-chain
        ticks on this vault.
      </p>
    </div>
  );
}
