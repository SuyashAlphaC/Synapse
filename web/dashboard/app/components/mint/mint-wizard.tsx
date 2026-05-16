'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from '@mysten/dapp-kit';
import { CodeTag } from '../ui/code-tag';
import { WalletButton } from '../ui/wallet-button';
import { useToast } from '../ui/toast';
import { buildMintPTB, generateSessionKeypair } from '@/lib/ptb';
import { explorerTxUrl } from '@/lib/synapse-config';
import { shortenAddress, shortenHash } from '@/lib/format';
import { recordVault } from '@/lib/local-vaults';
import { RISK_LABEL, type LiveStrategy } from '@/lib/strategies';
import { useStrategies } from '../../hooks/use-strategies';

const STEPS = [
  {
    n: '01',
    title: 'Connect a Sui wallet',
    body: 'Use Slush, Sui Wallet, or any Wallet Standard-compatible browser wallet. The wallet signs every PTB locally — Synapse never holds your keys.',
    accent: 'var(--accent-blue)',
    tag: 'identity',
  },
  {
    n: '02',
    title: 'Hire a strategy',
    body: 'Pick a published strategy from the marketplace. Royalty + version + lifetime reputation are all on-chain; you can revoke and rehire any time.',
    accent: 'var(--accent-yellow)',
    tag: 'marketplace',
  },
  {
    n: '03',
    title: 'Configure policy',
    body: 'Spend cap per epoch, contract allowlist, expiry. Every constraint becomes Move VM enforcement.',
    accent: 'var(--accent-green)',
    tag: 'policy',
  },
  {
    n: '04',
    title: 'Seed the treasury',
    body: 'Fund the Vault with SUI from your wallet. Balances live inside the AgentIdentity Bag, gated by wallet::spend.',
    accent: 'var(--accent-orange)',
    tag: 'treasury',
  },
  {
    n: '05',
    title: 'Connect MemWal',
    body: 'Attach a MemWal account for private strategy recall, or mint without memory and keep every decision on-chain.',
    accent: 'var(--accent-purple)',
    tag: 'memory',
  },
  {
    n: '06',
    title: 'Mint on testnet',
    body: 'Construct + sign + submit the mint PTB. agent::new → fund<SUI> → share, atomic.',
    accent: 'var(--accent-blue)',
    tag: 'mint',
  },
] as const;

interface MintForm {
  strategyId: string | null;
  spendPct: number;
  expiryDays: number;
  fundingSui: number;
  memwalAccountId: string;
  memwalDelegateKeyHex: string;
  skipMemWal: boolean;
}

