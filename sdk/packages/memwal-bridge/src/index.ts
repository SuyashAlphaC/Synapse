/**
 * @synapse-core/memwal-bridge
 *
 * Thin Synapse-aware wrapper over `@mysten-incubation/memwal`. Reads the
 * MemWal `accountId` + `namespace` from an on-chain `AgentIdentity` so callers
 * don't have to plumb them around manually. The Ed25519 delegate secret
 * itself must come from the agent's secure storage (the on-chain object only
 * stores its identifier, never the secret).
 *
 * The MemWal SDK currently exposes:
 *   - MemWal.create({ key, accountId, serverUrl?, namespace? })
 *   - memwal.remember(text, namespace?)       → async job
 *   - memwal.waitForRememberJob(jobId)        → wait for completion
 *   - memwal.rememberAndWait(text, namespace?)→ all-in-one
 *   - memwal.recall(query, limit?, namespace?)→ semantic search
 *   - memwal.destroy()                        → wipe keys from memory
 *
 * This bridge exposes the same surface keyed by `AgentIdentity` instead of
 * by raw config so the call sites read naturally.
 */

import { MemWal } from '@mysten-incubation/memwal';
import type {
  RecallResult,
  RememberResult,
  RememberAcceptedResult,
  MemWalConfig,
} from '@mysten-incubation/memwal';
import type { AgentIdentity } from '@synapse-core/client';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The off-chain credentials needed to operate a MemWal client on behalf of an
 * agent. The agent runtime is responsible for persisting `delegateKeyHex`
 * securely (e.g., Seal-encrypted on Walrus, OS keychain, or HSM). It must
 * NEVER be sent over the wire to a third party.
 */
export interface AgentMemWalCredentials {
  /** Ed25519 delegate private key as hex string (64 chars, no `0x` prefix). */
  delegateKeyHex: string;
  /** Optional override of the MemWal relayer URL. */
  serverUrl?: string;
}

export interface CreateMemWalClientArgs {
  identity: AgentIdentity;
  credentials: AgentMemWalCredentials;
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

/**
 * Construct a MemWal client bound to a specific `AgentIdentity`. The returned
 * client has the agent's namespace as its default; pass an override per-call
 * only when crossing into a shared namespace.
 *
 * The caller owns the lifetime of the returned client — call `client.destroy()`
 * when the agent runtime shuts down to wipe the Ed25519 key from memory.
 */
export function createMemWalClient(args: CreateMemWalClientArgs): MemWal {
  return createMemWalClientFromParts({
    memwalAccountId: args.identity.memwalAccountId,
    memwalNamespace: args.identity.memwalNamespace,
    delegateKeyHex: args.credentials.delegateKeyHex,
    ...(args.credentials.serverUrl ? { serverUrl: args.credentials.serverUrl } : {}),
  });
}

/**
 * The raw MemWal identity parts — the account id + namespace byte fields of
 * an `AgentIdentity`, plus the delegate secret. Used by callers (e.g. the
 * dashboard's recall panel) that hold the on-chain identity in a different
 * shape than the full SDK `AgentIdentity` but still need a client.
 */
export interface MemWalClientParts {
  /** `AgentIdentity.memwalAccountId` bytes (ASCII-hex of the account id). */
  memwalAccountId: Uint8Array;
  /** `AgentIdentity.memwalNamespace` bytes (UTF-8 namespace string). */
  memwalNamespace: Uint8Array;
  /** Ed25519 delegate private key as hex (64 chars, no `0x`). */
  delegateKeyHex: string;
  /** Optional MemWal relayer URL (e.g. a same-origin proxy in the browser). */
  serverUrl?: string;
}

/**
 * Construct a MemWal client from the raw identity byte fields rather than a
 * full `AgentIdentity`. Same decoding as {@link createMemWalClient}.
 */
export function createMemWalClientFromParts(parts: MemWalClientParts): MemWal {
  const config: MemWalConfig = {
    key: parts.delegateKeyHex,
    accountId: bytesToAsciiHex(parts.memwalAccountId),
    namespace: decodeNamespace(parts.memwalNamespace),
    ...(parts.serverUrl ? { serverUrl: parts.serverUrl } : {}),
  };
  return MemWal.create(config);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface RememberArgs {
  client: MemWal;
  text: string;
  /** Optional namespace override; defaults to the client's bound namespace. */
  namespace?: string;
}

export interface RememberWaitArgs extends RememberArgs {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RecallArgs {
  client: MemWal;
  query: string;
  /** Top-K memories to return. Default: 5. */
  limit?: number;
  namespace?: string;
}

/**
 * Fire-and-forget remember — returns as soon as the relayer accepts the job.
 * The actual encryption + Walrus upload runs server-side in the background.
 */
export function rememberAsync(args: RememberArgs): Promise<RememberAcceptedResult> {
  return args.namespace !== undefined
    ? args.client.remember(args.text, args.namespace)
    : args.client.remember(args.text);
}

/**
 * Remember and block until the relayer reports the job is durable on Walrus.
 * Use this when the caller needs the resulting `blob_id` before continuing
 * (e.g., to record an `ArtifactRef` referencing the memory blob).
 */
export function rememberAndWait(args: RememberWaitArgs): Promise<RememberResult> {
  const opts: { pollIntervalMs?: number; timeoutMs?: number } = {};
  if (args.pollIntervalMs !== undefined) opts.pollIntervalMs = args.pollIntervalMs;
  if (args.timeoutMs !== undefined) opts.timeoutMs = args.timeoutMs;

  return args.namespace !== undefined
    ? args.client.rememberAndWait(args.text, args.namespace, opts)
    : args.client.rememberAndWait(args.text, undefined, opts);
}

/**
 * Semantic recall — the relayer embeds the query, runs vector search across
 * the agent's namespace, downloads + decrypts the top-K matches, and returns
 * them ordered by similarity.
 */
export function recall(args: RecallArgs): Promise<RecallResult> {
  const limit = args.limit ?? 5;
  return args.namespace !== undefined
    ? args.client.recall(args.query, limit, args.namespace)
    : args.client.recall(args.query, limit);
}

// ---------------------------------------------------------------------------
// Type re-exports for downstream consumers (vault, adapters)
// ---------------------------------------------------------------------------

export type { MemWal, RecallResult, RememberResult, RememberAcceptedResult } from '@mysten-incubation/memwal';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw byte vector into an ASCII hex string of the form `0x…`. The
 * `memwal_account_id` field in `AgentIdentity` stores the canonical Sui
 * object ID for a `MemWalAccount`, encoded as ASCII bytes of the hex string.
 */
function bytesToAsciiHex(bytes: Uint8Array): string {
  // First try interpreting the bytes as UTF-8 (since callers typically pass
  // the hex string itself, encoded as ASCII). Fall back to a raw hex render
  // when that yields a non-printable result.
  const decoded = utf8FromBytes(bytes);
  if (/^0x[0-9a-fA-F]+$/.test(decoded) || /^[0-9a-fA-F]+$/.test(decoded)) {
    return decoded.startsWith('0x') ? decoded : `0x${decoded}`;
  }
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function utf8FromBytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Strictly decode the namespace bytes. Unlike the accountId path (which has a
 * hex fallback), a malformed namespace must fail loudly: silently substituting
 * U+FFFD would point recall/remember at the wrong namespace and lose memory.
 */
function decodeNamespace(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('memwal namespace bytes are not valid UTF-8');
  }
}
