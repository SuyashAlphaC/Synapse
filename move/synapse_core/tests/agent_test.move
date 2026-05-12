// Synapse Core — Agent lifecycle tests.
//
// Covers mint → fund → spend → artifact publish → cross-agent coordination
// → revoke, plus negative cases: wrong sender, expired, revoked, over-budget,
// non-allowlisted package.

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

const HUMAN: address = @0xA11CE;
const AGENT_SESSION: address = @0xBEEF;
const SECOND_AGENT_SESSION: address = @0xCAFE;
const APPROVED_PKG: address = @0xDEFA17;
const FORBIDDEN_PKG: address = @0xBADBAD;

// === Helpers ===

fun mint_agent(
    scenario: &mut ts::Scenario,
    session: address,
    spend_per_epoch: u64,
    expiry_offset: u64,
    namespace: vector<u8>,
): AgentIdentity {
    let ctx = ts::ctx(scenario);
    let current_epoch = ctx.epoch();
    agent::new(
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

    // Mint
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"shared-ns");
    assert!(agent::owner(&identity) == HUMAN, 0);
    assert!(agent::session_addr(&identity) == AGENT_SESSION, 1);
    assert!(!agent::is_revoked(&identity), 2);
    assert!(agent::spend_per_epoch(&identity) == 1000, 3);

    // Fund 5000 SUI
    fund_with_sui(&mut identity, 5000, &mut scenario);
    assert!(wallet::balance_of<SUI>(&identity) == 5000, 4);

    // Switch to the agent's session key and spend 400
    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 400, ts::ctx(&mut scenario));
    assert!(coin.value() == 400, 5);
    assert!(wallet::balance_of<SUI>(&identity) == 4600, 6);
    assert!(agent::spent_this_epoch(&identity) == 400, 7);
    assert!(agent::remaining_budget(&identity, ts::ctx(&mut scenario)) == 600, 8);

    // Burn the test coin so test_scenario can wrap up cleanly
    test_utils::destroy(coin);

    // Switch back to owner and revoke
    ts::next_tx(&mut scenario, HUMAN);
    agent::revoke(&mut identity, ts::ctx(&mut scenario));
    assert!(agent::is_revoked(&identity), 9);

    // Cleanup
    test_utils::destroy(identity);
    ts::end(scenario);
}

// === Artifact publish + burn ===

#[test]
fun publish_and_burn_artifact_succeeds() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns-1");

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

    // Burn the artifact
    artifacts::burn(&mut identity, 0, ts::ctx(&mut scenario));
    assert!(!artifacts::exists(&identity, 0), 5);
    assert!(agent::artifact_count(&identity) == 0, 6);

    test_utils::destroy(identity);
    ts::end(scenario);
}

// === Cross-agent coordination ===

#[test]
fun shared_namespace_cross_agent_read_succeeds() {
    let mut scenario = ts::begin(HUMAN);

    let researcher = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"research-team");
    let trader = mint_agent(&mut scenario, SECOND_AGENT_SESSION, 1000, 10, b"research-team");

    assert!(coordination::share_namespace(&trader, &researcher), 0);

    // Trader records a cross-agent read of researcher's MemWal memory
    ts::next_tx(&mut scenario, SECOND_AGENT_SESSION);
    coordination::record_cross_agent_read(
        &trader,
        &researcher,
        b"memwal-memory-id-xyz",
        ts::ctx(&mut scenario),
    );

    test_utils::destroy(researcher);
    test_utils::destroy(trader);
    ts::end(scenario);
}

// === Negative cases ===

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotAuthorized)]
fun spend_from_wrong_sender_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    // Owner (not the session key) tries to spend — should abort.
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotWhitelisted)]
fun spend_to_forbidden_package_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, FORBIDDEN_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::EOverBudget)]
fun spend_over_budget_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 500, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 600, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ERevoked)]
fun spend_after_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns");
    fund_with_sui(&mut identity, 5000, &mut scenario);

    agent::revoke(&mut identity, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, AGENT_SESSION);
    let coin = wallet::spend<SUI>(&mut identity, APPROVED_PKG, 100, ts::ctx(&mut scenario));
    test_utils::destroy(coin);
    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::ENotOwner)]
fun non_owner_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns");

    // Different address attempts to revoke
    ts::next_tx(&mut scenario, AGENT_SESSION);
    agent::revoke(&mut identity, ts::ctx(&mut scenario));

    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::agent::EAlreadyRevoked)]
fun double_revoke_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let mut identity = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns");

    agent::revoke(&mut identity, ts::ctx(&mut scenario));
    agent::revoke(&mut identity, ts::ctx(&mut scenario));

    test_utils::destroy(identity);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = synapse_core::coordination::ENamespaceMismatch)]
fun cross_agent_read_different_namespace_aborts() {
    let mut scenario = ts::begin(HUMAN);
    let researcher = mint_agent(&mut scenario, AGENT_SESSION, 1000, 10, b"ns-A");
    let trader = mint_agent(&mut scenario, SECOND_AGENT_SESSION, 1000, 10, b"ns-B");

    ts::next_tx(&mut scenario, SECOND_AGENT_SESSION);
    coordination::record_cross_agent_read(
        &trader,
        &researcher,
        b"memory-id",
        ts::ctx(&mut scenario),
    );

    test_utils::destroy(researcher);
    test_utils::destroy(trader);
    ts::end(scenario);
}
