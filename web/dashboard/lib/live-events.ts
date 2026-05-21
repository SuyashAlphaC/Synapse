/**
 * Live event loader. Queries Sui RPC for all events emitted by the deployed
 * `synapse_core` modules and projects them into the same `TimelineEntry`
 * shape the dashboard renders. This replaces sample data when the dashboard
 * has detected a real vault.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { TimelineEntry } from './sample-data';
import { SYNAPSE_INDEXER_URL, SYNAPSE_PACKAGE_ID, SYNAPSE_PACKAGE_HISTORY } from './synapse-config';

/** The Sui RPC client surface we need — narrowed to just `queryEvents`. */
type LiveEventsClient = Pick<SuiJsonRpcClient, 'queryEvents'>;

const MODULES = [
  'agent',
  'wallet',
  'artifacts',
  'coordination',
  'messaging_bridge',
  'deepbook_adapter',
  'attestation',
] as const;

const KIND_BY_EVENT_TAIL: Array<{ tail: string; kind: TimelineEntry['kind']; accent: string }> = [
  { tail: '::agent::AgentMintedEvent', kind: 'agent_minted', accent: '#030F1C' },
  { tail: '::agent::AgentRevokedEvent', kind: 'agent_revoked', accent: '#FF6B35' },
  { tail: '::agent::AgentFundedEvent', kind: 'agent_funded', accent: '#5BD49C' },
  { tail: '::wallet::SpendEvent', kind: 'spend', accent: '#5BC0EB' },
  { tail: '::artifacts::ArtifactPublishedEvent', kind: 'artifact_published', accent: '#9D7AEB' },
  { tail: '::coordination::CrossAgentReadEvent', kind: 'cross_agent_read', accent: '#FF8FA3' },
  { tail: '::messaging_bridge::MessageSentEvent', kind: 'message_sent', accent: '#FF8FA3' },
  { tail: '::messaging_bridge::MessageReceivedEvent', kind: 'message_received', accent: '#FF8FA3' },
  { tail: '::deepbook_adapter::SwapEvent', kind: 'swap', accent: '#FF6B35' },
  { tail: '::attestation::ActionLogEvent', kind: 'action_log', accent: '#F7C543' },
];

function classifyType(type: string): { kind: TimelineEntry['kind']; accent: string } | null {
  for (const m of KIND_BY_EVENT_TAIL) {
    if (type.endsWith(m.tail)) return { kind: m.kind, accent: m.accent };
  }
  return null;
}

export interface LoadEventsOptions {
  client: LiveEventsClient;
  /** Restrict to events tagged with this AgentIdentity ID. */
  agentId?: string;
  /** Page size. Default 50. */
  limit?: number;
}

/**
 * Fetch events emitted by the deployed `synapse_core` package, optionally
 * filtered to a single agent. Newest first.
 *
 * When `NEXT_PUBLIC_SYNAPSE_INDEXER_URL` is configured, we try the GraphQL
 * endpoint first (pagination + cross-agent joins). Any failure transparently
 * falls back to direct `queryEvents` against the Sui fullnode so the UI
 * stays responsive even when the indexer is down or unconfigured.
 */
export async function loadLiveTimeline(opts: LoadEventsOptions): Promise<TimelineEntry[]> {
  const { client, agentId, limit = 50 } = opts;

  if (SYNAPSE_INDEXER_URL && agentId) {
    try {
      const entries = await fetchFromIndexer(SYNAPSE_INDEXER_URL, agentId, limit);
      if (entries.length > 0) return entries;
    } catch (err) {
      console.warn('[synapse-events] indexer query failed, falling back to RPC', err);
    }
  }

  // Events are namespaced by the package version that ORIGINALLY
  // emitted them — a tick recorded by v3's runtime against a v2
  // module still has v2's type tag. Walk every historical package
  // per module; dedupe by `(txDigest, eventSeq)` since the same
  // event can't appear twice across versions.
  const packages =
    SYNAPSE_PACKAGE_HISTORY.length > 0 ? SYNAPSE_PACKAGE_HISTORY : [SYNAPSE_PACKAGE_ID];
  const entries: TimelineEntry[] = [];
  const seen = new Set<string>();

  for (const pkg of packages) {
    for (const moduleName of MODULES) {
      const pageLimit = Math.min(50, limit);
      try {
        const page = await client.queryEvents({
          query: { MoveModule: { package: pkg, module: moduleName } },
          cursor: null,
          limit: pageLimit,
          order: 'descending',
        });
        for (const ev of page.data) {
          const id = `${ev.id.txDigest}-${ev.id.eventSeq}`;
          if (seen.has(id)) continue;
          const meta = classifyType(ev.type);
          if (!meta) continue;
          const parsed = ev.parsedJson as Record<string, unknown>;
          if (agentId && !matchesAgent(parsed, agentId)) continue;
          seen.add(id);
          const entry: TimelineEntry = {
            id,
            vaultId: agentId ?? '',
            kind: meta.kind,
            description: describe(meta.kind, parsed),
            timestamp: Number(ev.timestampMs ?? Date.now()),
            txDigest: ev.id.txDigest,
            accentColor: meta.accent,
          };
          // Surface the balance-moving amount + token so the NAV history
          // reconstruction can replay funding inflows / spend outflows.
          // (Swaps are NAV-neutral at current prices, so we deliberately
          // leave them unannotated — see use-live-nav-history.)
          const balance = balanceFieldsFor(meta.kind, parsed);
          if (balance) {
            entry.amount = balance.amount;
            entry.tokenSymbol = balance.symbol;
          }
          entries.push(entry);
        }
      } catch (err) {
        // Per-module / per-package failures shouldn't kill the load.
        console.warn(`[synapse-events] ${pkg.slice(0, 10)}…/${moduleName} query failed`, err);
      }
    }
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Hosted-indexer path
// ---------------------------------------------------------------------------

interface IndexerTimelineRow {
  vaultId: string;
  kind: string;
  description: string;
  txDigest: string;
  timestampMs: string;
  walrusBlobId?: string | null;
  amount?: string | null;
  tokenType?: string | null;
  counterparty?: string | null;
}

const TIMELINE_QUERY = `
query VaultTimeline($vaultId: ID!) {
  vaultTimeline(vaultId: $vaultId) {
    vaultId
    kind
    description
    txDigest
    timestampMs
    walrusBlobId
    amount
    tokenType
    counterparty
  }
}`;

async function fetchFromIndexer(
  endpoint: string,
  agentId: string,
  limit: number,
): Promise<TimelineEntry[]> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: TIMELINE_QUERY, variables: { vaultId: agentId } }),
  });
  if (!response.ok) throw new Error(`indexer returned ${response.status}`);
  const body = (await response.json()) as { data?: { vaultTimeline?: IndexerTimelineRow[] } };
  const rows = body.data?.vaultTimeline ?? [];

  return rows.slice(0, limit).map((row, index) => {
    const kind = row.kind as TimelineEntry['kind'];
    const accent = KIND_BY_EVENT_TAIL.find((m) => m.kind === kind)?.accent ?? '#5BC0EB';
    const entry: TimelineEntry = {
      id: `${row.txDigest}-${index}`,
      vaultId: row.vaultId,
      kind,
      description: row.description,
      timestamp: Number(row.timestampMs ?? Date.now()),
      txDigest: row.txDigest,
      accentColor: accent,
    };
    if (row.walrusBlobId) entry.walrusBlobId = row.walrusBlobId;
    if (row.amount !== null && row.amount !== undefined) entry.amount = Number(row.amount);
    if (row.tokenType) entry.tokenSymbol = row.tokenType.split('::').pop() ?? row.tokenType;
    if (row.counterparty) entry.counterparty = row.counterparty;
    return entry;
  });
}

