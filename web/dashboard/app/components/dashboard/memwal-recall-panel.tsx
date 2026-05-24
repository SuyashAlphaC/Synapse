'use client';

import { useCallback, useMemo, useState } from 'react';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import { shortenHash } from '@/lib/format';
import { recallVaultMemory, type RecallResult } from '@/lib/memwal-recall';

const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs';

interface Props {
  memwalAccountId: Uint8Array;
  memwalNamespace: Uint8Array;
}

/**
 * MemWal recall panel — the "inspect agent memory stored on Walrus" tool.
 *
 * The vault's memories are SEAL-encrypted blobs on Walrus, addressed by a
 * MemWal namespace. This panel issues a real semantic `recall()`: the
 * relayer embeds the query, vector-searches the namespace, downloads + SEAL-
 * decrypts the top matches, and returns them. The delegate key (from the
 * .key file) authorizes decryption and never leaves the browser; the relayer
 * is reached via the same-origin /api/memwal-proxy.
 */
export function MemWalRecallPanel({ memwalAccountId, memwalNamespace }: Props) {
  const toast = useToast();
  const namespace = useMemo(
    () => new TextDecoder().decode(memwalNamespace),
    [memwalNamespace],
  );

  const [keyFileText, setKeyFileText] = useState<string | null>(null);
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  const [query, setQuery] = useState('recent rebalance decisions');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPickKeyFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith('.key') && !file.name.endsWith('.json')) {
        toast.push({ variant: 'warn', title: 'Wrong file type', body: 'Expected the .key file from mint.' });
        return;
      }
      if (file.size > 32_768) {
        toast.push({ variant: 'warn', title: 'File too large', body: `Got ${file.size} bytes — expected a .key file.` });
        return;
      }
      const text = await file.text();
      try {
        const parsed = JSON.parse(text) as { address?: unknown };
        if (typeof parsed.address !== 'string') throw new Error('missing `address` field');
      } catch (err) {
        toast.push({ variant: 'danger', title: 'Not a valid .key file', body: err instanceof Error ? err.message : String(err) });
        return;
      }
      setKeyFileText(text);
      setKeyFileName(file.name);
    },
    [toast],
  );

  const onRecall = useCallback(async () => {
    if (!keyFileText) {
      toast.push({ variant: 'warn', title: 'Pick a .key file first', body: 'The delegate key authorizes decryption.' });
      return;
    }
    if (!query.trim()) {
      toast.push({ variant: 'warn', title: 'Enter a query', body: '' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await recallVaultMemory({
        memwalAccountId,
        memwalNamespace,
        keyFileContents: keyFileText,
        query: query.trim(),
      });
      setResult(res);
      if (res.results.length === 0) {
        toast.push({ variant: 'info', title: 'No memories matched', body: 'This namespace may be empty or the query too narrow.' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.push({ variant: 'danger', title: 'Recall failed', body: msg.slice(0, 140), durationMs: 9000 });
    } finally {
      setLoading(false);
    }
  }, [keyFileText, query, memwalAccountId, memwalNamespace, toast]);

  return (
    <div className="card-flat p-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl font-bold">Agent memory</h3>
        <CodeTag>memwal · walrus</CodeTag>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-ink-soft">
        Semantic recall over this vault&rsquo;s memories — SEAL-encrypted blobs
        stored on Walrus under namespace{' '}
        <code className="font-mono text-[10px] text-ink">{namespace || '—'}</code>.
        Pick the <code className="font-mono text-[10px]">.key</code> file (the
        delegate key decrypts results and never leaves your browser), enter a
        query, and recall.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Delegate .key file
          </span>
          <input
            type="file"
            accept=".key,.json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickKeyFile(f);
            }}
            className="block w-full text-xs file:mr-3 file:rounded-sm file:border file:border-ink file:bg-paper-strong file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink hover:file:bg-paper"
          />
          {keyFileName && (
            <span className="font-mono text-[10px] text-state-active">✓ {keyFileName}</span>
          )}
        </label>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Query
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !loading) void onRecall();
            }}
            placeholder="e.g. why did the agent sell SUI last epoch?"
            className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
          />
        </label>
        <button
          type="button"
          onClick={onRecall}
          disabled={loading || !keyFileText}
          className="btn-flat"
          data-variant="accent"
        >
          {loading ? 'Recalling…' : 'Recall'}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-sm border-l-2 border-state-danger bg-paper p-2 font-mono text-[10px] text-state-danger">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-5 grid gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            {result.results.length} of {result.total} memor{result.total === 1 ? 'y' : 'ies'}{' '}
            · ordered by relevance
          </span>
          <ul className="grid gap-2">
            {result.results.map((m, i) => (
              <li key={`${m.blob_id}-${i}`} className="rounded-sm border border-divider bg-paper p-3">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{m.text}</p>
                <div className="mt-2 flex items-center gap-3 font-mono text-[10px] text-ink-mute">
                  <span>distance {m.distance.toFixed(4)}</span>
                  <a
                    href={`${WALRUS_AGGREGATOR}/${m.blob_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-ink hover:underline"
                  >
                    blob {shortenHash(m.blob_id)} ↗
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
