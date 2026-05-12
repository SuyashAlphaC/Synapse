// Synapse Core — Unified attestation log.
//
// Modules in this package emit their own typed events (SpendEvent,
// ArtifactPublishedEvent, MessageSentEvent, etc.) for type-safe indexing.
// In addition, every meaningful action also emits a generic `ActionLogEvent`
// here, giving the indexer a single stream to subscribe to for forensic
// audit views without enumerating every event type.
//
// Adapters (LangGraph, Claude Agent SDK, Eliza) call `log_action` after
// non-on-chain actions (e.g., an LLM inference call paid for via `wallet::spend`)
// so the audit trail reflects the full agent decision graph, not just what
// the Move VM saw natively.

module synapse_core::attestation;

use std::string::String;
use sui::event;

use synapse_core::agent::{Self, AgentIdentity};

// === Error codes ===

const EEmptyKind: u64 = 500;
const EEmptyPayload: u64 = 501;

// === Action kind discriminants (kept as u8 constants for indexer convenience) ===

const KIND_SPEND: u8 = 1;
const KIND_MEMORY_WRITE: u8 = 2;
const KIND_MEMORY_RECALL: u8 = 3;
const KIND_ARTIFACT_PUBLISH: u8 = 4;
const KIND_ARTIFACT_FETCH: u8 = 5;
const KIND_MESSAGE_SEND: u8 = 6;
const KIND_MESSAGE_RECEIVE: u8 = 7;
const KIND_DEEPBOOK_SWAP: u8 = 8;
const KIND_LLM_CALL: u8 = 9;
const KIND_CUSTOM: u8 = 255;

// === Events ===

/// Generic action log entry. The `kind` discriminant tells the indexer how
/// to deserialize `payload_hash`. Event ordering is recovered from Sui's
/// natural (checkpoint, tx_digest, event_idx) tuple in the indexer.
public struct ActionLogEvent has copy, drop {
    agent_id: ID,
    kind: u8,
    description: String,
    payload_hash: vector<u8>,
    epoch: u64,
}

// === Public API ===

/// Log an action against the agent's session key. Use one of the KIND_*
/// constants for `kind`. `payload_hash` is the SHA256 of the action's input
/// or output; `description` is a short human-readable label for the dashboard.
public fun log_action(
    identity: &AgentIdentity,
    kind: u8,
    description: String,
    payload_hash: vector<u8>,
    ctx: &TxContext,
) {
    agent::assert_can_act(identity, ctx);
    assert!(kind > 0, EEmptyKind);
    assert!(payload_hash.length() > 0, EEmptyPayload);

    event::emit(ActionLogEvent {
        agent_id: object::id(identity),
        kind,
        description,
        payload_hash,
        epoch: ctx.epoch(),
    });
}

/// Owner-side log (e.g., for governance actions not gated by session key).
public fun log_owner_action(
    identity: &AgentIdentity,
    kind: u8,
    description: String,
    payload_hash: vector<u8>,
    ctx: &TxContext,
) {
    agent::assert_owner(identity, ctx);
    assert!(kind > 0, EEmptyKind);
    assert!(payload_hash.length() > 0, EEmptyPayload);

    event::emit(ActionLogEvent {
        agent_id: object::id(identity),
        kind,
        description,
        payload_hash,
        epoch: ctx.epoch(),
    });
}

// === Kind constants (re-exported for adapters) ===

public fun kind_spend(): u8 { KIND_SPEND }
public fun kind_memory_write(): u8 { KIND_MEMORY_WRITE }
public fun kind_memory_recall(): u8 { KIND_MEMORY_RECALL }
public fun kind_artifact_publish(): u8 { KIND_ARTIFACT_PUBLISH }
public fun kind_artifact_fetch(): u8 { KIND_ARTIFACT_FETCH }
public fun kind_message_send(): u8 { KIND_MESSAGE_SEND }
public fun kind_message_receive(): u8 { KIND_MESSAGE_RECEIVE }
public fun kind_deepbook_swap(): u8 { KIND_DEEPBOOK_SWAP }
public fun kind_llm_call(): u8 { KIND_LLM_CALL }
public fun kind_custom(): u8 { KIND_CUSTOM }
