/**
 * Walrus strategy loader.
 *
 * Fetches a strategist's compiled bundle from Walrus, verifies its
 * sha256 matches the on-chain `code_hash` commitment, and dynamically
 * imports it as an ESM module. The default export is validated to
 * match the `Strategy` shape before being returned.
 *
 * Trust model — IMPORTANT, READ CAREFULLY:
 *
 * Loaded strategies run with the runtime's full Node privileges. There
 * is no sandbox in this version. Enabling Walrus loading
 * (`SYNAPSE_ALLOW_WALRUS_STRATEGIES=true`) is operator opt-in: it
 * means "I trust strategies published to the on-chain marketplace
 * enough to execute them on my infrastructure." The hash-verification
 * guarantee is "this is exactly the code the strategist committed to
 * publish" — *not* "this code can't read env vars or open sockets".
 *
 * Hardening path (not implemented here): run the loaded module inside
 * `node:vm`'s `SourceTextModule` with an empty global, deny `fetch`,
 * `process`, `require`, filesystem, network. Tracked as a follow-up.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Strategy } from '../types.js';

// Use the universal `globalThis.crypto.subtle` for sha256 so this
// module works in both Node 20+ and browsers / Web Workers — no
// `node:crypto` import means the bundle can ship into the
// dashboard's in-browser runtime without polyfills.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const WALRUS_TESTNET_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_MAINNET_AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space';

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export type WalrusNetwork = 'testnet' | 'mainnet';

export interface LoadedWalrusStrategy {
  strategy: Strategy;
  /** Lowercase hex, no `0x` prefix. */
  codeHashHex: string;
  sourceWalrusBlob: string;
  byteSize: number;
}

/**
 * Optional operator-supplied allowlist applied AFTER the on-chain
 * consent flag but BEFORE the dynamic import. Use this to lock the
 * runtime down to a known set of audited bundles even when the vault
 * has consented to Walrus loading.
 *
 * Trust model: per-vault on-chain consent + operator allowlist =
 * defense in depth. The vault owner says "I'm OK with marketplace
 * strategies"; the operator says "and only these specific
 * code_hashes/publishers". A code_hash entry binds bit-for-bit to a
 * compiled bundle — bumping a strategy's version requires explicit
 * allowlist update.
 */
export interface WalrusStrategyAllowlist {
  /** Lowercase 64-char hex `code_hash` values. Empty / undefined = "any". */
  hashes?: ReadonlySet<string>;
  /** 0x-prefixed Sui addresses. Empty / undefined = "any". Currently advisory; the on-chain Strategy publisher field is not yet parsed. */
  publishers?: ReadonlySet<string>;
}

interface CachedEntry extends LoadedWalrusStrategy {}

/**
 * In-process cache keyed by `code_hash` — the on-chain commitment to
 * the bundle bytes. Two on-chain Strategy objects pointing at the same
 * bytes share a cache entry (forks are free).
 */
const cache = new Map<string, CachedEntry>();

/**
 * Resolve a marketplace `Strategy` object on Sui into a runnable
 * `Strategy` by fetching its Walrus bundle and dynamically importing.
 *
 * Returns `null` when the on-chain object has no `source_walrus_blob`
 * (legacy / seeded strategies that don't carry a bundle pointer).
 * Throws when the bundle is present but invalid (hash mismatch,
 * import failure, bad shape) — callers decide whether to fall back to
 * a runtime-configured default or abort.
 */
export async function loadStrategyFromWalrus(args: {
  client: SuiJsonRpcClient;
  packageId: string;
  strategyId: string;
  network: WalrusNetwork;
  signal?: AbortSignal;
  /** Operator-supplied allowlist; when set, gates execution. */
  allowlist?: WalrusStrategyAllowlist;
}): Promise<LoadedWalrusStrategy | null> {
  const meta = await fetchStrategyMeta(args.client, args.strategyId);
  if (meta === null) return null;
  if (meta.sourceWalrusBlob.length === 0) return null;

  // Operator allowlist gate #1 — refuse before any network fetch when
  // the on-chain code_hash isn't in the allowlist. Saves the bandwidth
  // and provides the earliest possible failure signal.
  assertHashAllowed(meta.codeHashHex, args.allowlist, args.strategyId);

  const cached = cache.get(meta.codeHashHex);
  if (cached && cached.sourceWalrusBlob === meta.sourceWalrusBlob) {
    return { ...cached };
  }

  const bytes = await fetchWalrusBundle({
    blobId: meta.sourceWalrusBlob,
    network: args.network,
    ...(args.signal ? { signal: args.signal } : {}),
  });

  // Cryptographic gate: the bundle MUST match the on-chain commitment.
  // Anyone could host arbitrary bytes at a blob ID they don't own;
  // only the sha256 binds the running code to what the strategist
  // signed for at publish time.
  const actualHashHex = await sha256Hex(bytes);
  if (actualHashHex !== meta.codeHashHex) {
    throw new WalrusStrategyError(
      `Strategy ${args.strategyId}: Walrus bundle sha256 ${actualHashHex} ` +
        `does not match on-chain code_hash ${meta.codeHashHex}. Refusing to execute.`,
    );
  }

  // Operator allowlist gate #2 — re-check after the hash verification.
  // Belt-and-braces against a future code path that resolves the hash
  // from the bundle itself rather than the on-chain object.
  assertHashAllowed(actualHashHex, args.allowlist, args.strategyId);

  const strategy = await importStrategyBundle({
    bundleBytes: bytes,
    strategyId: args.strategyId,
    sourceWalrusBlob: meta.sourceWalrusBlob,
    codeHashHex: meta.codeHashHex,
  });

  const entry: CachedEntry = {
    strategy,
    codeHashHex: meta.codeHashHex,
    sourceWalrusBlob: meta.sourceWalrusBlob,
    byteSize: bytes.length,
  };
  cache.set(meta.codeHashHex, entry);
  return { ...entry };
}

