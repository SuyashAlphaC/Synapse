'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import { useSuiClient } from '@mysten/dapp-kit';
import {
  fetchWalrusBlobAsText,
  listVaultArtifacts,
  type ArtifactRecord,
} from '@/lib/artifacts-client';
import { decryptSealedArtifact } from '@/lib/seal-decrypt';
import { NETWORK, SYNAPSE_SEAL_PACKAGE_ID } from '@/lib/synapse-config';
import { CodeTag } from '../ui/code-tag';
import { Modal } from '../ui/modal';
import { useToast } from '../ui/toast';
import { shortenHash } from '@/lib/format';

interface ArtifactsPanelProps {
  vaultId: string;
}

const WALRUS_NETWORK = NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

/**
 * Browse Walrus artifacts produced by the given vault. Each artifact links
 * out to the real Walrus aggregator content; clicking opens an inline
 * markdown viewer.
 */
export function ArtifactsPanel({ vaultId }: ArtifactsPanelProps) {
  const client = useSuiClient();
  const toast = useToast();
  const [selected, setSelected] = useState<ArtifactRecord | null>(null);

  // Seal decrypt state for the selected artifact (only used when it's
  // sealEncrypted). Reset whenever a different artifact is opened/closed.
  const [keyText, setKeyText] = useState<string | null>(null);
  const [keyName, setKeyName] = useState<string | null>(null);
  const [decBusy, setDecBusy] = useState(false);
  const [decText, setDecText] = useState<string | null>(null);
  const [decErr, setDecErr] = useState<string | null>(null);

  useEffect(() => {
    setDecText(null);
    setDecErr(null);
  }, [selected]);

  const listing = useQuery({
    queryKey: ['artifacts', vaultId],
    queryFn: () => listVaultArtifacts({ client, vaultId }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const content = useQuery({
    queryKey: ['artifact-content', selected?.walrusBlobId, WALRUS_NETWORK],
    queryFn: async ({ signal }) => {
      if (!selected) return null;
      return fetchWalrusBlobAsText({
        walrusBlobId: selected.walrusBlobId,
        network: WALRUS_NETWORK,
        signal,
      });
    },
    // Sealed blobs are ciphertext — don't fetch them as text (that shows
    // garbage). The decrypt panel fetches the raw bytes itself.
    enabled: selected !== null && !selected.sealEncrypted,
    staleTime: 5 * 60_000,
  });

  const onDecrypt = useCallback(async () => {
    if (!selected || !keyText) return;
    setDecBusy(true);
    setDecErr(null);
    try {
      const url = `https://aggregator.walrus-${WALRUS_NETWORK}.walrus.space/v1/blobs/${selected.walrusBlobId}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Walrus aggregator returned ${res.status}`);
      const encrypted = new Uint8Array(await res.arrayBuffer());
      const text = await decryptSealedArtifact({
        suiClient: client,
        sealPackageId: SYNAPSE_SEAL_PACKAGE_ID,
        encrypted,
        keyFileContents: keyText,
      });
      setDecText(text);
    } catch (err) {
      setDecErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDecBusy(false);
    }
  }, [selected, keyText, client]);

  return (
    <div className="card-flat p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl font-bold">Artifacts</h3>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>walrus</CodeTag>{' '}
            {listing.data ? `${listing.data.length} published` : listing.isLoading ? 'loading…' : '—'}
          </p>
        </div>
        <button
          className="btn-flat"
          data-variant="ghost"
          onClick={() => {
            void listing.refetch();
            toast.push({ variant: 'info', title: 'Refreshing artifacts…' });
          }}
        >
          Refresh
        </button>
      </div>

      {listing.isError && (
        <p className="rounded-sm border-l-2 border-state-revoked bg-paper p-3 font-mono text-[11px] text-ink-soft">
          Could not load artifacts: {listing.error?.message ?? 'unknown'}
        </p>
      )}

      {listing.data && listing.data.length === 0 ? (
        <p className="rounded-sm border border-dashed border-ink-mute p-6 text-center font-mono text-xs text-ink-mute">
          No artifacts yet. Strategy ticks will publish audit reports here.
        </p>
      ) : (
        <ul className="space-y-2">
          {listing.data?.map((artifact) => (
            <li key={artifact.slot.toString()}>
              <button
                onClick={() => setSelected(artifact)}
                className="grid w-full grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-sm border border-divider bg-paper-strong/60 p-3 text-left transition hover:border-ink/40 hover:bg-paper-strong"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                  #{artifact.slot.toString()}
                </span>
                <span>
                  <span className="block font-display text-sm font-semibold text-ink">
                    {artifact.label || '(untitled)'}
                  </span>
                  <span className="font-mono text-[10px] text-ink-mute">
                    {artifact.mimeType} · {humanBytes(artifact.sizeBytes)} · walrus{' '}
                    {shortenHash(artifact.walrusBlobId)}
                  </span>
                </span>
                <span className="font-mono text-[10px] text-state-active">
                  epoch {artifact.createdAtEpoch.toString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.label ? `Artifact: ${selected.label}` : 'Artifact preview'}
        accent="var(--accent-purple)"
        footer={
          <>
            <button className="btn-flat" data-variant="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
            {selected && (
              <a
                className="btn-flat"
                data-variant="primary"
                href={`https://aggregator.walrus-${WALRUS_NETWORK}.walrus.space/v1/blobs/${selected.walrusBlobId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open raw blob ↗
              </a>
            )}
          </>
        }
      >
        {selected && (
          <div className="space-y-3">
            <div className="rounded-sm border border-divider bg-paper p-3 font-mono text-[10px] text-ink-soft">
              <p>walrus_blob_id: {selected.walrusBlobId}</p>
              <p>
                sha256:{' '}
                {Array.from(selected.sha256)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')}
              </p>
              <p>
                mime: {selected.mimeType} · size: {humanBytes(selected.sizeBytes)} · seal:{' '}
                {selected.sealEncrypted ? 'yes' : 'no'}
              </p>
            </div>

            {selected.sealEncrypted ? (
              <div className="space-y-3">
                {!SYNAPSE_SEAL_PACKAGE_ID ? (
                  <p className="rounded-sm border-l-2 border-state-expired bg-paper p-3 font-mono text-[11px] text-ink-soft">
                    This artifact is Seal-encrypted. Set{' '}
                    <code className="text-ink">NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID</code> (the
                    published <code className="text-ink">synapse_seal</code> package) to enable
                    in-browser decryption.
                  </p>
                ) : (
                  <>
                    <p className="font-mono text-[11px] text-ink-soft">
                      Seal-encrypted blob. Pick the vault{' '}
                      <code className="text-ink">.key</code> — the session key authorizes
                      decryption and never leaves your browser.
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="file"
                        accept=".key,.json,application/json"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          setKeyText(await f.text());
                          setKeyName(f.name);
                        }}
                        className="block w-full text-xs file:mr-3 file:rounded-sm file:border file:border-ink file:bg-paper-strong file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink hover:file:bg-paper"
                      />
                      <button
                        className="btn-flat"
                        data-variant="accent"
                        disabled={!keyText || decBusy}
                        onClick={onDecrypt}
                      >
                        {decBusy ? 'Decrypting…' : 'Decrypt'}
                      </button>
                    </div>
                    {keyName && (
                      <span className="font-mono text-[10px] text-state-active">✓ {keyName}</span>
                    )}
                    {decErr && (
                      <p className="rounded-sm border-l-2 border-state-revoked bg-paper p-3 font-mono text-[11px] text-ink-soft">
                        Decrypt failed: {decErr}
                      </p>
                    )}
                    {decText !== null && (
                      <pre className="max-h-[420px] overflow-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap">
                        {decText}
                      </pre>
                    )}
                  </>
                )}
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                {content.isLoading && (
                  <motion.p
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="font-mono text-xs text-ink-mute"
                  >
                    Fetching from Walrus aggregator…
                  </motion.p>
                )}
                {content.isError && (
                  <motion.p
                    key="error"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="rounded-sm border-l-2 border-state-revoked bg-paper p-3 font-mono text-[11px] text-ink-soft"
                  >
                    Aggregator error: {(content.error as Error).message}
                  </motion.p>
                )}
                {content.data !== undefined && content.data !== null && (
                  <motion.pre
                    key="content"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="max-h-[420px] overflow-auto rounded-sm border border-divider bg-paper p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap"
                  >
                    {content.data}
                  </motion.pre>
                )}
              </AnimatePresence>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function humanBytes(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
