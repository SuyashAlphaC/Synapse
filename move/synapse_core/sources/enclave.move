// SPDX-License-Identifier: Apache-2.0
// Vendored + adapted from the Marlin Oyster / Mysten Nautilus reference:
//   https://github.com/marlinprotocol/sui-oyster-demo (contracts/sources/enclave.move)
//   https://github.com/MystenLabs/nautilus (move/enclave)
//
// Generic, permissionless registration + signature verification for an
// AWS Nitro Enclave. The enclave (deployed via Marlin Oyster) produces a
// Nitro attestation document binding its ephemeral secp256k1 public key to a
// reproducible-build PCR measurement. We register that document once (verifying
// the PCRs match what we published), store the pubkey, and thereafter verify
// each enclave-signed message cheaply against the stored key.
//
// This is the substrate that makes Synapse's "verifiable AI decision" claim
// literally true: a decision signed inside the attested enclave can be checked
// on-chain before the trade it authorizes is allowed to execute.

module synapse_core::enclave;

use std::bcs;
use std::string::String;
use sui::ecdsa_k1;
use sui::nitro_attestation::NitroAttestationDocument;

use fun to_pcrs as NitroAttestationDocument.to_pcrs;

const EInvalidPCRs: u64 = 0;
const EInvalidConfigVersion: u64 = 1;
const EInvalidCap: u64 = 2;
const EInvalidOwner: u64 = 3;
const EInvalidPublicKeyLength: u64 = 4;
const EInvalidSignature: u64 = 5;

// Expected public key lengths for secp256k1.
const SECP256K1_PK_LENGTH_COMPRESSED: u64 = 33;
const SECP256K1_PK_LENGTH_UNCOMPRESSED: u64 = 64;

// PCR0: enclave image file · PCR1: kernel · PCR2: application · PCR16: app image.
public struct Pcrs(vector<u8>, vector<u8>, vector<u8>, vector<u8>) has copy, drop, store;

public struct EnclaveConfig<phantom T> has key {
    id: UID,
    name: String,
    pcrs: Pcrs,
    capability_id: ID,
    version: u64, // Incremented when the PCRs change (a rebuilt enclave).
}

// A verified enclave instance, with its registered secp256k1 public key.
public struct Enclave<phantom T> has key {
    id: UID,
    pk: vector<u8>,
    config_version: u64,
    owner: address,
}

// Capability to update the enclave config (held by the deployer).
public struct Cap<phantom T> has key, store {
    id: UID,
}

// The intent message wrapper the enclave signs over (must match the off-chain
// BCS layout in the Node enclave exactly: { intent, timestamp_ms, payload }).
public struct IntentMessage<T: drop> has copy, drop {
    intent: u8,
    timestamp_ms: u64,
    payload: T,
}

/// Create a new `Cap` from a module witness `T`.
public fun new_cap<T: drop>(_: T, ctx: &mut TxContext): Cap<T> {
    Cap { id: object::new(ctx) }
}

public fun create_enclave_config<T: drop>(
    cap: &Cap<T>,
    name: String,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    pcr16: vector<u8>,
    ctx: &mut TxContext,
) {
    let enclave_config = EnclaveConfig<T> {
        id: object::new(ctx),
        name,
        pcrs: Pcrs(pcr0, pcr1, pcr2, pcr16),
        capability_id: cap.id.to_inner(),
        version: 0,
    };
    transfer::share_object(enclave_config);
}

/// Register an enclave by verifying its Nitro attestation against the configured
/// PCRs and extracting the signing public key. Shares an `Enclave<T>`.
public fun register_enclave<T>(
    enclave_config: &EnclaveConfig<T>,
    document: NitroAttestationDocument,
    ctx: &mut TxContext,
) {
    let pk = enclave_config.load_pk(&document);
    let enclave = Enclave<T> {
        id: object::new(ctx),
        pk,
        config_version: enclave_config.version,
        owner: ctx.sender(),
    };
    transfer::share_object(enclave);
}

/// Verify a secp256k1 signature over the BCS-serialized IntentMessage wrapping
/// `payload`. Returns true iff the registered enclave key signed it.
public fun verify_signature<T, P: drop>(
    enclave: &Enclave<T>,
    intent_scope: u8,
    timestamp_ms: u64,
    payload: P,
    signature: &vector<u8>,
): bool {
    let intent_message = create_intent_message(intent_scope, timestamp_ms, payload);
    let message_bytes = bcs::to_bytes(&intent_message);
    ecdsa_k1::secp256k1_verify(signature, &enclave.pk, &message_bytes, 1) // 1 = SHA256
}

public fun update_pcrs<T: drop>(
    config: &mut EnclaveConfig<T>,
    cap: &Cap<T>,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    pcr16: vector<u8>,
) {
    cap.assert_is_valid_for_config(config);
    config.pcrs = Pcrs(pcr0, pcr1, pcr2, pcr16);
    config.version = config.version + 1;
}

