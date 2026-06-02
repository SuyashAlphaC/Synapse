// SPDX-License-Identifier: Apache-2.0
//
// Synapse decision attestation — the application layer over `synapse_core::enclave`.
//
// The AI advisor runs inside an attested AWS Nitro enclave (deployed via Marlin
// Oyster). Each tick the enclave produces a `DecisionPayload` — the vault, epoch,
// target weight, and a hash of the inputs it reasoned over — and signs it with its
// attested secp256k1 key. Before a rebalance PTB is allowed to execute the swap,
// it calls `assert_decision_attested`, which aborts the whole transaction unless
// the registered enclave signed exactly this decision.
//
// This is OPT-IN per vault: only vaults whose runtime calls this gate carry the
// check. Existing vaults are unaffected — their rebalance PTBs simply don't
// include the call.
//
// Trust upgrade vs. the plain Walrus audit log: the audit log proves a rationale
// was *bound to and unaltered after* a trade. This proves the decision was
// *produced by the published agent code running in a genuine enclave* — the trade
// can't execute on a forged or tampered decision.

module synapse_core::decision_attestation;

use std::bcs;
use sui::ecdsa_k1;
use sui::event;
use synapse_core::enclave::{Self, Enclave, Cap, EnclaveConfig};

const EInvalidAttestation: u64 = 0;

/// Intent scope the enclave signs under. Must match `INTENT_SCOPE` in the Node
/// enclave (`enclave/src/index.js`).
const INTENT_DECISION: u8 = 0;

/// One-time witness — types the enclave config/registration to this module.
public struct DECISION_ATTESTATION has drop {}

/// The decision the enclave signs. Field order + types MUST match the BCS layout
/// the Node enclave serializes (`DecisionPayload` there).
public struct DecisionPayload has copy, drop {
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64, // target base-asset weight × 1000 (0..=1000)
    inputs_hash: vector<u8>,  // sha256 of the canonical advisor inputs
}

/// Emitted on every successfully attested decision — the audit timeline renders
/// this as a "decision provably produced by enclave <pk>" edge.
public struct DecisionAttested has copy, drop {
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
}

/// Set up the enclave config at publish time. PCRs are placeholders here and MUST
/// be set to the real reproducible-build measurements via `enclave::update_pcrs`
/// after the enclave image is built (and again on every rebuild). The `Cap` goes
/// to the deployer.
fun init(witness: DECISION_ATTESTATION, ctx: &mut TxContext) {
    let cap = enclave::new_cap(witness, ctx);
    cap.create_enclave_config(
        b"Synapse Decision Enclave".to_string(),
        // Placeholder PCRs — overwrite with `update_pcrs` after the enclave build.
        x"00",
        x"00",
        x"00",
        x"00",
        ctx,
    );
    transfer::public_transfer(cap, ctx.sender());
}

/// Verify the enclave signed exactly this decision; returns the boolean.
public fun verify_decision(
    enclave: &Enclave<DECISION_ATTESTATION>,
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

/// The gate. Aborts the transaction unless the registered enclave signed this
/// decision. Called at the top of an attested vault's rebalance PTB, before the
/// swap. Emits `DecisionAttested` for the audit timeline.
public fun assert_decision_attested(
    enclave: &Enclave<DECISION_ATTESTATION>,
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
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
    event::emit(DecisionAttested {
        vault_id,
        epoch,
        target_weight_milli,
        inputs_hash,
        timestamp_ms,
    });
}

/// Entry wrapper so the gate can be invoked directly in a PTB by reference args.
entry fun attest_decision(
    enclave: &Enclave<DECISION_ATTESTATION>,
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
    timestamp_ms: u64,
    signature: vector<u8>,
) {
    assert_decision_attested(
        enclave,
        vault_id,
        epoch,
        target_weight_milli,
        inputs_hash,
        timestamp_ms,
        signature,
    );
}

// ----- BCS layout contract test ----------------------------------------------
// Locks the on-chain serialization so the Node enclave can be built to match it
// byte-for-byte. The exact expected bytes are also asserted in the Node enclave's
// test against a Move-produced fixture; here we assert determinism + field
// sensitivity (same input => same bytes; any changed field => different bytes).

#[test_only]
use synapse_core::enclave::IntentMessage;

#[test]
fun decision_bcs_is_deterministic_and_field_sensitive() {
    let vault = @0x1234;
    let base = bcs::to_bytes(&make_intent(vault, 100, 500, b"hash"));
    // Same inputs -> identical bytes.
    assert!(base == bcs::to_bytes(&make_intent(vault, 100, 500, b"hash")), 0);
    // Each field flip changes the serialization.
    assert!(base != bcs::to_bytes(&make_intent(@0x5678, 100, 500, b"hash")), 1);
    assert!(base != bcs::to_bytes(&make_intent(vault, 101, 500, b"hash")), 2);
    assert!(base != bcs::to_bytes(&make_intent(vault, 100, 501, b"hash")), 3);
    assert!(base != bcs::to_bytes(&make_intent(vault, 100, 500, b"hesh")), 4);
}

#[test_only]
fun make_intent(
    vault_id: address,
    epoch: u64,
    target_weight_milli: u64,
    inputs_hash: vector<u8>,
): IntentMessage<DecisionPayload> {
    enclave::new_intent_message_for_testing(
        INTENT_DECISION,
        1_744_038_900_000,
        DecisionPayload { vault_id, epoch, target_weight_milli, inputs_hash },
    )
}

// Cross-stack crypto contract: a signature produced by the Node enclave
// (enclave/gen_fixture.mjs, deterministic key 0x01..0x20) must verify on-chain.
// If the BCS layout or hashing ever drifts between Node and Move, this fails.
#[test]
fun verifies_node_signed_decision() {
    let mut ctx = tx_context::dummy();
    let pk = x"0284bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0";
    let enclave = enclave::new_enclave_for_testing<DECISION_ATTESTATION>(pk, &mut ctx);
    let inputs_hash = x"f43c09c97259c438778fbff22b4a9941370439e1fb96a35682d0e3be68788da8";
    let signature = x"cde98f205ae4cef4da644f0b9a77739ec8ffbde8a4c60da071ba33596f6ee4f3656bd50e37b15efd5f02062b6d40a03b299b4281c08f4ef24d109b0b333f7ce6";
    let ok = verify_decision(
        &enclave,
        @0x1234,
        100,
        500,
        inputs_hash,
        1_744_038_900_000,
        &signature,
    );
    assert!(ok, 0);
    // A tampered weight must NOT verify.
    let bad = verify_decision(
        &enclave,
        @0x1234,
        100,
        501,
        inputs_hash,
        1_744_038_900_000,
        &signature,
    );
    assert!(!bad, 1);
    enclave::destroy(enclave);
}
