/**
 * On-chain discovery of every vault the connected wallet owns, sourced
 * from `AgentMintedEvent` against the active `synapse_core` package.
 *
 * Replaces the legacy localStorage flow: any vault you ever minted with
 * this wallet shows up here, even if you cleared the browser cache or
 * minted from a different machine / the seed-live-vaults script.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID } from './synapse-config';

export interface OwnedVault {
  agentId: string;
  owner: string;
  sessionAddr: string;
  strategyId: string;
  mintedAtMs: number;
  mintDigest: string;
  expiryEpoch: bigint;
}

export async function loadOwnedVaults(args: {
  client: SuiJsonRpcClient;
  owner: string;
  packageId?: string;
  /** Hard cap on returned vaults — defaults to 50, plenty for v1. */
  limit?: number;
}): Promise<OwnedVault[]> {
  const packageId = args.packageId ?? SYNAPSE_PACKAGE_ID;
  const eventType = `${packageId}::agent::AgentMintedEvent`;
  const limit = args.limit ?? 50;

  const out: OwnedVault[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  const ownerNorm = normalizeAddress(args.owner);

  while (out.length < limit) {
    const page = await args.client.queryEvents({
      query: { MoveEventType: eventType },
      cursor,
      order: 'descending',
      limit: 50,
    });
    for (const ev of page.data) {
      const parsed = ev.parsedJson as
        | {
            agent_id?: string;
            owner?: string;
            session_addr?: string;
            strategy_id?: string;
            expiry_epoch?: string | number;
          }
        | undefined;
      if (!parsed?.owner || !parsed.agent_id) continue;
      // Sui returns addresses in both short ("0xa758…") and padded
      // ("0x0000…a758…") form depending on the codepath. Normalize both
      // sides so a refresh after a fresh mint actually matches.
      if (normalizeAddress(parsed.owner) !== ownerNorm) continue;
      out.push({
        agentId: parsed.agent_id,
        owner: parsed.owner,
        sessionAddr: parsed.session_addr ?? '',
        strategyId: parsed.strategy_id ?? '',
        mintedAtMs: ev.timestampMs ? Number(ev.timestampMs) : 0,
        mintDigest: ev.id.txDigest,
        expiryEpoch:
          parsed.expiry_epoch !== undefined ? BigInt(parsed.expiry_epoch) : 0n,
      });
      if (out.length >= limit) break;
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  // Newest first.
  return out.sort((a, b) => b.mintedAtMs - a.mintedAtMs);
}

/**
 * Canonicalize a Sui address for string comparison: lowercase, strip a
 * leading `0x`, pad to 64 hex chars. Round-trips both short and padded
 * forms to the same value.
 */
function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase().trim();
  const noPrefix = lower.startsWith('0x') ? lower.slice(2) : lower;
  return noPrefix.padStart(64, '0');
}
