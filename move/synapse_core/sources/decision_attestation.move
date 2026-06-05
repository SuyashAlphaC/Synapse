// SPDX-License-Identifier: Apache-2.0
//
// Synapse decision attestation — the application layer over `synapse_core::enclave`.
//
// The vault's hired strategy runs inside an attested AWS Nitro enclave (Marlin
// Oyster). Each tick the enclave produces a decision and signs it with its
// attested secp256k1 key; before a rebalance PTB executes the swap it calls
// `attest_decision_v2`, which aborts unless the registered enclave signed exactly
// this decision AND ran the vault's hired strategy code.
//
// OPT-IN per vault: only vaults whose runtime calls the gate carry the check.
//
// v1 (verify_decision / assert_decision_attested / DecisionPayload) is kept for
// upgrade compatibility — the published surface can't change. v2 is the
// strategy-agnostic version: it binds the signed `code_hash` to the on-chain
// `Strategy.code_hash`, so publishing a new strategy needs NO enclave change.

module synapse_core::decision_attestation;

use std::bcs;
use sui::ecdsa_k1;
use sui::event;
use synapse_core::enclave::{Self, Enclave, Cap, EnclaveConfig};
use synapse_core::agent::{Self, AgentIdentity};
use synapse_core::strategy_registry::{Self, Strategy};

/// DEV / TESTNET ONLY. Register a local (non-TEE) enclave's public key, skipping
/// Nitro attestation. Deployer-gated via the `Cap`. Use for free local-box demos;
/// production registers via `enclave::register_enclave` with a real attestation.
entry fun register_dev_enclave(
    config: &EnclaveConfig<DecisionEnclave>,
    cap: &Cap<DecisionEnclave>,
    pk: vector<u8>,
    ctx: &mut TxContext,
) {
    enclave::register_enclave_dev(config, cap, pk, ctx);
}

const EInvalidAttestation: u64 = 0;
/// The signed code_hash doesn't match the registered Strategy's code_hash.
const ECodeHashMismatch: u64 = 1;
/// The passed Strategy isn't the one the vault hired.
const EStrategyMismatch: u64 = 2;

/// Intent scope the enclave signs under. Must match `INTENT_DECISION` in the Node
/// enclave (`enclave/src/index.js`).
const INTENT_DECISION: u8 = 0;

/// Marker type that scopes the enclave config/registration to this module. A
/// plain witness (not a one-time witness): this module is added to an
/// already-published `synapse_core` via upgrade, where an OTW `init` never fires,
/// so the config is created by `bootstrap_config` instead.
public struct DecisionEnclave has drop {}

// ===== v1 payload (preserved for upgrade compatibility) =====================

public struct DecisionPayload has copy, drop {
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
}

public struct DecisionAttested has copy, drop {
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
}

// ===== v2 payload — strategy-agnostic =======================================

/// The decision the enclave signs. Field order + types MUST match the BCS layout
/// the Node enclave serializes (`DecisionPayload` there). The enclave runs the
/// vault's HIRED strategy bundle and signs its `code_hash` plus a hash of the
/// decision it produced — so any published strategy is attestable with NO enclave
/// change.
public struct DecisionPayloadV2 has copy, drop {
    vault_id: address,
    epoch: u64,
    code_hash: vector<u8>,     // sha256 of the strategy bundle that ran (== Strategy.code_hash)
    decision_hash: vector<u8>, // sha256 of the canonical decision the bundle produced
    inputs_hash: vector<u8>,   // sha256 of the inputs the strategy reasoned over
}

/// Emitted on every successfully attested decision — the audit timeline renders
/// this as a "decision provably produced by enclave <pk> running strategy
/// <code_hash>" edge.
public struct DecisionAttestedV2 has copy, drop {
    vault_id: address,
    epoch: u64,
    code_hash: vector<u8>,
    decision_hash: vector<u8>,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
}

