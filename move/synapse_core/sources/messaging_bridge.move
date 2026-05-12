// Synapse Core — Sui Stack Messaging integration bridge.
//
// The actual messaging channels are managed by `MystenLabs/sui-stack-messaging`.
// Synapse only records correlation events when an agent sends or receives a
// message via its registered inbox/outbox IDs. The payloads themselves are
// Seal-encrypted blobs stored on Walrus (the messaging library handles that).
//
// Why we don't own the channel logic: keeping our package small avoids
// forking sponsor primitives. The off-chain SDK calls the messaging library
// directly and uses Synapse purely for the on-chain audit trail.

module synapse_core::messaging_bridge;

use sui::event;

use synapse_core::agent::{Self, AgentIdentity};

// === Error codes ===

const ENoMessagingChannels: u64 = 400;
const EEmptyMessageDigest: u64 = 401;

// === Events ===

public struct MessageSentEvent has copy, drop {
    sender_agent_id: ID,
    outbox_id: ID,
    message_digest: vector<u8>,
    recipient_inbox_id: ID,
    epoch: u64,
}

public struct MessageReceivedEvent has copy, drop {
    receiver_agent_id: ID,
    inbox_id: ID,
    message_digest: vector<u8>,
    sender_outbox_id: ID,
    epoch: u64,
}

// === Public API ===

/// Record that the agent sent a message to a recipient inbox. Caller must be
/// the agent's session key. Off-chain SDK is responsible for the actual
/// message delivery via Sui Stack Messaging; this is purely the audit trail.
public fun record_send(
    identity: &AgentIdentity,
    recipient_inbox_id: ID,
    message_digest: vector<u8>,
    ctx: &TxContext,
) {
    agent::assert_can_act(identity, ctx);
    assert!(message_digest.length() > 0, EEmptyMessageDigest);
    let outbox_opt = agent::messaging_outbox(identity);
    assert!(outbox_opt.is_some(), ENoMessagingChannels);

    event::emit(MessageSentEvent {
        sender_agent_id: object::id(identity),
        outbox_id: *outbox_opt.borrow(),
        message_digest,
        recipient_inbox_id,
        epoch: ctx.epoch(),
    });
}

/// Record that the agent received a message in its inbox.
public fun record_receive(
    identity: &AgentIdentity,
    sender_outbox_id: ID,
    message_digest: vector<u8>,
    ctx: &TxContext,
) {
    agent::assert_can_act(identity, ctx);
    assert!(message_digest.length() > 0, EEmptyMessageDigest);
    let inbox_opt = agent::messaging_inbox(identity);
    assert!(inbox_opt.is_some(), ENoMessagingChannels);

    event::emit(MessageReceivedEvent {
        receiver_agent_id: object::id(identity),
        inbox_id: *inbox_opt.borrow(),
        message_digest,
        sender_outbox_id,
        epoch: ctx.epoch(),
    });
}

// === Read-only views ===

public fun has_messaging(identity: &AgentIdentity): bool {
    agent::messaging_inbox(identity).is_some() && agent::messaging_outbox(identity).is_some()
}
