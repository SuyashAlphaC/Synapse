/**
 * Browser-side zkLogin flow for the dashboard.
 *
 * The flow is the canonical one documented at:
 *   https://docs.sui.io/guides/developer/cryptography/zklogin-integration
 *
 *   1. Click "Sign in with Google"
 *   2. Generate ephemeral Ed25519 keypair + randomness + nonce
 *   3. Stash them in `sessionStorage` keyed by the nonce
 *   4. Redirect to Google OAuth with `response_type=id_token` and our nonce
 *   5. Google redirects back to `/zklogin/callback#id_token=...`
 *   6. We parse the JWT, derive a user salt (stable per-account), derive the
 *      zkLogin address, request a ZK proof from Mysten's `prover-dev` service,
 *      and persist everything in `localStorage`
 *   7. From then on, the dashboard reads the active zkLogin account from
 *      `localStorage` and can sign Sui PTBs with it instead of (or alongside)
 *      a dapp-kit wallet.
 *
 * The salt is generated deterministically per-account on first login and
 * persisted in `localStorage`. Production deployments swap this for the
 * hosted Mysten Enoki salt server, but the on-chain semantics are identical.
 */

import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import {
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  jwtToAddress,
  type ZkLoginSignatureInputs,
} from '@mysten/sui/zklogin';

const PENDING_STORAGE_KEY = 'synapse:zklogin:pending:v1';
const ACTIVE_STORAGE_KEY = 'synapse:zklogin:account:v1';
const SALT_STORAGE_KEY_PREFIX = 'synapse:zklogin:salt:v1:';

export const ZKLOGIN_PROVER_URL =
  process.env['NEXT_PUBLIC_ZKLOGIN_PROVER_URL'] ?? 'https://prover-dev.mystenlabs.com/v1';

export const GOOGLE_CLIENT_ID = process.env['NEXT_PUBLIC_GOOGLE_CLIENT_ID'] ?? '';

export const ZKLOGIN_REDIRECT_PATH = '/zklogin/callback';

/** Configurable in case you serve the dashboard at a non-root path. */
function redirectUri(): string {
  if (typeof window === 'undefined') return '';
  const base = window.location.origin;
  return `${base}${ZKLOGIN_REDIRECT_PATH}`;
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface PendingZkLogin {
  ephemeralSecretBase64: string;
  ephemeralPublicKeyBase64: string;
  maxEpoch: string;
  randomness: string;
  nonce: string;
}

export interface ActiveZkLoginAccount {
  address: string;
  jwt: string;
  /** Mirrors `decoded.sub` so we can look up the salt deterministically. */
  jwtSub: string;
  /** Mirrors `decoded.aud` for proof generation. */
  jwtAud: string;
  /** Mirrors `decoded.iss` for proof generation. */
  jwtIss: string;
  userSalt: string;
  maxEpoch: string;
  ephemeralSecretBase64: string;
  ephemeralPublicKeyBase64: string;
  randomness: string;
  /** Result of the prover request; needed to assemble the signature. */
  zkProofInputs: ZkLoginSignatureInputs;
  /** When this account was minted (ms since epoch). */
  createdAtMs: number;
}

export function loadActiveAccount(): ActiveZkLoginAccount | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveZkLoginAccount;
  } catch {
    return null;
  }
}

export function clearActiveAccount(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACTIVE_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('synapse-zklogin-changed'));
}

function saveActiveAccount(account: ActiveZkLoginAccount): void {
  window.localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(account));
  window.dispatchEvent(new CustomEvent('synapse-zklogin-changed'));
}

function loadPending(): PendingZkLogin | null {
  const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingZkLogin;
  } catch {
    return null;
  }
}

function savePending(p: PendingZkLogin): void {
  window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(p));
}