/// One-time bootstrap. Creates the `Cap` + `EnclaveConfig` and transfers the Cap
/// to the caller (the deployer). Called once after the `synapse_core` upgrade
/// that adds this module — an OTW `init` can't be used here because `init` only
/// fires on a package's first publish, not on upgrade.
entry fun bootstrap_config(ctx: &mut TxContext) {
    create_config(DecisionEnclave {}, ctx);
}

fun create_config(witness: DecisionEnclave, ctx: &mut TxContext) {
    let cap = enclave::new_cap(witness, ctx);
    cap.create_enclave_config(
        b"Synapse Decision Enclave".to_string(),
        // Placeholder PCRs — overwrite with `update_pcrs` after the enclave build
        // (real TEE), or use `register_dev_enclave` for a local non-TEE box.
        x"00",
        x"00",
        x"00",
        x"00",
        ctx,
    );
    transfer::public_transfer(cap, ctx.sender());
}

// ===== v1 verify/gate (preserved) ===========================================

/// Verify the enclave signed exactly this (v1) decision; returns the boolean.
public fun verify_decision(
    enclave: &Enclave<DecisionEnclave>,
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: &vector<u8>,
): bool {
    let payload = DecisionPayload { vault_id, epoch, target_weight_milli, inputs_hash };
    enclave.verify_signature(INTENT_DECISION, timestamp_ms, payload, signature)
}

public fun assert_decision_attested(
    enclave: &Enclave<DecisionEnclave>,
    identity: &mut AgentIdentity,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
    let vault_id = object::id_address(identity);
    let ok = verify_decision(
        enclave,
        vault_id,
        epoch,
        target_weight_milli,
        inputs_hash,
        timestamp_ms,
        &signature,
    );
    assert!(ok, EInvalidAttestation);
    agent::stamp_attested(identity, epoch);
    event::emit(DecisionAttested { vault_id, epoch, target_weight_milli, inputs_hash, timestamp_ms });
}

entry fun attest_decision(
    enclave: &Enclave<DecisionEnclave>,
    identity: &mut AgentIdentity,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
    assert_decision_attested(enclave, identity, epoch, target_weight_milli, inputs_hash, timestamp_ms, signature);
}

// ===== v2 verify/gate — strategy-agnostic ===================================

/// Verify the enclave signed exactly this (v2) decision; returns the boolean.
public fun verify_decision_v2(
    enclave: &Enclave<DecisionEnclave>,
    vault_id: address,
    epoch: u64,
    code_hash: vector<u8>,
    decision_hash: vector<u8>,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: &vector<u8>,
): bool {
    let payload = DecisionPayloadV2 { vault_id, epoch, code_hash, decision_hash, inputs_hash };
    enclave.verify_signature(INTENT_DECISION, timestamp_ms, payload, signature)
}

/// The gate. Aborts unless the registered enclave signed a decision for THIS
/// vault, running THIS vault's hired strategy:
///   1. `strategy` is the one the vault hired (`identity.strategy_id`),
///   2. the signed `code_hash` equals the registered strategy's on-chain
///      `code_hash` — the enclave ran the exact published bundle, and
///   3. the enclave signature is valid (vault derived on-chain — no replay).
/// On success, stamps the vault as attested for `epoch` — `wallet::spend` checks
/// that stamp. Emits `DecisionAttestedV2`.
public fun assert_decision_attested_v2(
    enclave: &Enclave<DecisionEnclave>,
    identity: &mut AgentIdentity,
    strategy: &Strategy,
    epoch: u64,
    code_hash: vector<u8>,
    decision_hash: vector<u8>,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
    assert!(
        strategy_registry::strategy_id(strategy) == agent::strategy_id(identity),
        EStrategyMismatch,
    );
    assert!(code_hash == *strategy_registry::code_hash(strategy), ECodeHashMismatch);

    let vault_id = object::id_address(identity);
    let ok = verify_decision_v2(
        enclave,
        vault_id,
        epoch,
        code_hash,
        decision_hash,
        inputs_hash,
        timestamp_ms,
        &signature,
    );
    assert!(ok, EInvalidAttestation);
    agent::stamp_attested(identity, epoch);
    event::emit(DecisionAttestedV2 {
        vault_id,
        epoch,
        code_hash,
        decision_hash,
        inputs_hash,
        timestamp_ms,
    });
}

