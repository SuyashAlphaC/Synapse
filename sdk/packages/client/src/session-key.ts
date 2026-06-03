/**
 * Agent session key — ephemeral Ed25519 keypair that signs the agent's
 * transactions. Used by the agent's runtime (LangGraph, Claude Agent SDK,
 * Eliza, etc.) as the Sui transaction sender. The corresponding address is
 * committed on-chain as `AgentIdentity.session_addr`.
 *
 * Lifecycle:
 *   1. Human zkLogin parent generates a fresh keypair via `generateSessionKey()`.
 *   2. Address is bound to the AgentIdentity at mint time.
 *   3. Agent runtime persists the secret out-of-band (e.g., Seal-encrypted in
 *      a Walrus blob or in an HSM); never sent on-chain.
 *   4. Owner can rotate via `agent::rotate_session_key` at any time.
 *
 * SECURITY: the secret never leaves the agent's runtime. Compromise of the
 * session key still cannot exceed the on-chain policy (spend cap, allowlist,
 * expiry) — that's the whole point of Synapse.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

/**
 * An ephemeral session key for an agent. The keypair signs Sui transactions
 * on the agent's behalf; the Sui address derived from it is the
 * `session_addr` enforced by every Synapse policy gate.
 */
export interface SessionKey {
  /** The agent's Sui address. */
  address: string;
  /** Base64-encoded 32-byte Ed25519 secret. NEVER send this over the wire. */
  secretBase64: string;
  /** Live keypair object — recreated from `secretBase64` if needed. */
  keypair: Ed25519Keypair;
}

/**
 * Generate a fresh Ed25519 session key. Use this when minting a new agent.
 */
export function generateSessionKey(): SessionKey {
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  // `getSecretKey()` returns a Bech32 `suiprivkey1...` string, NOT base64.
  // Decode it properly to the raw 32-byte secret before base64-encoding;
  // string-stripping the prefix and base64-decoding the bech32 body yields
  // ~45 corrupt bytes that `restoreSessionKey` then rejects.
  const { secretKey } = decodeSuiPrivateKey(keypair.getSecretKey());
  return {
    address,
    secretBase64: toBase64(secretKey),
    keypair,
  };
}

/**
 * Reconstruct a session key from its persisted base64 secret. Used by the
 * agent runtime on startup to resume signing transactions.
 *
 * @throws if `secretBase64` is malformed or not 32 bytes.
 */
export function restoreSessionKey(secretBase64: string): SessionKey {
  const secretBytes = fromBase64(secretBase64);
  if (secretBytes.length !== 32) {
    throw new Error(
      `restoreSessionKey: expected 32-byte secret, got ${secretBytes.length} bytes`,
    );
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretBytes);
  return {
    address: keypair.toSuiAddress(),
    secretBase64,
    keypair,
  };
}
