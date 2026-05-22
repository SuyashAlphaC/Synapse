/**
 * Browser-safe Pyth Hermes price fetcher. No SDK — direct HTTP, so it
 * tree-shakes cleanly into the dashboard bundle.
 *
 * Hermes V2 API (current): https://hermes.pyth.network/docs
 *   GET /v2/updates/price/latest?ids[]=<feed_id>&ids[]=<feed_id>...
 *
 * Each price feed entry includes a `price` object with:
 *   { price: string; conf: string; expo: number; publish_time: number }
 *
 * `price` is an int-stringified mantissa; the real USD value is
 * `Number(price) * 10^expo`.
 */

export const PYTH_FEED_IDS = {
  SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  DBUSDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
} as const;

export type PythSymbol = keyof typeof PYTH_FEED_IDS;

const HERMES_URLS = [
  'https://hermes.pyth.network',
  'https://hermes-beta.pyth.network',
];

interface HermesPriceFeedResponse {
  parsed?: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
    ema_price?: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

/**
 * CoinGecko simple-price fallback when all Pyth Hermes endpoints are
 * unreachable. Only covers symbols we have a CoinGecko ID for.
 */
const COINGECKO_IDS: Partial<Record<string, string>> = {
  SUI: 'sui',
  BTC: 'bitcoin',
  ETH: 'ethereum',
};

async function fetchCoinGeckoFallback(
  symbols: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const ids = symbols
    .map((s) => COINGECKO_IDS[s.toUpperCase()])
    .filter((id): id is string => !!id);
  if (ids.length === 0) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return {};
  const body = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number> = {};
  for (const sym of symbols) {
    const geckoId = COINGECKO_IDS[sym.toUpperCase()];
    if (!geckoId) continue;
    const price = body[geckoId]?.usd;
    if (typeof price === 'number' && price > 0) {
      out[sym] = price;
      out[sym.toUpperCase()] = price;
    }
  }
  return out;
}

async function fetchFromHermes(
  hermesUrl: string,
  feedIds: string[],
  symbolByFeedId: Record<string, string[]>,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const url = new URL(`${hermesUrl}/v2/updates/price/latest`);
  for (const id of feedIds) url.searchParams.append('ids[]', id);

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Pyth Hermes returned ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as HermesPriceFeedResponse;
  if (!body.parsed) return {};

  const out: Record<string, number> = {};
  for (const entry of body.parsed) {
    const normalizedId = entry.id.startsWith('0x') ? entry.id : `0x${entry.id}`;
    const aliases =
      symbolByFeedId[normalizedId] ??
      symbolByFeedId[normalizedId.toLowerCase()] ??
      symbolByFeedId[`0x${normalizedId.replace(/^0x/, '').toLowerCase()}`];
    if (!aliases) continue;
    const mantissa = Number(entry.price.price);
    if (!Number.isFinite(mantissa)) continue;
    const price = mantissa * Math.pow(10, entry.price.expo);
    if (!Number.isFinite(price) || price <= 0) continue;
    for (const symbol of aliases) {
      out[symbol] = price;
      out[symbol.toUpperCase()] = price;
    }
  }
  return out;
}

/**
 * Fetch the latest USD price for the given symbols. Tries multiple Pyth
 * Hermes endpoints, then falls back to CoinGecko if all are down.
 * Unknown symbols are silently dropped.
 */
export async function fetchPythPricesUsd(
  symbols: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const symbolByFeedId: Record<string, string[]> = {};
  for (const raw of symbols) {
    const symbol = raw.toUpperCase();
    const feedId = (PYTH_FEED_IDS as Record<string, string>)[symbol];
    if (!feedId) continue;
    (symbolByFeedId[feedId] ??= []).push(raw);
  }

  const feedIds = Object.keys(symbolByFeedId);
  if (feedIds.length === 0) return {};

  // Try each Hermes endpoint; first success wins.
  for (const hermesUrl of HERMES_URLS) {
    try {
      const result = await fetchFromHermes(hermesUrl, feedIds, symbolByFeedId, signal);
      if (Object.keys(result).length > 0) return result;
    } catch {
      // Try next endpoint.
    }
  }

  // All Pyth endpoints failed — fall back to CoinGecko for the symbols
  // we have mappings for.
  try {
    return await fetchCoinGeckoFallback(symbols, signal);
  } catch {
    // Total oracle failure — caller sees an empty price map, which
    // use-live-vault.ts reports as `unpriced` symbols.
    return {};
  }
}