/** Drop the cache. Tests + operators rotating bundles call this. */
export function clearWalrusStrategyCache(): void {
  cache.clear();
}

export class WalrusStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalrusStrategyError';
  }
}

// ---------------------------------------------------------------------------
// Internal: on-chain Strategy metadata
// ---------------------------------------------------------------------------

export interface StrategyMeta {
  sourceWalrusBlob: string;
  /** Lowercase hex, no `0x` prefix. */
  codeHashHex: string;
}

export async function fetchStrategyMeta(
  client: SuiJsonRpcClient,
  strategyId: string,
): Promise<StrategyMeta | null> {
  const obj = await client.getObject({
    id: strategyId,
    options: { showContent: true },
  });
  const content = obj.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  const fields = (content as { fields: Record<string, unknown> }).fields;
  const blobIdBytes = parseByteVec(fields['source_walrus_blob'], 'source_walrus_blob');
  const codeHashBytes = parseByteVec(fields['code_hash'], 'code_hash');
  if (codeHashBytes.length !== 32) {
    throw new WalrusStrategyError(
      `Strategy ${strategyId}: code_hash is ${codeHashBytes.length} bytes, expected 32`,
    );
  }
  const sourceWalrusBlob = new TextDecoder('utf-8', { fatal: false }).decode(blobIdBytes);
  return {
    sourceWalrusBlob,
    codeHashHex: bytesToHex(codeHashBytes),
  };
}

// ---------------------------------------------------------------------------
// Internal: Walrus fetch
// ---------------------------------------------------------------------------

