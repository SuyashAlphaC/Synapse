'use client';

import { useEffect, useState } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import {
  beginGoogleSignIn,
  clearActiveAccount,
  GOOGLE_CLIENT_ID,
  loadActiveAccount,
  type ActiveZkLoginAccount,
} from '@/lib/zklogin';
import { shortenAddress } from '@/lib/format';

/**
 * "Sign in with Google" — kicks off the real zkLogin OAuth flow. After
 * Google redirects back to `/zklogin/callback`, the callback page completes
 * the flow and stashes the active account in `localStorage`; this button
 * then displays it. Click again to sign out (clears local state only).
 */
export function ZkLoginSignInButton({
  className = '',
}: {
  className?: string;
}) {
  const suiClient = useSuiClient();
  const [account, setAccount] = useState<ActiveZkLoginAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setAccount(loadActiveAccount());
    refresh();
    window.addEventListener('synapse-zklogin-changed', refresh);
    return () => window.removeEventListener('synapse-zklogin-changed', refresh);
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    return (
      <span className="font-mono text-[11px] text-ink-mute">
        zkLogin not configured · set <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>
      </span>
    );
  }

  async function startSignIn() {
    setBusy(true);
    setError(null);
    try {
      const { epoch } = await suiClient.getLatestSuiSystemState();
      beginGoogleSignIn({ currentEpoch: BigInt(epoch) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (account) {
    return (
      <button
        type="button"
        className={`btn-flat ${className}`}
        data-variant="ghost"
        onClick={() => {
          clearActiveAccount();
        }}
        title="Sign out (clears local zkLogin state)"
      >
        <GoogleGlyph />
        <span>
          zkLogin · <span className="font-mono">{shortenAddress(account.address)}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`btn-flat ${className}`}
      data-variant="primary"
      onClick={startSignIn}
      disabled={busy}
    >
      <GoogleGlyph />
      <span>{busy ? 'Redirecting…' : 'Sign in with Google'}</span>
      {error && (
        <span className="ml-2 font-mono text-[10px] text-accent-orange">{error}</span>
      )}
    </button>
  );
}

function GoogleGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      aria-hidden
      className="-ml-0.5"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.93v2.34A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.71A5.41 5.41 0 0 1 3.7 9c0-.59.1-1.16.28-1.71V4.96H.93A9 9 0 0 0 0 9c0 1.45.35 2.83.93 4.04l3.05-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.34l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .93 4.96l3.05 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
