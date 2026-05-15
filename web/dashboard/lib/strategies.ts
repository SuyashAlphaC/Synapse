/**
 * Browser-safe loader for the marketplace catalog. Queries the
 * `StrategyPublishedEvent` stream emitted by `strategy_registry::publish`
 * and hydrates each strategy's current shared-object state. Returns enough
 * data for the marketplace UI to render cards with live reputation.
 *
 * Direct RPC, no indexer required. When the GraphQL indexer is wired up
 * (`SYNAPSE_INDEXER_URL`), `use-strategies.ts` falls back to this loader
 * automatically if the endpoint is unreachable.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID } from './synapse-config';

export const RISK_PROFILE = {
  Conservative: 0,
  Balanced: 1,
  Aggressive: 2,
} as const;

export type RiskProfile = (typeof RISK_PROFILE)[keyof typeof RISK_PROFILE];

export const RISK_LABEL: Record<RiskProfile, string> = {
  0: 'Conservative',
  1: 'Balanced',
  2: 'Aggressive',
};

export interface LiveStrategy {
  id: string;
  strategist: string;
  name: string;
  description: string;
  codeHashHex: string;
  sourceWalrusBlob: string;
  riskProfile: RiskProfile;
  royaltyBps: number;
  version: bigint;
  publishedAtEpoch: bigint;
  active: boolean;
  vaultCount: bigint;
  activeVaultCount: bigint;
  totalAumCommitted: bigint;
  totalTicksRecorded: bigint;
  cumulativeAlphaBpsPos: bigint;
  cumulativeAlphaBpsNeg: bigint;
  revocations: bigint;
  totalRoyaltyPaid: bigint;
  lastUpdateEpoch: bigint;
}

interface LoadStrategiesArgs {
  client: SuiJsonRpcClient;
  packageId?: string;
  /** Hard cap on results — defaults to 200 which is plenty for v1. */
  limit?: number;
}

/**
 * Fetch the marketplace catalog. We page through `StrategyPublishedEvent`
 * (instead of querying the global object soup) because it gives us a stable
 * "every strategy that has ever existed" enumeration; deprecation is then
 * reflected via each strategy's live `active` flag.
 */
export async function loadStrategies({
  client,
  packageId = SYNAPSE_PACKAGE_ID,
  limit = 200,
}: LoadStrategiesArgs): Promise<LiveStrategy[]> {
  const eventType = `${packageId}::strategy_registry::StrategyPublishedEvent`;
  const seen = new Set<string>();
  const out: LiveStrategy[] = [];

  let cursor: { txDigest: string; eventSeq: string } | null = null;
  while (out.length < limit) {
    const page = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      order: 'descending',
      limit: Math.min(50, limit - out.length),
    });
    if (page.data.length === 0) break;

    for (const ev of page.data) {
      const parsed = ev.parsedJson as { strategy_id?: string } | undefined;
      const strategyId = parsed?.strategy_id;
      if (!strategyId || seen.has(strategyId)) continue;
      seen.add(strategyId);

      const live = await fetchStrategy(client, packageId, strategyId);
      if (live) out.push(live);
    }

    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return out;
}

export async function fetchStrategy(
  client: SuiJsonRpcClient,
  packageId: string,
  strategyId: string,
): Promise<LiveStrategy | null> {
  const obj = await client.getObject({ id: strategyId, options: { showContent: true } });
  if (obj.error || !obj.data?.content) return null;
  const content = obj.data.content;
  if (content.dataType !== 'moveObject') return null;
  const move = content as { type: string; fields: unknown };
  if (!move.type.startsWith(`${packageId}::strategy_registry::Strategy`)) return null;

  return parseStrategy(strategyId, asRecord(move.fields, 'Strategy.fields'));
}

function parseStrategy(id: string, f: Record<string, unknown>): LiveStrategy {
  return {
    id,
    strategist: stringField(f.strategist, 'strategist'),
    name: stringField(f.name, 'name'),
    description: stringField(f.description, 'description'),
    codeHashHex: hexFromBytes(f.code_hash, 'code_hash'),
    sourceWalrusBlob: utf8FromBytes(f.source_walrus_blob, 'source_walrus_blob'),
    riskProfile: riskFromU8(f.risk_profile),
    royaltyBps: numberField(f.royalty_bps, 'royalty_bps'),
    version: bigintField(f.version, 'version'),
    publishedAtEpoch: bigintField(f.published_at_epoch, 'published_at_epoch'),
    active: booleanField(f.active, 'active'),
    vaultCount: bigintField(f.vault_count, 'vault_count'),
    activeVaultCount: bigintField(f.active_vault_count, 'active_vault_count'),
    totalAumCommitted: bigintField(f.total_aum_committed, 'total_aum_committed'),
    totalTicksRecorded: bigintField(f.total_ticks_recorded, 'total_ticks_recorded'),
    cumulativeAlphaBpsPos: bigintField(f.cumulative_alpha_bps_pos, 'cumulative_alpha_bps_pos'),
    cumulativeAlphaBpsNeg: bigintField(f.cumulative_alpha_bps_neg, 'cumulative_alpha_bps_neg'),
    revocations: bigintField(f.revocations, 'revocations'),
    totalRoyaltyPaid: bigintField(f.total_royalty_paid, 'total_royalty_paid'),
    lastUpdateEpoch: bigintField(f.last_update_epoch, 'last_update_epoch'),
  };
}

// ---------------------------------------------------------------------------
// Net alpha helper — derived view, since Move stores +/- as separate sums.
// ---------------------------------------------------------------------------

export interface AlphaSummary {
  /** Net cumulative alpha in basis points (positive minus negative). */
  netBps: bigint;
  /** Mean alpha per tick, basis points (0 if no ticks recorded). */
  meanBps: number;
  /** Total ticks recorded, for sample-size context. */
  ticks: bigint;
}

export function alphaSummary(s: LiveStrategy): AlphaSummary {
  const net = s.cumulativeAlphaBpsPos - s.cumulativeAlphaBpsNeg;
  const ticks = s.totalTicksRecorded;
  const mean = ticks === 0n ? 0 : Number(net) / Number(ticks);
  return { netBps: net, meanBps: mean, ticks };
}

// ---------------------------------------------------------------------------
// Scalar parsers (mirror vault-state.ts)
// ---------------------------------------------------------------------------

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`);
  return value;
}

function numberField(value: unknown, label: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new Error(`${label} is not a number-like value`);
}

function bigintField(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} is not a u64/u128-like value`);
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`);
  return value;
}

function riskFromU8(value: unknown): RiskProfile {
  const n = numberField(value, 'risk_profile');
  if (n !== 0 && n !== 1 && n !== 2) {
    throw new Error(`risk_profile ${n} is out of range`);
  }
  return n;
}

function bytesField(value: unknown, label: string): Uint8Array {
  if (!Array.isArray(value)) throw new Error(`${label} is not a byte vector`);
  return Uint8Array.from(
    value.map((v, i) => {
      if (typeof v !== 'number' || v < 0 || v > 255 || !Number.isInteger(v)) {
        throw new Error(`${label}[${i}] is not a byte`);
      }
      return v;
    }),
  );
}

function hexFromBytes(value: unknown, label: string): string {
  const bytes = bytesField(value, label);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function utf8FromBytes(value: unknown, label: string): string {
  const bytes = bytesField(value, label);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
