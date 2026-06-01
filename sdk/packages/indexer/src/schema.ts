/**
 * GraphQL schema for the Synapse indexer. Vault-centric — the dashboard and
 * Memory Inspector both consume this.
 */

import { createSchema } from 'graphql-yoga';
import type { SynapseIndexer } from './indexer.js';

const typeDefs = /* GraphQL */ `
  type Query {
    """All events the indexer has observed, oldest first."""
    events(limit: Int = 100, offset: Int = 0): [IndexedEvent!]!
    """Vault timeline — projected events for one specific vault."""
    vaultTimeline(vaultId: ID!): [TimelineEntry!]!
    """Current holdings snapshot for a vault."""
    holdings(vaultId: ID!): HoldingsSnapshot!
    """Rebalance records for a vault, newest first."""
    rebalances(vaultId: ID!, limit: Int = 50): [Rebalance!]!
  }

  type IndexedEvent {
    kind: String!
    txDigest: String!
    timestampMs: String!
  }

  type TimelineEntry {
    vaultId: ID!
    kind: String!
    description: String!
    txDigest: String!
    timestampMs: String!
    walrusBlobId: String
    artifactSlot: String
    amount: String
    tokenType: String
    counterparty: String
  }

  type HoldingsSnapshot {
    vaultId: ID!
    asOfTimestampMs: String!
    artifactCount: String!
    balances: [TokenBalance!]!
  }

  type TokenBalance {
    tokenType: String!
    amount: String!
  }

  type Rebalance {
    vaultId: ID!
    planId: String!
    txDigest: String!
    timestampMs: String!
    baseType: String!
    quoteType: String!
    direction: Int!
    inputAmount: String!
    outputAmount: String!
    reportArtifactSlot: String
    reportWalrusBlobId: String
  }
`;

// Hard ceiling on any single query's page size — bounds the cost of an
// otherwise-uncapped `events(limit: …)` / `rebalances(limit: …)` against the
// O(n) in-memory resolvers.
const MAX_PAGE_LIMIT = 1000;

function clampLimit(requested: number | undefined, fallback: number): number {
  const n = Number.isFinite(requested) ? (requested as number) : fallback;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_PAGE_LIMIT);
}

export function buildSchema(indexer: SynapseIndexer) {
  return createSchema({
    typeDefs,
    resolvers: {
      Query: {
        events: (_p: unknown, args: { limit: number; offset: number }) => {
          const all = indexer.allEvents();
          const limit = clampLimit(args.limit, 100);
          const offset = Math.max(Math.trunc(Number(args.offset) || 0), 0);
          return all.slice(offset, offset + limit).map((e) => ({
            kind: e.kind,
            txDigest: e.meta.txDigest,
            timestampMs: e.meta.timestampMs.toString(),
          }));
        },
        vaultTimeline: (_p: unknown, args: { vaultId: string }) =>
          indexer.vaultTimeline(args.vaultId).map((t) => ({
            ...t,
            timestampMs: t.timestampMs.toString(),
            artifactSlot: t.artifactSlot?.toString() ?? null,
            amount: t.amount?.toString() ?? null,
          })),
        holdings: (_p: unknown, args: { vaultId: string }) => {
          const h = indexer.holdings(args.vaultId);
          return {
            vaultId: h.vaultId,
            asOfTimestampMs: h.asOfTimestampMs.toString(),
            artifactCount: h.artifactCount.toString(),
            balances: Object.entries(h.balances).map(([tokenType, amount]) => ({
              tokenType,
              amount: amount.toString(),
            })),
          };
        },
        rebalances: (_p: unknown, args: { vaultId: string; limit: number }) =>
          indexer
            .rebalances(args.vaultId)
            .slice(-clampLimit(args.limit, 50))
            .reverse()
            .map((r) => ({
              ...r,
              timestampMs: r.timestampMs.toString(),
              inputAmount: r.inputAmount.toString(),
              outputAmount: r.outputAmount.toString(),
              reportArtifactSlot: r.reportArtifactSlot?.toString() ?? null,
            })),
      },
    },
  });
}
