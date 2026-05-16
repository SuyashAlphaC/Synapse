/**
 * Strategy resolver — maps an on-chain `Strategy` object ID to a concrete
 * runtime implementation. The vault's `AgentIdentity.strategy_id` selects
 * which TypeScript Strategy module the runtime executes per tick.
 *
 * The seeded strategy IDs are pinned to the testnet deployment from
 * `scripts/seed-strategies.ts`. Update via the `SYNAPSE_STRATEGY_REGISTRY_JSON`
 * env var (a JSON object: `{"0xstrategyId": "balanced-yield", ...}`) or by
 * editing the `KNOWN_STRATEGIES` table below.
 *
 * When a strategy ID is not resolvable, the runtime falls back to the
 * `defaultStrategy` passed by the caller — for backward compatibility with
 * vaults minted before the marketplace existed.
 */

import type { Strategy } from '../types.js';
import {
  AGGRESSIVE_MOMENTUM_ID,
  BALANCED_YIELD_ID,
  CONSERVATIVE_REBALANCER_ID,
  aggressiveMomentum,
  balancedYield,
  conservativeRebalancer,
} from '../strategies/index.js';
import {
  SUI_TYPE_TAG_TESTNET,
  SUI_USDC_POOL_ID_TESTNET,
  USDC_TYPE_TAG_TESTNET,
} from './deepbook.js';

/** Strategy slug returned by `resolveStrategySlug`. */
export type StrategySlug =
  | typeof CONSERVATIVE_REBALANCER_ID
  | typeof BALANCED_YIELD_ID
  | typeof AGGRESSIVE_MOMENTUM_ID;

/**
 * Canonical on-chain `Strategy` object IDs from the testnet seed. Used as
 * defaults; override at runtime via env / config.
 */
export const KNOWN_STRATEGIES: Record<string, StrategySlug> = {
  '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec':
    CONSERVATIVE_REBALANCER_ID,
  '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679':
    BALANCED_YIELD_ID,
  '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1':
    AGGRESSIVE_MOMENTUM_ID,
};

/**
 * Look up the runtime slug for an on-chain `Strategy` ID, consulting the
 * env-provided override map first and then `KNOWN_STRATEGIES`.
 */
export function resolveStrategySlug(
  strategyId: string,
  envOverrideJson?: string,
): StrategySlug | null {
  const override = parseEnvOverride(envOverrideJson);
  if (override[strategyId]) return override[strategyId]!;
  return KNOWN_STRATEGIES[strategyId] ?? null;
}

function parseEnvOverride(raw: string | undefined): Record<string, StrategySlug> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, string>;
  const out: Record<string, StrategySlug> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (
      v === CONSERVATIVE_REBALANCER_ID ||
      v === BALANCED_YIELD_ID ||
      v === AGGRESSIVE_MOMENTUM_ID
    ) {
      out[k] = v;
    } else {
      throw new Error(`SYNAPSE_STRATEGY_REGISTRY_JSON: unknown slug "${v}"`);
    }
  }
  return out;
}

/**
 * Build a concrete `Strategy` for a known slug using the testnet defaults
 * or operator-provided overrides. Lets a single deployed package work for
 * any vault funded with any USDC variant.
 */
export interface BuildStrategyOverrides {
  /** Custom quote token type (e.g. Circle's USDC vs DeepBookV3's DBUSDC). */
  quoteTypeTag?: string;
  /** Display symbol for the quote token. Defaults to "USDC". */
  quoteSymbol?: string;
  /** DeepBookV3 pool the strategy should route through. */
  poolId?: string;
}

export function buildStrategy(
  slug: StrategySlug,
  overrides: BuildStrategyOverrides = {},
): Strategy {
  const commonPair = {
    baseTypeTag: SUI_TYPE_TAG_TESTNET,
    baseSymbol: 'SUI',
    quoteTypeTag: overrides.quoteTypeTag ?? USDC_TYPE_TAG_TESTNET,
    quoteSymbol: overrides.quoteSymbol ?? 'USDC',
    poolId: overrides.poolId ?? SUI_USDC_POOL_ID_TESTNET,
  } as const;

  switch (slug) {
    case CONSERVATIVE_REBALANCER_ID:
      return conservativeRebalancer({
        ...commonPair,
        targetBaseWeight: 0.5,
        driftThreshold: 0.05,
        slippageTolerance: 0.005,
      });
    case BALANCED_YIELD_ID:
      return balancedYield({
        ...commonPair,
        targetBaseWeight: 0.6,
        thresholdLow: 0.02,
        thresholdHigh: 0.08,
        slippageLow: 0.005,
        slippageHigh: 0.02,
        volWindow: 12,
      });
    case AGGRESSIVE_MOMENTUM_ID:
      return aggressiveMomentum({
        ...commonPair,
        entryThreshold: 0.02,
        exitThreshold: -0.01,
        maxConfBps: 75,
        slippageTolerance: 0.01,
        maxPositionFraction: 0.5,
      });
  }
}

/**
 * Resolve a runtime `Strategy` from an on-chain `strategy_id`, with the
 * supplied `defaultStrategy` as a fallback for unknown IDs and an
 * optional `overrides` block that re-targets the quote token + pool
 * (so the same strategy slug works for any USDC variant a vault holds).
 */
export function resolveStrategy(args: {
  strategyId: string;
  defaultStrategy: Strategy;
  envOverrideJson?: string;
  overrides?: BuildStrategyOverrides;
}): { strategy: Strategy; resolved: boolean; slug: StrategySlug | null } {
  const slug = resolveStrategySlug(args.strategyId, args.envOverrideJson);
  if (!slug) {
    return { strategy: args.defaultStrategy, resolved: false, slug: null };
  }
  return { strategy: buildStrategy(slug, args.overrides ?? {}), resolved: true, slug };
}
