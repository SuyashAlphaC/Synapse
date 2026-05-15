'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { completeSignInFromCallback } from '@/lib/zklogin';
import { shortenAddress } from '@/lib/format';

type Phase = 'pending' | 'success' | 'error';

export default function ZkLoginCallbackPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('pending');
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    completeSignInFromCallback()
      .then((account) => {
        if (cancelled) return;
        setAddress(account.address);
        setPhase('success');
        setTimeout(() => router.push('/mint'), 1500);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="container-tight grid min-h-[70vh] place-items-center">
      <div className="card-flat w-full max-w-md p-8 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          zkLogin · Google
        </p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
          {phase === 'pending'
            ? 'Finalizing your identity…'
            : phase === 'success'
              ? 'Identity ready'
              : 'Sign-in failed'}
        </h1>

        {phase === 'pending' && (
          <p className="mt-4 text-sm text-ink-soft">
            Requesting a zero-knowledge proof from the Mysten prover. Your Google JWT never
            leaves your browser — Synapse only sees the derived Sui address.
          </p>
        )}

        {phase === 'success' && address && (
          <>
            <p className="mt-4 text-sm text-ink-soft">
              Your zkLogin address:
            </p>
            <p className="num-display mt-1 text-xl">{shortenAddress(address)}</p>
            <p className="mt-4 font-mono text-[11px] text-ink-mute">
              Redirecting to mint…
            </p>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="mt-4 text-sm text-ink-soft">{error}</p>
            <Link href="/mint" className="btn-flat mt-6 inline-flex" data-variant="primary">
              Back to mint
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
