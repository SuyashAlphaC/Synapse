/**
 * TypeScript mirrors of the Move types and event payloads in
 * `move/synapse_core/`. Keep these in lockstep with the Move source — every
 * field name, every enum value, every error code must match.
 *
 * Move source of truth: `move/synapse_core/sources/*.move`
 */

/**
 * A reference to a Sui object: object ID, version, and content digest.
 * Mirrors the standard Sui-SDK shape without importing from a specific
 * subpackage so callers don't have to chase BCS types.
 */
export interface SuiObjectRef {
  objectId: string;
  version: string;
  digest: string;
}

// =============================================================================
// On-chain object types (from agent.move)
// =============================================================================

/**
 * The `AgentIdentity` shared object — Synapse's central primitive.
 *
 * Fields mirror `synapse_core::agent::AgentIdentity` exactly. `treasury` and
 * `artifacts` (dynamic fields) are not loaded into this type by default;
 * fetch them separately via dedicated views.
 */
export interface AgentIdentity {
  /** Sui object ID. */
  id: string;
  /** Address of the human zkLogin parent. */
  owner: string;
  /** Address of the agent's ephemeral session keypair. */
  sessionAddr: string;
  /** Epoch number after which the agent is considered expired. */
  expiryEpoch: bigint;
  /** Per-epoch spend cap in raw atomic units. */
  spendPerEpoch: bigint;
  /** Amount already spent this epoch (resets at epoch boundary). */
  spentThisEpoch: bigint;
  /** Last epoch the spend counter was synced against. */
  lastEpochSeen: bigint;
  /** Allowlisted contract package addresses. */
  approvedPackages: string[];
  /** Raw MemWal account ID bytes. */
  memwalAccountId: Uint8Array;
  /** Raw MemWal delegate-key identifier bytes. */
  memwalDelegateKeyId: Uint8Array;
  /** Raw MemWal namespace bytes. */
  memwalNamespace: Uint8Array;
  /** Monotonically increasing artifact slot counter. */
  nextArtifactId: bigint;
  /** Number of live artifacts currently registered. */
  artifactCount: bigint;
  /** Sui Stack Messaging inbox channel ID (if attached). */
  messagingInbox: string | null;
  /** Sui Stack Messaging outbox channel ID (if attached). */
  messagingOutbox: string | null;
  /** Soft-kill switch. Once true, all session-key actions abort. */
  revoked: boolean;
  /** Strategy registry ID this vault was minted against. */
  strategyId: string;
}

// =============================================================================
// Strategy marketplace types (from strategy_registry.move)
// =============================================================================

export const RiskProfile = {
  Conservative: 0,
  Balanced: 1,
  Aggressive: 2,
} as const;

export type RiskProfileValue = (typeof RiskProfile)[keyof typeof RiskProfile];

/**
 * On-chain `Strategy` object — the marketplace's catalog entry plus its
 * lifetime reputation. Mirrors `synapse_core::strategy_registry::Strategy`.
 */
