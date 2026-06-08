import Link from 'next/link';
import { Navbar } from './components/ui/navbar';
import { CodeTag } from './components/ui/code-tag';
import { HeroSceneLoader } from './components/hero/hero-scene-loader';

export default function LandingPage() {
  return (
    <>
      <Navbar />
      <main className="flex flex-col">
        <HeroSection />
        <PartnersStrip />
        <ValueSection />
        <PricingSection />
        <CtaSection />
        <FooterStrip />
      </main>
    </>
  );
}

// ============================================================================
// Hero
// ============================================================================

function HeroSection() {
  return (
    <section className="relative overflow-hidden">
      <div className="blueprint-grid absolute inset-0 opacity-60" aria-hidden />
      <div className="relative mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-6 pb-24 pt-16 lg:grid-cols-[1.05fr_1fr] lg:gap-6 lg:px-10 lg:pb-32 lg:pt-24">
        <div className="z-10 flex flex-col gap-8 lg:max-w-[640px]">
          <div className="inline-flex items-center gap-2 self-start rounded-full border-2 border-ink bg-paper-strong px-3 py-1">
            <span className="live-dot" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
              Sui Overflow 2026 · Walrus Track
            </span>
          </div>

          <h1 className="headline text-6xl md:text-7xl lg:text-[6.5rem]">
            <span className="block">Autonomous</span>
            <span className="block">
              AI <span className="font-serif italic text-ink-soft">treasury</span>
            </span>
            <span className="block">
              management<span className="text-accent-orange">.</span>
            </span>
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-ink-soft md:text-xl">
            Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click.{' '}
            <span className="font-serif italic">Synapse Vault</span> is the first treasury manager
            where every decision is policy-bounded on-chain and every dollar is auditable to a
            single Sui transaction.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link href="/mint" className="btn-flat" data-variant="primary">
              Mint a vault
              <Arrow />
            </Link>
            <Link href="/dashboard" className="btn-flat" data-variant="accent">
              See it live
            </Link>
            <Link href="#pricing" className="btn-flat" data-variant="ghost">
              Pricing
            </Link>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-6 border-t border-ink/15 pt-6">
            <Stat label="Fee" value="1% AUM" sub="+ 0.5% perf" />
            <Stat label="Settlement" value="atomic" sub="single PTB" />
            <Stat label="Kill switch" value="1 tx" sub="cryptographic" />
          </dl>
        </div>

        <div className="relative h-[480px] lg:h-[680px]">
          <div className="absolute inset-0 rounded-md border-2 border-ink bg-paper-strong shadow-[6px_6px_0_0_var(--ink)]">
            <HeroSceneLoader />
          </div>

          {/* Floating annotations */}
          <FloatingAnnotation
            className="-left-4 top-6"
            tag="strategy"
            value="Conservative Rebalancer v1.0"
          />
          <FloatingAnnotation
            className="-right-4 top-32 hidden md:flex"
            tag="cap"
            value="5%/epoch · 0xDeepBook only"
          />
          <FloatingAnnotation
            className="-left-2 bottom-10 hidden md:flex"
            tag="revoke"
            value="instant · one PTB cascade"
            accent="var(--accent-orange)"
          />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">{label}</dt>
      <dd className="num-display mt-1 text-2xl">{value}</dd>
      {sub && (
        <dd className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">{sub}</dd>
      )}
    </div>
  );
}

