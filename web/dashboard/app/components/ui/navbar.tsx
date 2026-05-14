'use client';

import Link from 'next/link';
import { CodeTag } from './code-tag';
import { WalletButton } from './wallet-button';
import { formatDate } from '@/lib/format';

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/dashboard', label: 'Vaults' },
  { href: '/mint', label: 'Mint vault' },
  { href: '/inspector', label: 'Inspector' },
  { href: '#pricing', label: 'Pricing' },
];

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink/15 bg-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-6 px-6 py-4 lg:px-10">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute md:inline">
            Synapse Vault
          </span>
        </div>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="font-display text-sm font-medium text-ink-soft transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <div className="hidden h-9 items-center gap-2 rounded-md border border-ink/12 bg-paper-strong px-3 lg:flex">
            <span className="live-dot" />
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">
              testnet · live
            </span>
          </div>
          <div className="hidden h-9 items-center rounded-md border border-ink bg-ink px-3 text-paper lg:flex">
            <CodeTag>date</CodeTag>
            <span className="ml-2 font-mono text-[11px] tracking-wide">
              {formatDate(new Date())}
            </span>
            <CodeTag variant="close" className="ml-2">
              date
            </CodeTag>
          </div>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-2">
      <svg
        viewBox="0 0 36 36"
        className="h-9 w-9 transition-transform duration-300 group-hover:rotate-12"
        aria-hidden
      >
        <rect x="3" y="3" width="14" height="14" rx="2" fill="#FF6B35" stroke="#030F1C" strokeWidth="2" />
        <rect x="19" y="3" width="14" height="14" rx="2" fill="#5BD49C" stroke="#030F1C" strokeWidth="2" />
        <rect x="3" y="19" width="14" height="14" rx="2" fill="#9D7AEB" stroke="#030F1C" strokeWidth="2" />
        <rect x="19" y="19" width="14" height="14" rx="2" fill="#4A9BFF" stroke="#030F1C" strokeWidth="2" />
      </svg>
      <span className="hidden font-display text-xl font-extrabold tracking-tight text-ink md:inline">
        Synapse
        <span className="text-accent-orange">.</span>
      </span>
    </Link>
  );
}

