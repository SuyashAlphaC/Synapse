import 'server-only';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Strategy } from '@synapse-core/vault';
import { loadStrategyFromWalrus } from '@synapse-core/vault/walrus-loader';
import {
  aggressiveMomentum,
  balancedYield,
  conservativeRebalancer,
  dcaTwap,
  mmInventory,
} from '@synapse-core/vault/strategies';
import {
  BACKTEST_POOL_ID,
  BACKTEST_QUOTE_TYPE_TAG,
  BACKTEST_SUI_TYPE_TAG,
} from './backtest-engine';
import { NETWORK, SYNAPSE_PACKAGE_ID, SUI_FULLNODE_URL } from './synapse-config';
import type { LiveStrategy } from './strategies';

/** Bundled fallbacks when Walrus fetch fails (offline manifest, LLM-only, etc.). */
const BUNDLED_BY_SLUG: Record<string, () => Strategy> = {
  'conservative-rebalancer': () =>
    conservativeRebalancer({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      targetBaseWeight: 0.5,
      driftThreshold: 0.05,
      poolId: BACKTEST_POOL_ID,
      slippageTolerance: 0.005,
    }),
  'balanced-yield': () =>
    balancedYield({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      targetBaseWeight: 0.6,
      thresholdLow: 0.02,
      thresholdHigh: 0.08,
      slippageLow: 0.005,
      slippageHigh: 0.02,
      volWindow: 12,
      poolId: BACKTEST_POOL_ID,
    }),
  'aggressive-momentum': () =>
    aggressiveMomentum({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      entryThreshold: 0.02,
      exitThreshold: -0.01,
      maxConfBps: 75,
      slippageTolerance: 0.01,
      maxPositionFraction: 0.5,
      poolId: BACKTEST_POOL_ID,
    }),
  'mm-inventory': () =>
    mmInventory({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      lowerBaseWeight: 0.4,
      upperBaseWeight: 0.6,
      slippageTolerance: 0.005,
      poolId: BACKTEST_POOL_ID,
    }),
  'dca-twap': () =>
    dcaTwap({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      direction: 'accumulate-base',
      cadenceTicks: 6,
      tradeSizeUsd: 10,
      slippageTolerance: 0.005,
      poolId: BACKTEST_POOL_ID,
    }),
  'demo-band-keeper': () =>
    mmInventory({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      lowerBaseWeight: 0.45,
      upperBaseWeight: 0.55,
      slippageTolerance: 0.005,
      poolId: BACKTEST_POOL_ID,
    }),
};

function slugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^synapse\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function bundledFallback(live: LiveStrategy): Strategy | null {
  const slug = slugFromName(live.name);
  const factory = BUNDLED_BY_SLUG[slug];
  if (factory) return factory();
  if (live.name.toLowerCase().includes('band keeper')) {
    return BUNDLED_BY_SLUG['demo-band-keeper']!();
  }
  return null;
}

/**
 * Resolve a marketplace strategy to a runnable `Strategy` for backtesting.
 * Prefers Walrus bundle (hash-verified); falls back to bundled implementations
 * for known Synapse seeds when Walrus is unavailable.
 */
export async function resolveStrategyForBacktest(
  live: LiveStrategy,
): Promise<{ strategy: Strategy; source: 'walrus' | 'bundled' } | { error: string }> {
  const walrusNetwork = NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const fullnodeUrl = process.env.SUI_FULLNODE_URL ?? SUI_FULLNODE_URL;
  const client = new SuiJsonRpcClient({ network: NETWORK, url: fullnodeUrl });

  try {
    const loaded = await loadStrategyFromWalrus({
      client,
      packageId: SYNAPSE_PACKAGE_ID,
      strategyId: live.id,
      network: walrusNetwork,
    });
    if (loaded?.strategy) {
      return { strategy: loaded.strategy, source: 'walrus' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const bundled = bundledFallback(live);
    if (bundled) {
      return { strategy: bundled, source: 'bundled' };
    }
    return { error: message.slice(0, 240) };
  }

  const bundled = bundledFallback(live);
  if (bundled) {
    return { strategy: bundled, source: 'bundled' };
  }

  if (!live.sourceWalrusBlob || live.sourceWalrusBlob.length < 40) {
    return { error: 'No Walrus bundle and no bundled fallback for this strategy name.' };
  }

  return { error: 'Could not load strategy from Walrus for backtest.' };
}