function FloatingAnnotation({
  className,
  tag,
  value,
  accent,
}: {
  className?: string;
  tag: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className={`absolute z-10 inline-flex items-center gap-2 rounded-sm border-2 border-ink bg-paper-strong px-2.5 py-1.5 shadow-[3px_3px_0_0_var(--ink)] animate-drift ${className ?? ''}`}
    >
      <span
        className="h-2 w-2 rounded-sm"
        style={{ backgroundColor: accent ?? 'var(--accent-blue)' }}
      />
      <CodeTag>{tag}</CodeTag>
      <span className="font-mono text-[11px] text-ink">{value}</span>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 7H12M12 7L7.5 2.5M12 7L7.5 11.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

// ============================================================================
// Partners marquee
// ============================================================================

function PartnersStrip() {
  const tokens = ['Walrus', 'MemWal', 'DeepBook', 'Seal', 'Sui Stack Messaging', 'zkLogin'];
  const items = [...tokens, ...tokens, ...tokens];
  return (
    <section className="border-y-2 border-ink bg-ink py-3 text-paper">
      <div className="marquee">
        <ul className="flex animate-ticker items-center gap-12 whitespace-nowrap">
          {items.map((t, i) => (
            <li
              key={i}
              className="flex items-center gap-3 font-display text-sm font-semibold uppercase tracking-[0.2em]"
            >
              <span className="h-2 w-2 rounded-full bg-accent-orange" />
              built on {t}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ============================================================================
// Value / how-it-works
// ============================================================================

function ValueSection() {
  return (
    <section className="relative px-6 py-24 lg:px-10 lg:py-32">
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-16 lg:grid-cols-[1fr_1.5fr]">
        <div className="lg:sticky lg:top-32 lg:self-start">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
            <CodeTag>04</CodeTag> · how it works
          </span>
          <h2 className="mt-4 font-display text-5xl font-extrabold leading-[0.95] tracking-tight md:text-6xl">
            Four primitives.
            <br />
            One <span className="font-serif italic text-ink-soft">audit trail</span>.
          </h2>
          <p className="mt-6 max-w-md text-ink-soft">
            Every Vault is a single Sui object that composes Walrus storage, MemWal memory, Seal
            encryption, and DeepBookV3 liquidity. The Move VM enforces every policy gate.
          </p>
        </div>

        <ol className="space-y-6">
          {VALUE_STEPS.map((step, i) => (
            <Step key={step.title} index={i + 1} step={step} />
          ))}
        </ol>
      </div>
    </section>
  );
}

interface ValueStep {
  title: string;
  body: string;
  accent: string;
  tag: string;
}

const VALUE_STEPS: ValueStep[] = [
  {
    title: 'Mint with zkLogin',
    body: 'Sign in with Google. Spawn a Vault in two clicks with spend cap, contract allowlist, and expiry baked into Move at mint time.',
    accent: 'var(--accent-blue)',
    tag: 'identity',
  },
  {
    title: 'Recall via MemWal',
    body: 'The strategy reads its long-term memory off Walrus before every decision. Past rebalance rationale persists across sessions and surviv-ors crashes.',
    accent: 'var(--accent-green)',
    tag: 'memory',
  },
  {
    title: 'Execute on DeepBookV3',
    body: 'One PTB chains policy gate → wallet::spend → DeepBookV3 swap → record audit. Atomic. No off-policy action can land — the Move VM rejects it.',
    accent: 'var(--accent-orange)',
    tag: 'execute',
  },
  {
    title: 'Audit & revoke',
    body: 'Every action is a signed event. Compliance officers query by agent + epoch. One revocation PTB cascades wallet, MemWal delegate, and Walrus blobs.',
    accent: 'var(--accent-purple)',
    tag: 'audit',
  },
];

function Step({ index, step }: { index: number; step: ValueStep }) {
  return (
    <li className="card-flat group flex items-start gap-6 p-6 transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--ink)]">
      <div
        className="flex h-14 w-14 flex-none items-center justify-center rounded-sm border-2 border-ink font-display text-2xl font-extrabold"
        style={{ backgroundColor: step.accent }}
      >
        {String(index).padStart(2, '0')}
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2">
          <CodeTag>{step.tag}</CodeTag>
        </div>
        <h3 className="font-display text-2xl font-bold tracking-tight">{step.title}</h3>
        <p className="mt-2 max-w-2xl leading-relaxed text-ink-soft">{step.body}</p>
      </div>
    </li>
  );
}

// ============================================================================
// Pricing calculator (interactive component imported)
// ============================================================================

import { PricingCalculator } from './components/dashboard/pricing-calculator';

function PricingSection() {
  return (
    <section id="pricing" className="border-t-2 border-ink bg-paper-soft px-6 py-24 lg:px-10 lg:py-32">
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-12 flex flex-col items-start gap-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
            <CodeTag>05</CodeTag> · pricing
          </span>
          <h2 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight md:text-7xl">
            Pay <span className="font-serif italic">in basis points</span>,
            <br />
            not flat fees.
          </h2>
          <p className="max-w-2xl text-lg text-ink-soft">
            Industry-standard treasury management economics: 1% annual management fee plus 0.5% of
            realised alpha vs. benchmark. Streamed continuously to the protocol fee account on-chain.
          </p>
        </div>
        <PricingCalculator />
      </div>
    </section>
  );
}

// ============================================================================
// CTA
// ============================================================================

function CtaSection() {
  return (
    <section className="relative overflow-hidden bg-ink py-24 text-paper lg:py-32">
      <div className="dot-grid absolute inset-0 opacity-30" aria-hidden />
      <div className="relative mx-auto max-w-[1100px] px-6 text-center lg:px-10">
        <h2 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight md:text-7xl">
          <span className="text-accent-orange">/&gt;</span> Hire your first AI
          <br />
          treasury manager.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg text-paper/80">
          Sign in with Google, set a spend cap, watch it rebalance — and revoke it whenever you
          want.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/mint" className="btn-flat" data-variant="accent">
            Mint a vault
            <Arrow />
          </Link>
          <Link href="/dashboard" className="btn-flat">
            Tour the dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}

function FooterStrip() {
  return (
    <footer className="border-t border-ink/20 bg-paper px-6 py-8 lg:px-10">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 text-xs text-ink-mute">
        <span className="font-mono uppercase tracking-[0.18em]">
          © {new Date().getFullYear()} Synapse Labs · Built for Sui Overflow 2026
        </span>
        <span className="flex items-center gap-4 font-mono">
          <a href="https://github.com/SuyashAlphaC/Synapse" className="hover:text-ink">
            Docs
          </a>
          <a href="https://github.com/MystenLabs/MemWal" className="hover:text-ink">
            MemWal
          </a>
          <a href="https://docs.wal.app/" className="hover:text-ink">
            Walrus
          </a>
        </span>
      </div>
    </footer>
  );
}
