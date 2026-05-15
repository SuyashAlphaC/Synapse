// Synapse Core — AgentIdentity spine module.
//
// `AgentIdentity` is the central Sui object that anchors an autonomous AI agent
// to its human zkLogin parent and binds together five subsystems:
//   1. Identity      — session_addr, expiry, owner
//   2. Wallet        — Bag treasury, spend policy, contract allowlist
//   3. MemWal bridge — delegate key reference + namespace
//   4. Artifacts     — Walrus blob registry (stored as dynamic fields)
//   5. Messaging     — optional Sui Stack Messaging channel IDs
//
// Other modules (wallet, artifacts, messaging_bridge, coordination, attestation,
// deepbook_adapter) read and mutate state through the package-visible helpers
// defined at the bottom of this file. This keeps `AgentIdentity` the single
// source of truth and makes the revocation cascade enforceable.

module synapse_core::agent;

use std::type_name::{Self, TypeName};
use sui::bag::{Self, Bag};
use sui::balance;
use sui::coin;
use sui::event;
use synapse_core::strategy_registry::{Self, Strategy};

// === Error codes ===

const ENotOwner: u64 = 0;
const ENotAuthorized: u64 = 1;
const EExpired: u64 = 2;
const ERevoked: u64 = 3;
const ENotWhitelisted: u64 = 4;
const EOverBudget: u64 = 5;
const EAlreadyRevoked: u64 = 8;
const EInvalidExpiry: u64 = 9;
const EZeroSpend: u64 = 10;
const EMessagingAlreadySet: u64 = 11;
const EStrategyMismatch: u64 = 12;
const EInsufficientBalance: u64 = 13;

// === Events ===

/// Emitted when an AgentIdentity becomes a shared object and is ready to act.
public struct AgentMintedEvent has copy, drop {
    agent_id: ID,
    owner: address,
    session_addr: address,
    expiry_epoch: u64,
    spend_per_epoch: u64,
    memwal_namespace: vector<u8>,
    strategy_id: ID,
}

/// Emitted by `revoke`. Off-chain indexer subscribes and calls MemWal delegate
/// revocation API + signals Walrus epoch eviction for the agent's blobs.
public struct AgentRevokedEvent has copy, drop {
    agent_id: ID,
    owner: address,
    memwal_delegate_key_id: vector<u8>,
    revoked_at_epoch: u64,
}

/// Emitted by `fund`. Off-chain indexer uses this for the unified audit log.
public struct AgentFundedEvent has copy, drop {
    agent_id: ID,
    token_type: TypeName,
    amount: u64,
}

/// Emitted when the owner rotates the agent's ephemeral session key.
public struct SessionKeyRotatedEvent has copy, drop {
    agent_id: ID,
    old_session_addr: address,
    new_session_addr: address,
    rotated_at_epoch: u64,
}

/// Emitted when the owner extends the agent's lifespan.
public struct ExpiryExtendedEvent has copy, drop {
    agent_id: ID,
    old_expiry_epoch: u64,
    new_expiry_epoch: u64,
}

/// Emitted when messaging channels are attached to the agent.
public struct MessagingAttachedEvent has copy, drop {
    agent_id: ID,
    inbox: ID,
    outbox: ID,
}

// === The spine struct ===

public struct AgentIdentity has key {
    id: UID,
    // --- Identity ---
    owner: address,
    session_addr: address,
    expiry_epoch: u64,
    revoked: bool,
    // --- Wallet policy ---
    spend_per_epoch: u64,
    spent_this_epoch: u64,
    last_epoch_seen: u64,
    approved_packages: vector<address>,
    treasury: Bag,
    // --- MemWal bridge ---
    memwal_account_id: vector<u8>,
    memwal_delegate_key_id: vector<u8>,
    memwal_namespace: vector<u8>,
    // --- Artifacts (stored as dynamic fields keyed by u64) ---
    next_artifact_id: u64,
    artifact_count: u64,
    // --- Sui Stack Messaging ---
    messaging_inbox: Option<ID>,
    messaging_outbox: Option<ID>,
    // --- Strategy linkage (marketplace) ---
    strategy_id: ID,
}

// === Public lifecycle (PTB-chainable) ===

