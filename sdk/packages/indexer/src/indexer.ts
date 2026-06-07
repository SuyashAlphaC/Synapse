/**
 * The polling indexer. Subscribes to all `synapse_core` events on a Sui
 * fullnode via `queryEvents` with `MoveModule` filters, decodes them into
 * `IndexedEvent` records, and maintains derived per-vault views.
 *
 * The v1 storage layer is in-memory — fast to ship, sufficient for the
 * Vault dashboard + Memory Inspector demos. Phase 3 replaces it with
 * Postgres behind the same interface.
 */

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { defaultNetworkConfig } from '@synapse-core/client';
import type {
  EventKind,
  EventMetadata,
  IndexedEvent,
  IndexerOptions,
  RebalanceRecord,
  VaultHoldingsSnapshot,
  VaultTimelineEntry,
} from './types.js';

const MODULES_OF_INTEREST = [
  'agent',
  'wallet',
  'artifacts',
  'coordination',
  'messaging_bridge',
  'attestation',
  'deepbook_adapter',
] as const;

/**
 * Map a fully-qualified Move event type to a `kind` discriminant.
 * Format example: `0x…::agent::AgentMintedEvent`.
 */
function classifyEventType(type: string): EventKind | null {
  if (type.endsWith('::agent::AgentMintedEvent')) return 'agent_minted';
  if (type.endsWith('::agent::AgentRevokedEvent')) return 'agent_revoked';
  if (type.endsWith('::agent::AgentFundedEvent')) return 'agent_funded';
  if (type.endsWith('::wallet::SpendEvent')) return 'spend';
  if (type.endsWith('::artifacts::ArtifactPublishedEvent')) return 'artifact_published';
  if (type.endsWith('::coordination::CrossAgentReadEvent')) return 'cross_agent_read';
  if (type.endsWith('::messaging_bridge::MessageSentEvent')) return 'message_sent';
  if (type.endsWith('::messaging_bridge::MessageReceivedEvent')) return 'message_received';
  if (type.endsWith('::deepbook_adapter::SwapEvent')) return 'swap';
  if (type.endsWith('::attestation::ActionLogEvent')) return 'action_log';
  return null;
}