async function fetchWalrusBundle(args: {
  blobId: string;
  network: WalrusNetwork;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const aggregator =
    args.network === 'mainnet' ? WALRUS_MAINNET_AGGREGATOR : WALRUS_TESTNET_AGGREGATOR;
  const url = `${aggregator}/v1/blobs/${args.blobId}`;
  const init: RequestInit = args.signal ? { signal: args.signal } : {};
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new WalrusStrategyError(
      `Walrus aggregator returned ${response.status} ${response.statusText} for blob ${args.blobId}`,
    );
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    throw new WalrusStrategyError(`Walrus blob ${args.blobId} is empty`);
  }
  if (bytes.length > MAX_BUNDLE_BYTES) {
    throw new WalrusStrategyError(
      `Walrus blob ${args.blobId} is ${bytes.length}B, exceeds ${MAX_BUNDLE_BYTES}B limit`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Internal: dynamic import + shape validation
// ---------------------------------------------------------------------------

async function importStrategyBundle(args: {
  bundleBytes: Uint8Array;
  strategyId: string;
  sourceWalrusBlob: string;
  codeHashHex: string;
}): Promise<Strategy> {
  // The bundle is self-contained ESM (esbuild emitted it with all
  // imports external). We load it via dynamic import — but the URL
  // scheme differs by platform:
  //
  //   Node:    `data:text/javascript;base64,…` works natively.
  //   Browser: data: imports are frequently blocked by CSP, and
  //            `Buffer` doesn't exist. Use a `blob:` URL instead —
  //            browsers allow `import()` of blob URLs for ESM.
  //
  // The `webpackIgnore` / `@vite-ignore` magic comments stop the
  // bundler from trying to statically resolve the runtime URL.
  const isBrowser =
    typeof window !== 'undefined' ||
    typeof (globalThis as { document?: unknown }).document !== 'undefined';

  let url: string;
  let revoke: (() => void) | null = null;
  if (isBrowser) {
    const blob = new Blob([args.bundleBytes as BlobPart], { type: 'text/javascript' });
    url = URL.createObjectURL(blob);
    revoke = () => URL.revokeObjectURL(url);
  } else {
    const base64 = Buffer.from(args.bundleBytes).toString('base64');
    url = `data:text/javascript;base64,${base64}`;
  }

  let module: { default?: unknown };
  try {
    module = (await import(/* webpackIgnore: true */ /* @vite-ignore */ url)) as {
      default?: unknown;
    };
  } catch (err) {
    throw new WalrusStrategyError(
      `Walrus bundle ${args.sourceWalrusBlob} (sha256 ${args.codeHashHex}) ` +
        `failed to import: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // `await import(url)` resolves only after the module is fully
    // evaluated, so it's safe to revoke the blob URL here.
    revoke?.();
  }
  return validateStrategyExport(module.default, args.strategyId);
}

function validateStrategyExport(value: unknown, strategyId: string): Strategy {
  // Factory pattern — the bundle's default export is a zero-arg
  // function that returns a Strategy. Common when the strategist
  // wants config to be baked in at instantiation.
  if (typeof value === 'function') {
    let built: unknown;
    try {
      built = (value as () => unknown)();
    } catch (err) {
      throw new WalrusStrategyError(
        `Strategy ${strategyId}: factory function threw on instantiation: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    return validateStrategyExport(built, strategyId);
  }
  if (typeof value !== 'object' || value === null) {
    throw new WalrusStrategyError(
      `Strategy ${strategyId}: bundle default export is ${typeof value}, ` +
        `expected Strategy object or factory function`,
    );
  }
  const obj = value as Record<string, unknown>;
  requireString(obj, 'id', strategyId);
  requireString(obj, 'name', strategyId);
  requireString(obj, 'version', strategyId);
  requireString(obj, 'description', strategyId);
  if (typeof obj['evaluate'] !== 'function') {
    throw new WalrusStrategyError(
      `Strategy ${strategyId}: missing async \`evaluate\` function`,
    );
  }
  if (obj['prepareMemoryWrite'] !== undefined && typeof obj['prepareMemoryWrite'] !== 'function') {
    throw new WalrusStrategyError(
      `Strategy ${strategyId}: optional \`prepareMemoryWrite\` must be a function when present`,
    );
  }
  return obj as unknown as Strategy;
}

function requireString(obj: Record<string, unknown>, field: string, strategyId: string): void {
  if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
    throw new WalrusStrategyError(
      `Strategy ${strategyId}: missing or non-string field \`${field}\``,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal: byte vec parsers (Sui returns these as `number[]` from JSON-RPC)
// ---------------------------------------------------------------------------

function parseByteVec(value: unknown, label: string): Uint8Array {
  if (typeof value === 'string') {
    // Some encodings deliver vector<u8> as a base64/utf8 string.
    return new TextEncoder().encode(value);
  }
  if (!Array.isArray(value)) {
    throw new WalrusStrategyError(`${label}: expected vector<u8>, got ${typeof value}`);
  }
  return Uint8Array.from(
    value.map((v, i) => {
      if (typeof v !== 'number' || v < 0 || v > 255) {
        throw new WalrusStrategyError(`${label}[${i}] is not a byte`);
      }
      return v;
    }),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Throws a `WalrusStrategyError` if the allowlist is configured and
 * `hash` is not in it. No-op when the allowlist is undefined / empty
 * (back-compat: existing operators get the legacy "any consented
 * strategy" behavior).
 */
function assertHashAllowed(
  hash: string,
  allowlist: WalrusStrategyAllowlist | undefined,
  strategyId: string,
): void {
  if (!allowlist?.hashes || allowlist.hashes.size === 0) return;
  if (allowlist.hashes.has(hash.toLowerCase())) return;
  throw new WalrusStrategyError(
    `Strategy ${strategyId}: code_hash ${hash} is not in the operator allowlist. Refusing to execute.`,
  );
}

/**
 * Parse `SYNAPSE_ALLOWED_STRATEGY_HASHES` (comma-separated lowercase
 * 64-char hex) and `SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS` (comma-separated
 * 0x-prefixed Sui addresses) into a `WalrusStrategyAllowlist`. Returns
 * `undefined` when neither env var is configured — meaning no allowlist
 * gate (legacy behavior). Throws on malformed entries so a typo in
 * config fails loudly at boot rather than silently allowing everything.
 */
export function parseWalrusAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WalrusStrategyAllowlist | undefined {
  const hashes = parseHashList(env.SYNAPSE_ALLOWED_STRATEGY_HASHES);
  const publishers = parsePublisherList(env.SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS);
  if (!hashes && !publishers) return undefined;
  const out: WalrusStrategyAllowlist = {};
  if (hashes) out.hashes = hashes;
  if (publishers) out.publishers = publishers;
  return out;
}

function parseHashList(raw: string | undefined): ReadonlySet<string> | undefined {
  if (!raw) return undefined;
  const out = new Set<string>();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const cleaned = entry.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleaned)) {
      throw new Error(
        `SYNAPSE_ALLOWED_STRATEGY_HASHES: "${entry}" is not a 64-char hex sha256`,
      );
    }
    out.add(cleaned);
  }
  return out.size > 0 ? out : undefined;
}

function parsePublisherList(raw: string | undefined): ReadonlySet<string> | undefined {
  if (!raw) return undefined;
  const out = new Set<string>();
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(entry)) {
      throw new Error(
        `SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS: "${entry}" is not a 0x-prefixed Sui address`,
      );
    }
    out.add(entry.toLowerCase());
  }
  return out.size > 0 ? out : undefined;
}
