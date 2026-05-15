import { Navbar } from '../components/ui/navbar';
import { CodeTag } from '../components/ui/code-tag';
import { MarketplaceBrowser } from '../components/marketplace/marketplace-browser';

export const metadata = {
  title: 'Strategy marketplace · Synapse Vault',
};

export default function MarketplacePage() {
  return (
    <>
      <Navbar />
      <main className="blueprint-grid relative">
        <div className="absolute inset-0 bg-paper/30" aria-hidden />
        <section className="relative mx-auto max-w-[1440px] px-6 py-16 lg:px-10 lg:py-24">
          <header className="mb-12 flex flex-col gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
              <CodeTag>marketplace</CodeTag> · published strategies · on-chain reputation
            </span>
            <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight md:text-6xl">
              Hire an<br />
              <span className="font-serif italic">autonomous strategy</span>.
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-ink-soft md:text-lg">
              Every strategy on this page is a Move shared object. Royalty splits, version
              history, and lifetime reputation (vaults managed, cumulative alpha, revocations)
              are all queryable from any Sui fullnode. Pick one and mint a vault against it.
            </p>
          </header>
          <MarketplaceBrowser />
        </section>
      </main>
    </>
  );
}