public fun update_name<T: drop>(config: &mut EnclaveConfig<T>, cap: &Cap<T>, name: String) {
    cap.assert_is_valid_for_config(config);
    config.name = name;
}

public fun pcr0<T>(config: &EnclaveConfig<T>): &vector<u8> { &config.pcrs.0 }
public fun pcr1<T>(config: &EnclaveConfig<T>): &vector<u8> { &config.pcrs.1 }
public fun pcr2<T>(config: &EnclaveConfig<T>): &vector<u8> { &config.pcrs.2 }
public fun pcr16<T>(config: &EnclaveConfig<T>): &vector<u8> { &config.pcrs.3 }
public fun pk<T>(enclave: &Enclave<T>): &vector<u8> { &enclave.pk }
public fun config_version<T>(enclave: &Enclave<T>): u64 { enclave.config_version }

public fun destroy_old_enclave<T>(e: Enclave<T>, config: &EnclaveConfig<T>) {
    assert!(e.config_version < config.version, EInvalidConfigVersion);
    let Enclave { id, .. } = e;
    id.delete();
}

public fun destroy_old_enclave_by_owner<T>(e: Enclave<T>, ctx: &mut TxContext) {
    assert!(e.owner == ctx.sender(), EInvalidOwner);
    let Enclave { id, .. } = e;
    id.delete();
}

fun assert_is_valid_for_config<T>(cap: &Cap<T>, enclave_config: &EnclaveConfig<T>) {
    assert!(cap.id.to_inner() == enclave_config.capability_id, EInvalidCap);
}

fun load_pk<T>(enclave_config: &EnclaveConfig<T>, document: &NitroAttestationDocument): vector<u8> {
    assert!(document.to_pcrs() == enclave_config.pcrs, EInvalidPCRs);
    let mut pk = (*document.public_key()).destroy_some();
    if (pk.length() == SECP256K1_PK_LENGTH_UNCOMPRESSED) {
        pk = compress_secp256k1_pubkey(&pk);
    };
    assert!(pk.length() == SECP256K1_PK_LENGTH_COMPRESSED, EInvalidPublicKeyLength);
    pk
}

/// Compress an uncompressed secp256k1 key (64 bytes X||Y) to 33 bytes (prefix||X).
fun compress_secp256k1_pubkey(uncompressed: &vector<u8>): vector<u8> {
    assert!(uncompressed.length() == 64, EInvalidSignature);
    let mut compressed = vector::empty<u8>();
    let y_last_byte = uncompressed[63];
    let prefix = if (y_last_byte % 2 == 0) { 0x02 } else { 0x03 };
    compressed.push_back(prefix);
    let mut i = 0;
    while (i < 32) {
        compressed.push_back(uncompressed[i]);
        i = i + 1;
    };
    compressed
}

fun to_pcrs(document: &NitroAttestationDocument): Pcrs {
    let pcrs = document.pcrs();
    let mut pcr0 = vector::empty<u8>();
    let mut pcr1 = vector::empty<u8>();
    let mut pcr2 = vector::empty<u8>();
    let mut pcr16 = vector::empty<u8>();
    let mut i = 0;
    while (i < pcrs.length()) {
        let entry = &pcrs[i];
        let idx = entry.index();
        if (idx == 0) { pcr0 = *entry.value(); }
        else if (idx == 1) { pcr1 = *entry.value(); }
        else if (idx == 2) { pcr2 = *entry.value(); }
        else if (idx == 16) { pcr16 = *entry.value(); };
        i = i + 1;
    };
    Pcrs(pcr0, pcr1, pcr2, pcr16)
}

fun create_intent_message<P: drop>(intent: u8, timestamp_ms: u64, payload: P): IntentMessage<P> {
    IntentMessage { intent, timestamp_ms, payload }
}

#[test_only]
public fun destroy<T>(enclave: Enclave<T>) {
    let Enclave { id, .. } = enclave;
    id.delete();
}

#[test_only]
/// Construct an `IntentMessage` for cross-module serde tests.
public fun new_intent_message_for_testing<P: drop>(
    intent: u8,
    timestamp_ms: u64,
    payload: P,
): IntentMessage<P> {
    create_intent_message(intent, timestamp_ms, payload)
}

#[test_only]
/// Construct an `Enclave<T>` with a known public key for crypto contract tests
/// (bypasses attestation — verifies the secp256k1 path against a real fixture).
public fun new_enclave_for_testing<T>(pk: vector<u8>, ctx: &mut TxContext): Enclave<T> {
    Enclave<T> { id: object::new(ctx), pk, config_version: 0, owner: ctx.sender() }
}
