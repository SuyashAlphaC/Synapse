/**
 * Seal encryption wrapper for sensitive artifacts.
 *
 * Use this BEFORE uploading to Walrus when the payload contains private
 * information. The encrypted bytes go into Walrus; decryption requires the
 * agent's session key plus a Seal `seal_approve*` PTB.
 *
 * Reference: https://seal-docs.wal.app/
 */

import type {
  SealClientOptions,
  EncryptOptions,
  DecryptOptions,
  KeyServerConfig,
} from '@mysten/seal';
import { SealClient, SessionKey } from '@mysten/seal';

/**
 * Mysten-operated Seal **testnet** key servers (permissionless / open mode).
 * Verified live: both resolve to `…::key_server::KeyServer` objects on
 * testnet. Override via `SYNAPSE_SEAL_KEY_SERVERS` (comma-separated objectIds)
 * if Mysten rotates them — the canonical list lives in the Seal docs.
 */
export const SEAL_TESTNET_KEY_SERVERS: readonly string[] = [
  '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
  '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
];

/** Build `serverConfigs` from object ids (defaults to the testnet servers). */
export function synapseSealServerConfigs(objectIds?: readonly string[]): KeyServerConfig[] {
  const ids = objectIds && objectIds.length > 0 ? objectIds : SEAL_TESTNET_KEY_SERVERS;
  return ids.map((objectId) => ({ objectId, weight: 1 }));
}

/**
 * Construct a SealClient wired to the Synapse testnet key servers. Pass the
 * same `suiClient` the rest of the runtime uses. `verifyKeyServers` defaults
 * to `false` — skipping the extra on-chain authenticity check keeps testnet
 * encryption robust; flip it on for stricter production setups.
 */
export function buildSynapseSealClient(args: {
  suiClient: SealClientOptions['suiClient'];
  keyServerObjectIds?: readonly string[];
  verifyKeyServers?: boolean;
}): SealClient {
  return new SealClient({
    suiClient: args.suiClient,
    serverConfigs: synapseSealServerConfigs(args.keyServerObjectIds),
    verifyKeyServers: args.verifyKeyServers ?? false,
  });
}

/**
 * Compose a Seal identity gated by an address: `id = <32-byte address> ||
 * suffix`, hex-encoded. The `synapse_seal::policy::seal_approve` function
 * authorizes decryption only when the PTB sender's address is this prefix —
 * so only a SessionKey for `address` can decrypt. `suffix` disambiguates
 * artifacts under the same address (e.g. the report's plan id bytes).
 */
export function sealIdForAddress(address: string, suffix: Uint8Array): string {
  const addrBytes = hexToBytes(address);
  const id = new Uint8Array(addrBytes.length + suffix.length);
  id.set(addrBytes, 0);
  id.set(suffix, addrBytes.length);
  return bytesToHex(id);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) throw new Error(`sealIdForAddress: odd-length hex "${hex}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface SealEncryptArgs {
  /** Bytes to encrypt. */
  payload: Uint8Array;
  /** Synapse Core package ID (provides the seal_approve namespace). */
  packageId: string;
  /** Identity bytes that gate access — typically agent_id or namespace. */
  id: string;
  /** TSS threshold (number of key servers required). Default 2. */
  threshold?: number;
}

export interface SealDecryptArgs {
  /** Encrypted bytes (the EncryptedObject blob). */
  encrypted: Uint8Array;
  /** Session key established via SessionKey.create(...). */
  sessionKey: SessionKey;
  /** Encoded PTB bytes calling `seal_approve*` for this identity. */
  txBytes: Uint8Array;
}

/** Create a SealClient. Reuse one per process. */
export function createSealClient(options: SealClientOptions): SealClient {
  return new SealClient(options);
}

/** Convenience encrypt using sensible defaults. */
export async function sealEncrypt(
  client: SealClient,
  args: SealEncryptArgs,
): Promise<Uint8Array> {
  const opts: EncryptOptions = {
    threshold: args.threshold ?? 2,
    packageId: args.packageId,
    id: args.id,
    data: args.payload,
  };
  const result = await client.encrypt(opts);
  return result.encryptedObject;
}

export async function sealDecrypt(
  client: SealClient,
  args: SealDecryptArgs,
): Promise<Uint8Array> {
  const opts: DecryptOptions = {
    data: args.encrypted,
    sessionKey: args.sessionKey,
    txBytes: args.txBytes,
  };
  return client.decrypt(opts);
}

export { SessionKey as SealSessionKey };
/** Parse a Seal `EncryptedObject` to read its embedded `id` / `packageId`. */
export { EncryptedObject } from '@mysten/seal';
