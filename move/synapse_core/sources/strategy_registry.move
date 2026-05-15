// Synapse Core — Strategy Registry.
//
// A `Strategy` is the on-chain manifest for an autonomous portfolio-management
// program that human owners can hire to manage their Vault. Strategists publish
// a strategy once and earn a royalty on the performance fee of every vault
// minted against it. The same object also carries the strategy's lifetime
// reputation (vault count, AUM committed, cumulative alpha, revocations).
//
// Strategy objects are shared so anyone can list them. Mutating operations are
// gated by a `StrategistCap` returned at publish time. Vault adoption,
// revocation, tick performance, and royalty payouts are recorded via
// package-internal entry points called from `agent.move`.

module synapse_core::strategy_registry;

use std::string::{Self, String};
use std::type_name::{Self, TypeName};
use sui::event;

// === Error codes ===

const ENotStrategist: u64 = 0;
const EBadRiskProfile: u64 = 1;
const EInactive: u64 = 2;
const EEmptyName: u64 = 3;
const EMaxRoyaltyExceeded: u64 = 4;

/// Hard ceiling on the strategist's cut of perf fees: 50%.
const MAX_ROYALTY_BPS: u16 = 5000;

// === Risk profile constants (informational tags) ===

const RISK_CONSERVATIVE: u8 = 0;
const RISK_BALANCED: u8 = 1;
const RISK_AGGRESSIVE: u8 = 2;

// === Types ===

/// On-chain manifest for a published strategy. Shared so the dashboard +
/// marketplace can list every strategy globally. Reputation counters live
/// here to keep on-chain truth in one place.
public struct Strategy has key {
    id: UID,
    strategist: address,
    name: String,
    description: String,
    /// 32-byte commitment to the strategy runtime code (e.g. LangGraph bundle).
    code_hash: vector<u8>,
    /// Walrus blob ID containing the strategy source / documentation.
    source_walrus_blob: vector<u8>,
    /// 0=Conservative, 1=Balanced, 2=Aggressive.
    risk_profile: u8,
    /// Strategist's share of perf fees, in basis points (max 5000 = 50%).
    royalty_bps: u16,
    version: u64,
    published_at_epoch: u64,
    active: bool,
    // --- Reputation counters (monotonic, updated package-internal) ---
    vault_count: u64,
    active_vault_count: u64,
    total_aum_committed: u128,
    total_ticks_recorded: u64,
    cumulative_alpha_bps_pos: u128,
    cumulative_alpha_bps_neg: u128,
    revocations: u64,
    total_royalty_paid: u128,
    last_update_epoch: u64,
}

/// Capability returned to the strategist when they publish. Required to
/// upgrade the strategy's code hash or deprecate it.
public struct StrategistCap has key, store {
    id: UID,
    strategy_id: ID,
}

// === Events ===

public struct StrategyPublishedEvent has copy, drop {
    strategy_id: ID,
    strategist: address,
    name: String,
    code_hash: vector<u8>,
    risk_profile: u8,
    royalty_bps: u16,
}

public struct StrategyVersionedEvent has copy, drop {
    strategy_id: ID,
    new_version: u64,
    code_hash: vector<u8>,
}

public struct StrategyDeprecatedEvent has copy, drop {
    strategy_id: ID,
}

public struct VaultAdoptedEvent has copy, drop {
    strategy_id: ID,
    vault_id: ID,
    aum_committed: u128,
}

public struct VaultRevokedFromStrategyEvent has copy, drop {
    strategy_id: ID,
    vault_id: ID,
}

public struct TickRecordedEvent has copy, drop {
    strategy_id: ID,
    vault_id: ID,
    alpha_bps_pos: u64,
    alpha_bps_neg: u64,
    epoch: u64,
}

public struct RoyaltyPaidEvent has copy, drop {
    strategy_id: ID,
    vault_id: ID,
    strategist: address,
    amount: u64,
    coin_type: TypeName,
}

// === Publishing & lifecycle ===

