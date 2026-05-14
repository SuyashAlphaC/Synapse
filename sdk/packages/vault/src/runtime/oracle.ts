/**
 * Oracle price providers. Production runtime uses Pyth Network's Hermes
 * service for USD prices; tests inject a `StaticOracle` with deterministic
 * values. Both implement the same `OraclePriceProvider` interface so the
 * market loader is oracle-agnostic.
 *
 * Pyth Hermes API: https://hermes.pyth.network/docs
 * Feed IDs:        https://pyth.network/developers/price-feed-ids
 */

import { PriceServiceConnection } from '@pythnetwork/price-service-client';

/** Canonical Pyth price-feed IDs, in hex (with `0x` prefix). */
export const PYTH_FEED_IDS = {
  'SUI/USD': '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  'USDC/USD': '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
} as const;

const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

/**
 * Map from human-readable symbol → Pyth feed ID. Tests can override to use
 * dummy IDs; the runtime defaults to the canonical mainnet feeds (which are
 * valid for testnet too — Pyth Hermes is a single global service).
 */
export type FeedIdMap = Record<string, string>;

export const DEFAULT_FEED_BY_SYMBOL: FeedIdMap = {
  SUI: PYTH_FEED_IDS['SUI/USD'],
  USDC: PYTH_FEED_IDS['USDC/USD'],
  DBUSDC: PYTH_FEED_IDS['USDC/USD'], // testnet wrap of USDC — same peg
  BTC: PYTH_FEED_IDS['BTC/USD'],
  ETH: PYTH_FEED_IDS['ETH/USD'],
};

export interface OraclePriceProvider {
  /** Returns USD price per unit, or null if no feed configured / available. */
  getPriceUsd(symbol: string): Promise<number | null>;
  /** Batch variant — implementations should make a single HTTP call. */
  getPricesUsd(symbols: readonly string[]): Promise<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Production: Pyth Hermes
// ---------------------------------------------------------------------------

export interface PythOracleOptions {
  hermesUrl?: string;
  feedIdBySymbol?: FeedIdMap;
}

export class PythOracle implements OraclePriceProvider {
  readonly #connection: PriceServiceConnection;
  readonly #feeds: FeedIdMap;

  constructor(opts: PythOracleOptions = {}) {
    this.#connection = new PriceServiceConnection(opts.hermesUrl ?? DEFAULT_HERMES_URL);
    this.#feeds = opts.feedIdBySymbol ?? DEFAULT_FEED_BY_SYMBOL;
  }

  async getPriceUsd(symbol: string): Promise<number | null> {
    const feedId = this.#feeds[symbol];
    if (!feedId) return null;
    const feeds = await this.#connection.getLatestPriceFeeds([feedId]);
    if (!feeds || feeds.length === 0) return null;
    const price = feeds[0]?.getPriceUnchecked();
    return price ? price.getPriceAsNumberUnchecked() : null;
  }

  async getPricesUsd(symbols: readonly string[]): Promise<Record<string, number>> {
    const symbolByFeedId: Record<string, string> = {};
    const feedIds: string[] = [];
    for (const symbol of symbols) {
      const feedId = this.#feeds[symbol];
      if (!feedId) continue;
      if (symbolByFeedId[feedId]) continue; // dedupe same feed (e.g., USDC + DBUSDC)
      symbolByFeedId[feedId] = symbol;
      feedIds.push(feedId);
    }
    if (feedIds.length === 0) return {};

    const feeds = await this.#connection.getLatestPriceFeeds(feedIds);
    const result: Record<string, number> = {};
    if (!feeds) return result;

    for (const feed of feeds) {
      const sym = symbolByFeedId[`0x${feed.id.replace(/^0x/, '')}`] ?? symbolByFeedId[feed.id];
      if (!sym) continue;
      const price = feed.getPriceUnchecked();
      if (!price) continue;
      const usd = price.getPriceAsNumberUnchecked();
      result[sym] = usd;
      // Mirror to every alias that resolved to the same feed (e.g., DBUSDC ← USDC).
      for (const [s, fid] of Object.entries(this.#feeds)) {
        const normalized = fid.startsWith('0x') ? fid : `0x${fid}`;
        if (normalized === (`0x${feed.id.replace(/^0x/, '')}`)) {
          result[s] = usd;
        }
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Tests: deterministic static oracle
// ---------------------------------------------------------------------------

/**
 * Always returns the configured prices. Used in unit tests to bypass network
 * calls. Not exported from the runtime barrel — tests import directly.
 */
export class StaticOracle implements OraclePriceProvider {
  constructor(private readonly prices: Record<string, number>) {}

  async getPriceUsd(symbol: string): Promise<number | null> {
    return this.prices[symbol] ?? null;
  }

  async getPricesUsd(symbols: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const v = this.prices[s];
      if (v !== undefined) out[s] = v;
    }
    return out;
  }
}
