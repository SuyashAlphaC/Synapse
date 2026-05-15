'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { motion } from 'motion/react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { CodeTag } from '../ui/code-tag';
import { WalletButton } from '../ui/wallet-button';
import { useToast } from '../ui/toast';
import { synapseTarget, explorerTxUrl, explorerObjectUrl } from '@/lib/synapse-config';
import { shortenHash } from '@/lib/format';
import { RISK_LABEL, type RiskProfile } from '@/lib/strategies';

interface FormState {
  name: string;
  description: string;
  sourceWalrusBlob: string;
  codeHashHex: string;
  riskProfile: RiskProfile;
  royaltyBps: number;
}

const INITIAL: FormState = {
  name: '',
  description: '',
  sourceWalrusBlob: '',
  codeHashHex: '',
  riskProfile: 0,
  royaltyBps: 1500,
};

export function PublishStrategyForm() {
  const router = useRouter();
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const toast = useToast();

  const [form, setForm] = useState<FormState>(INITIAL);
  const [result, setResult] = useState<{
    digest: string;
    strategyId: string;
    capId: string;
  } | null>(null);

  const canSubmit =
    form.name.trim().length > 0 &&
    form.description.trim().length >= 20 &&
    /^0x[0-9a-fA-F]{64}$/.test(form.codeHashHex.trim()) &&
    form.royaltyBps >= 0 &&
    form.royaltyBps <= 5000;

  async function generateCodeHash() {
    if (!form.sourceWalrusBlob && !form.description) {
      toast.push({
        variant: 'warn',
        title: 'Nothing to hash yet',
        body: 'Fill in source pointer or description first.',
      });
      return;
    }
    const seed = `${form.name}\n${form.description}\n${form.sourceWalrusBlob}\n${Date.now()}`;
    const bytes = new TextEncoder().encode(seed);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const hex = '0x' + Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    setForm((f) => ({ ...f, codeHashHex: hex }));
  }

  async function submit() {
    if (!account) {
      toast.push({
        variant: 'warn',
        title: 'Connect a wallet first',
        body: 'Publishing a strategy requires signing a PTB.',
      });
      return;
    }
    if (!canSubmit) {
      toast.push({
        variant: 'warn',
        title: 'Form incomplete',
        body: 'Name, description (≥ 20 chars), and a 32-byte code hash are required.',
      });
      return;
    }
    try {
      const tx = new Transaction();
      const codeHashBytes = hexToBytes(form.codeHashHex.trim());
      const cap = tx.moveCall({
        target: synapseTarget('strategy_registry', 'publish'),
        arguments: [
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(form.name.trim()))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(form.description.trim()))),
          tx.pure.vector('u8', Array.from(codeHashBytes)),
          tx.pure.vector(
            'u8',
            Array.from(new TextEncoder().encode(form.sourceWalrusBlob.trim())),
          ),
          tx.pure.u8(form.riskProfile),
          tx.pure.u16(form.royaltyBps),
        ],
      });
      tx.transferObjects([cap], tx.pure.address(account.address));

      toast.push({
        variant: 'info',
        title: 'Awaiting wallet signature',
        body: 'Approve the publish PTB to commit the strategy on-chain.',
        durationMs: 7000,
      });

      const signed = await signAndExecute({ transaction: tx });
      const detail = await suiClient.waitForTransaction({
        digest: signed.digest,
        options: { showObjectChanges: true },
        timeout: 60_000,
        pollInterval: 600,
      });
      const changes = detail.objectChanges ?? [];
      const created = changes.filter((c) => c.type === 'created');
      const strategyChange = created.find(
        (c) => 'objectType' in c && c.objectType.endsWith('::strategy_registry::Strategy'),
      );
      const capChange = created.find(
        (c) => 'objectType' in c && c.objectType.endsWith('::strategy_registry::StrategistCap'),
      );

      if (!strategyChange || !('objectId' in strategyChange)) {
        throw new Error('Could not extract Strategy object from transaction effects');
      }
      const strategyId = strategyChange.objectId as string;
      const capId =
        capChange && 'objectId' in capChange ? (capChange.objectId as string) : '0x0';

      setResult({ digest: signed.digest, strategyId, capId });
      toast.push({
        variant: 'success',
        title: 'Strategy published',
        body: `Strategy ${shortenHash(strategyId)} is live on testnet`,
        durationMs: 9000,
      });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Publish failed',
        body: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        durationMs: 9000,
      });
    }
  }

  if (result) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="card-flat mx-auto max-w-2xl p-8 text-center"
      >
        <span
          className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full border-2 border-ink font-display text-xl font-extrabold"
          style={{ backgroundColor: 'var(--state-active)' }}
        >
          ✓
        </span>
        <h2 className="font-display text-3xl font-bold tracking-tight">Strategy live</h2>
        <p className="mt-3 text-sm text-ink-soft">
          You now own the StrategistCap. Hold it to publish new versions, deprecate, or
          reactivate. Royalties land in your wallet automatically on every paid tick.
        </p>
        <dl className="mt-6 grid gap-2 text-left text-xs">
          <RowKv label="Strategy" value={result.strategyId} link={explorerObjectUrl(result.strategyId)} />
          <RowKv label="StrategistCap" value={result.capId} link={explorerObjectUrl(result.capId)} />
          <RowKv label="Tx" value={result.digest} link={explorerTxUrl(result.digest)} />
        </dl>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            className="btn-flat"
            data-variant="primary"
            onClick={() => router.push('/marketplace')}
          >
            View marketplace →
          </button>
          <button
            className="btn-flat"
            data-variant="ghost"
            onClick={() => {
              setResult(null);
              setForm(INITIAL);
            }}
          >
            Publish another
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="card-flat grid gap-6 p-6 lg:p-8">
        <Field
          label="Strategy name"
          hint="Shown as the card title in the marketplace."
        >
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Conservative Rebalancer v1"
            className="w-full rounded-sm border border-divider bg-paper-strong px-3 py-2 outline-none focus:border-ink"
            maxLength={64}
          />
        </Field>

        <Field
          label="Description"
          hint="Plain text. At least 20 characters. Shown on the card + detail view."
        >
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={4}
            placeholder="Rebalances SUI/USDC daily with a 5% per-epoch cap. Tracks SUI/USDC benchmark + 50bps."
            className="w-full resize-y rounded-sm border border-divider bg-paper-strong px-3 py-2 text-sm outline-none focus:border-ink"
            maxLength={400}
          />
          <p className="mt-1 font-mono text-[10px] text-ink-mute">
            {form.description.length}/400
          </p>
        </Field>

        <div className="grid gap-6 md:grid-cols-2">
          <Field
            label="Risk profile"
            hint="Drives default policy templates for vaults that hire this strategy."
          >
            <div className="grid grid-cols-3 gap-2">
              {([0, 1, 2] as RiskProfile[]).map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setForm({ ...form, riskProfile: r })}
                  className={`rounded-sm border-2 px-3 py-2 text-xs font-semibold transition ${
                    form.riskProfile === r
                      ? 'border-ink shadow-[3px_3px_0_0_var(--ink)]'
                      : 'border-divider bg-paper-strong hover:border-ink'
                  }`}
                  style={{
                    backgroundColor:
                      form.riskProfile === r
                        ? r === 0
                          ? 'var(--accent-green)'
                          : r === 1
                            ? 'var(--accent-blue)'
                            : 'var(--accent-orange)'
                        : undefined,
                  }}
                >
                  {RISK_LABEL[r]}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label={`Royalty: ${(form.royaltyBps / 100).toFixed(1)}% of perf fee`}
            hint="Strategist's cut of realized profit. Max 50%."
          >
            <input
              type="range"
              min={0}
              max={5000}
              step={50}
              value={form.royaltyBps}
              onChange={(e) => setForm({ ...form, royaltyBps: Number(e.target.value) })}
              className="w-full accent-ink"
            />
            <p className="mt-1 font-mono text-[10px] text-ink-mute">
              {form.royaltyBps} bps (basis points)
            </p>
          </Field>
        </div>

        <Field
          label="Walrus source blob ID"
          hint="(optional for testnet) Where the full runtime code lives. Helpful for reproducibility audits."
        >
          <input
            type="text"
            value={form.sourceWalrusBlob}
            onChange={(e) => setForm({ ...form, sourceWalrusBlob: e.target.value })}
            placeholder="walrus-blob-id-abc…"
            className="w-full rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
          />
        </Field>

        <Field
          label="Code hash (sha256, 32 bytes hex)"
          hint="Commitment to the strategy runtime bundle. Click ‘derive’ to generate one from the description."
        >
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              type="text"
              value={form.codeHashHex}
              onChange={(e) => setForm({ ...form, codeHashHex: e.target.value })}
              placeholder="0x…"
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-[11px] outline-none focus:border-ink"
              maxLength={66}
            />
            <button type="button" className="btn-flat" data-variant="ghost" onClick={generateCodeHash}>
              Derive sha256
            </button>
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          {account ? (
            <button
              type="button"
              className="btn-flat"
              data-variant="accent"
              onClick={submit}
              disabled={!canSubmit || isPending}
            >
              {isPending ? 'Signing & submitting…' : 'Publish strategy'}
            </button>
          ) : (
            <WalletButton />
          )}
          {!canSubmit && (
            <span className="font-mono text-[11px] text-ink-mute">
              Fill name + description (≥20 chars) + 32-byte hex code hash.
            </span>
          )}
        </div>
      </div>

      <aside className="lg:sticky lg:top-32 lg:self-start">
        <div className="card-flat p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>summary</CodeTag>
          </p>
          <dl className="mt-4 grid gap-2 text-xs">
            <RowSummary label="Name" value={form.name || '—'} />
            <RowSummary label="Risk" value={RISK_LABEL[form.riskProfile]} />
            <RowSummary
              label="Royalty"
              value={`${(form.royaltyBps / 100).toFixed(1)}% (${form.royaltyBps}bps)`}
            />
            <RowSummary
              label="Code hash"
              value={
                form.codeHashHex.length > 0
                  ? `${form.codeHashHex.slice(0, 10)}…${form.codeHashHex.slice(-6)}`
                  : '—'
              }
            />
          </dl>
          <hr className="divider-dashed my-5" />
          <p className="text-xs leading-relaxed text-ink-soft">
            Your strategy is a Sui shared object after publish. The marketplace card shows
            its name + lifetime reputation. Any owner can hire it; royalties flow to your
            address on every <code className="font-mono text-[10px]">pay_strategist_royalty</code> call.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-display text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="font-mono text-[10px] text-ink-mute">{hint}</span>}
    </label>
  );
}

function RowSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-divider pb-1.5 last:border-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <span className="num text-xs">{value}</span>
    </div>
  );
}

function RowKv({ label, value, link }: { label: string; value: string; link: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-divider pb-1.5 last:border-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="num font-mono text-[11px] text-accent-blue hover:underline"
      >
        {shortenHash(value)} ↗
      </a>
    </div>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Hex string must have even length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