export function MintWizard() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute, isPending: signing } = useSignAndExecuteTransaction();
  const toast = useToast();
  const [activeStep, setActiveStep] = useState(0);
  const [form, setForm] = useState<MintForm>({
    strategyId: null,
    spendPct: 5,
    expiryDays: 7,
    fundingSui: 0.1,
    memwalAccountId: '',
    memwalDelegateKeyHex: '',
    skipMemWal: false,
  });
  const [mintResult, setMintResult] = useState<{
    digest: string;
    agentId?: string;
    sessionAddress: string;
  } | null>(null);

  const strategiesQuery = useStrategies();
  const strategies = useMemo(
    () => strategiesQuery.data?.filter((s) => s.active) ?? [],
    [strategiesQuery.data],
  );
  const selected = strategies.find((s) => s.id === form.strategyId) ?? null;

  if (account && activeStep === 0 && !mintResult) {
    setTimeout(() => setActiveStep(1), 0);
  }

  function advance() {
    setActiveStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setActiveStep((s) => Math.max(s - 1, 0));
  }

  async function performMint() {
    if (!account) {
      toast.push({
        variant: 'warn',
        title: 'Connect a wallet first',
        body: 'Step 1 needs to finish before minting.',
      });
      return;
    }
    if (!form.strategyId) {
      toast.push({
        variant: 'warn',
        title: 'Pick a strategy first',
        body: 'Every vault must be hired against a published strategy.',
      });
      return;
    }

    const session = generateSessionKeypair();
    const fundingMist = BigInt(Math.round(form.fundingSui * 1_000_000_000));
    const spendPerEpochMist = (fundingMist * BigInt(Math.round(form.spendPct * 100))) / 10_000n;

    // CRITICAL — save the session key file *before* submitting the mint PTB.
    // If the tx fails or the user closes the tab mid-flow, they still have
    // the secret in their Downloads. The secret is what the agent runtime
    // signs ticks with; without it the vault is unrunnable.
    downloadSessionKeyFile({
      address: session.address,
      secretBase64: session.secretBase64,
      strategyId: form.strategyId ?? '',
      ownerAddress: account.address,
      mintedAtMs: Date.now(),
    });
    toast.push({
      variant: 'info',
      title: 'Session key saved to Downloads',
      body: 'Keep this .key file safe — the agent runtime signs with it.',
      durationMs: 6000,
    });

    try {
      const { epoch } = await suiClient.getLatestSuiSystemState();
      const expiryEpoch = BigInt(epoch) + BigInt(form.expiryDays);
      const tx = buildMintPTB({
        strategyId: form.strategyId,
        sessionAddr: session.address,
        expiryEpoch,
        spendPerEpochMist: spendPerEpochMist > 0n ? spendPerEpochMist : 1n,
        approvedPackages: [],
        memwalAccountId: form.skipMemWal
          ? new Uint8Array()
          : new TextEncoder().encode(form.memwalAccountId.trim()),
        memwalDelegateKeyId: form.skipMemWal
          ? new Uint8Array()
          : new TextEncoder().encode(form.memwalDelegateKeyHex.trim()),
        memwalNamespace: form.skipMemWal
          ? new Uint8Array()
          : new TextEncoder().encode(`synapse:vault:${account.address}`),
        fundingMist,
      });

      toast.push({
        variant: 'info',
        title: 'Awaiting wallet signature',
        body: 'Approve the mint PTB in your wallet to continue.',
        durationMs: 8000,
      });

      const result = await signAndExecute({ transaction: tx });

      const detail = await suiClient.waitForTransaction({
        digest: result.digest,
        options: { showObjectChanges: true, showEffects: true },
        timeout: 60_000,
        pollInterval: 600,
      });

      const agentChange = detail.objectChanges?.find(
        (c) => c.type === 'created' && c.objectType.includes('::agent::AgentIdentity'),
      );
      const agentId =
        agentChange && 'objectId' in agentChange ? (agentChange.objectId as string) : undefined;

      setMintResult({
        digest: result.digest,
        sessionAddress: session.address,
        ...(agentId ? { agentId } : {}),
      });
      if (agentId) {
        recordVault({
          agentId,
          ownerAddress: account.address,
          digest: result.digest,
          sessionAddress: session.address,
          memwalAccountId: form.skipMemWal ? null : form.memwalAccountId.trim(),
          mintedAtMs: Date.now(),
        });
        if (!form.skipMemWal) {
          window.localStorage.setItem(
            `synapse:memwal:${agentId}`,
            form.memwalDelegateKeyHex.trim(),
          );
        }
      }

      toast.push({
        variant: 'success',
        title: 'Vault minted on testnet',
        body: agentId
          ? `AgentIdentity ${shortenHash(agentId)} created`
          : `Tx ${shortenHash(result.digest)} confirmed`,
        durationMs: 8000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({
        variant: 'danger',
        title: 'Mint PTB failed',
        body: msg.slice(0, 160),
        durationMs: 9000,
      });
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <ol className="grid gap-4">
        {STEPS.map((step, i) => {
          const state =
            i < activeStep || (i === 0 && account)
              ? 'done'
              : i === activeStep
                ? 'active'
                : 'locked';
          return (
            <motion.li
              key={step.n}
              layout
              transition={{ layout: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
              className={`card-flat group grid grid-cols-[3rem_1fr] items-start gap-6 p-6 md:grid-cols-[3rem_1fr_auto] ${
                state === 'locked' ? 'opacity-60' : ''
              } ${state === 'active' ? 'ring-2 ring-ink' : ''}`}
            >
              <div
                className="flex h-12 w-12 items-center justify-center rounded-sm border-2 border-ink font-display text-xl font-extrabold"
                style={{
                  backgroundColor: state === 'done' ? 'var(--state-active)' : step.accent,
                }}
              >
                {state === 'done' ? '✓' : step.n}
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <CodeTag>{step.tag}</CodeTag>
                  {state === 'active' && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-orange">
                      · current
                    </span>
                  )}
                </div>
                <h3 className="font-display text-2xl font-bold tracking-tight">{step.title}</h3>
                <p className="mt-2 max-w-2xl text-ink-soft">{step.body}</p>

                <AnimatePresence mode="popLayout">
                  {state === 'active' && i === 0 && (
                    <motion.div
                      key="connect-step"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="mt-4 flex flex-wrap items-center gap-3"
                    >
                      <WalletButton />
                      <span className="font-mono text-[11px] text-ink-mute">
                        Connection persists across page reloads.
                      </span>
                    </motion.div>
                  )}

                  {state === 'active' && i === 1 && (
                    <StrategyStep
                      strategies={strategies}
                      loading={strategiesQuery.isLoading}
                      selectedId={form.strategyId}
                      onSelect={(id) => setForm({ ...form, strategyId: id })}
                      onAdvance={advance}
                      onBack={back}
                    />
                  )}
                  {state === 'active' && i === 2 && (
                    <PolicyStep
                      form={form}
                      onChange={setForm}
                      onAdvance={advance}
                      onBack={back}
                    />
                  )}
                  {state === 'active' && i === 3 && (
                    <TreasuryStep
                      form={form}
                      onChange={setForm}
                      onAdvance={advance}
                      onBack={back}
                    />
                  )}
                  {state === 'active' && i === 4 && (
                    <MemWalStep
                      form={form}
                      onChange={setForm}
                      onAdvance={advance}
                      onBack={back}
                    />
                  )}
                  {state === 'active' && i === 5 && (
                    <MintStep
                      form={form}
                      strategy={selected}
                      account={account?.address}
                      onSubmit={performMint}
                      onBack={back}
                      pending={signing}
                      result={mintResult}
                    />
                  )}
                </AnimatePresence>
              </div>
            </motion.li>
          );
        })}
      </ol>

      <aside className="lg:sticky lg:top-32 lg:self-start">
        <div className="card-flat p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            <CodeTag>progress</CodeTag>
          </p>
          <p className="num-display mt-2 text-4xl">
            {Math.round(((activeStep + (mintResult ? 1 : 0)) / STEPS.length) * 100)}%
          </p>
          <div className="mt-4 h-2 w-full rounded-sm border-2 border-ink bg-paper">
            <motion.div
              className="h-full bg-ink"
              animate={{
                width: `${((activeStep + (mintResult ? 1 : 0)) / STEPS.length) * 100}%`,
              }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <p className="mt-4 font-serif italic text-sm text-ink-soft">
            Step {activeStep + 1} of {STEPS.length}
          </p>

          <hr className="divider-dashed my-5" />

          {account ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                <CodeTag>connected</CodeTag>
              </p>
              <p className="mt-2 font-mono text-xs">{shortenAddress(account.address)}</p>
            </div>
          ) : (
            <p className="text-sm text-ink-soft">
              Connect a wallet to enable the next step.
            </p>
          )}

          {selected && (
            <>
              <hr className="divider-dashed my-5" />
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                <CodeTag>hired</CodeTag>
              </p>
              <p className="mt-2 font-display text-sm font-semibold">{selected.name}</p>
              <p className="mt-1 font-mono text-[11px] text-ink-mute">
                {RISK_LABEL[selected.riskProfile]} ·{' '}
                {(selected.royaltyBps / 100).toFixed(1)}% royalty
              </p>
            </>
          )}

          {mintResult && (
            <>
              <hr className="divider-dashed my-5" />
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-state-active">
                <CodeTag>minted</CodeTag>
              </p>
              <a
                className="mt-2 block font-mono text-[11px] text-ink hover:underline"
                href={explorerTxUrl(mintResult.digest)}
                target="_blank"
                rel="noreferrer"
              >
                tx {shortenHash(mintResult.digest)} ↗
              </a>
              {mintResult.agentId && (
                <p className="mt-1 font-mono text-[11px] text-ink-soft">
                  agent {shortenHash(mintResult.agentId)}
                </p>
              )}
              <Link
                href="/dashboard"
                className="btn-flat mt-4 w-full justify-center"
                data-variant="primary"
              >
                Open dashboard →
              </Link>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ============================================================================
// Steps
// ============================================================================

function StrategyStep({
  strategies,
  loading,
  selectedId,
  onSelect,
  onAdvance,
  onBack,
}: {
  strategies: LiveStrategy[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdvance: () => void;
  onBack: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-4 grid gap-3 rounded-sm border border-divider bg-paper p-4"
    >
      <div className="flex items-center justify-between">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          {loading
            ? 'Loading marketplace…'
            : `${strategies.length} active strateg${strategies.length === 1 ? 'y' : 'ies'}`}
        </p>
        <Link
          href="/marketplace"
          className="font-mono text-[11px] text-accent-blue hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          browse full marketplace →
        </Link>
      </div>
      {!loading && strategies.length === 0 && (
        <p className="rounded-sm border-l-2 border-accent-orange bg-paper-strong p-3 font-mono text-[11px] text-ink-soft">
          No strategies published yet. Run{' '}
          <code>npx tsx scripts/seed-strategies.ts</code> to seed the defaults, or visit{' '}
          <Link href="/marketplace" className="text-accent-blue underline">
            /marketplace
          </Link>{' '}
          to publish one.
        </p>
      )}
      <div className="grid gap-2">
        {strategies.map((s) => (
          <StrategyOption
            key={s.id}
            strategy={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 pt-2">
        <button
          className="btn-flat"
          data-variant="primary"
          onClick={onAdvance}
          disabled={!selectedId}
        >
          Continue
        </button>
        <button className="btn-flat" data-variant="ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </motion.div>
  );
}

function StrategyOption({
  strategy,
  selected,
  onSelect,
}: {
  strategy: LiveStrategy;
  selected: boolean;
  onSelect: () => void;
}) {
  const netAlpha =
    strategy.cumulativeAlphaBpsPos - strategy.cumulativeAlphaBpsNeg;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-sm border-2 px-3 py-2.5 text-left transition ${
        selected
          ? 'border-ink bg-paper-strong shadow-[3px_3px_0_0_var(--ink)]'
          : 'border-divider bg-paper hover:border-ink'
      }`}
    >
      <span
        className="h-3 w-3 rounded-full border border-ink"
        style={{ backgroundColor: selected ? 'var(--ink)' : 'transparent' }}
      />
      <div>
        <p className="font-display text-sm font-semibold">{strategy.name}</p>
        <p className="mt-0.5 line-clamp-1 text-xs text-ink-soft">{strategy.description}</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          {RISK_LABEL[strategy.riskProfile]} · royalty {(strategy.royaltyBps / 100).toFixed(1)}% ·
          v{strategy.version.toString()} · {strategy.activeVaultCount.toString()}/
          {strategy.vaultCount.toString()} vaults
          {strategy.totalTicksRecorded > 0n && (
            <> · α {netAlpha >= 0n ? '+' : ''}{netAlpha.toString()}bps</>
          )}
        </p>
      </div>
      <span
        className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
        style={{
          backgroundColor:
            strategy.riskProfile === 0
              ? 'var(--accent-green)'
              : strategy.riskProfile === 1
                ? 'var(--accent-blue)'
                : 'var(--accent-orange)',
        }}
      >
        {RISK_LABEL[strategy.riskProfile]}
      </span>
    </button>
  );
}

function PolicyStep({
  form,
  onChange,
  onAdvance,
  onBack,
}: {
  form: MintForm;
  onChange: (f: MintForm) => void;
  onAdvance: () => void;
  onBack: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-4 grid gap-4 rounded-sm border border-divider bg-paper p-4"
    >
      <Slider
        label="Spend cap per epoch"
        value={form.spendPct}
        onChange={(v) => onChange({ ...form, spendPct: v })}
        min={1}
        max={50}
        step={0.5}
        suffix="%"
      />
      <Slider
        label="Expiry (epochs from now)"
        value={form.expiryDays}
        onChange={(v) => onChange({ ...form, expiryDays: v })}
        min={1}
        max={90}
        step={1}
        suffix=" epochs"
      />
      <div className="flex items-center gap-3 pt-2">
        <button className="btn-flat" data-variant="primary" onClick={onAdvance}>
          Continue
        </button>
        <button className="btn-flat" data-variant="ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </motion.div>
  );
}

function TreasuryStep({
  form,
  onChange,
  onAdvance,
  onBack,
}: {
  form: MintForm;
  onChange: (f: MintForm) => void;
  onAdvance: () => void;
  onBack: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-4 grid gap-4 rounded-sm border border-divider bg-paper p-4"
    >
      <Slider
        label="Funding (SUI from your wallet)"
        value={form.fundingSui}
        onChange={(v) => onChange({ ...form, fundingSui: v })}
        min={0.01}
        max={1}
        step={0.01}
        suffix=" SUI"
      />
      <p className="font-mono text-[11px] text-ink-mute">
        Demo seed amount. The full mint PTB will split this off your wallet's gas coin
        and deposit it into the AgentIdentity treasury.
      </p>
      <div className="flex items-center gap-3 pt-2">
        <button className="btn-flat" data-variant="primary" onClick={onAdvance}>
          Continue
        </button>
        <button className="btn-flat" data-variant="ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </motion.div>
  );
}

function MemWalStep({
  form,
  onChange,
  onAdvance,
  onBack,
}: {
  form: MintForm;
  onChange: (f: MintForm) => void;
  onAdvance: () => void;
  onBack: () => void;
}) {
  const canContinue =
    form.skipMemWal ||
    (form.memwalAccountId.trim().startsWith('0x') && form.memwalDelegateKeyHex.trim().length > 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-4 grid gap-4 rounded-sm border border-divider bg-paper p-4"
    >
      <label className="grid gap-1.5">
        <span className="font-display text-sm font-semibold">MemWal account ID</span>
        <input
          value={form.memwalAccountId}
          onChange={(e) => onChange({ ...form, memwalAccountId: e.target.value })}
          placeholder="0x…"
          disabled={form.skipMemWal}
          className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
      <label className="grid gap-1.5">
        <span className="font-display text-sm font-semibold">Delegate key (hex)</span>
        <input
          type="password"
          value={form.memwalDelegateKeyHex}
          onChange={(e) => onChange({ ...form, memwalDelegateKeyHex: e.target.value })}
          disabled={form.skipMemWal}
          className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
      <label className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
        <input
          type="checkbox"
          checked={form.skipMemWal}
          onChange={(e) => onChange({ ...form, skipMemWal: e.target.checked })}
          className="accent-ink"
        />
        Skip — no memory
      </label>
      <div className="flex items-center gap-3 pt-2">
        <button
          className="btn-flat"
          data-variant="primary"
          onClick={onAdvance}
          disabled={!canContinue}
        >
          Continue
        </button>
        <button className="btn-flat" data-variant="ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </motion.div>
  );
}

function MintStep({
  form,
  strategy,
  account,
  onSubmit,
  onBack,
  pending,
  result,
}: {
  form: MintForm;
  strategy: LiveStrategy | null;
  account?: string;
  onSubmit: () => void;
  onBack: () => void;
  pending: boolean;
  result: { digest: string; agentId?: string; sessionAddress: string } | null;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-4 grid gap-3 rounded-sm border border-divider bg-paper p-4"
    >
      <SummaryRow label="Owner" value={account ?? '— not connected —'} />
      <SummaryRow
        label="Strategy"
        value={strategy ? `${strategy.name} (v${strategy.version})` : '— not picked —'}
      />
      <SummaryRow
        label="Royalty"
        value={strategy ? `${(strategy.royaltyBps / 100).toFixed(1)}% of perf fee` : '—'}
      />
      <SummaryRow label="Spend cap" value={`${form.spendPct.toFixed(1)}% per epoch`} />
      <SummaryRow label="Expiry" value={`${form.expiryDays} epochs from now`} />
      <SummaryRow label="Funding" value={`${form.fundingSui.toFixed(3)} SUI`} />
      <SummaryRow
        label="MemWal"
        value={form.skipMemWal ? 'skipped' : form.memwalAccountId || '—'}
      />

      {result ? (
        <div className="rounded-sm border-l-2 border-state-active bg-paper-strong p-3 font-mono text-[11px]">
          <p className="text-state-active">● minted</p>
          {result.agentId && (
            <p className="mt-1 text-ink">AgentIdentity: {shortenHash(result.agentId)}</p>
          )}
          <p className="mt-1 text-ink-soft">tx: {shortenHash(result.digest)}</p>
          <a
            href={explorerTxUrl(result.digest)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-accent-blue underline"
          >
            view on suiscan →
          </a>
        </div>
      ) : (
        <p className="rounded-sm border-l-2 border-accent-orange bg-paper p-3 font-mono text-[11px] text-ink-soft">
          <span className="text-accent-orange">!</span> Submitting will prompt your wallet
          to sign a real PTB on Sui testnet.
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          className="btn-flat"
          data-variant="accent"
          onClick={onSubmit}
          disabled={pending || !account || !strategy || result !== null}
        >
          {pending ? (
            <span className="flex items-center gap-2">
              <Spinner /> Signing & submitting…
            </span>
          ) : result ? (
            'Vault minted ✓'
          ) : (
            'Mint vault on testnet'
          )}
        </button>
        <button className="btn-flat" data-variant="ghost" onClick={onBack} disabled={pending}>
          Back
        </button>
      </div>
    </motion.div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-divider pb-2 last:border-0">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <span className="num text-sm">{value}</span>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  suffix: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="flex items-baseline justify-between font-display text-sm font-semibold">
        {label}
        <span className="num font-semibold text-ink">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-ink"
      />
    </label>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Trigger a browser download of the freshly-generated session keypair so
 * the user has the secret persistently before the mint PTB ever fires.
 * The file is JSON so it round-trips into scripts/live-vaults.json cleanly.
 */
function downloadSessionKeyFile(payload: {
  address: string;
  secretBase64: string;
  strategyId: string;
  ownerAddress: string;
  mintedAtMs: number;
}): void {
  const body = JSON.stringify(
    {
      address: payload.address,
      secretBase64: payload.secretBase64,
      strategyId: payload.strategyId,
      ownerAddress: payload.ownerAddress,
      mintedAtMs: payload.mintedAtMs,
      note: 'Session secret for a Synapse Vault. Keep private. Use with scripts/run-live-tick.ts.',
    },
    null,
    2,
  );
  const blob = new Blob([body], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `synapse-session-${payload.address.slice(2, 10)}.key`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
