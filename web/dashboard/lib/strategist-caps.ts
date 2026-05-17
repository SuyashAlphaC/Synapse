/**
 * Browser-safe loader: every `StrategistCap` owned by a given address, plus
 * the live `Strategy` it controls. Powers the `/strategist` console where
 * cap-holders deprecate, version-bump, or transfer ownership.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID, SYNAPSE_PACKAGE_HISTORY } from './synapse-config';
import { fetchStrategy, type LiveStrategy } from './strategies';

export interface OwnedStrategistCap {
  capId: string;
  strategyId: string;
  strategy: LiveStrategy;
}

interface LoadArgs {
  client: SuiJsonRpcClient;
  owner: string;
  packageId?: string;
}

/**
 * Paginate through every owned object on `owner` filtered to the Synapse
 * `StrategistCap` type, then hydrate each cap's Strategy reference.
 */
export async function loadOwnedStrategistCaps({
  client,
  owner,
  packageId = SYNAPSE_PACKAGE_ID,
}: LoadArgs): Promise<OwnedStrategistCap[]> {
  const packages =
    SYNAPSE_PACKAGE_HISTORY.length > 0
      ? SYNAPSE_PACKAGE_HISTORY
      : [packageId];
  const out: OwnedStrategistCap[] = [];
  const seen = new Set<string>();

  // Iterate every historical package — StrategistCap objects keep the
  // type they were created with, so caps minted under v1 don't match a
  // v2-only StructType filter. Union by capId across packages.
  for (const pkg of packages) {
    const capType = `${pkg}::strategy_registry::StrategistCap`;
    let cursor: string | null | undefined;
    do {
      let page;
      try {
        page = await client.getOwnedObjects({
          owner,
          filter: { StructType: capType },
          options: { showContent: true, showType: true },
          ...(cursor ? { cursor } : {}),
        });
      } catch {
        break;
      }
      for (const item of page.data) {
        const content = item.data?.content;
        if (!content || content.dataType !== 'moveObject') continue;
        const fields = (content as { fields: unknown }).fields;
        const strategyId = readStrategyIdField(fields);
        const capId = item.data?.objectId;
        if (!capId || !strategyId || seen.has(capId)) continue;
        seen.add(capId);
        const strategy = await fetchStrategy(client, packageId, strategyId);
        if (!strategy) continue;
        out.push({ capId, strategyId, strategy });
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
  }

  return out.sort(
    (a, b) => Number(b.strategy.publishedAtEpoch - a.strategy.publishedAtEpoch),
  );
}

function readStrategyIdField(fields: unknown): string | null {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const obj = fields as Record<string, unknown>;
  const raw = obj['strategy_id'];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const inner = raw as Record<string, unknown>;
    if (typeof inner['id'] === 'string') return inner['id'] as string;
    if (typeof inner['fields'] === 'object' && inner['fields'] !== null) {
      const f = inner['fields'] as Record<string, unknown>;
      if (typeof f['id'] === 'string') return f['id'] as string;
    }
  }
  return null;
}
