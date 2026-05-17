'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import {
  bundleStrategySource,
  StrategyBundleError,
} from '@/lib/strategy-bundler';
import { publishToWalrus, type WalrusNetwork } from '@/lib/walrus-publisher';
import { NETWORK } from '@/lib/synapse-config';
import { shortenHash } from '@/lib/format';

const DEFAULT_EPOCHS = 12;
const MAX_SOURCE_BYTES = 256 * 1024; // 256 KiB — generous for a single strategy
const STARTER_TEMPLATE = `// Strategists: write a self-contained strategy that default-exports either:
//   (a) a Strategy object, or
//   (b) a factory function returning a Strategy.
//
// Types from @synapse-core/vault are erased at compile time, so you can
// import them as 'type-only' imports for editor support without runtime cost.

import type { Strategy, StrategyInput, StrategyDecision } from '@synapse-core/vault';

const strategy: Strategy = {
  id: 'my-strategy',
  name: 'My Strategy',
  version: '1.0.0',
  description: 'Replace this with a one-paragraph plain-English description.',
  evaluate: async (input: StrategyInput): Promise<StrategyDecision> => {
    return { kind: 'noop', rationale: 'No-op example. Replace with real logic.' };
  },
};

export default strategy;
`;

export interface BundlerCallbackArgs {
  walrusBlobId: string;
  codeHashHex: string;
  sizeBytes: number;
  alreadyCertified: boolean;
  publicUrl: string;
}

interface Props {
  /** Fired once a successful bundle + Walrus upload completes. */
  onBundled: (args: BundlerCallbackArgs) => void;
  /** Disable the controls when the parent is mid-submit. */
  disabled?: boolean;
}

type Mode = 'paste' | 'upload';

type Phase =
  | { kind: 'idle' }
  | { kind: 'bundling' }
  | { kind: 'uploading'; sizeBytes: number; sha256Hex: string }
  | { kind: 'done'; result: BundlerCallbackArgs }
  | { kind: 'error'; message: string };

