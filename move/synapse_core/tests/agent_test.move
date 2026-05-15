// Synapse Core — Agent lifecycle tests.
//
// Covers mint → fund → spend → artifact publish → cross-agent coordination
// → revoke, plus negative cases: wrong sender, expired, revoked, over-budget,
// non-allowlisted package. All vaults are now bound to a published Strategy
// from the marketplace registry; tests instantiate a fixture strategy first.

#[test_only]
module synapse_core::agent_test;

use std::string;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui::test_utils;

use synapse_core::agent::{Self, AgentIdentity};
use synapse_core::wallet;
use synapse_core::artifacts;
use synapse_core::coordination;
use synapse_core::strategy_registry::{Self, Strategy, StrategistCap};

const HUMAN: address = @0xA11CE;
const STRATEGIST: address = @0x5712A7;
const AGENT_SESSION: address = @0xBEEF;
const SECOND_AGENT_SESSION: address = @0xCAFE;
const APPROVED_PKG: address = @0xDEFA17;
const FORBIDDEN_PKG: address = @0xBADBAD;

// === Helpers ===

/// Publish a fixture strategy from STRATEGIST. Returns (strategy_id, cap_id)
/// so callers can take_shared / take_from_address in subsequent tx blocks.
fun publish_fixture_strategy(scenario: &mut ts::Scenario): (ID, ID) {
    ts::next_tx(scenario, STRATEGIST);
    let cap = strategy_registry::publish(
        b"Conservative Rebalancer",
        b"Daily SUI/USDC rebalance with 5% per-epoch cap",
        x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        b"walrus-blob-source-001",
        0, // RISK_CONSERVATIVE
        2000, // 20% of perf fee goes to strategist
        ts::ctx(scenario),
    );
    let cap_id = object::id(&cap);
    let strategy_id = strategy_registry::strategist_cap_strategy_id(&cap);
    transfer::public_transfer(cap, STRATEGIST);

    // Re-enter as HUMAN so subsequent agent operations are owner-authorized.
    ts::next_tx(scenario, HUMAN);
    (strategy_id, cap_id)
}

fun mint_agent_against(
    scenario: &mut ts::Scenario,
    strategy: &mut Strategy,
    session: address,
    spend_per_epoch: u64,
    expiry_offset: u64,
    namespace: vector<u8>,
): AgentIdentity {
    let ctx = ts::ctx(scenario);
    let current_epoch = ctx.epoch();
    agent::new(
        strategy,
        session,
        current_epoch + expiry_offset,
        spend_per_epoch,
        vector[APPROVED_PKG],
        b"memwal-account-001",
        b"delegate-key-001",
        namespace,
        ctx,
    )
}

fun fund_with_sui(identity: &mut AgentIdentity, amount: u64, scenario: &mut ts::Scenario) {
    let ctx = ts::ctx(scenario);
    let coin = coin::mint_for_testing<SUI>(amount, ctx);
    agent::fund(identity, coin);
}

// === Happy-path lifecycle ===

#[test]
fun mint_fund_spend_revoke_succeeds() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);

    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    // Mint
    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"shared-ns");
    assert!(agent::owner(&identity) == HUMAN, 0);
    assert!(agent::session_addr(&identity) == AGENT_SESSION, 1);
    assert!(!agent::is_revoked(&identity), 2);
    assert!(agent::spend_per_epoch(&identity) == 1000, 3);
    assert!(agent::strategy_id(&identity) == strategy_id, 4);
    assert!(strategy_registry::vault_count(&strategy) == 1, 5);
    assert!(strategy_registry::active_vault_count(&strategy) == 1, 6);

    // Fund 5000 SUI
    fund_with_sui(&mut identity, 5000, &mut scenario);
    assert!(wallet::balance_of<SUI>(&identity) == 5000, 7);

    // Switch to the agent's session key and spend 400
    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 400, ts::ctx(&mut scenario));
    assert!(coin.value() == 400, 8);
    assert!(wallet::balance_of<SUI>(&identity) == 4600, 9);
    assert!(agent::spent_this_epoch(&identity) == 400, 10);
    assert!(agent::remaining_budget(&identity, ts::ctx(&mut scenario)) == 600, 11);

    test_utils::destroy(coin);

    // Switch back to owner and revoke
    ts::next_tx(&mut scenario, HUMAN);
    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));
    assert!(agent::is_revoked(&identity), 12);
    assert!(strategy_registry::revocations(&strategy) == 1, 13);
    assert!(strategy_registry::active_vault_count(&strategy) == 0, 14);

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

// === Royalty payout flow ===

#[test]
fun strategist_royalty_is_paid_on_realized_profit() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);

    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);
    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 1_000_000, &mut scenario);

    // Session-authorized: pay 20% of 100_000 profit = 20_000 to strategist.
    ts::next_tx(&mut scenario, AGENT_SESSION);
    agent::pay_strategist_royalty<SUI>(
        &mut identity,
        &mut strategy,
        100_000,
        ts::ctx(&mut scenario),
    );

    assert!(wallet::balance_of<SUI>(&identity) == 980_000, 0);
    assert!(strategy_registry::total_royalty_paid(&strategy) == 20_000, 1);

    // The strategist now holds the royalty coin.
    ts::next_tx(&mut scenario, STRATEGIST);
    let paid = ts::take_from_address<coin::Coin<SUI>>(&scenario, STRATEGIST);
    assert!(coin::value(&paid) == 20_000, 2);
    test_utils::destroy(paid);

    // Cleanup as owner.
    ts::next_tx(&mut scenario, HUMAN);
    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));
    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
