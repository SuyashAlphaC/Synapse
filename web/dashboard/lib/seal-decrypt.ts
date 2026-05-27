import { Transaction } from '@mysten/sui/transactions';
import { useSuiClient } from '@mysten/dapp-kit';
// Import from the walrus-free `./seal` + `./keypair` subpaths, NOT the
// package roots — the root barrels pull in @mysten/walrus (WASM), which
// breaks Next prerender of any page that statically imports this module.
import {
  buildSynapseSealClient,
  sealDecrypt,
  SealSessionKey,
  EncryptedObject,
} from '@synapse-core/client/seal';
import { loadSessionKeypair } from '@synapse-core/vault/keypair';

type DappSuiClient = ReturnType<typeof useSuiClient>;

export interface DecryptSealedArtifactArgs {
  /** The dapp-kit Sui client (`useSuiClient()`). */
  suiClient: DappSuiClient;
  /** First-version `synapse_seal` package ID (the seal_approve namespace). */
  sealPackageId: string;
  /** The encrypted blob bytes downloaded from Walrus. */
  encrypted: Uint8Array;
  /** Raw contents of the vault's `.key` file (holds the session keypair). */
  keyFileContents: string;
  /** SessionKey TTL in minutes. Default 10. */
  ttlMin?: number;
}

/**
 * Decrypt a Seal-encrypted artifact in the browser.
 *
 * Flow: parse the EncryptedObject to read its embedded identity → create a
 * Seal SessionKey signed by the vault's session keypair (loaded from the
 * .key, never leaves the tab) → build the `policy::seal_approve(id)` PTB →
 * ask the key servers (via the SealClient) for the decryption shares. The
 * key servers dry-run `seal_approve`, which only passes because the session
 * address is the identity prefix. Returns the decrypted UTF-8 text.
 */
export async function decryptSealedArtifact(args: DecryptSealedArtifactArgs): Promise<string> {
  if (!args.sealPackageId) {
    throw new Error('Seal not configured — set NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID.');
  }
  const keypair = await loadSessionKeypair({ sessionKeyEnv: args.keyFileContents });
  const sealClient = buildSynapseSealClient({ suiClient: args.suiClient });

  const parsed = EncryptedObject.parse(args.encrypted);

  const sessionKey = await SealSessionKey.create({
    address: keypair.toSuiAddress(),
    packageId: args.sealPackageId,
    ttlMin: args.ttlMin ?? 10,
    signer: keypair,
    suiClient: args.suiClient,
  });

  // seal_approve takes a single pure `vector<u8>` (the identity), so the PTB
  // serializes offline — no client/object resolution needed.
  const tx = new Transaction();
  tx.moveCall({
    target: `${args.sealPackageId}::policy::seal_approve`,
    arguments: [tx.pure.vector('u8', hexToBytes(parsed.id))],
  });
  const txBytes = await tx.build({ onlyTransactionKind: true });

  const plaintext = await sealDecrypt(sealClient, {
    encrypted: args.encrypted,
    sessionKey,
    txBytes,
  });
  return new TextDecoder().decode(plaintext);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
