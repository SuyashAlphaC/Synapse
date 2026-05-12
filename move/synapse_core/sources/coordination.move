// Synapse Core — Multi-agent coordination capability gates.
//
// When two agents share a MemWal namespace, this module records cross-agent
// reads and enforces namespace consistency. Reading another agent's memory
// requires:
//   1. Both agents share the same MemWal namespace.
//   2. The reader is not revoked, not expired, and the session key is signing.
//
// We emit `CrossAgentReadEvent` so the indexer can render the agent-to-agent
// dependency graph in the Memory Inspector dev tool.

module synapse_core::coordination;

use sui::event;

use synapse_core::agent::{Self, AgentIdentity};

// === Error codes ===

const ENamespaceMismatch: u64 = 300;
const EWriterRevoked: u64 = 301;
const EEmptyMemoryId: u64 = 302;

// === Events ===

public struct CrossAgentReadEvent has copy, drop {
    reader_id: ID,
    writer_id: ID,
    namespace: vector<u8>,
    memwal_memory_id: vector<u8>,
    epoch: u64,
}

public struct ArtifactSharedEvent has copy, drop {
    reader_id: ID,
    writer_id: ID,
    writer_artifact_slot: u64,
    namespace: vector<u8>,
    epoch: u64,
}

// === Public API ===

/// Assert two agents share the same MemWal namespace. Used as a precondition
/// before any cross-agent read or artifact handoff.
public fun assert_shared_namespace(reader: &AgentIdentity, writer: &AgentIdentity) {
    assert!(
        agent::memwal_namespace(reader) == agent::memwal_namespace(writer),
        ENamespaceMismatch,
    );
}

/// Record that the reader fetched a MemWal memory written by the writer.
/// Caller must be the reader's session key. Writer must not be revoked
/// (an artifact from a revoked agent is suspect).
public fun record_cross_agent_read(
    reader: &AgentIdentity,
    writer: &AgentIdentity,
    memwal_memory_id: vector<u8>,
    ctx: &TxContext,
) {
    agent::assert_can_act(reader, ctx);
    assert_shared_namespace(reader, writer);
    assert!(!agent::is_revoked(writer), EWriterRevoked);
    assert!(memwal_memory_id.length() > 0, EEmptyMemoryId);

    event::emit(CrossAgentReadEvent {
        reader_id: object::id(reader),
        writer_id: object::id(writer),
        namespace: *agent::memwal_namespace(reader),
        memwal_memory_id,
        epoch: ctx.epoch(),
    });
}

/// Record that the reader consumed a Walrus artifact produced by the writer.
/// Pairs with `artifacts::borrow` to give the indexer a full handoff record.
public fun record_artifact_share(
    reader: &AgentIdentity,
    writer: &AgentIdentity,
    writer_artifact_slot: u64,
    ctx: &TxContext,
) {
    agent::assert_can_act(reader, ctx);
    assert_shared_namespace(reader, writer);
    assert!(!agent::is_revoked(writer), EWriterRevoked);

    event::emit(ArtifactSharedEvent {
        reader_id: object::id(reader),
        writer_id: object::id(writer),
        writer_artifact_slot,
        namespace: *agent::memwal_namespace(reader),
        epoch: ctx.epoch(),
    });
}

// === Read-only views ===

public fun share_namespace(reader: &AgentIdentity, writer: &AgentIdentity): bool {
    agent::memwal_namespace(reader) == agent::memwal_namespace(writer)
}