export class SynapseIndexer {
  readonly options: Required<Pick<IndexerOptions, 'network' | 'packageId' | 'pollIntervalMs' | 'pageSize'>> & {
    fullnodeUrl: string;
  };
  private readonly client: SuiJsonRpcClient;
  /** Most recent event cursor per module, used for incremental polls. */
  private readonly cursors = new Map<string, { txDigest: string; eventSeq: string }>();
  /** Flat in-memory event log, append-only, oldest-first. */
  private readonly events: IndexedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: IndexerOptions) {
    const networkDefaults = defaultNetworkConfig(options.network);
    const fullnodeUrl =
      options.fullnodeUrl ?? networkDefaults.fullnodeUrl ?? getJsonRpcFullnodeUrl(options.network);
    this.options = {
      network: options.network,
      packageId: options.packageId,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
      pageSize: options.pageSize ?? 50,
      fullnodeUrl,
    };
    this.client = new SuiJsonRpcClient({ url: fullnodeUrl, network: options.network });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error('[synapse-indexer] poll failed:', err);
      }
      if (this.running) {
        this.timer = setTimeout(tick, this.options.pollIntervalMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  async pollOnce(): Promise<number> {
    let total = 0;
    for (const mod of MODULES_OF_INTEREST) {
      total += await this.pollModule(mod);
    }
    return total;
  }

  private async pollModule(module: string): Promise<number> {
    const cursor = this.cursors.get(module) ?? null;
    const result = await this.client.queryEvents({
      query: {
        MoveModule: { package: this.options.packageId, module },
      },
      cursor,
      limit: this.options.pageSize,
      order: 'ascending',
    });

    let appended = 0;
    for (const ev of result.data) {
      const kind = classifyEventType(ev.type);
      if (!kind) continue;
      const indexed = this.normalize(kind, ev);
      if (!indexed) continue;
      this.events.push(indexed);
      appended++;
    }

    if (result.nextCursor) {
      this.cursors.set(module, {
        txDigest: result.nextCursor.txDigest,
        eventSeq: result.nextCursor.eventSeq,
      });
    }
    return appended;
  }

  private normalize(kind: EventKind, ev: unknown): IndexedEvent | null {
    // Sui RPC returns the Move event payload under `parsedJson` using the
    // on-chain (snake_case) field names, with u64 as decimal strings, vector<u8>
    // as number[], and TypeName as `{ name }`. We decode each kind explicitly
    // into the camelCase / bigint / Uint8Array shape the rest of the package
    // expects. A blanket cast (the previous behavior) left every field
    // mis-named and mis-typed, so all vault filters silently matched nothing.
    const e = ev as {
      id: { txDigest: string; eventSeq: string };
      timestampMs?: string | null;
      parsedJson: Record<string, unknown>;
    };
    const meta: EventMetadata = {
      txDigest: e.id.txDigest,
      eventSeq: BigInt(e.id.eventSeq),
      timestampMs: BigInt(e.timestampMs ?? '0'),
      checkpoint: 0n,
    };
    const payload = decodePayload(kind, e.parsedJson ?? {});
    if (!payload) return null;
    return { kind, payload, meta } as IndexedEvent;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** All events, oldest first. */
  allEvents(): readonly IndexedEvent[] {
    return this.events;
  }

  /** Per-vault timeline derived from raw events. */
  vaultTimeline(vaultId: string): VaultTimelineEntry[] {
    const entries: VaultTimelineEntry[] = [];
    for (const e of this.events) {
      const entry = projectTimelineEntry(vaultId, e);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Holdings snapshot derived by replaying funded/spend events. */
  holdings(vaultId: string): VaultHoldingsSnapshot {
    const balances: Record<string, bigint> = {};
    let artifactCount = 0n;
    let asOfTimestampMs = 0n;
    let asOfCheckpoint = 0n;
    for (const e of this.events) {
      switch (e.kind) {
        case 'agent_funded':
          if (e.payload.agentId === vaultId) {
            const k = e.payload.tokenType;
            balances[k] = (balances[k] ?? 0n) + e.payload.amount;
          }
          break;
        case 'spend':
          if (e.payload.agentId === vaultId) {
            const k = e.payload.tokenType;
            balances[k] = (balances[k] ?? 0n) - e.payload.amount;
          }
          break;
        case 'artifact_published':
          if (e.payload.agentId === vaultId) artifactCount += 1n;
          break;
        default:
          break;
      }
      asOfTimestampMs = bigintMax(asOfTimestampMs, e.meta.timestampMs);
      asOfCheckpoint = bigintMax(asOfCheckpoint, e.meta.checkpoint);
    }
    return { vaultId, balances, artifactCount, asOfTimestampMs, asOfCheckpoint };
  }

  /** Recent rebalances (joins swap events with subsequent artifact pubs). */
  rebalances(vaultId: string): RebalanceRecord[] {
    const records: RebalanceRecord[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (!e) continue;
      if (e.kind !== 'swap') continue;
      if (e.payload.agentId !== vaultId) continue;
      const followup = findArtifactPublishAfter(this.events, i, vaultId);
      const record: RebalanceRecord = {
        vaultId,
        planId: e.payload.note,
        txDigest: e.meta.txDigest,
        timestampMs: e.meta.timestampMs,
        baseType: e.payload.baseType,
        quoteType: e.payload.quoteType,
        direction: e.payload.direction,
        inputAmount: e.payload.inputAmount,
        outputAmount: e.payload.outputAmount,
      };
      if (followup) {
        record.reportArtifactSlot = followup.payload.artifactSlot;
        record.reportWalrusBlobId = utf8(followup.payload.walrusBlobId);
      }
      records.push(record);
    }
    return records;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectTimelineEntry(
  vaultId: string,
  e: IndexedEvent,
): VaultTimelineEntry | null {
  const meta = { txDigest: e.meta.txDigest, timestampMs: e.meta.timestampMs };
  switch (e.kind) {
    case 'agent_minted':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Vault minted by ${e.payload.owner}, session ${shortenAddr(e.payload.sessionAddr)}`,
        ...meta,
      };
    case 'agent_revoked':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Vault revoked at epoch ${e.payload.revokedAtEpoch}`,
        ...meta,
      };
    case 'agent_funded':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Funded ${e.payload.amount} of ${shortenType(e.payload.tokenType)}`,
        amount: e.payload.amount,
        tokenType: e.payload.tokenType,
        ...meta,
      };
    case 'spend':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Spent ${e.payload.amount} ${shortenType(e.payload.tokenType)} → ${shortenAddr(e.payload.targetPkg)}`,
        amount: e.payload.amount,
        tokenType: e.payload.tokenType,
        counterparty: e.payload.targetPkg,
        ...meta,
      };
    case 'artifact_published':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Artifact #${e.payload.artifactSlot} published (${e.payload.label})`,
        walrusBlobId: utf8(e.payload.walrusBlobId),
        artifactSlot: e.payload.artifactSlot,
        ...meta,
      };
    case 'cross_agent_read':
      if (e.payload.readerId !== vaultId && e.payload.writerId !== vaultId) return null;
      if (e.payload.writerId === vaultId) {
        return {
          vaultId,
          kind: 'cross_agent_write',
          description: `Peer ${shortenAddr(e.payload.readerId)} read your MemWal memory`,
          counterparty: e.payload.readerId,
          ...meta,
        };
      }
      return {
        vaultId,
        kind: e.kind,
        description: `Cross-agent MemWal read from writer ${shortenAddr(e.payload.writerId)}`,
        counterparty: e.payload.writerId,
        ...meta,
      };
    case 'message_sent':
      if (e.payload.senderAgentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Message sent → ${shortenAddr(e.payload.recipientInboxId)}`,
        counterparty: e.payload.recipientInboxId,
        ...meta,
      };
    case 'message_received':
      if (e.payload.receiverAgentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Message received ← ${shortenAddr(e.payload.senderOutboxId)}`,
        counterparty: e.payload.senderOutboxId,
        ...meta,
      };
    case 'swap':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: `Swap ${e.payload.inputAmount} ${shortenType(e.payload.baseType)} → ${e.payload.outputAmount} ${shortenType(e.payload.quoteType)}`,
        amount: e.payload.inputAmount,
        ...meta,
      };
    case 'action_log':
      if (e.payload.agentId !== vaultId) return null;
      return {
        vaultId,
        kind: e.kind,
        description: e.payload.description,
        ...meta,
      };
  }
}

function findArtifactPublishAfter(
  events: readonly IndexedEvent[],
  startIdx: number,
  vaultId: string,
): { payload: import('@synapse-core/client').ArtifactPublishedEvent } | null {
  // Look up to 4 events after the swap for an artifact publish from the same vault.
  for (let i = startIdx + 1; i < Math.min(events.length, startIdx + 5); i++) {
    const e = events[i];
    if (!e || e.kind !== 'artifact_published') continue;
    if (e.payload.agentId !== vaultId) continue;
    return { payload: e.payload };
  }
  return null;
}

// ---------------------------------------------------------------------------
// parsedJson decoding (snake_case Move payload -> typed camelCase event)
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string' && v.trim() !== '') return BigInt(v);
  return 0n;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function boolean(v: unknown): boolean {
  return v === true || v === 'true';
}

/** vector<u8> arrives as number[]; tolerate Uint8Array / base64-ish string. */
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return new Uint8Array();
}

/** Move `TypeName` renders as `{ name: "addr::mod::Struct" }` (or a bare string). */
function typeName(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).name);
  }
  return v == null ? '' : String(v);
}

