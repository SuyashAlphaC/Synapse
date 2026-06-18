import 'server-only';

import {
  buildBacktestIndex,
  fetchSuiHistoryFromCoinGecko,
  runBacktest,
  type BacktestIndex,
  type BacktestSummary,
  type DailyPrice,
} from './backtest-engine';
import { resolveStrategyForBacktest } from './backtest-resolver.server';
import { loadStrategies } from './strategies';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { NETWORK, SYNAPSE_PACKAGE_ID, SUI_FULLNODE_URL } from './synapse-config';

const PRICE_TTL_MS = 60 * 60 * 1000;
const RESULT_TTL_MS = 60 * 60 * 1000;

let priceCache: { at: number; prices: DailyPrice[] } | null = null;
const resultCache = new Map<string, { at: number; summary: BacktestSummary }>();

function cacheKey(strategyId: string, codeHashHex: string): string {
  return `${strategyId}:${codeHashHex}`;
}

async function getPrices(): Promise<DailyPrice[]> {
  const now = Date.now();
  if (priceCache && now - priceCache.at < PRICE_TTL_MS) {
    return priceCache.prices;
  }
  const prices = await fetchSuiHistoryFromCoinGecko();
  priceCache = { at: now, prices };
  return prices;
}

async function backtestOne(
  live: Awaited<ReturnType<typeof loadStrategies>>[number],
  prices: DailyPrice[],
): Promise<BacktestSummary> {
  const key = cacheKey(live.id, live.codeHashHex);
  const cached = resultCache.get(key);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) {
    return cached.summary;
  }

  const resolved = await resolveStrategyForBacktest(live);
  if ('error' in resolved) {
    const failed: BacktestSummary = {
      strategyId: live.id,
      strategySlug: live.name.toLowerCase().replace(/\s+/g, '-'),
      strategyName: live.name,
      startDate: prices[0] ? new Date(prices[0].ts).toISOString().slice(0, 10) : '',
      endDate: prices.at(-1)
        ? new Date(prices.at(-1)!.ts).toISOString().slice(0, 10)
        : '',
      startNavUsd: 0,
      endNavUsd: 0,
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      alphaPct: 0,
      maxDrawdownPct: 0,
      volatilityPct: 0,
      sharpeAnnualized: 0,
      tradesExecuted: 0,
      noops: 0,
      series: [],
      generatedAt: new Date().toISOString(),
      error: resolved.error,
    };
    resultCache.set(key, { at: Date.now(), summary: failed });
    return failed;
  }

  try {
    const summary = await runBacktest({
      strategyId: live.id,
      strategy: resolved.strategy,
      prices,
    });
    resultCache.set(key, { at: Date.now(), summary });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: BacktestSummary = {
      strategyId: live.id,
      strategySlug: resolved.strategy.id,
      strategyName: live.name,
      startDate: prices[0] ? new Date(prices[0].ts).toISOString().slice(0, 10) : '',
      endDate: prices.at(-1)
        ? new Date(prices.at(-1)!.ts).toISOString().slice(0, 10)
        : '',
      startNavUsd: 0,
      endNavUsd: 0,
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      alphaPct: 0,
      maxDrawdownPct: 0,
      volatilityPct: 0,
      sharpeAnnualized: 0,
      tradesExecuted: 0,
      noops: 0,
      series: [],
      generatedAt: new Date().toISOString(),
      error: message.slice(0, 240),
    };
    resultCache.set(key, { at: Date.now(), summary: failed });
    return failed;
  }
}

export async function getLiveBacktestIndex(): Promise<BacktestIndex> {
  const network = NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const fullnodeUrl = process.env.SUI_FULLNODE_URL ?? SUI_FULLNODE_URL;
  const client = new SuiJsonRpcClient({ network: NETWORK, url: fullnodeUrl });
  const [prices, catalog] = await Promise.all([
    getPrices(),
    loadStrategies({ client, packageId: SYNAPSE_PACKAGE_ID, limit: 100 }),
  ]);

  const active = catalog.filter((s) => s.active);
  const summaries = await Promise.all(active.map((s) => backtestOne(s, prices)));
  return buildBacktestIndex(summaries, prices);
}

export async function getLiveBacktest(strategyId: string): Promise<BacktestSummary | null> {
  const network = NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const fullnodeUrl = process.env.SUI_FULLNODE_URL ?? SUI_FULLNODE_URL;
  const client = new SuiJsonRpcClient({ network: NETWORK, url: fullnodeUrl });
  const prices = await getPrices();
  const catalog = await loadStrategies({ client, packageId: SYNAPSE_PACKAGE_ID, limit: 200 });
  const live = catalog.find((s) => s.id === strategyId);
  if (!live) return null;
  return backtestOne(live, prices);
}

/** Drop caches (tests / manual refresh). */
export function clearBacktestCaches(): void {
  priceCache = null;
  resultCache.clear();
}
