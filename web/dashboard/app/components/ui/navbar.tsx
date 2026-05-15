'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CodeTag } from './code-tag';
import { WalletButton } from './wallet-button';
import { ZkLoginSignInButton } from '../zklogin/sign-in-button';
import { formatDate } from '@/lib/format';

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/dashboard', label: 'Vaults' },
  { href: '/mint', label: 'Mint vault' },
  { href: '/inspector', label: 'Inspector' },
];

export function Navbar() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close drawer on route changes / size up to desktop
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 768) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-ink/15 bg-paper/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:gap-6 md:px-6 md:py-4 lg:px-10">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute md:inline">
            Synapse Vault
          </span>
        </div>

        <nav className="hidden items-center gap-7 md:flex">
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

        <div className="flex items-center gap-2 md:gap-3">
          <div className="hidden h-9 items-center gap-2 rounded-md border border-ink/12 bg-paper-strong px-3 lg:flex">
            <span className="live-dot" />
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">
              testnet · live
            </span>
          </div>
          <div className="hidden h-9 items-center rounded-md border border-ink bg-ink px-3 text-paper xl:flex">
            <CodeTag>date</CodeTag>
            <span className="ml-2 font-mono text-[11px] tracking-wide">
              {formatDate(new Date())}
            </span>
            <CodeTag variant="close" className="ml-2">
              date
            </CodeTag>
          </div>
          <ZkLoginSignInButton className="hidden md:inline-flex" />
          <WalletButton />
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border-2 border-ink bg-paper md:hidden"
            aria-label="Toggle menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <span className="sr-only">Menu</span>
            <BurgerIcon open={drawerOpen} />
          </button>
        </div>
      </div>

      {drawerOpen && (
        <div className="md:hidden">
          <div
            className="absolute inset-x-0 top-full grid gap-1 border-b-2 border-ink bg-paper-strong px-4 py-4 shadow-[0_8px_24px_rgba(3,15,28,0.08)]"
            role="navigation"
          >
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setDrawerOpen(false)}
                className="flex items-center justify-between rounded-md border border-divider bg-paper px-3 py-3 font-display text-sm font-semibold text-ink"
              >
                {link.label}
                <span className="font-mono text-[10px] text-ink-mute">→</span>
              </Link>
            ))}
            <div className="mt-2 grid gap-2">
              <ZkLoginSignInButton />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect
        x="2"
        y={open ? '8' : '3'}
        width="14"
        height="2"
        fill="currentColor"
        transform={open ? 'rotate(45 9 9)' : undefined}
      />
      <rect
        x="2"
        y="8"
        width="14"
        height="2"
        fill="currentColor"
        style={{ opacity: open ? 0 : 1 }}
      />
      <rect
        x="2"
        y={open ? '8' : '13'}
        width="14"
        height="2"
        fill="currentColor"
        transform={open ? 'rotate(-45 9 9)' : undefined}
      />
    </svg>
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
