// BCS layout for the signed decision. This MUST match
// `synapse_core::decision_attestation::DecisionPayload` and the generic
// `synapse_core::enclave::IntentMessage` wrapper byte-for-byte, or the on-chain
// `ecdsa_k1::secp256k1_verify` will reject every signature.
//
//   IntentMessage { intent: u8, timestamp_ms: u64, payload: DecisionPayload }
//   DecisionPayload {
//     vault_id: address (32 raw bytes, no length prefix),
//     epoch: u64,
//     code_hash: vector<u8>,     // sha256 of the strategy bundle that ran (== Strategy.code_hash)
//     decision_hash: vector<u8>, // sha256 of the canonical decision the bundle produced
//     inputs_hash: vector<u8>,   // sha256 of the inputs the strategy reasoned over
//   }
//
// Strategy-agnostic: the enclave runs the vault's HIRED strategy bundle (loaded
// from Walrus, hash-verified) and signs over its code_hash + the decision it
// produced. Publishing a new strategy needs NO enclave change.

import { bcs } from '@mysten/bcs';

/** Sui `address` is 32 fixed bytes with no length prefix — a fixedArray, not a vector. */
const SuiAddress = bcs.fixedArray(32, bcs.u8());

export const DecisionPayload = bcs.struct('DecisionPayload', {
  vault_id: SuiAddress,
  epoch: bcs.u64(),
  code_hash: bcs.vector(bcs.u8()),
  decision_hash: bcs.vector(bcs.u8()),
  inputs_hash: bcs.vector(bcs.u8()),
});

export const IntentMessageDecision = bcs.struct('IntentMessage', {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  payload: DecisionPayload,
});

/** Intent scope — must equal `INTENT_DECISION` in the Move module (0). */
export const INTENT_DECISION = 0;

/** Convert a 0x-prefixed Sui address/object id into a 32-byte array. */
export function addressToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.padStart(64, '0');
  if (padded.length !== 64) throw new Error(`bad address length: ${hex}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return Array.from(out);
}

/**
 * Serialize the IntentMessage the enclave signs. Returns the BCS bytes that the
 * Move contract reconstructs and verifies the signature against.
 */
export function serializeDecisionIntent({ vaultId, epoch, codeHash, decisionHash, inputsHash, timestampMs }) {
  return IntentMessageDecision.serialize({
    intent: INTENT_DECISION,
    timestamp_ms: timestampMs,
    payload: {
      vault_id: addressToBytes(vaultId),
      epoch,
      code_hash: Array.from(codeHash),
      decision_hash: Array.from(decisionHash),
      inputs_hash: Array.from(inputsHash),
    },
  }).toBytes();
}