/// Publish a new strategy. The Strategy object is shared so anyone can
/// hire it; the returned StrategistCap is transferred to the publisher for
/// future governance.
public fun publish(
    name: vector<u8>,
    description: vector<u8>,
    code_hash: vector<u8>,
    source_walrus_blob: vector<u8>,
    risk_profile: u8,
    royalty_bps: u16,
    ctx: &mut TxContext,
): StrategistCap {
    assert!(!name.is_empty(), EEmptyName);
    assert!(risk_profile <= RISK_AGGRESSIVE, EBadRiskProfile);
    assert!(royalty_bps <= MAX_ROYALTY_BPS, EMaxRoyaltyExceeded);

    let strategist = ctx.sender();
    let strategy = Strategy {
        id: object::new(ctx),
        strategist,
        name: string::utf8(name),
        description: string::utf8(description),
        code_hash,
        source_walrus_blob,
        risk_profile,
        royalty_bps,
        version: 1,
        published_at_epoch: ctx.epoch(),
        active: true,
        vault_count: 0,
        active_vault_count: 0,
        total_aum_committed: 0,
        total_ticks_recorded: 0,
        cumulative_alpha_bps_pos: 0,
        cumulative_alpha_bps_neg: 0,
        revocations: 0,
        total_royalty_paid: 0,
        last_update_epoch: ctx.epoch(),
    };
    let strategy_id = strategy.id.to_inner();

    event::emit(StrategyPublishedEvent {
        strategy_id,
        strategist,
        name: strategy.name,
        code_hash: strategy.code_hash,
        risk_profile,
        royalty_bps,
    });

    transfer::share_object(strategy);

    StrategistCap { id: object::new(ctx), strategy_id }
}

/// Publish a new code version of an existing strategy. Vault owners can
/// inspect `version` + `code_hash` before deciding to keep their vault
/// pointed at this strategy.
public fun publish_new_version(
    strategy: &mut Strategy,
    cap: &StrategistCap,
    new_code_hash: vector<u8>,
    new_source_walrus_blob: vector<u8>,
    ctx: &TxContext,
) {
    assert!(cap.strategy_id == strategy.id.to_inner(), ENotStrategist);
    strategy.version = strategy.version + 1;
    strategy.code_hash = new_code_hash;
    strategy.source_walrus_blob = new_source_walrus_blob;
    strategy.last_update_epoch = ctx.epoch();

    event::emit(StrategyVersionedEvent {
        strategy_id: strategy.id.to_inner(),
        new_version: strategy.version,
        code_hash: new_code_hash,
    });
}

/// Soft-deprecate a strategy: existing vaults keep working, but new vaults
/// cannot adopt it. The strategist can re-activate by publishing a new version.
public fun deprecate(strategy: &mut Strategy, cap: &StrategistCap, ctx: &TxContext) {
    assert!(cap.strategy_id == strategy.id.to_inner(), ENotStrategist);
    strategy.active = false;
    strategy.last_update_epoch = ctx.epoch();
    event::emit(StrategyDeprecatedEvent { strategy_id: strategy.id.to_inner() });
}

/// Re-activate a deprecated strategy.
public fun reactivate(strategy: &mut Strategy, cap: &StrategistCap, ctx: &TxContext) {
    assert!(cap.strategy_id == strategy.id.to_inner(), ENotStrategist);
    strategy.active = true;
    strategy.last_update_epoch = ctx.epoch();
}

// === Read-only accessors ===

public fun strategy_id(s: &Strategy): ID { s.id.to_inner() }
public fun strategist(s: &Strategy): address { s.strategist }
public fun name(s: &Strategy): &String { &s.name }
public fun description(s: &Strategy): &String { &s.description }
public fun code_hash(s: &Strategy): &vector<u8> { &s.code_hash }
public fun source_walrus_blob(s: &Strategy): &vector<u8> { &s.source_walrus_blob }
public fun risk_profile(s: &Strategy): u8 { s.risk_profile }
public fun royalty_bps(s: &Strategy): u16 { s.royalty_bps }
public fun version(s: &Strategy): u64 { s.version }
public fun published_at_epoch(s: &Strategy): u64 { s.published_at_epoch }
public fun is_active(s: &Strategy): bool { s.active }
public fun vault_count(s: &Strategy): u64 { s.vault_count }
public fun active_vault_count(s: &Strategy): u64 { s.active_vault_count }
public fun total_aum_committed(s: &Strategy): u128 { s.total_aum_committed }
public fun total_ticks_recorded(s: &Strategy): u64 { s.total_ticks_recorded }
public fun cumulative_alpha_bps_pos(s: &Strategy): u128 { s.cumulative_alpha_bps_pos }
public fun cumulative_alpha_bps_neg(s: &Strategy): u128 { s.cumulative_alpha_bps_neg }
public fun revocations(s: &Strategy): u64 { s.revocations }
public fun total_royalty_paid(s: &Strategy): u128 { s.total_royalty_paid }
public fun last_update_epoch(s: &Strategy): u64 { s.last_update_epoch }