/// Entry wrapper so the v2 gate can be invoked directly in a PTB.
entry fun attest_decision_v2(
    enclave: &Enclave<DecisionEnclave>,
    identity: &mut AgentIdentity,
    strategy: &Strategy,
    epoch: u64,
    code_hash: vector<u8>,
    decision_hash: vector<u8>,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
    assert_decision_attested_v2(
        enclave,
        identity,
        strategy,
        epoch,
        code_hash,
        decision_hash,
        inputs_hash,
        timestamp_ms,
        signature,
    );
}

// ----- BCS layout contract test (v2) -----------------------------------------
// Locks the on-chain serialization so the Node enclave matches it byte-for-byte.

#[test_only]
use synapse_core::enclave::IntentMessage;

#[test]
fun decision_bcs_is_deterministic_and_field_sensitive() {
    let vault = @0x1234;
    let base = bcs::to_bytes(&make_intent(vault, 100, b"code", b"dec", b"in"));
    assert!(base == bcs::to_bytes(&make_intent(vault, 100, b"code", b"dec", b"in")), 0);
    assert!(base != bcs::to_bytes(&make_intent(@0x5678, 100, b"code", b"dec", b"in")), 1);
    assert!(base != bcs::to_bytes(&make_intent(vault, 101, b"code", b"dec", b"in")), 2);
    assert!(base != bcs::to_bytes(&make_intent(vault, 100, b"CODE", b"dec", b"in")), 3);
    assert!(base != bcs::to_bytes(&make_intent(vault, 100, b"code", b"DEC", b"in")), 4);
    assert!(base != bcs::to_bytes(&make_intent(vault, 100, b"code", b"dec", b"IN")), 5);
}

#[test_only]
fun make_intent(
    vault_id: address,
    epoch: u64,
    code_hash: vector<u8>,
    decision_hash: vector<u8>,
    inputs_hash: vector<u8>,
): IntentMessage<DecisionPayloadV2> {
    enclave::new_intent_message_for_testing(
        INTENT_DECISION,
        1_744_038_900_000,
        DecisionPayloadV2 { vault_id, epoch, code_hash, decision_hash, inputs_hash },
    )
}

// Cross-stack crypto contract: a signature produced by the Node enclave
// (enclave/scripts/gen-fixture.mjs, deterministic key 0x01..0x20) must verify
// on-chain. If the BCS layout or hashing drifts between Node and Move, this fails.
#[test]
fun verifies_node_signed_decision() {
    let mut ctx = tx_context::dummy();
    let pk = x"0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0";
    let enclave = enclave::new_enclave_for_testing<DecisionEnclave>(pk, &mut ctx);
    let code_hash = x"60e54b7d2880f4b7990f7c2a7ef8a32413647ab821f02be8b94ef372f3f19e46";
    let decision_hash = x"1da503326fead9f8caddfe697b3b9507bb51ae24422a0f65673680ac2c42cf47";
    let inputs_hash = x"f43c09c97259c438778fbff22b4a9941370439e1fb96a35682d0e3be68788da8";
    let signature = x"51f520438f55458c5b8bea38fecc3dd989d8df552a8ec47a5f0e03b9c926c1d06691275175ed005218085a22789bc6b498209877b27d54eabe269138ce119c16";
    let ok = verify_decision_v2(
        &enclave, @0x1234, 100, code_hash, decision_hash, inputs_hash, 1_744_038_900_000, &signature,
    );
    assert!(ok, 0);
    // A tampered decision hash must NOT verify.
    let bad = verify_decision_v2(
        &enclave, @0x1234, 100, code_hash,
        x"00a503326fead9f8caddfe697b3b9507bb51ae24422a0f65673680ac2c42cf47",
        inputs_hash, 1_744_038_900_000, &signature,
    );
    assert!(!bad, 1);
    enclave::destroy(enclave);
}
