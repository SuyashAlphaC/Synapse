/**
 * Marketplace strategy classification, parallel to the runtime's allowlist
 * gate (`SYNAPSE_ALLOWED_STRATEGY_HASHES` / `SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS`
 * in `sdk/packages/vault/src/runtime/walrus-loader.ts`).
 *
 * The runtime is the only real enforcement point — it refuses to load a
 * Walrus strategy whose `code_hash` (or strategist) is missing from the
 * configured operator allowlist. This module surfaces the same answer in
 * the dashboard so vault owners can tell, before they hire a strategy,
 * whether the operator running their headless runtime is going to accept
 * it. Pure UI signal; the on-chain consent + the runtime gate remain the
 * authoritative checks.
 *
 * Configure via `.env.local` in the dashboard:
 *   NEXT_PUBLIC_SYNAPSE_ALLOWED_STRATEGY_HASHES=hex1,hex2,...
 *   NEXT_PUBLIC_SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS=0x...,0x...
 */

import type { LiveStrategy } from './strategies';

/** Result of classifying a single strategy against the allowlist policy. */
export type StrategyAuditStatus =
  /** Allowlist is configured AND this strategy's code-hash or publisher is on it. */
  | 'audited'
  /** Allowlist is configured AND this strategy is NOT on it. */
  | 'unverified'
  /** No allowlist configured by the operator — fallback to on-chain consent only. */
  | 'unspecified';

export interface StrategyAllowlist {
  /** Lowercase hex code-hashes (no `0x` prefix) the operator trusts. */
  readonly hashes: ReadonlySet<string>;
  /** Lowercase 0x-prefixed Sui addresses the operator trusts. */
  readonly publishers: ReadonlySet<string>;
}

/**
 * Parses comma-separated env vars into a typed allowlist. Empty strings,
 * whitespace, and non-hex/0x entries are silently dropped — same forgiving
 * semantics as `parseWalrusAllowlistFromEnv()` in the runtime, so the
 * dashboard never disagrees with the runtime over the same value.
 */
export function parseAllowlistFromEnv(env: {
  hashes?: string;
  publishers?: string;
}): StrategyAllowlist {
  const hashes = new Set<string>();
  for (const raw of (env.hashes ?? '').split(',')) {
    const v = raw.trim().toLowerCase().replace(/^0x/, '');
    // sha256 → exactly 64 lowercase hex chars
    if (/^[0-9a-f]{64}$/.test(v)) hashes.add(v);
  }
  const publishers = new Set<string>();
  for (const raw of (env.publishers ?? '').split(',')) {
    const v = raw.trim().toLowerCase();
    if (/^0x[0-9a-f]{1,64}$/.test(v)) publishers.add(v);
  }
  return { hashes, publishers };
}

/** Allowlist read once at module load from `NEXT_PUBLIC_*` envs. */
export const STRATEGY_ALLOWLIST: StrategyAllowlist = parseAllowlistFromEnv({
  hashes: process.env['NEXT_PUBLIC_SYNAPSE_ALLOWED_STRATEGY_HASHES'],
  publishers: process.env['NEXT_PUBLIC_SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS'],
});

/** True iff at least one hash or publisher is configured. */
export function isAllowlistConfigured(
  allowlist: StrategyAllowlist = STRATEGY_ALLOWLIST,
): boolean {
  return allowlist.hashes.size > 0 || allowlist.publishers.size > 0;
}

/**
 * Classifies a single strategy. Mirrors the runtime's `assertHashAllowed`
 * logic from walrus-loader.ts: hash match wins, publisher match is a
 * fallback for strategies that don't ship a Walrus bundle.
 */
export function classifyStrategy(
  strategy: Pick<LiveStrategy, 'codeHashHex' | 'strategist'>,
  allowlist: StrategyAllowlist = STRATEGY_ALLOWLIST,
): StrategyAuditStatus {
  if (!isAllowlistConfigured(allowlist)) return 'unspecified';
  const hash = strategy.codeHashHex.toLowerCase().replace(/^0x/, '');
  if (allowlist.hashes.has(hash)) return 'audited';
  const pub = strategy.strategist.toLowerCase();
  if (allowlist.publishers.has(pub)) return 'audited';
  return 'unverified';
}