function decodePayload(kind: EventKind, p: Record<string, unknown>): IndexedEvent['payload'] | null {
  switch (kind) {
    case 'agent_minted':
      return {
        agentId: str(p.agent_id),
        owner: str(p.owner),
        sessionAddr: str(p.session_addr),
        expiryEpoch: big(p.expiry_epoch),
        spendPerEpoch: big(p.spend_per_epoch),
        memwalNamespace: bytes(p.memwal_namespace),
        strategyId: str(p.strategy_id),
      };
    case 'agent_revoked':
      return {
        agentId: str(p.agent_id),
        owner: str(p.owner),
        memwalDelegateKeyId: bytes(p.memwal_delegate_key_id),
        revokedAtEpoch: big(p.revoked_at_epoch),
      };
    case 'agent_funded':
      return {
        agentId: str(p.agent_id),
        tokenType: typeName(p.token_type),
        amount: big(p.amount),
      };
    case 'spend':
      return {
        agentId: str(p.agent_id),
        targetPkg: str(p.target_pkg),
        tokenType: typeName(p.token_type),
        amount: big(p.amount),
        epoch: big(p.epoch),
        remainingBudget: big(p.remaining_budget),
      };
    case 'artifact_published':
      return {
        agentId: str(p.agent_id),
        artifactSlot: big(p.artifact_slot),
        walrusBlobId: bytes(p.walrus_blob_id),
        sha256: bytes(p.sha256),
        mimeType: str(p.mime_type),
        sizeBytes: big(p.size_bytes),
        label: str(p.label),
        sealEncrypted: boolean(p.seal_encrypted),
        epoch: big(p.epoch),
      };
    case 'cross_agent_read':
      return {
        readerId: str(p.reader_id),
        writerId: str(p.writer_id),
        namespace: bytes(p.namespace),
        memwalMemoryId: bytes(p.memwal_memory_id),
        epoch: big(p.epoch),
      };
    case 'message_sent':
      return {
        senderAgentId: str(p.sender_agent_id),
        outboxId: str(p.outbox_id),
        messageDigest: bytes(p.message_digest),
        recipientInboxId: str(p.recipient_inbox_id),
        epoch: big(p.epoch),
      };
    case 'message_received':
      return {
        receiverAgentId: str(p.receiver_agent_id),
        inboxId: str(p.inbox_id),
        messageDigest: bytes(p.message_digest),
        senderOutboxId: str(p.sender_outbox_id),
        epoch: big(p.epoch),
      };
    case 'swap':
      return {
        agentId: str(p.agent_id),
        poolId: str(p.pool_id),
        deepbookPkg: str(p.deepbook_pkg),
        baseType: typeName(p.base_type),
        quoteType: typeName(p.quote_type),
        direction: num(p.direction),
        inputAmount: big(p.input_amount),
        outputAmount: big(p.output_amount),
        note: str(p.note),
        epoch: big(p.epoch),
      };
    case 'action_log':
      return {
        agentId: str(p.agent_id),
        kind: num(p.kind),
        description: str(p.description),
        payloadHash: bytes(p.payload_hash),
        epoch: big(p.epoch),
      };
    default:
      return null;
  }
}

function shortenAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

function shortenType(t: string): string {
  const last = t.split('::').pop();
  return last ?? t;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
