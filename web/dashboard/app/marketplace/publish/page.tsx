import { Navbar } from '../../components/ui/navbar';
import { CodeTag } from '../../components/ui/code-tag';
import { PublishStrategyForm } from '../../components/marketplace/publish-form';

export const metadata = {
  title: 'Publish a strategy · Synapse Vault',
};

export default function PublishStrategyPage() {
  return (
    <>
      <Navbar />
      <main className="blueprint-grid relative">
        <div className="absolute inset-0 bg-paper/30" aria-hidden />
        <section className="relative mx-auto max-w-[1200px] px-6 py-16 lg:px-10 lg:py-24">
          <header className="mb-12 flex flex-col gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-mute">
              <CodeTag>publish</CodeTag> · strategist onboarding
            </span>
            <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight md:text-6xl">
              Publish a<br />
              <span className="font-serif italic">strategy</span>.
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-ink-soft md:text-lg">
              Your strategy becomes a Move shared object. Every vault that hires it pays you
              a royalty on realized profit, programmatically. No platform cut beyond the
              protocol fee, no vendor lock-in.
            </p>
          </header>
          <PublishStrategyForm />
        </section>
      </main>
    </>
  );
}
