'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WalletButton } from './wallet-button';
import { ZkLoginSignInButton } from '../zklogin/sign-in-button';

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/strategist', label: 'Strategist' },
  { href: '/dashboard', label: 'Vaults' },
  { href: '/mint', label: 'Mint' },
  { href: '/inspector', label: 'Inspector' },
];

export function Navbar() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 1024) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-ink/12 bg-paper/90 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 md:gap-6 md:px-8 lg:gap-8">
        <Logo />

        <nav className="hidden flex-1 items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="whitespace-nowrap font-display text-[14px] font-medium text-ink-soft transition-colors hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:gap-3">
          <NetworkPill />
          <span className="hidden h-6 w-px bg-divider md:inline-block" />
          <ZkLoginSignInButton className="hidden md:inline-flex" />
          <WalletButton />
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border-2 border-ink bg-paper lg:hidden"
            aria-label="Toggle menu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <BurgerIcon open={drawerOpen} />
          </button>
        </div>
      </div>

      {drawerOpen && (
        <div className="lg:hidden">
          <div
            className="border-b-2 border-ink bg-paper-strong px-4 py-4 shadow-[0_8px_24px_rgba(3,15,28,0.08)]"
            role="navigation"
          >
            <ul className="grid gap-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={() => setDrawerOpen(false)}
                    className="flex items-center justify-between rounded-md border border-divider bg-paper px-3 py-3 font-display text-sm font-semibold text-ink"
                  >
                    {link.label}
                    <span className="font-mono text-[10px] text-ink-mute">→</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-3 grid gap-2">
              <ZkLoginSignInButton />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function NetworkPill() {
  return (
    <span className="hidden h-9 items-center gap-2 whitespace-nowrap rounded-full border border-ink/15 bg-paper-strong px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-soft md:inline-flex">
      <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-state-active">
        <span className="absolute inset-0 animate-pulse-ring rounded-full bg-state-active" />
      </span>
      Testnet
    </span>
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
    <Link href="/" className="group flex shrink-0 items-center gap-2.5" aria-label="Synapse Vault">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="Synapse Vault"
        width={36}
        height={36}
        className="h-9 w-9 transition-transform duration-300 group-hover:rotate-12"
      />
      <span className="hidden whitespace-nowrap font-display text-lg font-extrabold tracking-tight text-ink sm:inline">
        Synapse<span className="text-accent-orange">.</span>
      </span>
    </Link>
  );
}