/// Construct a fresh AgentIdentity bound to a published `Strategy`. The
/// returned object is a hot potato — the caller MUST consume it via `share`
/// (or destroy it explicitly) in the same PTB. The session keypair is
/// generated client-side; only the address is committed on-chain.
///
/// The strategy reference is mutated to increment its adoption counters
/// (`vault_count`, `active_vault_count`). Adopting an inactive strategy
/// aborts inside `strategy_registry::record_vault_minted`.
public fun new(
    strategy: &mut Strategy,
    session_addr: address,
    expiry_epoch: u64,
    spend_per_epoch: u64,
    approved_packages: vector<address>,
    memwal_account_id: vector<u8>,
    memwal_delegate_key_id: vector<u8>,
    memwal_namespace: vector<u8>,
    ctx: &mut TxContext,
): AgentIdentity {
    let current_epoch = ctx.epoch();
    assert!(expiry_epoch > current_epoch, EInvalidExpiry);
    assert!(spend_per_epoch > 0, EZeroSpend);

    let uid = object::new(ctx);
    let vault_id = uid.to_inner();
    let strategy_id = strategy_registry::strategy_id(strategy);
    strategy_registry::record_vault_minted(strategy, vault_id, 0, ctx);

    AgentIdentity {
        id: uid,
        owner: ctx.sender(),
        session_addr,
        expiry_epoch,
        revoked: false,
        spend_per_epoch,
        spent_this_epoch: 0,
        last_epoch_seen: current_epoch,
        approved_packages,
        treasury: bag::new(ctx),
        memwal_account_id,
        memwal_delegate_key_id,
        memwal_namespace,
        next_artifact_id: 0,
        artifact_count: 0,
        messaging_inbox: option::none(),
        messaging_outbox: option::none(),
        strategy_id,
    }
}

/// Attach Sui Stack Messaging channels to the agent. May be called exactly once
/// during the mint PTB (or later by the owner). Channels are external Sui
/// objects — we only record their IDs for off-chain correlation.
public fun attach_messaging(
    identity: &mut AgentIdentity,
    inbox: ID,
    outbox: ID,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(identity.messaging_inbox.is_none(), EMessagingAlreadySet);
    assert!(identity.messaging_outbox.is_none(), EMessagingAlreadySet);
    identity.messaging_inbox = option::some(inbox);
    identity.messaging_outbox = option::some(outbox);

    event::emit(MessagingAttachedEvent {
        agent_id: identity.id.to_inner(),
        inbox,
        outbox,
    });
}

/// Convert the AgentIdentity into a shared object so the session key can
/// mutate it via gated functions. Consumes the hot potato. Emits the canonical
/// mint event for indexers.
public fun share(identity: AgentIdentity) {
    let agent_id = identity.id.to_inner();
    let owner = identity.owner;
    let session_addr = identity.session_addr;
    let expiry_epoch = identity.expiry_epoch;
    let spend_per_epoch = identity.spend_per_epoch;
    let memwal_namespace = identity.memwal_namespace;
    let strategy_id = identity.strategy_id;

    transfer::share_object(identity);

    event::emit(AgentMintedEvent {
        agent_id,
        owner,
        session_addr,
        expiry_epoch,
        spend_per_epoch,
        memwal_namespace,
        strategy_id,
    });
}

/// Fund the agent's treasury with a coin of any type. Subsequent calls with
/// the same coin type merge balances into the existing slot.
public fun fund<T>(identity: &mut AgentIdentity, coin: sui::coin::Coin<T>) {
    let amount = coin.value();
    let token_type = type_name::with_defining_ids<T>();

    if (identity.treasury.contains_with_type<TypeName, sui::balance::Balance<T>>(token_type)) {
        let bal: &mut sui::balance::Balance<T> = identity.treasury.borrow_mut(token_type);
        bal.join(coin.into_balance());
    } else {
        identity.treasury.add(token_type, coin.into_balance());
    };

    event::emit(AgentFundedEvent {
        agent_id: identity.id.to_inner(),
        token_type,
        amount,
    });
}

// === Owner-only governance entry points ===

/// Atomic kill switch. Flips the revocation flag, decrements the strategy's
/// active vault counter, and emits an event the off-chain indexer uses to
/// fan out MemWal delegate revocation + Walrus eviction signaling.
/// Idempotent guard prevents double-emission.
public fun revoke(
    identity: &mut AgentIdentity,
    strategy: &mut Strategy,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(!identity.revoked, EAlreadyRevoked);
    assert!(
        strategy_registry::strategy_id(strategy) == identity.strategy_id,
        EStrategyMismatch,
    );
    identity.revoked = true;

    let vault_id = identity.id.to_inner();
    strategy_registry::record_vault_revoked(strategy, vault_id, ctx);

    event::emit(AgentRevokedEvent {
        agent_id: vault_id,
        owner: identity.owner,
        memwal_delegate_key_id: identity.memwal_delegate_key_id,
        revoked_at_epoch: ctx.epoch(),
    });
}

