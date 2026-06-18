#!/usr/bin/env tsx
/**
 * Refresh static backtest JSON (offline fallback) using the same engine as the
 * live `/api/backtests` route. Prefer the live API in production; run this for
 * marketing site / air-gapped dev:
 *
 *   npx tsx scripts/backtest-strategies.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  aggressiveMomentum,
  balancedYield,
  conservativeRebalancer,
} from '../sdk/packages/vault/src/strategies/index.js';

import {
  BACKTEST_POOL_ID,
  BACKTEST_QUOTE_TYPE_TAG,
  BACKTEST_SUI_TYPE_TAG,
  buildBacktestIndex,
  fetchSuiHistoryFromCoinGecko,
  runBacktest,
} from '../web/dashboard/lib/backtest-engine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, '..', 'web', 'dashboard', 'public', 'backtests');

const SEEDED = [
  {
    strategyId: '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec',
    strategy: conservativeRebalancer({
      baseTypeTag: BACKTEST_SUI_TYPE_TAG,
      baseSymbol: 'SUI',
      quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      quoteSymbol: 'DBUSDC',
      targetBaseWeight: 0.5,
      driftThreshold: 0.05,
      poolId: BACKTEST_POOL_ID,
      slippageTolerance: 0.005,
    }),
  },
  {
    strategyId: '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679',
    strategy: balancedYield({
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
  },
  {
    strategyId: '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1',
    strategy: aggressiveMomentum({
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
  },
] as const;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Fetching 90-day SUI/USD from CoinGecko…');
  const prices = await fetchSuiHistoryFromCoinGecko();
  const summaries = [];
  for (const { strategyId, strategy } of SEEDED) {
    console.log(`→ ${strategy.name}`);
    const summary = await runBacktest({ strategyId, strategy, prices });
    summaries.push(summary);
    writeFileSync(join(OUT_DIR, `${summary.strategySlug}.json`), JSON.stringify(summary, null, 2));
  }
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(buildBacktestIndex(summaries), null, 2));
  console.log(`Wrote ${summaries.length} reports to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
