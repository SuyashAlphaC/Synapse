/**
 * @synapse-core/adapter-langgraph
 *
 * `SynapseStore` — a `BaseStore` implementation backed by Synapse Core's
 * MemWal bridge. Any LangGraph workflow can drop this in as its
 * persistence layer to get:
 *
 *   - Walrus-durable semantic memory (via MemWal)
 *   - On-chain delegate-key authorization (the agent must hold the key
 *     bound to the `AgentIdentity` it operates as)
 *   - Cryptographic revocation: when the AgentIdentity is revoked, the
 *     MemWal delegate is invalidated server-side and no further reads
 *     or writes succeed
 *
 * The implementation maps LangGraph's `namespace: string[]` hierarchy to
 * MemWal namespaces by joining with `/`, and serializes the LangGraph
 * `value: Record<string, any>` payload as JSON inside the MemWal memory
 * text. A small in-memory key index keeps `get(namespace, key)` an O(1)
 * lookup; `search(namespacePrefix, { query })` proxies to MemWal's
 * semantic recall.
 *
 * Limitations of v1 (documented intentionally — no mocks):
 *   - `delete` is implemented as a tombstone memory plus an in-memory
 *     key-index removal. The underlying MemWal blob is not yet evicted
 *     because the MemWal SDK 0.0.3 does not expose a forget API; we
 *     surface the limitation rather than fake it.
 *   - `listNamespaces` returns namespaces observed via this store
 *     instance only. Recovering historical namespaces from MemWal
 *     requires the relayer's restore endpoint (deferred to v2).
 */