/// Rotate the agent's ephemeral session key (e.g., after suspected compromise).
public fun rotate_session_key(
    identity: &mut AgentIdentity,
    new_session_addr: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(!identity.revoked, ERevoked);
    let old = identity.session_addr;
    identity.session_addr = new_session_addr;

    event::emit(SessionKeyRotatedEvent {
        agent_id: identity.id.to_inner(),
        old_session_addr: old,
        new_session_addr,
        rotated_at_epoch: ctx.epoch(),
    });
}

/// Extend the agent's expiry epoch. New value must be strictly greater.
public fun extend_expiry(
    identity: &mut AgentIdentity,
    new_expiry_epoch: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(!identity.revoked, ERevoked);
    assert!(new_expiry_epoch > identity.expiry_epoch, EInvalidExpiry);
    let old = identity.expiry_epoch;
    identity.expiry_epoch = new_expiry_epoch;

    event::emit(ExpiryExtendedEvent {
        agent_id: identity.id.to_inner(),
        old_expiry_epoch: old,
        new_expiry_epoch,
    });
}

/// Tighten or relax the per-epoch spend cap.
public fun update_spend_per_epoch(
    identity: &mut AgentIdentity,
    new_spend_per_epoch: u64,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(!identity.revoked, ERevoked);
    assert!(new_spend_per_epoch > 0, EZeroSpend);
    identity.spend_per_epoch = new_spend_per_epoch;
}

/// Add a contract package to the agent's allowlist.
public fun add_approved_package(
    identity: &mut AgentIdentity,
    pkg: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    assert!(!identity.revoked, ERevoked);
    if (!identity.approved_packages.contains(&pkg)) {
        identity.approved_packages.push_back(pkg);
    };
}

/// Remove a contract package from the agent's allowlist.
public fun remove_approved_package(
    identity: &mut AgentIdentity,
    pkg: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
    let (found, idx) = identity.approved_packages.index_of(&pkg);
    if (found) {
        identity.approved_packages.remove(idx);
    };
}

// === Marketplace (strategy-linked) actions ===

/// Record per-tick performance alpha on the linked strategy. Splits the
/// alpha signal into two u64 buckets (`pos` and `neg`) so the strategy
/// counters can stay as unsigned `u128` sums. Session-authorized.
public fun record_tick_performance(
    identity: &AgentIdentity,
    strategy: &mut Strategy,
    alpha_bps_pos: u64,
    alpha_bps_neg: u64,
    ctx: &TxContext,
) {
    assert_can_act(identity, ctx);
    assert!(
        strategy_registry::strategy_id(strategy) == identity.strategy_id,
        EStrategyMismatch,
    );
    strategy_registry::record_tick(
        strategy,
        identity.id.to_inner(),
        alpha_bps_pos,
        alpha_bps_neg,
        ctx,
    );
}

/// Pay the strategist their royalty share out of the vault's treasury,
/// in the same coin type the profit was realized in. Session-authorized.
///
/// `profit_amount` is the gross profit (in coin minor units) on which the
/// royalty is computed: payout = profit_amount * royalty_bps / 10_000.
/// Royalties do NOT count against the per-epoch spend cap (they are a
/// protocol-internal transfer to a registered strategist, not an external
/// call to an allowlisted contract).
public fun pay_strategist_royalty<T>(
    identity: &mut AgentIdentity,
    strategy: &mut Strategy,
    profit_amount: u64,
    ctx: &mut TxContext,
) {
    assert_can_act(identity, ctx);
    assert!(
        strategy_registry::strategy_id(strategy) == identity.strategy_id,
        EStrategyMismatch,
    );

    let royalty_bps = strategy_registry::royalty_bps(strategy);
    if (royalty_bps == 0 || profit_amount == 0) return;

    let royalty: u64 =
        (((profit_amount as u128) * (royalty_bps as u128) / 10_000u128) as u64);
    if (royalty == 0) return;

    let token_type = type_name::with_defining_ids<T>();
    assert!(
        identity.treasury.contains_with_type<TypeName, balance::Balance<T>>(token_type),
        EInsufficientBalance,
    );
    let bal: &mut balance::Balance<T> = identity.treasury.borrow_mut(token_type);
    assert!(bal.value() >= royalty, EInsufficientBalance);

    let payout_balance = bal.split(royalty);
    let payout_coin = coin::from_balance(payout_balance, ctx);
    let strategist = strategy_registry::strategist(strategy);
    transfer::public_transfer(payout_coin, strategist);

    strategy_registry::record_royalty_paid<T>(
        strategy,
        identity.id.to_inner(),
        royalty,
    );
}

// === Read-only accessors ===

public fun owner(identity: &AgentIdentity): address { identity.owner }

public fun session_addr(identity: &AgentIdentity): address { identity.session_addr }