export interface Strategy {
  id: string;
  strategist: string;
  name: string;
  description: string;
  /** 32-byte commitment to the runtime code (hex-encoded with 0x prefix). */
  codeHash: string;
  /** Walrus blob ID of the source / docs (UTF-8 decoded). */
  sourceWalrusBlob: string;
  riskProfile: RiskProfileValue;
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

export interface StrategyPublishedEvent {
  strategyId: string;
  strategist: string;
  name: string;
  codeHash: Uint8Array;
  riskProfile: number;
  royaltyBps: number;
}

export interface VaultAdoptedEvent {
  strategyId: string;
  vaultId: string;
  aumCommitted: bigint;
}

export interface VaultRevokedFromStrategyEvent {
  strategyId: string;
  vaultId: string;
}

export interface TickRecordedEvent {
  strategyId: string;
  vaultId: string;
  alphaBpsPos: bigint;
  alphaBpsNeg: bigint;
  epoch: bigint;
}

export interface RoyaltyPaidEvent {
  strategyId: string;
  vaultId: string;
  strategist: string;
  amount: bigint;
  coinType: string;
}

/**
 * Mirror of `synapse_core::artifacts::ArtifactRef`. Stored as a dynamic field
 * on the AgentIdentity UID, keyed by `u64` slot.
 */
export interface ArtifactRef {
  /** Walrus blob ID bytes (as returned by the Walrus client). */
  walrusBlobId: Uint8Array;
  /** SHA256 of the payload (32 bytes). */
  sha256: Uint8Array;
  /** MIME type, e.g. `text/markdown`. */
  mimeType: string;
  /** Payload size in bytes. */
  sizeBytes: bigint;
  /** Epoch at which the artifact was registered on-chain. */
  createdAtEpoch: bigint;
  /** Whether the Walrus blob is Seal-encrypted. */
  sealEncrypted: boolean;
  /** Human-readable label for dashboards / Memory Inspector. */
  label: string;
}

// =============================================================================
// Event payloads (from each module)
// =============================================================================

export interface AgentMintedEvent {
  agentId: string;
  owner: string;
  sessionAddr: string;
  expiryEpoch: bigint;
  spendPerEpoch: bigint;
  memwalNamespace: Uint8Array;
  strategyId: string;
}

export interface AgentRevokedEvent {
  agentId: string;
  owner: string;
  memwalDelegateKeyId: Uint8Array;
  revokedAtEpoch: bigint;
}

export interface AgentFundedEvent {
  agentId: string;
  tokenType: string;
  amount: bigint;
}

export interface SessionKeyRotatedEvent {
  agentId: string;
  oldSessionAddr: string;
  newSessionAddr: string;
  rotatedAtEpoch: bigint;
}

export interface ExpiryExtendedEvent {
  agentId: string;
  oldExpiryEpoch: bigint;
  newExpiryEpoch: bigint;
}

export interface MessagingAttachedEvent {
  agentId: string;
  inbox: string;
  outbox: string;
}

export interface SpendEvent {
  agentId: string;
  targetPkg: string;
  tokenType: string;
  amount: bigint;
  epoch: bigint;
  remainingBudget: bigint;
}

export interface WithdrawEvent {
  agentId: string;
  tokenType: string;
  amount: bigint;
  to: string;
}

export interface ArtifactPublishedEvent {
  agentId: string;
  artifactSlot: bigint;
  walrusBlobId: Uint8Array;
  sha256: Uint8Array;
  mimeType: string;
  sizeBytes: bigint;
  label: string;
  sealEncrypted: boolean;
  epoch: bigint;
}

export interface ArtifactBurnedEvent {
  agentId: string;
  artifactSlot: bigint;
  walrusBlobId: Uint8Array;
  epoch: bigint;
}

export interface CrossAgentReadEvent {
  readerId: string;
  writerId: string;
  namespace: Uint8Array;
  memwalMemoryId: Uint8Array;
  epoch: bigint;
}

export interface ArtifactSharedEvent {
  readerId: string;
  writerId: string;
  writerArtifactSlot: bigint;
  namespace: Uint8Array;
  epoch: bigint;
}

export interface MessageSentEvent {
  senderAgentId: string;
  outboxId: string;
  messageDigest: Uint8Array;
  recipientInboxId: string;
  epoch: bigint;
}

export interface MessageReceivedEvent {
  receiverAgentId: string;
  inboxId: string;
  messageDigest: Uint8Array;
  senderOutboxId: string;
  epoch: bigint;
}

export interface ActionLogEvent {
  agentId: string;
  kind: number;
  description: string;
  payloadHash: Uint8Array;
  epoch: bigint;
}

export interface SwapAuthorizedEvent {
  agentId: string;
  poolId: string;
  deepbookPkg: string;
  baseType: string;
  quoteType: string;
  direction: number;
  maxInput: bigint;
  epoch: bigint;
}

export interface SwapEvent {
  agentId: string;
  poolId: string;
  deepbookPkg: string;
  baseType: string;
  quoteType: string;
  direction: number;
  inputAmount: bigint;
  outputAmount: bigint;
  note: string;
  epoch: bigint;
}

// =============================================================================
// Action kind discriminants (from attestation.move)
// =============================================================================

export const ActionKind = {
  Spend: 1,
  MemoryWrite: 2,
  MemoryRecall: 3,
  ArtifactPublish: 4,
  ArtifactFetch: 5,
  MessageSend: 6,
  MessageReceive: 7,
  DeepBookSwap: 8,
  LlmCall: 9,
  Custom: 255,
} as const;

export type ActionKindValue = (typeof ActionKind)[keyof typeof ActionKind];

// =============================================================================
// Swap direction (from deepbook_adapter.move)
// =============================================================================

export const SwapDirection = {
  BaseToQuote: 0,
  QuoteToBase: 1,
} as const;

export type SwapDirectionValue = (typeof SwapDirection)[keyof typeof SwapDirection];

// =============================================================================
// Error codes
// =============================================================================

/**
 * Move abort codes by module. Module IDs are encoded into Sui's
 * `MoveAbort` errors so callers can route specific failures to UI messages.
 */
export const SynapseErrorCode = {
  // agent.move (0–99)
  NotOwner: 0,
  NotAuthorized: 1,
  Expired: 2,
  Revoked: 3,
  NotWhitelisted: 4,
  OverBudget: 5,
  AlreadyRevoked: 8,
  InvalidExpiry: 9,
  ZeroSpend: 10,
  MessagingAlreadySet: 11,
  StrategyMismatch: 12,
  InsufficientBalance: 13,
  // strategy_registry.move (50–69)
  StrategyNotStrategist: 50,
  StrategyBadRiskProfile: 51,
  StrategyInactive: 52,
  StrategyEmptyName: 53,
  StrategyMaxRoyaltyExceeded: 54,
  // wallet.move (100–199)
  InsufficientFunds: 100,
  TokenNotFound: 101,
  ZeroAmount: 102,
  // artifacts.move (200–299)
  ArtifactNotFound: 200,
  EmptyBlobId: 201,
  EmptyHash: 202,
  ZeroSize: 203,
  PermissionDenied: 204,
  // coordination.move (300–399)
  NamespaceMismatch: 300,
  WriterRevoked: 301,
  EmptyMemoryId: 302,
  // messaging_bridge.move (400–499)
  NoMessagingChannels: 400,
  EmptyMessageDigest: 401,
  // attestation.move (500–599)
  EmptyKind: 500,
  EmptyPayload: 501,
  // deepbook_adapter.move (600–699)
  ZeroInput: 600,
  ZeroOutput: 601,
} as const;

export type SynapseErrorCodeValue =
  (typeof SynapseErrorCode)[keyof typeof SynapseErrorCode];

// =============================================================================
// Network + module identifiers
// =============================================================================

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

/**
 * Per-network configuration: the published package ID of `synapse_core` plus
 * environment-specific service URLs (Walrus aggregators, MemWal relayer).
 */
export interface SynapseNetworkConfig {
  network: SuiNetwork;
  /** Deployed `synapse_core` package ID. Use `0x0` only during pre-deploy. */
  synapseCorePackageId: string;
  /** Sui full-node RPC URL. */
  fullnodeUrl: string;
  /** Walrus aggregator (read) URL. */
  walrusAggregatorUrl: string;
  /** Walrus publisher (write) URL. */
  walrusPublisherUrl: string;
  /** MemWal relayer URL. */
  memwalRelayerUrl: string;
}

// =============================================================================
// PTB builder shared types
// =============================================================================

/**
 * Common context passed into PTB builders so they can construct module calls
 * against the right package. The `tx` field is injected by the caller's PTB.
 */
export interface PTBContext {
  packageId: string;
}

/**
 * The hot-potato shape returned by `agent::new`. Once consumed (by `share`,
 * `fund`, or another internal mutator) it ceases to exist.
 */
export type AgentIdentityHotPotato = SuiObjectRef;

/**
 * Inputs to mint a fresh AgentIdentity. All fields map 1:1 to the Move
 * function signature in `agent::new`. Vectors are accepted as `Uint8Array`
 * for binary fields and arrays of strings for `approvedPackages`.
 */
export interface MintAgentInput {
  /** ID of a published `Strategy` to bind this vault to. */
  strategyId: string;
  sessionAddr: string;
  expiryEpoch: bigint;
  spendPerEpoch: bigint;
  approvedPackages: string[];
  memwalAccountId: Uint8Array;
  memwalDelegateKeyId: Uint8Array;
  memwalNamespace: Uint8Array;
}