function clearPending(): void {
  window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// Salt: deterministic per-(jwt.sub, jwt.aud) for the demo. Production should
// replace this with a hosted salt server (Enoki) for unlinkability.
// ---------------------------------------------------------------------------

export function getOrCreateUserSalt(jwtSub: string, jwtAud: string): string {
  const key = `${SALT_STORAGE_KEY_PREFIX}${jwtAud}:${jwtSub}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  // 16 random bytes → decimal string, fits in the BN254 field.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const out = salt.toString();
  window.localStorage.setItem(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Step 1+2+3: kick off OAuth
// ---------------------------------------------------------------------------

export interface BeginSignInArgs {
  /** Current Sui epoch — fetched via `client.getLatestSuiSystemState()`. */
  currentEpoch: bigint;
  /** Validity window for the ephemeral key (default 2 epochs ≈ 24 hours). */
  epochValidity?: bigint;
}

export function beginGoogleSignIn(args: BeginSignInArgs): void {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error(
      'NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set. Register an OAuth client at https://console.cloud.google.com/apis/credentials and add it to web/dashboard/.env.local',
    );
  }
  const maxEpoch = args.currentEpoch + (args.epochValidity ?? 2n);
  const ephemeralKeypair = new Ed25519Keypair();
  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeralKeypair.getPublicKey(), Number(maxEpoch), randomness);

  const ephemeralSecretBase64 = ephemeralKeypair.getSecretKey().replace(/^suiprivkey/, '');
  const ephemeralPublicKeyBase64 = ephemeralKeypair.getPublicKey().toBase64();

  savePending({
    ephemeralSecretBase64,
    ephemeralPublicKeyBase64,
    maxEpoch: maxEpoch.toString(),
    randomness,
    nonce,
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'id_token',
    scope: 'openid email',
    nonce,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Step 4+5+6: handle redirect callback
// ---------------------------------------------------------------------------

interface DecodedIdToken {
  sub: string;
  aud: string;
  iss: string;
  exp?: number;
  email?: string;
  nonce?: string;
}

function decodeJwtPayload(jwt: string): DecodedIdToken {
  const [, payload] = jwt.split('.');
  if (!payload) throw new Error('Malformed JWT');
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return JSON.parse(decoded) as DecodedIdToken;
}

/**
 * Called from `/zklogin/callback` after Google redirects back with a JWT in
 * the URL fragment. Completes the flow: derives address, fetches ZK proof,
 * saves the account to localStorage.
 */
export async function completeSignInFromCallback(): Promise<ActiveZkLoginAccount> {
  const fragment = window.location.hash.slice(1);
  if (!fragment) throw new Error('No JWT fragment on callback URL');
  const params = new URLSearchParams(fragment);
  const jwt = params.get('id_token');
  if (!jwt) throw new Error('id_token missing from callback fragment');

  const pending = loadPending();
  if (!pending) throw new Error('No pending zkLogin context — start sign-in again');

  const decoded = decodeJwtPayload(jwt);
  if (decoded.nonce !== pending.nonce) {
    throw new Error('JWT nonce mismatch — possible replay');
  }
  // The prover is the final authority, but validate the token locally first so
  // a token minted for a different app (aud confusion), a non-Google issuer, or
  // an expired token is rejected before we derive an address / request a proof.
  if (GOOGLE_CLIENT_ID && decoded.aud !== GOOGLE_CLIENT_ID) {
    throw new Error('JWT aud mismatch — token was not issued for this app');
  }
  if (decoded.iss !== 'https://accounts.google.com' && decoded.iss !== 'accounts.google.com') {
    throw new Error(`JWT iss unexpected: ${decoded.iss}`);
  }
  if (typeof decoded.exp === 'number' && decoded.exp * 1000 <= Date.now()) {
    throw new Error('JWT expired — sign in again');
  }

  const userSalt = getOrCreateUserSalt(decoded.sub, decoded.aud);
  const address = jwtToAddress(jwt, userSalt, false);

  const ephemeralPublicKey = new Ed25519PublicKey(pending.ephemeralPublicKeyBase64);
  const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(ephemeralPublicKey);

  const proofResponse = await fetch(ZKLOGIN_PROVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jwt,
      extendedEphemeralPublicKey,
      maxEpoch: pending.maxEpoch,
      jwtRandomness: pending.randomness,
      salt: userSalt,
      keyClaimName: 'sub',
    }),
  });
  if (!proofResponse.ok) {
    const text = await proofResponse.text();
    throw new Error(`Prover request failed (${proofResponse.status}): ${text.slice(0, 200)}`);
  }
  const proof = (await proofResponse.json()) as Omit<ZkLoginSignatureInputs, 'addressSeed'> & {
    addressSeed?: string;
  };

  const zkProofInputs: ZkLoginSignatureInputs = {
    ...proof,
    addressSeed: proof.addressSeed ?? deriveAddressSeed(userSalt, decoded.sub, decoded.aud),
  };

  const account: ActiveZkLoginAccount = {
    address,
    jwt,
    jwtSub: decoded.sub,
    jwtAud: decoded.aud,
    jwtIss: decoded.iss,
    userSalt,
    maxEpoch: pending.maxEpoch,
    ephemeralSecretBase64: pending.ephemeralSecretBase64,
    ephemeralPublicKeyBase64: pending.ephemeralPublicKeyBase64,
    randomness: pending.randomness,
    zkProofInputs,
    createdAtMs: Date.now(),
  };
  saveActiveAccount(account);
  clearPending();
  return account;
}

/**
 * Compute the address seed BigInt the same way `@mysten/sui/zklogin` does
 * internally — provided so the prover response (which may omit it on some
 * versions) doesn't break the signature assembler.
 */
function deriveAddressSeed(salt: string, sub: string, aud: string): string {
  return genAddressSeed(BigInt(salt), 'sub', sub, aud).toString();
}

// ---------------------------------------------------------------------------
// Signing helpers (for the mint wizard etc.)
// ---------------------------------------------------------------------------

export function ephemeralKeypair(account: ActiveZkLoginAccount): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(fromBase64(account.ephemeralSecretBase64));
}
