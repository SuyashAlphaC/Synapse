// Synapse Core — DeepBookV3 audit adapter.
//
// We do NOT wrap DeepBookV3's swap functions. Sui composability is best when
// every primitive is callable directly inside a PTB. Instead, Synapse provides:
//
//   1. `authorize_swap` — pre-call policy gate that asserts the agent is
//      active, the session key is signing, and the target DeepBookV3 pool
//      package is allowlisted. Returns nothing — pure assertion.
//
//   2. `record_swap` — post-call audit logger that emits `SwapEvent` once
//      the user's PTB has consumed the returned coin via the real DeepBookV3
//      call.
//
// A canonical PTB looks like:
//   1. let usdc = wallet::spend<USDC>(identity, DEEPBOOK_PKG, 100, ctx);
//   2. let sui = deepbook::pool::swap_exact_base_for_quote(pool, usdc, ...);  // real DeepBookV3
//   3. deepbook_adapter::record_swap(identity, DEEPBOOK_PKG, base_in, quote_out, ctx);
//
// This keeps Synapse decoupled from any specific DeepBookV3 version while
// still producing a full audit trail.

module synapse_core::deepbook_adapter;

use std::string::String;
use std::type_name::{Self, TypeName};
use sui::event;

use synapse_core::agent::{Self, AgentIdentity};

// === Error codes ===

const EZeroInput: u64 = 600;
const EZeroOutput: u64 = 601;

// === Events ===

public struct SwapAuthorizedEvent has copy, drop {
    agent_id: ID,
    pool_id: ID,
    deepbook_pkg: address,
    base_type: TypeName,
    quote_type: TypeName,
    direction: u8, // 0 = base->quote, 1 = quote->base
    max_input: u64,
    epoch: u64,
}

public struct SwapEvent has copy, drop {
    agent_id: ID,
    pool_id: ID,
    deepbook_pkg: address,
    base_type: TypeName,
    quote_type: TypeName,
    direction: u8,
    input_amount: u64,
    output_amount: u64,
    note: String,
    epoch: u64,
}

// === Direction discriminants ===

const DIR_BASE_TO_QUOTE: u8 = 0;
const DIR_QUOTE_TO_BASE: u8 = 1;

// === Public API ===

/// Pre-swap policy gate. Call this immediately before invoking DeepBookV3's
/// swap function in your PTB. Asserts the agent's session key, expiry, and
/// allowlist permit operating on `deepbook_pkg` with `pool_id`.
public fun authorize_swap<Base, Quote>(
    identity: &AgentIdentity,
    pool_id: ID,
    deepbook_pkg: address,
    direction: u8,
    max_input: u64,
    ctx: &TxContext,
) {
    agent::assert_can_act(identity, ctx);
    agent::assert_package_allowed(identity, deepbook_pkg);
    assert!(max_input > 0, EZeroInput);

    event::emit(SwapAuthorizedEvent {
        agent_id: object::id(identity),
        pool_id,
        deepbook_pkg,
        base_type: type_name::with_defining_ids<Base>(),
        quote_type: type_name::with_defining_ids<Quote>(),
        direction,
        max_input,
        epoch: ctx.epoch(),
    });
}

/// Post-swap audit logger. Call this after DeepBookV3 returns the swapped
/// coin. The indexer pairs this with the preceding `SwapAuthorizedEvent` to
/// confirm the swap completed within the authorized parameters.
public fun record_swap<Base, Quote>(
    identity: &AgentIdentity,
    pool_id: ID,
    deepbook_pkg: address,
    direction: u8,
    input_amount: u64,
    output_amount: u64,
    note: String,
    ctx: &TxContext,
) {
    agent::assert_can_act(identity, ctx);
    assert!(input_amount > 0, EZeroInput);
    assert!(output_amount > 0, EZeroOutput);

    event::emit(SwapEvent {
        agent_id: object::id(identity),
        pool_id,
        deepbook_pkg,
        base_type: type_name::with_defining_ids<Base>(),
        quote_type: type_name::with_defining_ids<Quote>(),
        direction,
        input_amount,
        output_amount,
        note,
        epoch: ctx.epoch(),
    });
}

// === Direction constants (for adapter ergonomics) ===

public fun direction_base_to_quote(): u8 { DIR_BASE_TO_QUOTE }
public fun direction_quote_to_base(): u8 { DIR_QUOTE_TO_BASE }