fun tick_performance_records_alpha_on_strategy() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);

    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);
    let identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");

    ts::next_tx(&mut scenario, AGENT_SESSION);
    agent::record_tick_performance(
        &identity,
        &mut strategy,
        125, // +1.25%
        0,
        ts::ctx(&mut scenario),
    );
    agent::record_tick_performance(
        &identity,
        &mut strategy,
        0,
        40, // -0.40%
        ts::ctx(&mut scenario),
    );

    assert!(strategy_registry::total_ticks_recorded(&strategy) == 2, 0);
    assert!(strategy_registry::cumulative_alpha_bps_pos(&strategy) == 125, 1);
    assert!(strategy_registry::cumulative_alpha_bps_neg(&strategy) == 40, 2);

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

// === Artifact publish + burn ===

#[test]
fun publish_and_burn_artifact_succeeds() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns-1");

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let slot = artifacts::publish(
        &mut identity,
        b"walrus-blob-id-abc",
        x"0000000000000000000000000000000000000000000000000000000000000001",
        string::utf8(b"text/markdown"),
        4096,
        false,
        string::utf8(b"eth_outlook_2026.md"),
        ts::ctx(&mut scenario),
    );
    assert!(slot == 0, 0);
    assert!(artifacts::exists(&identity, 0), 1);
    assert!(agent::artifact_count(&identity) == 1, 2);

    let artifact = artifacts::borrow(&identity, 0);
    assert!(artifacts::size_bytes(artifact) == 4096, 3);
    assert!(!artifacts::is_seal_encrypted(artifact), 4);

    artifacts::burn(&mut identity, 0, ts::ctx(&mut scenario));
    assert!(!artifacts::exists(&identity, 0), 5);
    assert!(agent::artifact_count(&identity) == 0, 6);

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

// === Cross-agent coordination ===

#[test]
fun shared_namespace_cross_agent_read_succeeds() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let researcher =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"research-team");
    let trader =
        mint_agent_against(&mut scenario, &mut strategy, SECOND_AGENT_SESSION, 1000, 10, b"research-team");

    assert!(coordination::share_namespace(&trader, &researcher), 0);

    ts::next_tx(&mut scenario, SECOND_AGENT_SESSION);
    coordination::record_cross_agent_read(
        &trader,
        &researcher,
        b"memwal-memory-id-xyz",
        ts::ctx(&mut scenario),
    );

    test_utils::destroy(researcher);
    test_utils::destroy(trader);
    ts::return_shared(strategy);
    ts::end(scenario);
}

// === Negative cases ===

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotAuthorized)]
fun spend_from_wrong_sender_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotWhitelisted)]
fun spend_to_forbidden_package_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, FORBIDDEN_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::EOverBudget)]
fun spend_over_budget_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 500, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 600, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ERevoked)]
fun spend_after_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotOwner)]
fun non_owner_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");

    ts::next_tx(&mut scenario, AGENT_SESSION);
    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::EAlreadyRevoked)]
fun double_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let mut identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");

    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));
    agent::revoke(&mut identity, &mut strategy, ts::ctx(&mut scenario));

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::coordination::ENamespaceMismatch)]
fun cross_agent_read_different_namespace_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    let researcher =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns-A");
    let trader =
        mint_agent_against(&mut scenario, &mut strategy, SECOND_AGENT_SESSION, 1000, 10, b"ns-B");

    ts::next_tx(&mut scenario, SECOND_AGENT_SESSION);
    coordination::record_cross_agent_read(
        &trader,
        &researcher,
        b"memory-id",
        ts::ctx(&mut scenario),
    );

    test_utils::destroy(researcher);
    test_utils::destroy(trader);
    ts::return_shared(strategy);
    ts::end(scenario);
}

// === Marketplace-specific: cannot adopt deprecated strategy ===

#[test]
#[expected_failure(abort_code = synapse_core::strategy_registry::EInactive)]
fun cannot_mint_against_deprecated_strategy() {
    let mut scenario = ts::begin(HUMAN);
    let (strategy_id, _cap_id) = publish_fixture_strategy(&mut scenario);
    let mut strategy: Strategy = ts::take_shared_by_id<Strategy>(&scenario, strategy_id);

    // Strategist deprecates.
    ts::next_tx(&mut scenario, STRATEGIST);
    let cap = ts::take_from_address<StrategistCap>(&scenario, STRATEGIST);
    strategy_registry::deprecate(&mut strategy, &cap, ts::ctx(&mut scenario));
    ts::return_to_address(STRATEGIST, cap);

    // Owner tries to mint anyway — should abort EInactive.
    ts::next_tx(&mut scenario, HUMAN);
    let identity =
        mint_agent_against(&mut scenario, &mut strategy, AGENT_SESSION, 1000, 10, b"ns");

    test_utils::destroy(identity);
    ts::return_shared(strategy);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::strategy_registry::EMaxRoyaltyExceeded)]
fun publishing_strategy_with_royalty_above_cap_aborts() {
    let mut scenario = ts::begin(STRATEGIST);
    let cap = strategy_registry::publish(
        b"Aggressive",
        b"",
        x"00",
        b"",
        2,
        6000, // > MAX_ROYALTY_BPS (5000)
        ts::ctx(&mut scenario),
    );
    transfer::public_transfer(cap, STRATEGIST);
    ts::end(scenario);
}