import { BaseStore } from '@langchain/langgraph-checkpoint';
import type {
  GetOperation,
  Item,
  ListNamespacesOperation,
  Operation,
  OperationResults,
  PutOperation,
  SearchItem,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';
import {
  createMemWalClient,
  rememberAndWait,
  recall,
  type AgentMemWalCredentials,
} from '@synapse-core/memwal-bridge';
import type { AgentIdentity } from '@synapse-core/client';
import type { MemWal } from '@mysten-incubation/memwal';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SynapseStoreOptions {
  /** AgentIdentity the store operates on behalf of. */
  identity: AgentIdentity;
  /** Off-chain MemWal delegate credentials. */
  credentials: AgentMemWalCredentials;
  /**
   * Override the auto-constructed MemWal client. Useful for tests or for
   * sharing a client across multiple store instances.
   */
  client?: MemWal;
  /**
   * MemWal recall limit when the caller does not specify one. Default 5.
   */
  defaultSearchLimit?: number;
}

// ---------------------------------------------------------------------------
// Item encoding helpers
// ---------------------------------------------------------------------------

interface EncodedItem {
  /** Discriminator so we can later add more record types. */
  kind: 'synapse-store-item-v1';
  /** Slash-joined namespace path. */
  namespacePath: string;
  /** Hierarchical namespace as stored. */
  namespace: string[];
  /** Item key within the namespace. */
  key: string;
  /** User payload. */
  value: Record<string, unknown>;
  /** Wall-clock timestamp the item was written. */
  writtenAt: string;
  /** Tombstone marker for deletions (true == this record deletes prior). */
  tombstone?: boolean;
}

function encode(item: EncodedItem): string {
  return JSON.stringify(item);
}

function tryDecode(text: string): EncodedItem | null {
  try {
    const parsed = JSON.parse(text) as Partial<EncodedItem>;
    if (parsed.kind !== 'synapse-store-item-v1') return null;
    if (typeof parsed.key !== 'string') return null;
    if (!Array.isArray(parsed.namespace)) return null;
    if (typeof parsed.value !== 'object' || parsed.value === null) return null;
    return parsed as EncodedItem;
  } catch {
    return null;
  }
}

function namespacePath(namespace: string[]): string {
  return namespace.join('/');
}

function namespaceMatchesPrefix(itemNamespace: string[], prefix: string[]): boolean {
  if (prefix.length > itemNamespace.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== itemNamespace[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SynapseStore
// ---------------------------------------------------------------------------

export class SynapseStore extends BaseStore {
  private readonly client: MemWal;
  private readonly defaultLimit: number;
  /** Latest known MemWal blob for each (namespace, key). */
  private readonly keyIndex = new Map<string, { blobId: string; value: Record<string, unknown> }>();
  /** Known namespaces this store has observed locally. */
  private readonly observedNamespaces = new Set<string>();

  constructor(options: SynapseStoreOptions) {
    super();
    this.client = options.client ?? createMemWalClient({
      identity: options.identity,
      credentials: options.credentials,
    });
    this.defaultLimit = options.defaultSearchLimit ?? 5;
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = new Array(operations.length);
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op === undefined) {
        results[i] = null;
        continue;
      }
      if (isPut(op)) {
        await this.handlePut(op);
        results[i] = undefined;
        continue;
      }
      if (isGet(op)) {
        results[i] = await this.handleGet(op);
        continue;
      }
      if (isSearch(op)) {
        results[i] = await this.handleSearch(op);
        continue;
      }
      if (isListNamespaces(op)) {
        results[i] = this.handleListNamespaces(op);
        continue;
      }
      results[i] = null;
    }
    return results as OperationResults<Op>;
  }

  // -------------------------------------------------------------------------
  // Per-op handlers
  // -------------------------------------------------------------------------

  private async handlePut(op: PutOperation): Promise<void> {
    const indexKey = `${namespacePath(op.namespace)}::${op.key}`;
    this.observedNamespaces.add(namespacePath(op.namespace));

    if (op.value === null) {
      const tombstone: EncodedItem = {
        kind: 'synapse-store-item-v1',
        namespacePath: namespacePath(op.namespace),
        namespace: op.namespace,
        key: op.key,
        value: {},
        writtenAt: new Date().toISOString(),
        tombstone: true,
      };
      await rememberAndWait({
        client: this.client,
        text: encode(tombstone),
        namespace: namespacePath(op.namespace),
      });
      this.keyIndex.delete(indexKey);
      return;
    }

    const encoded: EncodedItem = {
      kind: 'synapse-store-item-v1',
      namespacePath: namespacePath(op.namespace),
      namespace: op.namespace,
      key: op.key,
      value: op.value as Record<string, unknown>,
      writtenAt: new Date().toISOString(),
    };

    const result = await rememberAndWait({
      client: this.client,
      text: encode(encoded),
      namespace: namespacePath(op.namespace),
    });

    this.keyIndex.set(indexKey, {
      blobId: result.blob_id,
      value: encoded.value,
    });
  }

  private async handleGet(op: GetOperation): Promise<Item | null> {
    const indexKey = `${namespacePath(op.namespace)}::${op.key}`;
    const cached = this.keyIndex.get(indexKey);
    if (cached) {
      return {
        namespace: op.namespace,
        key: op.key,
        value: cached.value as Record<string, unknown>,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Item;
    }
    // Cache miss — query MemWal semantically using the key itself as the
    // search query. MemWal is ranked-by-similarity, not key-indexed, so a
    // stale write (or an older value) can outrank the newest record. We must
    // therefore scan ALL matching records and resolve by the most recent
    // `writtenAt`; if the newest is a tombstone the item is deleted. Taking the
    // first similarity match (the previous behavior) resurrected deleted/old
    // values. Over-fetch to raise the chance of capturing the tombstone.
    const recalled = await recall({
      client: this.client,
      query: op.key,
      limit: Math.max(this.defaultLimit, GET_RECALL_LIMIT),
      namespace: namespacePath(op.namespace),
    });
    let newest: EncodedItem | null = null;
    let newestBlob = '';
    for (const memory of recalled.results) {
      const decoded = tryDecode(memory.text);
      if (!decoded) continue;
      if (decoded.key !== op.key) continue;
      if (!arraysEqual(decoded.namespace, op.namespace)) continue;
      if (newest === null || isNewer(decoded, newest)) {
        newest = decoded;
        newestBlob = memory.blob_id;
      }
    }
    if (newest === null || newest.tombstone) return null;
    this.keyIndex.set(indexKey, { blobId: newestBlob, value: newest.value });
    return {
      namespace: op.namespace,
      key: op.key,
      value: newest.value,
      createdAt: new Date(newest.writtenAt),
      updatedAt: new Date(newest.writtenAt),
    } as Item;
  }

  private async handleSearch(op: SearchOperation): Promise<SearchItem[]> {
    const query = op.query ?? '*';
    const limit = op.limit ?? this.defaultLimit;
    const offset = op.offset ?? 0;
    const namespaceOverride =
      op.namespacePrefix.length > 0 ? namespacePath(op.namespacePrefix) : undefined;
    // Over-fetch by `offset` — MemWal recall has no offset parameter, so
    // slicing a `limit`-sized page by `offset` would drop never-fetched
    // results (and return empty whenever offset >= limit).
    const recalled = await recall({
      client: this.client,
      query,
      limit: offset + limit,
      ...(namespaceOverride !== undefined ? { namespace: namespaceOverride } : {}),
    });

    // Collapse to the newest record per (namespace, key) so an older write
    // can't shadow a newer one and a tombstone correctly hides the prior value.
    const newestByKey = new Map<string, { decoded: EncodedItem; distance: number }>();
    for (const memory of recalled.results) {
      const decoded = tryDecode(memory.text);
      if (!decoded) continue;
      if (!namespaceMatchesPrefix(decoded.namespace, op.namespacePrefix)) continue;
      const k = `${namespacePath(decoded.namespace)}::${decoded.key}`;
      const prev = newestByKey.get(k);
      if (!prev || isNewer(decoded, prev.decoded)) {
        newestByKey.set(k, { decoded, distance: memory.distance });
      }
    }

    const matches: SearchItem[] = [];
    for (const { decoded, distance } of newestByKey.values()) {
      if (decoded.tombstone) continue;
      if (op.filter && !matchesFilter(decoded.value, op.filter)) continue;
      matches.push({
        namespace: decoded.namespace,
        key: decoded.key,
        value: decoded.value,
        score: similarityFromDistance(distance),
        createdAt: new Date(decoded.writtenAt),
        updatedAt: new Date(decoded.writtenAt),
      } as SearchItem);
    }
    return matches.slice(offset, offset + limit);
  }

  private handleListNamespaces(op: ListNamespacesOperation): string[][] {
    let all = Array.from(this.observedNamespaces).map((p) => p.split('/').filter(Boolean));
    // Honor maxDepth by truncating then de-duplicating the prefixes.
    if (op.maxDepth !== undefined) {
      const seen = new Set<string>();
      const truncated: string[][] = [];
      for (const ns of all) {
        const cut = ns.slice(0, op.maxDepth);
        const k = cut.join('/');
        if (seen.has(k)) continue;
        seen.add(k);
        truncated.push(cut);
      }
      all = truncated;
    }
    // Honor matchConditions (prefix/suffix, with '*' as a single-segment wildcard).
    if (op.matchConditions && op.matchConditions.length > 0) {
      all = all.filter((ns) => op.matchConditions!.every((c) => matchesCondition(ns, c)));
    }
    const offset = op.offset ?? 0;
    const limit = op.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }
}

// ---------------------------------------------------------------------------
// Operation discriminators
// ---------------------------------------------------------------------------

function isPut(op: Operation): op is PutOperation {
  return 'key' in op && 'namespace' in op && 'value' in op;
}
function isGet(op: Operation): op is GetOperation {
  return 'key' in op && 'namespace' in op && !('value' in op);
}
function isSearch(op: Operation): op is SearchOperation {
  return 'namespacePrefix' in op;
}
function isListNamespaces(op: Operation): op is ListNamespacesOperation {
  return 'limit' in op && !('namespace' in op) && !('namespacePrefix' in op);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * How many records to pull when resolving a single key on a cache miss. MemWal
 * is similarity-ranked, not key-indexed, so the newest record for a key (or its
 * tombstone) may not be the top hit. Over-fetching raises the chance of seeing
 * it. Residual: if the key has more than this many revisions a stale value can
 * still slip through — the durable fix needs a key-indexed lookup or a MemWal
 * forget API (SDK 0.0.3 has neither).
 */
const GET_RECALL_LIMIT = 25;

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when `candidate` was written strictly later than `current`. */
function isNewer(candidate: EncodedItem, current: EncodedItem): boolean {
  return new Date(candidate.writtenAt).getTime() > new Date(current.writtenAt).getTime();
}

/** Apply a single ListNamespaces match condition (prefix/suffix, '*' wildcard). */
function matchesCondition(
  ns: string[],
  cond: { matchType: 'prefix' | 'suffix'; path: string[] },
): boolean {
  const { matchType, path } = cond;
  if (path.length > ns.length) return false;
  if (matchType === 'prefix') {
    for (let i = 0; i < path.length; i++) {
      if (path[i] !== '*' && path[i] !== ns[i]) return false;
    }
    return true;
  }
  // suffix
  const start = ns.length - path.length;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== '*' && path[i] !== ns[start + i]) return false;
  }
  return true;
}

/**
 * Convert MemWal's cosine *distance* (0 = identical, 2 = opposite) into a
 * BaseStore-compatible similarity score in [-1, 1] where 1 == identical.
 * Clamped defensively in case a backend ever returns distance outside [0, 2].
 */
function similarityFromDistance(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - distance));
}

function matchesFilter(value: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, expected] of Object.entries(filter)) {
    const actual = value[k];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      for (const [op, target] of Object.entries(ops)) {
        if (!applyComparator(op, actual, target)) return false;
      }
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function applyComparator(op: string, actual: unknown, target: unknown): boolean {
  switch (op) {
    case '$eq':
      return actual === target;
    case '$ne':
      return actual !== target;
    case '$gt':
      return typeof actual === 'number' && typeof target === 'number' && actual > target;
    case '$gte':
      return typeof actual === 'number' && typeof target === 'number' && actual >= target;
    case '$lt':
      return typeof actual === 'number' && typeof target === 'number' && actual < target;
    case '$lte':
      return typeof actual === 'number' && typeof target === 'number' && actual <= target;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

export { BaseStore } from '@langchain/langgraph-checkpoint';
export type { AgentMemWalCredentials } from '@synapse-core/memwal-bridge';

export const SYNAPSE_LANGGRAPH_ADAPTER_VERSION = '0.1.0';
