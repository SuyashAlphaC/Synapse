/**
 * Indexer types. These mirror the on-chain event shapes from
 * `move/synapse_core/sources/*.move` but normalize them into a single
 * timeline-friendly representation.
 */

import type {
  AgentMintedEvent,
  AgentRevokedEvent,
  AgentFundedEvent,
  SpendEvent,
  ArtifactPublishedEvent,
  CrossAgentReadEvent,
  MessageSentEvent,
  MessageReceivedEvent,
  SwapEvent,
  ActionLogEvent,
  SuiNetwork,
} from '@synapse-core/client';

export type EventKind =
  | 'agent_minted'
  | 'agent_revoked'
  | 'agent_funded'
  | 'spend'
  | 'artifact_published'
  | 'cross_agent_read'
  | 'message_sent'
  | 'message_received'
  | 'swap'
  | 'action_log';

/** Discriminated union of every event the indexer is aware of. */
export type IndexedEvent =
  | { kind: 'agent_minted'; payload: AgentMintedEvent; meta: EventMetadata }
  | { kind: 'agent_revoked'; payload: AgentRevokedEvent; meta: EventMetadata }
  | { kind: 'agent_funded'; payload: AgentFundedEvent; meta: EventMetadata }
  | { kind: 'spend'; payload: SpendEvent; meta: EventMetadata }
  | { kind: 'artifact_published'; payload: ArtifactPublishedEvent; meta: EventMetadata }
  | { kind: 'cross_agent_read'; payload: CrossAgentReadEvent; meta: EventMetadata }
  | { kind: 'message_sent'; payload: MessageSentEvent; meta: EventMetadata }
  | { kind: 'message_received'; payload: MessageReceivedEvent; meta: EventMetadata }
  | { kind: 'swap'; payload: SwapEvent; meta: EventMetadata }
  | { kind: 'action_log'; payload: ActionLogEvent; meta: EventMetadata };

export interface EventMetadata {
  /** Sui transaction digest. */
  txDigest: string;
  /** Event index within the tx. */
  eventSeq: bigint;
  /** Timestamp in ms (from event timestampMs when available). */
  timestampMs: bigint;
  /** Sui checkpoint sequence (monotonic ordering). */
  checkpoint: bigint;
}

export interface IndexerOptions {
  network: SuiNetwork;
  /** Deployed `synapse_core` package ID — used as the event filter target. */
  packageId: string;
  /** Override fullnode URL. Defaults to the network's canonical fullnode. */
  fullnodeUrl?: string;
  /** Polling interval in ms. Default 2000. */
  pollIntervalMs?: number;
  /** Page size per RPC query. Default 50. */
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Vault-centric views (derived from raw events)
// ---------------------------------------------------------------------------

/** Kinds surfaced on per-vault audit timelines (may differ from raw IndexedEvent kinds). */
export type VaultTimelineKind = EventKind | 'cross_agent_write';

/** A single point on the vault audit timeline. */
export interface VaultTimelineEntry {
  vaultId: string;
  kind: VaultTimelineKind;
  txDigest: string;
  timestampMs: bigint;
  description: string;
  /** Optional pointers the dashboard uses to render links. */
  walrusBlobId?: string;
  artifactSlot?: bigint;
  amount?: bigint;
  tokenType?: string;
  counterparty?: string;
}

/** Holdings snapshot derived from running spend/deposit events forward. */
export interface VaultHoldingsSnapshot {
  vaultId: string;
  asOfTimestampMs: bigint;
  asOfCheckpoint: bigint;
  /** Per coin-type balance in raw atomic units. */
  balances: Record<string, bigint>;
  /** Number of artifacts published lifetime. */
  artifactCount: bigint;
}

/** Rebalance summary derived from a SwapEvent + adjacent ActionLogEvent. */
export interface RebalanceRecord {
  vaultId: string;
  planId: string;
  txDigest: string;
  timestampMs: bigint;
  baseType: string;
  quoteType: string;
  direction: number;
  inputAmount: bigint;
  outputAmount: bigint;
  reportArtifactSlot?: bigint;
  reportWalrusBlobId?: string;
}
