/**
 * 90-day strategy backtest engine — shared by the live API and
 * `scripts/backtest-strategies.ts`.
 *
 * Replays each strategy's `evaluate()` against CoinGecko SUI/USD daily
 * closes on a synthetic SUI + DBUSDC portfolio (testnet coin types).
 */

import type {
  PastDecision,
  Strategy,
  StrategyInput,
  StrategyMemory,
  HoldingSnapshot,
} from '@synapse-core/vault';

export interface DailyPrice {
  ts: number;
  priceUsd: number;
}

export interface BacktestPoint {
  date: string;
  priceUsd: number;
  navUsd: number;
  suiUnits: number;
  quoteUnits: number;
  /** @deprecated legacy static JSON */
  usdcUnits?: number;
  decision: 'rebalance' | 'noop';
  rationale: string;
}

export interface BacktestSummary {
  strategyId: string;
  strategySlug: string;
  strategyName: string;
  startDate: string;
  endDate: string;
  startNavUsd: number;
  endNavUsd: number;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  volatilityPct: number;
  sharpeAnnualized: number;
  tradesExecuted: number;
  noops: number;
  series: BacktestPoint[];
  generatedAt: string;
  /** Set when the strategy could not be resolved or evaluate() threw. */
  error?: string;
}

export interface BacktestIndexEntry {
  strategyId: string;
  slug: string;
  name: string;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  sharpeAnnualized: number;
  tradesExecuted: number;
  error?: string;
}

export interface BacktestIndex {
  generatedAt: string;
  startDate: string;
  endDate: string;
  priceSource: 'coingecko';
  strategies: BacktestIndexEntry[];
}

/** Testnet DeepBook SUI/DBUSDC — matches live runtime defaults. */
export const BACKTEST_SUI_TYPE_TAG =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
export const BACKTEST_QUOTE_TYPE_TAG =
  '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
export const BACKTEST_POOL_ID =
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5';

const START_SUI = 1000;
const START_QUOTE = 2000;
const FEE_BPS = 25;
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/coins/sui/market_chart?vs_currency=usd&days=90&interval=daily';

export async function fetchSuiHistoryFromCoinGecko(): Promise<DailyPrice[]> {
  const response = await fetch(COINGECKO_URL, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`CoinGecko ${response.status}: ${await response.text()}`);
  }
  const json = (await response.json()) as { prices: [number, number][] };
  return json.prices.map(([ts, priceUsd]) => ({ ts, priceUsd }));
}

function buildHoldings(
  suiUnits: number,
  quoteUnits: number,
  suiPriceUsd: number,
): HoldingSnapshot[] {
  return [
    {
      coinTypeTag: BACKTEST_SUI_TYPE_TAG,
      symbol: 'SUI',
      amount: BigInt(Math.round(suiUnits * 1e9)),
      decimals: 9,
      priceUsd: suiPriceUsd,
      valueUsd: suiUnits * suiPriceUsd,
    },
    {
      coinTypeTag: BACKTEST_QUOTE_TYPE_TAG,
      symbol: 'DBUSDC',
      amount: BigInt(Math.round(quoteUnits * 1e6)),
      decimals: 6,
      priceUsd: 1,
      valueUsd: quoteUnits,
    },
  ];
}

function buildMemory(decisions: PastDecision[], priceLookback: number, confBps: number): StrategyMemory {
  return {
    recentDecisions: decisions.slice(-30),
    counters: { price_lookback_usd: priceLookback, pyth_conf_bps: confBps },
    facts: [],
  };
}

