/**
 * MemWal cross-agent read — wired into every runtime tick.
 *
 * For each configured peer vault sharing the same on-chain MemWal namespace:
 *   1. Semantic-recall the peer's recent strategy outcomes from the shared namespace.
 *   2. Attest unseen memories on-chain via `coordination::record_cross_agent_read`.
 *   3. Inject `xattr:{writer}:{blobId}:{snippet}` facts for the strategy.
 *
 * Seen memories are tracked with `xattr:seen:{sha256(blobId)}` facts so each
 * blob is attested at most once.
 */

import { Transaction } from '@mysten/sui/transactions';
import { target } from '@synapse-core/client';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { MemWal } from '@synapse-core/memwal-bridge';
import { recall } from '@synapse-core/memwal-bridge';
import { loadAgentState } from './state.js';
import { messageDigest } from './messaging.js';

export const XATTR_SEEN_PREFIX = 'xattr:seen:';
export const XATTR_FACT_PREFIX = 'xattr:';

export interface CrossAgentConsumeArgs {
  client: SuiJsonRpcClient;
  packageId: string;
  packageHistory: readonly string[];
  readerVaultId: string;
  readerNamespaceBytes: Uint8Array;
  memwal: MemWal;
  namespace: string;
  peerVaultIds: readonly string[];
  existingFacts: readonly string[];
  signer: unknown;
  query?: string;
  limit?: number;
}

export interface CrossAgentConsumeResult {
  facts: string[];
  seenMarkers: string[];
  attestedCount: number;
}

export function parseCrossAgentSeenMarkers(facts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.startsWith(XATTR_SEEN_PREFIX)) {
      seen.add(f.slice(XATTR_SEEN_PREFIX.length));
    }
  }
  return seen;
}

function namespacesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function snippet(text: string, max = 160): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, max);
}

async function recordCrossAgentReadPTB(args: {
  client: SuiJsonRpcClient;
  packageId: string;
  readerVaultId: string;
  writerVaultId: string;
  memoryId: string;
  signer: unknown;
}): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: target(args.packageId, 'coordination', 'record_cross_agent_read'),
    arguments: [
      tx.object(args.readerVaultId),
      tx.object(args.writerVaultId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(args.memoryId))),
    ],
  });
  await args.client.signAndExecuteTransaction({
    transaction: tx,
    signer: args.signer as never,
  });
}

/**
 * Recall peer memories from a shared MemWal namespace and attest new reads.
 * Degrades to empty on any failure so a flaky peer never trips the tick.
 */
export async function consumeCrossAgentMemories(
  args: CrossAgentConsumeArgs,
): Promise<CrossAgentConsumeResult> {
  if (args.peerVaultIds.length === 0) {
    return { facts: [], seenMarkers: [], attestedCount: 0 };
  }

  const seen = parseCrossAgentSeenMarkers(args.existingFacts);
  const facts: string[] = [];
  const seenMarkers: string[] = [];
  let attestedCount = 0;

  for (const peerId of args.peerVaultIds) {
    if (peerId.toLowerCase() === args.readerVaultId.toLowerCase()) continue;

    try {
      const peer = await loadAgentState({
        client: args.client,
        agentId: peerId,
        packageId: args.packageId,
        packageHistory: args.packageHistory,
      });

      if (peer.policy.revoked) continue;
      if (!namespacesEqual(args.readerNamespaceBytes, peer.identity.memwalNamespace)) {
        continue;
      }

      const query =
        args.query ??
        `vault ${peerId.slice(0, 10)} Synapse strategy outcome rebalance signal peer memory`;

      const recalled = await recall({
        client: args.memwal,
        namespace: args.namespace,
        query,
        limit: args.limit ?? 5,
      });

      for (const hit of recalled.results) {
        const blobId = hit.blob_id?.trim();
        if (!blobId) continue;
        if (seen.has(blobId)) continue;

        try {
          await recordCrossAgentReadPTB({
            client: args.client,
            packageId: args.packageId,
            readerVaultId: args.readerVaultId,
            writerVaultId: peerId,
            memoryId: blobId,
            signer: args.signer,
          });
          attestedCount += 1;
        } catch {
          // Peer memory is still useful in-process even if attestation fails.
        }

        const digest = await messageDigest(hit.text);
        facts.push(
          `${XATTR_FACT_PREFIX}${peerId}:${blobId}:${snippet(hit.text)} (digest=${digest.slice(0, 8).join('')})`,
        );
        seenMarkers.push(`${XATTR_SEEN_PREFIX}${blobId}`);
        seen.add(blobId);
      }
    } catch {
      // Skip this peer for this tick.
    }
  }

  return { facts, seenMarkers, attestedCount };
}

export function mergeTickMemoryWrite(args: {
  strategyWrite: import('../types.js').MemoryWrite | null;
  msgCursor: bigint | null;
  extraFacts: string[];
}): import('../types.js').MemoryWrite | null {
  if (!args.strategyWrite && args.msgCursor === null && args.extraFacts.length === 0) {
    return null;
  }
  return {
    counters: {
      ...(args.strategyWrite?.counters ?? {}),
      ...(args.msgCursor !== null ? { msgCursor: Number(args.msgCursor) } : {}),
    },
    facts: [...(args.strategyWrite?.facts ?? []), ...args.extraFacts],
  };
}
