'use client';

/**
 * Audit-status pill rendered next to a marketplace strategy. Sources truth
 * from the dashboard's mirror of the runtime allowlist (`STRATEGY_ALLOWLIST`
 * in `lib/strategy-allowlist.ts`) so a vault owner sees the same answer
 * the operator's runtime will reach when it boots.
 *
 * Visual states:
 *   audited     — operator explicitly trusts this code-hash or publisher
 *   unverified  — operator has an allowlist configured and this is NOT in it
 *   unspecified — no allowlist configured; runtime falls back to on-chain consent
 *
 * The "unspecified" case renders nothing — no allowlist means there is
 * nothing meaningful to assert about a given strategy, and surfacing
 * "untracked" everywhere would just become visual noise.
 */

import type { LiveStrategy } from '@/lib/strategies';
import { classifyStrategy, type StrategyAuditStatus } from '@/lib/strategy-allowlist';

const COPY: Record<StrategyAuditStatus, { label: string; tooltip: string } | null> = {
  audited: {
    label: '✓ audited',
    tooltip:
      "code_hash (or strategist) is on the operator's runtime allowlist — the headless runtime will execute this strategy.",
  },
  unverified: {
    label: '! unverified',
    tooltip:
      "operator allowlist is configured but this code_hash is not on it — the runtime will refuse to load this strategy and fall back to the built-in default.",
  },
  unspecified: null,
};

const STYLE: Record<StrategyAuditStatus, string> = {
  audited:
    'border-state-active text-state-active bg-paper-strong',
  unverified:
    'border-accent-orange text-accent-orange bg-paper-strong',
  unspecified: '',
};

export function AuditBadge({
  strategy,
}: {
  strategy: Pick<LiveStrategy, 'codeHashHex' | 'strategist'>;
}) {
  const status = classifyStrategy(strategy);
  const copy = COPY[status];
  if (!copy) return null;
  return (
    <span
      title={copy.tooltip}
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${STYLE[status]}`}
    >
      {copy.label}
    </span>
  );
}