export function StrategyBundlerPanel({ onBundled, disabled }: Props) {
  const toast = useToast();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>('paste');
  const [source, setSource] = useState<string>(STARTER_TEMPLATE);
  const [filename, setFilename] = useState<string>('strategy.ts');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [epochs, setEpochs] = useState<number>(DEFAULT_EPOCHS);

  const network: WalrusNetwork = NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const busy = phase.kind === 'bundling' || phase.kind === 'uploading';

  const onPickFile = useCallback(async (file: File) => {
    if (file.size > MAX_SOURCE_BYTES) {
      toast.push({
        variant: 'warn',
        title: 'File too large',
        body: `Max ${Math.floor(MAX_SOURCE_BYTES / 1024)} KiB. Refactor or pre-bundle larger sources.`,
      });
      return;
    }
    const text = await file.text();
    setSource(text);
    setFilename(file.name);
    setMode('upload');
    setPhase({ kind: 'idle' });
    setWarnings([]);
  }, [toast]);

  const onBundleAndUpload = useCallback(async () => {
    setWarnings([]);
    if (source.trim().length === 0) {
      toast.push({
        variant: 'warn',
        title: 'No source provided',
        body: 'Paste a strategy file or upload one before bundling.',
      });
      return;
    }
    setPhase({ kind: 'bundling' });
    try {
      const bundle = await bundleStrategySource({ source, filename });
      setWarnings(bundle.warnings);

      // Compute sha256 alongside the upload (publishToWalrus also returns
      // it) so we can show progress before the network roundtrip starts.
      const sha256Bytes = await crypto.subtle.digest(
        'SHA-256',
        bundle.bytes as BufferSource,
      );
      const sha256Hex = Array.from(new Uint8Array(sha256Bytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      setPhase({ kind: 'uploading', sizeBytes: bundle.bytes.length, sha256Hex });

      const upload = await publishToWalrus({
        bytes: bundle.bytes,
        network,
        epochs,
      });

      const result: BundlerCallbackArgs = {
        walrusBlobId: upload.blobId,
        codeHashHex: `0x${upload.sha256Hex}`,
        sizeBytes: upload.sizeBytes,
        alreadyCertified: upload.alreadyCertified,
        publicUrl: upload.publicUrl,
      };
      setPhase({ kind: 'done', result });
      onBundled(result);
      toast.push({
        variant: 'success',
        title: upload.alreadyCertified ? 'Bundle reused' : 'Bundle published',
        body: upload.alreadyCertified
          ? `Walrus recognised this sha256 and reused blob ${shortenHash(upload.blobId)}.`
          : `Uploaded ${upload.sizeBytes} B to Walrus as ${shortenHash(upload.blobId)}.`,
        durationMs: 7000,
      });
    } catch (err) {
      const message =
        err instanceof StrategyBundleError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setPhase({ kind: 'error', message });
      toast.push({
        variant: 'danger',
        title: 'Bundle failed',
        body: message.slice(0, 200),
        durationMs: 9000,
      });
    }
  }, [source, filename, network, epochs, onBundled, toast]);

  const onResetBundle = useCallback(() => {
    setPhase({ kind: 'idle' });
    setWarnings([]);
  }, []);

  return (
    <section className="grid gap-4 rounded-sm border-2 border-divider bg-paper-strong p-4 lg:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>bundle</CodeTag> · esbuild → walrus
          </p>
          <h3 className="mt-1 font-display text-lg font-bold tracking-tight">
            Bundle &amp; publish your strategy bundle
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">
            Compile your TypeScript in-browser, upload the bundle to Walrus, and let us
            wire the resulting blob ID + sha256 into the publish PTB below. No CLI.
          </p>
        </div>
        <div className="flex gap-1 rounded-sm border border-divider bg-paper p-0.5">
          {(['paste', 'upload'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled || busy}
              onClick={() => setMode(m)}
              className={`rounded-sm px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                mode === m ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {m === 'paste' ? 'Paste' : 'Upload file'}
            </button>
          ))}
        </div>
      </header>

      {mode === 'paste' ? (
        <textarea
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            if (phase.kind !== 'idle' && phase.kind !== 'bundling') {
              setPhase({ kind: 'idle' });
            }
          }}
          spellCheck={false}
          rows={16}
          disabled={disabled || busy}
          className="w-full resize-y rounded-sm border border-divider bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-ink"
        />
      ) : (
        <div className="grid gap-2">
          <label
            htmlFor={fileInputId}
            className={`flex items-center justify-between gap-3 rounded-sm border-2 border-dashed border-divider px-4 py-6 text-xs text-ink-soft transition hover:border-ink ${
              disabled || busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'
            }`}
          >
            <span>
              <strong className="font-display text-sm font-semibold text-ink">
                Drop or click to pick a strategy file
              </strong>
              <br />
              Accepts <code className="font-mono text-[10px]">.ts</code>,{' '}
              <code className="font-mono text-[10px]">.tsx</code>,{' '}
              <code className="font-mono text-[10px]">.js</code>,{' '}
              <code className="font-mono text-[10px]">.mjs</code>. Max{' '}
              {Math.floor(MAX_SOURCE_BYTES / 1024)} KiB.
            </span>
            {filename && (
              <span className="font-mono text-[11px] text-ink">
                {filename}
              </span>
            )}
          </label>
          <input
            ref={fileInputRef}
            id={fileInputId}
            type="file"
            accept=".ts,.tsx,.js,.mjs,.jsx"
            disabled={disabled || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickFile(file);
            }}
            className="hidden"
          />
          {source && (
            <details className="rounded-sm border border-divider bg-paper p-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
                Preview source ({source.length} chars)
              </summary>
              <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink">
                {source}
              </pre>
            </details>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="grid gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Walrus storage epochs
          </span>
          <input
            type="number"
            min={1}
            max={200}
            value={epochs}
            onChange={(e) => setEpochs(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
            disabled={disabled || busy || phase.kind === 'done'}
            className="rounded-sm border border-divider bg-paper px-3 py-2 font-mono text-xs outline-none focus:border-ink"
          />
        </label>
        {phase.kind === 'done' ? (
          <button
            type="button"
            className="btn-flat"
            data-variant="ghost"
            onClick={onResetBundle}
            disabled={disabled}
          >
            Re-bundle
          </button>
        ) : (
          <button
            type="button"
            className="btn-flat"
            data-variant="accent"
            onClick={onBundleAndUpload}
            disabled={disabled || busy || source.trim().length === 0}
          >
            {phase.kind === 'bundling'
              ? 'Compiling…'
              : phase.kind === 'uploading'
                ? 'Uploading to Walrus…'
                : 'Bundle & upload'}
          </button>
        )}
        <span className="font-mono text-[10px] text-ink-mute sm:text-right">
          network: <strong className="text-ink">{network}</strong>
        </span>
      </div>

      <PhaseStrip phase={phase} />

      {warnings.length > 0 && (
        <details className="rounded-sm border border-accent-orange bg-paper p-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-ink">
            {warnings.length} bundler warning{warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 grid gap-1 font-mono text-[11px] text-ink-soft">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PhaseStrip({ phase }: { phase: Phase }) {
  if (phase.kind === 'idle') return null;
  if (phase.kind === 'bundling') {
    return (
      <StripBase tone="info">
        <Dot pulse /> Compiling with esbuild-wasm…
      </StripBase>
    );
  }
  if (phase.kind === 'uploading') {
    return (
      <StripBase tone="info">
        <Dot pulse /> Uploading {phase.sizeBytes} B (sha256{' '}
        <code className="font-mono text-[10px]">{phase.sha256Hex.slice(0, 10)}…</code>)
        to Walrus
      </StripBase>
    );
  }
  if (phase.kind === 'error') {
    return (
      <StripBase tone="danger">
        <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
          {phase.message}
        </pre>
      </StripBase>
    );
  }
  const r = phase.result;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-sm border-2 border-ink bg-accent-green p-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
        <CodeTag>✓ bundled</CodeTag>{' '}
        {r.alreadyCertified ? '(reused existing blob)' : '(newly stored)'}
      </p>
      <dl className="mt-2 grid gap-1.5 text-[11px]">
        <KvRow label="Walrus blob" value={r.walrusBlobId} link={r.publicUrl} />
        <KvRow label="sha256 (32B)" value={r.codeHashHex} />
        <KvRow label="Bundle size" value={`${r.sizeBytes} bytes`} />
      </dl>
      <p className="mt-2 text-[11px] text-ink-soft">
        The publish form below is auto-filled with this blob ID + code hash. Sign the
        PTB to commit the strategy on-chain.
      </p>
    </motion.div>
  );
}

function StripBase({
  tone,
  children,
}: {
  tone: 'info' | 'danger';
  children: React.ReactNode;
}) {
  const style =
    tone === 'danger'
      ? { borderColor: 'var(--state-danger)' }
      : { borderColor: 'var(--ink)' };
  return (
    <div
      className="flex items-start gap-2 rounded-sm border-2 bg-paper p-3 text-xs text-ink"
      style={style}
    >
      {children}
    </div>
  );
}

function Dot({ pulse }: { pulse?: boolean }) {
  return (
    <span
      className={`mt-1 inline-block h-2 w-2 rounded-full bg-ink ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

function KvRow({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-divider/50 pb-1 last:border-0">
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="num font-mono text-[10px] text-ink hover:underline"
        >
          {shortenHash(value)} ↗
        </a>
      ) : (
        <span className="num font-mono text-[10px] text-ink">
          {value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value}
        </span>
      )}
    </div>
  );
}