function matchesAgent(parsed: Record<string, unknown>, agentId: string): boolean {
  const lower = agentId.toLowerCase();
  for (const key of [
    'agent_id',
    'reader_id',
    'writer_id',
    'sender_agent_id',
    'receiver_agent_id',
  ]) {
    const v = parsed[key];
    if (typeof v === 'string' && v.toLowerCase() === lower) return true;
  }
  return false;
}

function describe(kind: TimelineEntry['kind'], p: Record<string, unknown>): string {
  switch (kind) {
    case 'agent_minted':
      return `Vault minted · spend cap ${p['spend_per_epoch'] ?? '?'} per epoch`;
    case 'agent_revoked':
      return `Vault revoked at epoch ${p['revoked_at_epoch'] ?? '?'}`;
    case 'agent_funded':
      return `Treasury funded with ${p['amount'] ?? '?'} ${shortenTypeName(p['token_type'])}`;
    case 'spend':
      return `Spent ${p['amount'] ?? '?'} ${shortenTypeName(p['token_type'])} → ${shortenAddr(p['target_pkg'])}`;
    case 'artifact_published':
      return `Artifact ${p['label'] ?? p['artifact_slot'] ?? ''} published`;
    case 'cross_agent_read':
      return `Cross-agent memory read`;
    case 'message_sent':
      return `Message sent → ${shortenAddr(p['recipient_inbox_id'])}`;
    case 'message_received':
      return `Message received ← ${shortenAddr(p['sender_outbox_id'])}`;
    case 'swap':
      return `Swap ${p['input_amount'] ?? '?'} → ${p['output_amount'] ?? '?'}`;
    case 'action_log':
      return typeof p['description'] === 'string' ? (p['description'] as string) : 'Action log';
  }
}

function shortenAddr(v: unknown): string {
  if (typeof v !== 'string') return '?';
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}

function shortenTypeName(v: unknown): string {
  const sym = symbolFromTokenType(v);
  return sym ?? '';
}

/**
 * Extract a coin symbol from a Move `TypeName`, which Sui RPC serializes
 * either as a bare string (`"…::sui::SUI"`) or as `{ name: "…::sui::SUI" }`.
 * Returns the uppercased final `::` segment (e.g. `SUI`, `DBUSDC`), or
 * `null` when the shape is unrecognized.
 */
function symbolFromTokenType(v: unknown): string | null {
  let typeStr: string | null = null;
  if (typeof v === 'string') typeStr = v;
  else if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
    typeStr = (v as { name: string }).name;
  }
  if (!typeStr) return null;
  const last = typeStr.split('::').pop();
  if (!last) return null;
  return last.replace(/[<>]/g, '').toUpperCase();
}

/**
 * For balance-moving events, return the atomic amount + token symbol so
 * NAV reconstruction can replay treasury inflows/outflows. Only
 * `agent_funded` (inflow) and `spend` (outflow) carry a single,
 * unambiguous (amount, token) pair; swaps move two legs and are
 * NAV-neutral at current prices, so they're intentionally excluded here.
 */
function balanceFieldsFor(
  kind: TimelineEntry['kind'],
  parsed: Record<string, unknown>,
): { amount: number; symbol: string } | null {
  if (kind !== 'agent_funded' && kind !== 'spend') return null;
  const rawAmount = parsed['amount'];
  const amount =
    typeof rawAmount === 'string' || typeof rawAmount === 'number' ? Number(rawAmount) : NaN;
  const symbol = symbolFromTokenType(parsed['token_type']);
  if (!Number.isFinite(amount) || !symbol) return null;
  return { amount, symbol };
}
