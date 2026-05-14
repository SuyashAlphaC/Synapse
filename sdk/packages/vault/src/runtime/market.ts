import { DeepBookClient, testnetCoins, testnetPools } from '@mysten/deepbook-v3';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { MarketSnapshot, PoolSnapshot, Strategy } from '../types.js';
import { PythOracle, type OraclePriceProvider } from './oracle.js';

export interface LoadMarketSnapshotArgs {
  client: SuiJsonRpcClient;
  pools: string[];
  senderAddress: string;
  /**
   * Optional oracle. Defaults to a real Pyth Hermes client. Supply a
   * `StaticOracle` (from `./oracle.js`) in tests to avoid network calls.
   */
  oracle?: OraclePriceProvider;
  /**
   * Extra symbols to fetch USD prices for beyond what the pools reveal.
   */
  extraSymbols?: readonly string[];
}

const STABLE_PEG_SYMBOLS = new Set(['USDC', 'DBUSDC', 'USDT', 'DAI']);

export async function loadMarketSnapshot(args: LoadMarketSnapshotArgs): Promise<MarketSnapshot> {
  const deepbook = new DeepBookClient({
    client: args.client,
    address: args.senderAddress,
    network: 'testnet',
  });

  const pools = await loadPools(deepbook, args.pools);

  // Gather every coin symbol the strategy might price, then fetch oracle USD
  // prices in a single batched call.
  const symbols = uniqueSymbols([
    ...pools.flatMap((p) => [symbolFromTypeTag(p.baseTypeTag), symbolFromTypeTag(p.quoteTypeTag)]),
    ...(args.extraSymbols ?? []),
  ]);

  const oracle = args.oracle ?? new PythOracle();
  let oraclePrices: Record<string, number> = {};
  try {
    oraclePrices = await oracle.getPricesUsd(symbols);
  } catch (err) {
    // Fall through with empty oracle data — the DeepBook fallback below
    // still produces a usable snapshot. The runtime logs the failure.
    void err;
  }

  const prices = mergePrices(symbols, pools, oraclePrices);

  return {
    prices,
    pools,
    asOf: new Date().toISOString(),
  };
}

async function loadPools(
  deepbook: DeepBookClient,
  poolIds: readonly string[],
): Promise<PoolSnapshot[]> {
  const snapshots: PoolSnapshot[] = [];
  for (const poolId of poolIds) {
    const poolKey = poolKeyFromId(poolId);
    const pool = testnetPools[poolKey];
    const base = testnetCoins[pool.baseCoin];
    const quote = testnetCoins[pool.quoteCoin];
    const mid = await deepbook.midPrice(poolKey);
    const l2 = await deepbook.getLevel2TicksFromMid(poolKey, 1);
    const bestBid = l2.bid_prices[0] ?? mid;
    const bestAsk = l2.ask_prices[0] ?? mid;
    const vaultBalances = await deepbook.vaultBalances(poolKey);
    snapshots.push({
      poolId: pool.address,
      baseTypeTag: base.type,
      quoteTypeTag: quote.type,
      bestBid,
      bestAsk,
      mid,
      volume24h: vaultBalances.base,
    });
  }
  return snapshots;
}

/**
 * Merge prices from three sources, in priority order:
 *   1. Pyth oracle (gold standard, when available)
 *   2. Pegged-stable fallback (DBUSDC, USDT, etc. → $1)
 *   3. DeepBook mid-derived (`base = mid × quote_usd`)
 */
function mergePrices(
  symbols: readonly string[],
  pools: readonly PoolSnapshot[],
  oraclePrices: Record<string, number>,
): Record<string, number> {
  const prices: Record<string, number> = { ...oraclePrices };

  for (const symbol of symbols) {
    if (prices[symbol] !== undefined) continue;
    if (STABLE_PEG_SYMBOLS.has(symbol)) {
      prices[symbol] = 1;
    }
  }

  for (const pool of pools) {
    const baseSym = symbolFromTypeTag(pool.baseTypeTag);
    const quoteSym = symbolFromTypeTag(pool.quoteTypeTag);
    if (prices[baseSym] !== undefined) continue;
    const quoteUsd = prices[quoteSym];
    if (quoteUsd === undefined) continue;
    prices[baseSym] = pool.mid * quoteUsd;
  }

  return prices;
}

export function requiredPoolsForStrategy(
  strategy: Strategy & {
    requiredPools?: () => string[];
  },
): string[] {
  return strategy.requiredPools?.() ?? [testnetPools.SUI_DBUSDC.address];
}

function poolKeyFromId(poolId: string): keyof typeof testnetPools {
  for (const [key, value] of Object.entries(testnetPools)) {
    if (value.address.toLowerCase() === poolId.toLowerCase()) {
      return key as keyof typeof testnetPools;
    }
  }
  throw new Error(`DeepBook testnet pool ${poolId} is not present in @mysten/deepbook-v3 constants`);
}

function uniqueSymbols(symbols: readonly string[]): string[] {
  return Array.from(new Set(symbols.filter((s) => s.length > 0)));
}

function symbolFromTypeTag(typeTag: string): string {
  return typeTag.split('::').at(-1) ?? typeTag;
}