export function slugFromStrategyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^synapse\s+/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function runBacktest(args: {
  strategyId: string;
  strategy: Strategy;
  prices: DailyPrice[];
}): Promise<BacktestSummary> {
  const { strategyId, strategy, prices } = args;
  const slug = slugFromStrategyName(strategy.name);

  let suiUnits = START_SUI;
  let quoteUnits = START_QUOTE;
  const decisions: PastDecision[] = [];
  const series: BacktestPoint[] = [];
  let tradesExecuted = 0;
  let noops = 0;

  for (let i = 0; i < prices.length; i++) {
    const tick = prices[i]!;
    const lookback = i >= 7 ? prices[i - 7]!.priceUsd : tick.priceUsd;
    const confBps = Math.min(
      300,
      Math.round((Math.abs(tick.priceUsd - lookback) / lookback) * 10_000 * 0.3),
    );

    const holdings = buildHoldings(suiUnits, quoteUnits, tick.priceUsd);
    const navUsd = holdings.reduce((acc, h) => acc + h.valueUsd, 0);
    const input: StrategyInput = {
      vaultId: `backtest-${strategyId.slice(2, 10)}`,
      holdings,
      navUsd,
      market: {
        prices: { SUI: tick.priceUsd, DBUSDC: 1 },
        pools: [
          {
            poolId: BACKTEST_POOL_ID,
            baseTypeTag: BACKTEST_SUI_TYPE_TAG,
            quoteTypeTag: BACKTEST_QUOTE_TYPE_TAG,
            bestBid: tick.priceUsd * 0.999,
            bestAsk: tick.priceUsd * 1.001,
            mid: tick.priceUsd,
            volume24h: 1_000_000,
          },
        ],
        asOf: new Date(tick.ts).toISOString(),
      },
      memory: buildMemory(decisions, lookback, confBps),
      currentEpoch: BigInt(i),
      policy: {
        spendPerEpochUsd: navUsd,
        approvedPackages: [BACKTEST_POOL_ID],
        expiryEpoch: BigInt(prices.length + 100),
        revoked: false,
      },
    };

    const decision = await strategy.evaluate(input);

    if (decision.kind === 'rebalance') {
      for (const trade of decision.trades) {
        const fromBalance =
          trade.fromTypeTag === BACKTEST_SUI_TYPE_TAG ? suiUnits : quoteUnits;
        const fromPrice = trade.fromTypeTag === BACKTEST_SUI_TYPE_TAG ? tick.priceUsd : 1;
        const toPrice = trade.toTypeTag === BACKTEST_SUI_TYPE_TAG ? tick.priceUsd : 1;
        const amountInUnits =
          Number(trade.amountIn) /
          10 ** (trade.fromTypeTag === BACKTEST_SUI_TYPE_TAG ? 9 : 6);
        const effectiveIn = Math.min(amountInUnits, fromBalance);
        const fee = effectiveIn * (FEE_BPS / 10_000);
        const grossOutUsd = (effectiveIn - fee) * fromPrice;
        const outUnits = grossOutUsd / toPrice;

        if (trade.fromTypeTag === BACKTEST_SUI_TYPE_TAG) {
          suiUnits -= effectiveIn;
          quoteUnits += outUnits;
        } else {
          quoteUnits -= effectiveIn;
          suiUnits += outUnits;
        }
      }
      tradesExecuted++;
      const newHoldings = buildHoldings(suiUnits, quoteUnits, tick.priceUsd);
      const newNav = newHoldings.reduce((acc, h) => acc + h.valueUsd, 0);
      decisions.push({
        decisionId: decision.planId,
        epoch: BigInt(i),
        kind: 'rebalance',
        rationale: decision.summary,
        realizedPnlUsd: newNav - navUsd,
      });
    } else {
      noops++;
      decisions.push({
        decisionId: `noop-${i}`,
        epoch: BigInt(i),
        kind: 'noop',
        rationale: decision.rationale,
      });
    }

    const postHoldings = buildHoldings(suiUnits, quoteUnits, tick.priceUsd);
    const postNav = postHoldings.reduce((acc, h) => acc + h.valueUsd, 0);
    series.push({
      date: new Date(tick.ts).toISOString().slice(0, 10),
      priceUsd: tick.priceUsd,
      navUsd: postNav,
      suiUnits,
      quoteUnits,
      decision: decision.kind,
      rationale: decision.kind === 'noop' ? decision.rationale : decision.summary,
    });
  }

  const benchSeries = prices.map((p) => START_SUI * p.priceUsd + START_QUOTE);
  const startNav = series[0]?.navUsd ?? 0;
  const endNav = series[series.length - 1]?.navUsd ?? startNav;
  const totalReturnPct = startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0;
  const benchmarkReturnPct =
    benchSeries[0]! > 0
      ? ((benchSeries[benchSeries.length - 1]! - benchSeries[0]!) / benchSeries[0]!) * 100
      : 0;
  const alphaPct = totalReturnPct - benchmarkReturnPct;

  let peak = startNav;
  let maxDd = 0;
  for (const point of series) {
    if (point.navUsd > peak) peak = point.navUsd;
    if (peak > 0) {
      const dd = (peak - point.navUsd) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]!.navUsd;
    const b = series[i]!.navUsd;
    if (a > 0) returns.push((b - a) / a);
  }
  const meanRet = returns.reduce((s, x) => s + x, 0) / Math.max(1, returns.length);
  const variance =
    returns.reduce((acc, x) => acc + (x - meanRet) ** 2, 0) /
    Math.max(1, returns.length - 1);
  const stddev = Math.sqrt(variance);
  const volatilityPct = stddev * Math.sqrt(365) * 100;
  const sharpeAnnualized = stddev > 0 ? (meanRet / stddev) * Math.sqrt(365) : 0;

  return {
    strategyId,
    strategySlug: slug,
    strategyName: strategy.name,
    startDate: series[0]?.date ?? '',
    endDate: series[series.length - 1]?.date ?? '',
    startNavUsd: startNav,
    endNavUsd: endNav,
    totalReturnPct,
    benchmarkReturnPct,
    alphaPct,
    maxDrawdownPct: maxDd * 100,
    volatilityPct,
    sharpeAnnualized,
    tradesExecuted,
    noops,
    series,
    generatedAt: new Date().toISOString(),
  };
}

export function summaryToIndexEntry(summary: BacktestSummary): BacktestIndexEntry {
  return {
    strategyId: summary.strategyId,
    slug: summary.strategySlug,
    name: summary.strategyName,
    totalReturnPct: summary.totalReturnPct,
    benchmarkReturnPct: summary.benchmarkReturnPct,
    alphaPct: summary.alphaPct,
    maxDrawdownPct: summary.maxDrawdownPct,
    sharpeAnnualized: summary.sharpeAnnualized,
    tradesExecuted: summary.tradesExecuted,
    ...(summary.error ? { error: summary.error } : {}),
  };
}

export function buildBacktestIndex(summaries: BacktestSummary[]): BacktestIndex {
  const ok = summaries.filter((s) => !s.error && s.startDate);
  return {
    generatedAt: new Date().toISOString(),
    startDate: ok[0]?.startDate ?? summaries[0]?.startDate ?? '',
    endDate: ok[0]?.endDate ?? summaries[0]?.endDate ?? '',
    priceSource: 'coingecko',
    strategies: summaries.map(summaryToIndexEntry),
  };
}