public fun strategist_cap_strategy_id(cap: &StrategistCap): ID { cap.strategy_id }

// === Risk profile constants exposed for off-chain use ===

public fun risk_conservative(): u8 { RISK_CONSERVATIVE }
public fun risk_balanced(): u8 { RISK_BALANCED }
public fun risk_aggressive(): u8 { RISK_AGGRESSIVE }
public fun max_royalty_bps(): u16 { MAX_ROYALTY_BPS }

// === Package-internal mutators (called from agent.move) ===

/// Record that a new vault has adopted this strategy. Aborts if the
/// strategy is deprecated — protects vault owners from minting against
/// retired code.
public(package) fun record_vault_minted(
    strategy: &mut Strategy,
    vault_id: ID,
    aum_committed: u128,
    ctx: &TxContext,
) {
    assert!(strategy.active, EInactive);
    strategy.vault_count = strategy.vault_count + 1;
    strategy.active_vault_count = strategy.active_vault_count + 1;
    strategy.total_aum_committed = strategy.total_aum_committed + aum_committed;
    strategy.last_update_epoch = ctx.epoch();

    event::emit(VaultAdoptedEvent {
        strategy_id: strategy.id.to_inner(),
        vault_id,
        aum_committed,
    });
}

/// Record a vault revocation against this strategy. Always allowed even
/// after deprecation so cleanup keeps working.
public(package) fun record_vault_revoked(
    strategy: &mut Strategy,
    vault_id: ID,
    ctx: &TxContext,
) {
    if (strategy.active_vault_count > 0) {
        strategy.active_vault_count = strategy.active_vault_count - 1;
    };
    strategy.revocations = strategy.revocations + 1;
    strategy.last_update_epoch = ctx.epoch();

    event::emit(VaultRevokedFromStrategyEvent {
        strategy_id: strategy.id.to_inner(),
        vault_id,
    });
}

/// Record per-tick performance: signed alpha is split into positive and
/// negative legs so we can store both as u128 sums without an i128 type.
public(package) fun record_tick(
    strategy: &mut Strategy,
    vault_id: ID,
    alpha_bps_pos: u64,
    alpha_bps_neg: u64,
    ctx: &TxContext,
) {
    strategy.total_ticks_recorded = strategy.total_ticks_recorded + 1;
    strategy.cumulative_alpha_bps_pos =
        strategy.cumulative_alpha_bps_pos + (alpha_bps_pos as u128);
    strategy.cumulative_alpha_bps_neg =
        strategy.cumulative_alpha_bps_neg + (alpha_bps_neg as u128);
    strategy.last_update_epoch = ctx.epoch();

    event::emit(TickRecordedEvent {
        strategy_id: strategy.id.to_inner(),
        vault_id,
        alpha_bps_pos,
        alpha_bps_neg,
        epoch: ctx.epoch(),
    });
}

/// Record a royalty payout (typed by the coin paid).
public(package) fun record_royalty_paid<T>(
    strategy: &mut Strategy,
    vault_id: ID,
    amount: u64,
) {
    strategy.total_royalty_paid = strategy.total_royalty_paid + (amount as u128);

    event::emit(RoyaltyPaidEvent {
        strategy_id: strategy.id.to_inner(),
        vault_id,
        strategist: strategy.strategist,
        amount,
        coin_type: type_name::with_defining_ids<T>(),
    });
}