public fun expiry_epoch(identity: &AgentIdentity): u64 { identity.expiry_epoch }

public fun spend_per_epoch(identity: &AgentIdentity): u64 { identity.spend_per_epoch }

public fun spent_this_epoch(identity: &AgentIdentity): u64 { identity.spent_this_epoch }

public fun is_revoked(identity: &AgentIdentity): bool { identity.revoked }

public fun strategy_id(identity: &AgentIdentity): ID { identity.strategy_id }

public fun memwal_namespace(identity: &AgentIdentity): &vector<u8> { &identity.memwal_namespace }

public fun memwal_delegate_key_id(identity: &AgentIdentity): &vector<u8> {
    &identity.memwal_delegate_key_id
}

public fun memwal_account_id(identity: &AgentIdentity): &vector<u8> {
    &identity.memwal_account_id
}

public fun messaging_inbox(identity: &AgentIdentity): &Option<ID> { &identity.messaging_inbox }

public fun messaging_outbox(identity: &AgentIdentity): &Option<ID> { &identity.messaging_outbox }

public fun approved_packages(identity: &AgentIdentity): &vector<address> {
    &identity.approved_packages
}

public fun artifact_count(identity: &AgentIdentity): u64 { identity.artifact_count }

public fun has_approved_package(identity: &AgentIdentity, pkg: address): bool {
    identity.approved_packages.contains(&pkg)
}

public fun is_active(identity: &AgentIdentity, ctx: &TxContext): bool {
    !identity.revoked && ctx.epoch() < identity.expiry_epoch
}

public fun remaining_budget(identity: &AgentIdentity, ctx: &TxContext): u64 {
    let current_epoch = ctx.epoch();
    if (current_epoch > identity.last_epoch_seen) {
        identity.spend_per_epoch
    } else if (identity.spent_this_epoch >= identity.spend_per_epoch) {
        0
    } else {
        identity.spend_per_epoch - identity.spent_this_epoch
    }
}

// === Package-visible mutators (used by sibling modules) ===

/// Combined action gate. Every package-internal action MUST call this before
/// mutating state on behalf of the agent.
public(package) fun assert_can_act(identity: &AgentIdentity, ctx: &TxContext) {
    assert!(!identity.revoked, ERevoked);
    assert!(ctx.sender() == identity.session_addr, ENotAuthorized);
    assert!(ctx.epoch() < identity.expiry_epoch, EExpired);
}

/// Owner-only gate for governance operations performed outside this module.
public(package) fun assert_owner(identity: &AgentIdentity, ctx: &TxContext) {
    assert!(ctx.sender() == identity.owner, ENotOwner);
}

/// Enforce the contract allowlist.
public(package) fun assert_package_allowed(identity: &AgentIdentity, pkg: address) {
    assert!(identity.approved_packages.contains(&pkg), ENotWhitelisted);
}

/// Roll the per-epoch spend counter when a new epoch begins. Called at the
/// top of every spend operation.
public(package) fun reset_epoch_if_new(identity: &mut AgentIdentity, ctx: &TxContext) {
    let current_epoch = ctx.epoch();
    if (current_epoch > identity.last_epoch_seen) {
        identity.spent_this_epoch = 0;
        identity.last_epoch_seen = current_epoch;
    };
}

/// Charge `amount` against the per-epoch budget. Aborts if over.
public(package) fun record_spend(identity: &mut AgentIdentity, amount: u64) {
    assert!(identity.spent_this_epoch + amount <= identity.spend_per_epoch, EOverBudget);
    identity.spent_this_epoch = identity.spent_this_epoch + amount;
}

public(package) fun treasury(identity: &AgentIdentity): &Bag { &identity.treasury }

public(package) fun treasury_mut(identity: &mut AgentIdentity): &mut Bag {
    &mut identity.treasury
}

/// Allocate the next monotonically increasing artifact slot ID.
public(package) fun next_artifact_slot(identity: &mut AgentIdentity): u64 {
    let id = identity.next_artifact_id;
    identity.next_artifact_id = id + 1;
    identity.artifact_count = identity.artifact_count + 1;
    id
}

/// Called when an artifact is burned, to keep the on-chain count accurate.
public(package) fun decrement_artifact_count(identity: &mut AgentIdentity) {
    if (identity.artifact_count > 0) {
        identity.artifact_count = identity.artifact_count - 1;
    };
}

/// Expose a mutable UID handle so sibling modules can attach dynamic fields
/// (e.g., artifact records) directly. The UID itself is not transferable.
public(package) fun uid_mut(identity: &mut AgentIdentity): &mut UID { &mut identity.id }

public(package) fun uid(identity: &AgentIdentity): &UID { &identity.id }
