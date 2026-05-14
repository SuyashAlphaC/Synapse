import { Navbar } from '../components/ui/navbar';
import { InspectorShell } from '../components/inspector/inspector-shell';

export const metadata = {
  title: 'Memory Inspector · Synapse Vault',
};

export default function InspectorPage() {
  return (
    <>
      <Navbar />
      <main className="blueprint-grid relative">
        <div className="absolute inset-0 bg-paper/30" aria-hidden />
        <section className="relative mx-auto max-w-[1280px] px-6 py-16 lg:px-10 lg:py-20">
          <InspectorShell />
        </section>
      </main>
    </>
  );
}
